import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { analyzeExtractedInvoice } from '../modules/invoice-intelligence/analyze.js'
import { toInvoiceAnalysisApiResult } from './invoiceAnalysisResponse.js'
import { sha256Hex } from './fileHash.js'
import { issueInvoiceIntegrityToken } from './invoiceIntegrity.js'
import { confirmIntentDigest, mapConfirmIntentSourceLines } from './confirmIntent.js'
import { savePurchaseInvoice, type InvoiceSaveConfirmIntent, type InvoiceSaveRpcLog } from './invoiceSave.js'
import { InvoiceSaveError } from './invoiceSaveError.js'

const fixtures = JSON.parse(
  readFileSync(new URL('../modules/invoice-intelligence/fixtures/invoice-cases.json', import.meta.url), 'utf8'),
) as Record<string, unknown>
const serviceFixtures = JSON.parse(
  readFileSync(new URL('../modules/invoice-intelligence/fixtures/service-cases.json', import.meta.url), 'utf8'),
) as Record<string, unknown>
const commercialFixtures = JSON.parse(
  readFileSync(new URL('../modules/invoice-intelligence/fixtures/commercial-cases.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

const SECRET = 'test-integrity-secret-not-for-production'
const PDF = Buffer.from('%PDF-1.4\nfixture-save')
const NOW = new Date('2026-10-14T15:00:00.000Z')
const USER = 'user-save-1'
const LOCATION = { id: 'loc-1', organization_id: 'org-1' }

function snapshotFromExtracted(extracted: unknown) {
  const analyzed = analyzeExtractedInvoice(extracted)
  return toInvoiceAnalysisApiResult(analyzed, { fileSha256: sha256Hex(PDF) })
}

function userClient(options: {
  location?: { id: string; organization_id: string } | null
  documents?: Record<string, unknown>[]
} = {}) {
  const documents = options.documents ?? []
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq(_column: string, value: string) {
              if (table === 'locations') {
                return {
                  maybeSingle: async () => ({
                    data: options.location === undefined ? LOCATION : options.location,
                    error: null,
                  }),
                }
              }
              if (table === 'organizations') {
                return {
                  maybeSingle: async () => ({ data: { invoice_fiscal_tolerances: null }, error: null }),
                }
              }
              const match = documents.find((row) => row.id === value)
              const result = {
                data: documents,
                error: null,
                maybeSingle: async () => ({ data: match ?? null, error: null }),
                is() {
                  return result
                },
              }
              return result
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

function adminClient(rpcResult: { data?: unknown; error?: { code?: string; message?: string; details?: string; hint?: string } | null } = { data: 'doc-new', error: null }) {
  const upload = vi.fn(async () => ({ error: null }))
  const rpc = vi.fn(async (_name: string, args: { p: Record<string, unknown> }) => {
    expect(args.p.actor_user_id).toBe(USER)
    expect(args.p).not.toHaveProperty('inventory_product_id')
    return rpcResult
  })
  return {
    upload,
    rpc,
    client: {
      storage: { from: () => ({ upload }) },
      rpc,
    } as unknown as SupabaseClient,
  }
}

async function save(options: {
  extracted?: unknown
  decisions?: unknown
  documents?: Record<string, unknown>[]
  location?: { id: string; organization_id: string } | null
  admin?: ReturnType<typeof adminClient>
  acceptFiscal?: string
  logRpcError?: (entry: InvoiceSaveRpcLog) => void
  confirmIntent?: InvoiceSaveConfirmIntent | null
} = {}) {
  const snapshot = snapshotFromExtracted(options.extracted ?? fixtures.foodInvoice)
  const confirmIntent = options.confirmIntent === undefined
    ? {
      confirmIdempotencyKey: '11111111-1111-4111-8111-111111111111',
      lines: [{
        sourceLineId: String(snapshot.document.lines[0]?.id ?? ''),
        action: 'pending' as const,
      }],
    }
    : options.confirmIntent
  const token = issueInvoiceIntegrityToken({
    userId: USER,
    fileSha256: sha256Hex(PDF),
    snapshot,
    secret: SECRET,
    now: NOW,
  }).token
  const admin = options.admin ?? adminClient()
  const result = await savePurchaseInvoice({
    userId: USER,
    locationId: 'loc-1',
    fileBytes: PDF,
    filename: 'factura.pdf',
    mimeType: 'application/pdf',
    integrityToken: token,
    originalSnapshot: snapshot,
    commercialDecisions: options.decisions ?? [],
    acceptFiscalInconsistency: options.acceptFiscal,
    confirmIntent,
    secret: SECRET,
    now: NOW,
    deps: {
      userClient: userClient({ location: options.location, documents: options.documents }),
      adminClient: admin.client,
      logRpcError: options.logRpcError,
    },
  })
  return { result, admin, snapshot }
}

describe('savePurchaseInvoice', () => {
  it('guarda mercadería vía RPC de service_role con el actor de getUser', async () => {
    const { result, admin } = await save()
    expect(result).toMatchObject({
      id: 'doc-new',
      status: 'reviewed',
      organizationId: 'org-1',
      idempotent: false,
    })
    expect(result.eligibleLineCount).toBeGreaterThanOrEqual(1)
    expect(admin.upload).toHaveBeenCalledOnce()
    expect(admin.rpc).toHaveBeenCalledWith(
      'senda_save_purchase_invoice_with_confirm_intent',
      expect.objectContaining({
        p: expect.objectContaining({
          actor_user_id: USER,
          location_id: 'loc-1',
          supplier_id: null,
        }),
      }),
    )
    expect(admin.rpc).not.toHaveBeenCalledWith('senda_save_purchase_invoice', expect.anything())
    const payload = admin.rpc.mock.calls[0][1].p
    expect(payload.document_type).toBe('invoice')
    const original = payload.original_analysis as { document: { header: { type: string } } }
    expect(original.document.header.type).toBe('Factura A')
    expect(JSON.stringify(payload)).not.toMatch(/purchase_items|inventory_movements/)
  })

  it('rechaza un documento solo de servicios', async () => {
    await expect(save({ extracted: serviceFixtures.metrogasReference })).rejects.toMatchObject({
      code: 'SAVE_NOT_ALLOWED_NO_INVENTORY',
      status: 422,
    })
  })

  it('devuelve el mismo id si el hash ya existe', async () => {
    const { result, admin } = await save({
      documents: [{
        id: 'doc-existing',
        organization_id: 'org-1',
        file_sha256: sha256Hex(PDF),
        issuer_tax_id_normalized: '30123456781',
        voucher_type: 'A',
        point_of_sale: '0002',
        voucher_number: '00000010',
        status: 'reviewed',
        location_id: 'loc-1',
        eligible_line_count: 1,
        unmapped_line_count: 1,
        storage_object_path: `org-1/invoices/${sha256Hex(PDF)}.pdf`,
      }],
    })
    expect(result.idempotent).toBe(true)
    expect(result.id).toBe('doc-existing')
    expect(admin.upload).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('rechaza otro archivo con el mismo comprobante', async () => {
    await expect(save({
      documents: [{
        id: 'doc-other',
        organization_id: 'org-1',
        file_sha256: 'ab'.repeat(32),
        issuer_tax_id_normalized: '30123456781',
        voucher_type: 'A',
        point_of_sale: '0002',
        voucher_number: '00000010',
        status: 'reviewed',
      }],
    })).rejects.toMatchObject({ code: 'DUPLICATE_DOCUMENT', status: 409 })
  })

  it('no usa un actor enviado por el cliente', async () => {
    const { admin } = await save()
    expect(admin.rpc.mock.calls[0][1].p.actor_user_id).toBe(USER)
    expect(admin.rpc.mock.calls[0][1].p.actor_user_id).not.toBe('forged-user')
  })

  it('exige local visible por RLS', async () => {
    await expect(save({ location: null })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    })
  })

  it('registra el error real del RPC y responde un error seguro al cliente', async () => {
    const logs: InvoiceSaveRpcLog[] = []
    const admin = adminClient({
      data: null,
      error: {
        code: 'P0001',
        message: 'DRAFT_REQUIRES_STORAGE_PATH',
        details: 'new.storage_object_path',
        hint: 'Use {org}/invoices/{sha}.{ext}',
      },
    })
    await expect(save({ admin, logRpcError: (entry) => logs.push(entry) })).rejects.toMatchObject({
      name: 'InvoiceSaveError',
      code: 'SAVE_FAILED',
      status: 500,
      message: 'No se pudo guardar la factura.',
    })
    expect(logs).toEqual([{
      operation: 'senda_save_purchase_invoice',
      code: 'P0001',
      message: 'DRAFT_REQUIRES_STORAGE_PATH',
      details: 'new.storage_object_path',
      hint: 'Use {org}/invoices/{sha}.{ext}',
    }])
    expect(JSON.stringify(logs)).not.toMatch(/integrityToken|Bearer |SERVICE_ROLE|HMAC/i)
  })

  function commercialDecision(
    snapshot: ReturnType<typeof snapshotFromExtracted>,
    decision: 'confirm' | 'reject',
  ) {
    const relation = snapshot.interpretation.relations[0]
    const adjustment = snapshot.document.lines.find((line) => line.id === relation.adjustmentLineIds[0])
    return [{
      relationId: relation.id,
      decision,
      type: relation.type,
      targetLineId: relation.targetLineId,
      adjustmentLineIds: relation.adjustmentLineIds,
      proposedPhysicalQuantity: relation.proposedPhysicalQuantity,
      unit: relation.unit,
      bonusAmount: relation.bonusAmount,
      grossAmount: relation.grossAmount,
      netAcquisitionAmount: relation.netAcquisitionAmount,
      originalAdjustmentAmounts: [{
        lineId: adjustment!.id,
        amount: adjustment!.amount,
        unitPrice: adjustment!.unitPrice,
        quantity: adjustment!.quantity,
      }],
    }]
  }

  it('rechaza guardar Lúpulo si la bonificación sigue propuesta', async () => {
    await expect(save({ extracted: commercialFixtures.pilsenFullBonus })).rejects.toMatchObject({
      code: 'COMMERCIAL_RELATION_UNRESOLVED',
      status: 422,
      message: 'Confirmá o rechazá la bonificación de PILSEN antes de guardar.',
    })
  })

  it('persiste la confirmación de PILSEN y deja el negativo fuera del stock', async () => {
    const snapshot = snapshotFromExtracted(commercialFixtures.pilsenFullBonus)
    const { result, admin } = await save({
      extracted: commercialFixtures.pilsenFullBonus,
      decisions: commercialDecision(snapshot, 'confirm'),
    })
    expect(result.idempotent).toBe(false)
    const payload = admin.rpc.mock.calls[0][1].p as {
      commercial_decisions: Array<{ decision: string }>
      original_analysis: { interpretation: { relations: Array<{ status: string }> } }
      reviewed_analysis: {
        interpretation: { relations: Array<{ status: string; adjustmentLineIds: string[] }> }
        document: { lines: Array<{ id: string; name: string; amount: number | null; inventoryEligibility: string; unitPrice: number | null }> }
      }
    }
    expect(payload.commercial_decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'confirm' }),
    ]))
    expect(payload.original_analysis.interpretation.relations[0]?.status).toBe('proposed')
    expect(payload.reviewed_analysis.interpretation.relations[0]?.status).toBe('confirmed')
    const pilsen = payload.reviewed_analysis.document.lines.find((line) => line.name === 'PILSEN' && (line.amount ?? 0) > 0)
    const negative = payload.reviewed_analysis.document.lines.find((line) => (line.amount ?? 0) < 0)
    const iva = payload.reviewed_analysis.document.lines.find((line) => line.name.startsWith('IVA'))
    expect(pilsen).toMatchObject({ inventoryEligibility: 'eligible', amount: 82500, unitPrice: 1650 })
    expect(negative).toMatchObject({ inventoryEligibility: 'ineligible', amount: -82500 })
    expect(iva?.amount).toBe(128316.72)
  })

  it('cierra el rechazo de Lúpulo y no convierte el negativo en mercadería', async () => {
    const snapshot = snapshotFromExtracted(commercialFixtures.pilsenFullBonus)
    const { admin } = await save({
      extracted: commercialFixtures.pilsenFullBonus,
      decisions: commercialDecision(snapshot, 'reject'),
    })
    const payload = admin.rpc.mock.calls[0][1].p as {
      reviewed_analysis: {
        interpretation: { relations: Array<{ status: string }> }
        document: { lines: Array<{ name: string; amount: number | null; inventoryEligibility: string }> }
      }
    }
    expect(payload.reviewed_analysis.interpretation.relations[0]?.status).toBe('rejected')
    const negative = payload.reviewed_analysis.document.lines.find((line) => (line.amount ?? 0) < 0)
    expect(negative?.inventoryEligibility).toBe('ineligible')
  })

  it('no confirma automáticamente una bonificación ambigua', async () => {
    await expect(save({ extracted: commercialFixtures.similarProducts })).rejects.toMatchObject({
      code: 'COMMERCIAL_RELATION_UNRESOLVED',
      status: 422,
    })
  })

  it('no reescribe un duplicado aunque la bonificación siga pendiente', async () => {
    const { result, admin } = await save({
      extracted: commercialFixtures.pilsenFullBonus,
      documents: [{
        id: 'doc-lupulo',
        organization_id: 'org-1',
        file_sha256: sha256Hex(PDF),
        issuer_tax_id_normalized: '30123456781',
        voucher_type: 'A',
        point_of_sale: '0007',
        voucher_number: '00006046',
        status: 'reviewed',
        location_id: 'loc-1',
        eligible_line_count: 4,
        unmapped_line_count: 4,
        storage_object_path: `org-1/invoices/${sha256Hex(PDF)}.pdf`,
      }],
    })
    expect(result.idempotent).toBe(true)
    expect(result.id).toBe('doc-lupulo')
    expect(admin.upload).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('rechaza un alta nueva sin confirmIntent y no escribe', async () => {
    const admin = adminClient()
    await expect(save({ admin, confirmIntent: null })).rejects.toMatchObject({
      code: 'CONFIRM_INTENT_REQUIRED',
      status: 422,
    })
    expect(admin.upload).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('si falta el RPC nuevo responde 503 y no llama al alta antigua', async () => {
    const rpc = vi.fn(async (name: string) => {
      expect(name).toBe('senda_save_purchase_invoice_with_confirm_intent')
      return {
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.senda_save_purchase_invoice_with_confirm_intent in the schema cache',
        },
      }
    })
    const upload = vi.fn(async () => ({ error: null }))
    const admin = {
      upload,
      rpc,
      client: { storage: { from: () => ({ upload }) }, rpc },
    }
    await expect(save({ admin: admin as never })).rejects.toMatchObject({
      code: 'CONFIRM_INTENT_RPC_MISSING',
      status: 503,
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalledWith('senda_save_purchase_invoice', expect.anything())
  })

  it('con el RPC disponible persiste la factura y el intento en esa llamada', async () => {
    const snapshot = snapshotFromExtracted(fixtures.foodInvoice)
    const sourceLineId = String(snapshot.document.lines[0]?.id)
    const confirmIntent: InvoiceSaveConfirmIntent = {
      confirmIdempotencyKey: '11111111-1111-4111-8111-111111111111',
      lines: [{
        sourceLineId,
        action: 'create',
        create: { name: 'Azúcar', baseUnit: 'g' },
        conversionFactor: 1,
        receiveQuantity: 4,
        receiveIdempotencyKey: '33333333-3333-4333-8333-333333333333',
      }],
    }
    const mapped = mapConfirmIntentSourceLines(confirmIntent.lines, [{ id: 'stored-line-1', sourceLineId }])
    const intents = new Map<string, Record<string, unknown>>()
    const rpc = vi.fn(async (name: string, args: { p: { confirm_intent: { lines: unknown[] } } }) => {
      expect(name).toBe('senda_save_purchase_invoice_with_confirm_intent')
      intents.set('doc-new', {
        purchase_document_id: 'doc-new',
        organization_id: 'org-1',
        location_id: 'loc-1',
        actor_user_id: USER,
        confirm_idempotency_key: '11111111-1111-4111-8111-111111111111',
        lines: mapped,
        payload_digest: confirmIntentDigest(mapped),
      })
      expect(args.p.confirm_intent.lines).toEqual([
        expect.objectContaining({ source_line_id: sourceLineId, receiveQuantity: 4 }),
      ])
      return { data: 'doc-new', error: null }
    })
    const upload = vi.fn(async () => ({ error: null }))
    const admin = intentAdmin(sourceLineId, intents, rpc, upload)
    const { result } = await save({ admin: admin as never, confirmIntent })
    expect(result).toMatchObject({ id: 'doc-new', idempotent: false, confirmIntentStored: true })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(intents.get('doc-new')?.confirm_idempotency_key).toBe(confirmIntent.confirmIdempotencyKey)
    expect((intents.get('doc-new')?.lines as Array<{ receiveQuantity: number }>)[0]?.receiveQuantity).toBe(4)

    const replay = await save({
      admin: admin as never,
      confirmIntent,
      documents: [existingDocument('doc-new')],
    })
    expect(replay.result).toMatchObject({ id: 'doc-new', idempotent: true, confirmIntentStored: true })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(intents.size).toBe(1)
  })

  it('si falla el insert del intento no guarda por el RPC antiguo', async () => {
    const rpc = vi.fn(async (name: string) => {
      expect(name).toBe('senda_save_purchase_invoice_with_confirm_intent')
      return {
        data: null,
        error: { code: 'P0001', message: 'insert into purchase_document_confirm_intents failed' },
      }
    })
    const upload = vi.fn(async () => ({ error: null }))
    const admin = { upload, rpc, client: { storage: { from: () => ({ upload }) }, rpc } }
    await expect(save({ admin: admin as never })).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      status: 500,
    })
    expect(rpc).not.toHaveBeenCalledWith('senda_save_purchase_invoice', expect.anything())
  })

  it('rechaza reentrar con otro payload y conserva el intento guardado', async () => {
    const snapshot = snapshotFromExtracted(fixtures.foodInvoice)
    const sourceLineId = String(snapshot.document.lines[0]?.id)
    const storedPlan: InvoiceSaveConfirmIntent = {
      confirmIdempotencyKey: '11111111-1111-4111-8111-111111111111',
      lines: [{
        sourceLineId,
        action: 'create',
        create: { name: 'Azúcar', baseUnit: 'g' },
        conversionFactor: 1,
        receiveQuantity: 4,
        receiveIdempotencyKey: '33333333-3333-4333-8333-333333333333',
      }],
    }
    const mapped = mapConfirmIntentSourceLines(storedPlan.lines, [{ id: 'stored-line-1', sourceLineId }])
    const intents = new Map<string, Record<string, unknown>>([
      ['doc-new', {
        purchase_document_id: 'doc-new',
        organization_id: 'org-1',
        location_id: 'loc-1',
        actor_user_id: USER,
        confirm_idempotency_key: storedPlan.confirmIdempotencyKey,
        lines: mapped,
        payload_digest: confirmIntentDigest(mapped),
      }],
    ])
    const rpc = vi.fn()
    const upload = vi.fn(async () => ({ error: null }))
    const admin = intentAdmin(sourceLineId, intents, rpc, upload)
    await expect(save({
      admin: admin as never,
      confirmIntent: {
        ...storedPlan,
        lines: [{ ...storedPlan.lines[0], receiveQuantity: 1, conversionFactor: 2 }],
      },
      documents: [existingDocument('doc-new')],
    })).rejects.toMatchObject({ code: 'CONFIRM_INTENT_CONFLICT', status: 409 })
    expect(rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect((intents.get('doc-new')?.lines as Array<{ receiveQuantity: number; conversionFactor: number }>)[0])
      .toMatchObject({ receiveQuantity: 4, conversionFactor: 1 })
    expect(intents.get('doc-new')?.location_id).toBe('loc-1')
  })
})

function existingDocument(id: string) {
  return {
    id,
    organization_id: 'org-1',
    file_sha256: sha256Hex(PDF),
    issuer_tax_id_normalized: '30123456781',
    voucher_type: 'A',
    point_of_sale: '0002',
    voucher_number: '00000010',
    status: 'reviewed',
    location_id: 'loc-1',
    eligible_line_count: 1,
    unmapped_line_count: 1,
    storage_object_path: `org-1/invoices/${sha256Hex(PDF)}.pdf`,
  }
}

function intentAdmin(
  sourceLineId: string,
  intents: Map<string, Record<string, unknown>>,
  rpc: ReturnType<typeof vi.fn>,
  upload: ReturnType<typeof vi.fn>,
) {
  return {
    upload,
    rpc,
    client: {
      storage: { from: () => ({ upload }) },
      rpc,
      from(table: string) {
        if (table === 'purchase_document_lines') {
          return {
            select: () => ({
              eq: async () => ({
                data: [{ id: 'stored-line-1', source_line_id: sourceLineId }],
                error: null,
              }),
            }),
          }
        }
        if (table === 'purchase_document_confirm_intents') {
          return {
            select: () => ({
              eq: (_column: string, id: string) => ({
                maybeSingle: async () => ({ data: intents.get(id) ?? null, error: null }),
              }),
            }),
            insert: async () => {
              throw new Error('el alta no inserta el intento en una segunda operación')
            },
          }
        }
        throw new Error(table)
      },
    },
  }
}

describe('alta nueva', () => {
  it('no conserva una llamada al RPC antiguo ni un insert posterior del intento', () => {
    const source = readFileSync(new URL('./invoiceSave.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/rpc\(\s*'senda_save_purchase_invoice'/)
    expect(source).not.toMatch(/persistConfirmIntentForNewDocument/)
    expect(source).toMatch(/senda_save_purchase_invoice_with_confirm_intent/)
  })
})

describe('InvoiceSaveError', () => {
  it('conserva código HTTP', () => {
    const error = new InvoiceSaveError('x', 'Y', 422)
    expect(error.status).toBe(422)
  })
})

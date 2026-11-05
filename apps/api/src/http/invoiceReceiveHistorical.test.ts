import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { receiveInvoiceLine } from './invoiceReceive.js'

const DOC = '77a5cad6-abec-4517-a19d-2a63c9ff0e2e'
const OTHER_DOC = 'c74f9c65-1899-4f9d-9873-8b9199b07639'
const LINE = 'ea5eed69-2f41-434c-b04d-f1c8feaf916e'
const OTHER_LINE = 'b98555f9-0661-4a3b-98b9-8ef1934d6d2f'
const PRODUCT = '74382f8c-480f-4b27-8d13-82fa82c8da6b'
const KEY = 'e5be6144-cc86-458c-8434-c2ef5ca17bf0'
const OTHER_KEY = '6ee5d283-f840-4713-8018-de1766820bed'
const LOC = 'd8d78b7d-eec5-4e90-8f2d-98268a875d00'
const OTHER_LOC = '11111111-1111-4111-8111-111111111111'
const ORG = 'a01b3bf7-6af2-4078-9931-e70f55b4626e'
const SOURCE = 'line-1rblalr-1'
const USER = 'a30637ba-0d16-4b28-9467-a923ff3dd62d'
const OTHER_LINES = [
  'b98555f9-0661-4a3b-98b9-8ef1934d6d2f',
  '9ba6c3d4-2028-4680-b6c3-adef83b4b1ae',
  '4b9b3201-b1c3-44be-b16c-1f9a80a70285',
  'd73d8bdd-61ae-4f48-aac6-f3cbd2f853f8',
  'b307722c-8a34-4e79-af59-896d2d93ad03',
]

function documentLine(patch: Record<string, unknown> = {}) {
  return {
    id: SOURCE,
    quantity: 1,
    unit: 'u',
    unitPrice: 8213.95,
    amount: 72972.75,
    contentPerUnit: 8.8,
    contentUnit: 'kg',
    billedWeight: 8.88,
    billedWeightUnit: 'kg',
    inventoryPhysicalQuantity: 8880,
    ...patch,
  }
}

function interpreted(
  status: string,
  priceBasis: string,
  proposedQuantity: number,
  billedWeight: number | null,
) {
  return {
    lineId: SOURCE,
    status,
    physical: { priceBasis, billedWeight, proposedQuantity },
  }
}

function auroraInvoice(patch: {
  corrections?: unknown
  commercialDecisions?: unknown
  locationId?: string
  reviewedLine?: Record<string, unknown>
  originalLine?: Record<string, unknown>
  reviewedInterpretation?: Record<string, unknown>
} = {}) {
  const reviewedLine = documentLine({
    billedWeight: undefined,
    billedWeightUnit: undefined,
    inventoryPhysicalQuantity: 8800,
    ...patch.reviewedLine,
  })
  return {
    id: DOC,
    location_id: patch.locationId ?? LOC,
    organization_id: ORG,
    corrections: patch.corrections ?? {},
    commercial_decisions: patch.commercialDecisions ?? [],
    original_analysis: {
      document: { lines: [documentLine(patch.originalLine)] },
      interpretation: {
        lines: [interpreted('confirmed', 'weight', 8880, 8.88)],
      },
    },
    reviewed_analysis: {
      document: { lines: [reviewedLine] },
      interpretation: {
        lines: [patch.reviewedInterpretation ?? interpreted('requires_review', 'ambiguous', 8800, null)],
      },
    },
  }
}

function storedLine(patch: Record<string, unknown> = {}) {
  return {
    id: LINE,
    purchase_document_id: DOC,
    source_line_id: SOURCE,
    mapping_status: 'mapped',
    inventory_product_id: PRODUCT,
    inventory_physical_quantity: 8880,
    ...patch,
  }
}

function intent(patch: { locationId?: string; receiveKey?: string; receiveQuantity?: number } = {}) {
  return {
    purchase_document_id: DOC,
    location_id: patch.locationId ?? LOC,
    organization_id: ORG,
    lines: [
      {
        purchaseDocumentLineId: LINE,
        receiveQuantity: patch.receiveQuantity ?? 8880,
        receiveIdempotencyKey: patch.receiveKey ?? KEY,
      },
      ...OTHER_LINES.map((id, index) => ({
        purchaseDocumentLineId: id,
        receiveQuantity: 1000 * (index + 1),
        receiveIdempotencyKey: `0000000${index}-0000-4000-8000-000000000000`.replace(
          `0000000${index}`,
          `${index + 1}`.padStart(8, '0'),
        ),
      })),
    ],
  }
}

function db(options: {
  invoice?: Record<string, unknown> | null
  line?: Record<string, unknown> | null
  product?: Record<string, unknown> | null
  receipts?: Record<string, unknown>[]
  intent?: Record<string, unknown> | null
  rpcData?: Record<string, unknown> | null
  rpcError?: { message?: string } | null
} = {}) {
  const writes: string[] = []
  const from = vi.fn((table: string) => {
    const payload = (() => {
      if (table === 'purchase_documents') {
        return { data: options.invoice === undefined ? auroraInvoice() : options.invoice, error: null }
      }
      if (table === 'purchase_document_lines') {
        return { data: options.line === undefined ? storedLine() : options.line, error: null }
      }
      if (table === 'inventory_products') {
        return {
          data: options.product === undefined
            ? { id: PRODUCT, active: true, organization_id: ORG, base_unit: 'g' }
            : options.product,
          error: null,
        }
      }
      if (table === 'purchase_document_receipts') {
        return { data: options.receipts ?? [], error: null }
      }
      if (table === 'purchase_document_confirm_intents') {
        return { data: options.intent === undefined ? intent() : options.intent, error: null }
      }
      return { data: null, error: { message: 'unexpected' } }
    })()
    const query: Record<string, unknown> = {}
    const chain = () => query
    query.select = chain
    query.eq = chain
    query.is = chain
    query.update = () => {
      writes.push(`${table}.update`)
      return query
    }
    query.delete = () => {
      writes.push(`${table}.delete`)
      return query
    }
    query.maybeSingle = async () => payload
    query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => (
      Promise.resolve(payload).then(resolve, reject)
    )
    return query
  })
  const rpc = vi.fn(async () => ({
    data: options.rpcError
      ? null
      : (options.rpcData ?? {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        purchase_document_id: DOC,
        purchase_document_line_id: LINE,
        quantity: 8880,
        invoiced_quantity: 8880,
        received_quantity: 8880,
        remaining_quantity: 0,
        document_status: 'received',
        inventory_movement_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        idempotent: false,
      }),
    error: options.rpcError ?? null,
  }))
  return { from, rpc, writes, user: { from } as unknown as SupabaseClient, admin: { rpc, from } as unknown as SupabaseClient }
}

function receive(
  database: ReturnType<typeof db>,
  overrides: Partial<{ documentId: string; lineId: string; quantity: number; idempotencyKey: string; userId: string }> = {},
) {
  return receiveInvoiceLine({
    userClient: database.user,
    adminClient: database.admin,
    userId: overrides.userId ?? USER,
    documentId: overrides.documentId ?? DOC,
    lineId: overrides.lineId ?? LINE,
    quantity: overrides.quantity ?? 8880,
    idempotencyKey: overrides.idempotencyKey ?? KEY,
  })
}

describe('recuperación histórica de Doña Aurora', () => {
  it('recibe exactamente 8.880 g con la clave pendiente del intent', async () => {
    const database = db()
    const result = await receive(database)
    expect(result).toMatchObject({
      purchaseDocumentLineId: LINE,
      quantity: 8880,
      invoicedQuantity: 8880,
      receivedQuantity: 8880,
      remainingQuantity: 0,
      idempotent: false,
    })
    expect(database.rpc).toHaveBeenCalledTimes(1)
    expect(database.rpc).toHaveBeenCalledWith('senda_receive_purchase_document_line', {
      p_document_id: DOC,
      p_line_id: LINE,
      p_quantity: 8880,
      p_idempotency_key: KEY,
      p_actor_user_id: USER,
    })
    const sent = JSON.stringify(database.rpc.mock.calls)
    for (const other of OTHER_LINES) expect(sent).not.toContain(other)
    expect(database.writes).toEqual([])
    expect(sent).not.toContain('senda_confirm_purchase_invoice_intake')
  })

  it('una corrección explícita de la línea mantiene el bloqueo', async () => {
    const database = db({
      invoice: auroraInvoice({
        corrections: { lines: [{ id: SOURCE, amount: 65000 }] },
      }),
    })
    await expect(receive(database)).rejects.toMatchObject({
      code: 'COMMERCIAL_REVIEW_REQUIRED',
      status: 422,
    })
    expect(database.rpc).not.toHaveBeenCalled()
  })

  it('un importe distinto entre original y revisión mantiene el bloqueo', async () => {
    const database = db({
      invoice: auroraInvoice({ reviewedLine: { amount: 65000 } }),
    })
    await expect(receive(database)).rejects.toMatchObject({ code: 'COMMERCIAL_REVIEW_REQUIRED' })
    expect(database.rpc).not.toHaveBeenCalled()
  })

  it('otra línea u otra factura no usan la excepción', async () => {
    const otherSource = 'line-sob5kx-1'
    const otherLine = db({
      invoice: {
        ...auroraInvoice(),
        original_analysis: {
          document: { lines: [{ id: otherSource, quantity: 2, unit: 'u', unitPrice: 10, amount: 20 }] },
          interpretation: { lines: [{ lineId: otherSource, status: 'requires_review' }] },
        },
        reviewed_analysis: {
          document: { lines: [{ id: otherSource, quantity: 2, unit: 'u', unitPrice: 10, amount: 20 }] },
          interpretation: { lines: [{ lineId: otherSource, status: 'requires_review' }] },
        },
      },
      line: storedLine({
        id: OTHER_LINE,
        source_line_id: otherSource,
        inventory_physical_quantity: 7000,
        inventory_product_id: '872338d8-ea7c-4aab-8982-06fd65d4dd98',
      }),
    })
    await expect(receive(otherLine, { lineId: OTHER_LINE, quantity: 7000, idempotencyKey: OTHER_KEY }))
      .rejects.toMatchObject({ code: 'COMMERCIAL_REVIEW_REQUIRED' })
    expect(otherLine.rpc).not.toHaveBeenCalled()

    const otherInvoice = db({
      invoice: {
        id: OTHER_DOC,
        location_id: LOC,
        organization_id: ORG,
        corrections: {},
        commercial_decisions: [],
        original_analysis: {
          interpretation: { lines: [{ lineId: 'line-x', status: 'requires_review' }] },
        },
        reviewed_analysis: {
          interpretation: { lines: [{ lineId: 'line-x', status: 'requires_review' }] },
        },
      },
      line: storedLine({
        id: OTHER_LINE,
        purchase_document_id: OTHER_DOC,
        source_line_id: 'line-x',
      }),
    })
    await expect(receive(otherInvoice, {
      documentId: OTHER_DOC,
      lineId: OTHER_LINE,
      quantity: 8880,
      idempotencyKey: KEY,
    })).rejects.toMatchObject({ code: 'COMMERCIAL_REVIEW_REQUIRED' })
    expect(otherInvoice.rpc).not.toHaveBeenCalled()
  })

  it('rechaza una cantidad distinta de 8.880 g', async () => {
    const database = db()
    await expect(receive(database, { quantity: 8800 })).rejects.toMatchObject({
      code: 'COMMERCIAL_REVIEW_REQUIRED',
    })
    expect(database.rpc).not.toHaveBeenCalled()
  })

  it('rechaza una recepción previa con otra clave', async () => {
    const database = db({
      receipts: [{ quantity: 8880, idempotency_key: OTHER_KEY }],
    })
    await expect(receive(database)).rejects.toMatchObject({ code: 'COMMERCIAL_REVIEW_REQUIRED' })
    expect(database.rpc).not.toHaveBeenCalled()
  })

  it('rechaza una clave que no es la pendiente del intent', async () => {
    const database = db()
    await expect(receive(database, { idempotencyKey: OTHER_KEY })).rejects.toMatchObject({
      code: 'COMMERCIAL_REVIEW_REQUIRED',
    })
    expect(database.rpc).not.toHaveBeenCalled()
  })

  it('mantiene la autorización del usuario y de la sucursal', async () => {
    const forbidden = db({ rpcError: { message: 'NOT_A_MEMBER' } })
    await expect(receive(forbidden)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(forbidden.rpc).toHaveBeenCalledTimes(1)
    expect(forbidden.rpc.mock.calls[0]?.[1].p_actor_user_id).toBe(USER)

    const otherBranch = db({ intent: intent({ locationId: OTHER_LOC }) })
    await expect(receive(otherBranch)).rejects.toMatchObject({ code: 'COMMERCIAL_REVIEW_REQUIRED' })
    expect(otherBranch.rpc).not.toHaveBeenCalled()
  })

  it('repite la misma clave sin una segunda recepción', async () => {
    const database = db({
      receipts: [{ quantity: 8880, idempotency_key: KEY }],
      rpcData: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        purchase_document_id: DOC,
        purchase_document_line_id: LINE,
        quantity: 8880,
        invoiced_quantity: 8880,
        received_quantity: 8880,
        remaining_quantity: 0,
        document_status: 'received',
        inventory_movement_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        idempotent: true,
      },
    })
    const result = await receive(database)
    expect(result.idempotent).toBe(true)
    expect(result.quantity).toBe(8880)
    expect(database.rpc).toHaveBeenCalledTimes(1)
    expect(database.rpc.mock.calls[0]?.[1].p_quantity).toBe(8880)
    expect(database.writes).toEqual([])
  })

  it('no altera las cinco recepciones ya guardadas', async () => {
    const kept = OTHER_LINES.map((id) => ({ purchase_document_line_id: id, quantity: 7000 }))
    const database = db()
    await receive(database)
    expect(kept).toEqual(OTHER_LINES.map((id) => ({ purchase_document_line_id: id, quantity: 7000 })))
    expect(database.rpc.mock.calls.map((call) => call[1].p_line_id)).toEqual([LINE])
    expect(database.writes).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  confirmIntentDigest,
  createSupabaseConfirmIntentStore,
  decideConfirmRecovery,
  inspectConfirmRecovery,
  mapConfirmIntentSourceLines,
  persistConfirmIntentForNewDocument,
  shouldOfferCompleteSave,
} from './confirmIntent.js'
import { completeSavedInvoice, confirmPurchaseInvoiceIntake } from './invoiceConfirmIntake.js'

const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LOC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_LOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LINE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const KEY = '11111111-1111-4111-8111-111111111111'
const OTHER_KEY = '22222222-2222-4222-8222-222222222222'
const RKEY = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'

const lines = [{
  purchaseDocumentLineId: LINE,
  action: 'create' as const,
  create: { name: 'Azúcar', baseUnit: 'g' },
  conversionFactor: 1,
  receiveQuantity: 10000,
  receiveIdempotencyKey: RKEY,
}]

function database(options: { succeeded?: boolean; missing?: boolean } = {}) {
  const intents = new Map<string, Record<string, unknown>>()
  const rpc = vi.fn().mockResolvedValue({
    data: {
      purchase_document_id: DOC,
      document_status: 'received',
      idempotent: false,
      unmapped_line_count: 0,
      lines: [],
    },
    error: null,
  })
  const admin = {
    rpc,
    from(table: string) {
      if (table === 'purchase_document_confirm_intents') {
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({
              maybeSingle: async () => {
                if (options.missing) {
                  return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.purchase_document_confirm_intents' in the schema cache" } }
                }
                return { data: intents.get(id) ?? null, error: null }
              },
            }),
          }),
          insert: async (row: Record<string, unknown>) => {
            if (options.missing) {
              return { error: { code: 'PGRST205', message: 'Could not find the table public.purchase_document_confirm_intents in the schema cache' } }
            }
            const id = String(row.purchase_document_id)
            if (intents.has(id)) return { error: { code: '23505', message: 'duplicate' } }
            intents.set(id, row)
            return { error: null }
          },
        }
      }
      if (table === 'purchase_document_confirm_attempts') {
        return {
          select: () => ({
            eq: (column: string, value: string) => ({
              eq: () => ({
                limit: async () => ({
                  data: options.succeeded ? [{ id: 'attempt-1', status: 'succeeded' }] : [],
                  error: null,
                }),
              }),
              maybeSingle: async () => ({
                data: options.succeeded && column === 'confirm_idempotency_key'
                  ? {
                    purchase_document_id: DOC,
                    status: 'succeeded',
                    result: {
                      purchase_document_id: DOC,
                      document_status: 'received',
                      idempotent: false,
                      unmapped_line_count: 0,
                      lines: [],
                    },
                  }
                  : null,
                error: null,
              }),
            }),
          }),
        }
      }
      throw new Error(table)
    },
  }
  const user = {
    from(table: string) {
      if (table === 'purchase_documents') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: DOC,
                    status: 'reviewed',
                    location_id: LOC,
                    organization_id: ORG,
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'purchase_document_lines') {
        return {
          select: () => ({
            eq: async () => ({
              data: [{
                id: LINE,
                inventory_product_id: null,
                mapping_status: 'unmapped',
                inventory_eligibility: 'eligible',
                classification: 'stock',
                quantity_kind: 'inventory',
                reviewed_quantity: 10000,
                original_quantity: 10000,
                reviewed_unit: 'g',
                original_unit: 'g',
                reviewed_amount: 10,
                original_amount: 10,
                inventory_product: null,
              }],
              error: null,
            }),
          }),
        }
      }
      if (table === 'inventory_products') {
        const listed = Promise.resolve({ data: [], error: null })
        return {
          select: () => ({
            eq: () => listed,
          }),
        }
      }
      throw new Error(table)
    },
  }
  return { admin, user, intents, rpc }
}

describe('recuperación de un guardado incompleto', () => {
  it('no ofrece completar si el intento no quedó persistido', () => {
    expect(decideConfirmRecovery({
      documentOrganizationId: ORG,
      documentLocationId: LOC,
      requestedOrganizationId: ORG,
      requestedLocationId: LOC,
      succeeded: false,
      intent: null,
    }).status).toBe('unavailable')
    expect(shouldOfferCompleteSave('unavailable')).toBe(false)
    expect(shouldOfferCompleteSave('completed')).toBe(false)
    expect(shouldOfferCompleteSave('recoverable')).toBe(true)
  })

  it('después de persistir la factura, un fallo de inventario conserva la misma clave', async () => {
    const db = database()
    const store = createSupabaseConfirmIntentStore(db.admin as never)
    db.rpc.mockResolvedValueOnce({ data: null, error: { message: 'STOCK_FAILED' } })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines,
      intentStore: store,
    })).rejects.toThrow(/confirmar la recepción/i)
    expect(db.intents.get(DOC)?.confirm_idempotency_key).toBe(KEY)
    expect(db.rpc).toHaveBeenCalledTimes(1)
    const storedLines = db.intents.get(DOC)?.lines as typeof lines
    expect(storedLines[0]?.receiveIdempotencyKey).toBe(RKEY)

    await expect(confirmPurchaseInvoiceIntake({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{ ...lines[0], receiveIdempotencyKey: OTHER_KEY, receiveQuantity: 1 }],
      intentStore: store,
    })).rejects.toMatchObject({ code: 'CONFIRM_INTENT_CONFLICT' })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect((db.intents.get(DOC)?.lines as typeof lines)[0]?.receiveQuantity).toBe(10000)
    expect(db.intents.size).toBe(1)

    await confirmPurchaseInvoiceIntake({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines,
      intentStore: store,
    })
    expect(db.rpc).toHaveBeenCalledTimes(2)
    expect(db.rpc.mock.calls[1]?.[1]).toMatchObject({
      p: expect.objectContaining({
        confirm_idempotency_key: KEY,
        lines: [expect.objectContaining({ receive_idempotency_key: RKEY, receive_quantity: 10000 })],
      }),
    })

    await expect(confirmPurchaseInvoiceIntake({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: OTHER_KEY,
      lines,
      intentStore: store,
    })).rejects.toMatchObject({ code: 'CONFIRM_INTENT_CONFLICT' })
    expect(db.rpc).toHaveBeenCalledTimes(2)
  })

  it('al recargar recupera la misma operación y no arma otra clave', async () => {
    const db = database()
    db.intents.set(DOC, {
      purchase_document_id: DOC,
      organization_id: ORG,
      location_id: LOC,
      actor_user_id: USER,
      confirm_idempotency_key: KEY,
      lines,
      payload_digest: confirmIntentDigest(lines),
    })
    const recovery = await inspectConfirmRecovery({
      userClient: db.user as never,
      adminClient: db.admin as never,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })
    expect(recovery).toEqual({ status: 'recoverable', confirmIdempotencyKey: KEY })
    db.rpc.mockClear()
    await completeSavedInvoice({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(db.rpc.mock.calls[0]?.[1]).toMatchObject({
      p: expect.objectContaining({
        confirm_idempotency_key: KEY,
        lines: [expect.objectContaining({ receive_idempotency_key: RKEY })],
      }),
    })
  })

  it('si la respuesta se perdió pero el intento ya había salido bien, no vuelve a ejecutar el RPC', async () => {
    const db = database({ succeeded: true })
    db.intents.set(DOC, {
      purchase_document_id: DOC,
      organization_id: ORG,
      location_id: LOC,
      actor_user_id: USER,
      confirm_idempotency_key: KEY,
      lines,
      payload_digest: confirmIntentDigest(lines),
    })
    const recovery = await inspectConfirmRecovery({
      userClient: db.user as never,
      adminClient: db.admin as never,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })
    expect(recovery.status).toBe('completed')
    expect(shouldOfferCompleteSave(recovery.status)).toBe(false)
    const result = await completeSavedInvoice({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })
    expect(result.idempotent).toBe(true)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('rechaza otra sucursal o un usuario que no ve la factura, sin confirmar', async () => {
    const db = database()
    db.intents.set(DOC, {
      purchase_document_id: DOC,
      organization_id: ORG,
      location_id: LOC,
      actor_user_id: USER,
      confirm_idempotency_key: KEY,
      lines,
      payload_digest: confirmIntentDigest(lines),
    })
    await expect(completeSavedInvoice({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: OTHER_LOC,
    })).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    const hidden = {
      from: () => ({
        select: () => ({
          eq: () => ({
            is: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }
    await expect(confirmPurchaseInvoiceIntake({
      userClient: hidden as never,
      adminClient: db.admin as never,
      userId: '55555555-5555-4555-8555-555555555555',
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: OTHER_KEY,
      lines,
      intentStore: createSupabaseConfirmIntentStore(db.admin as never),
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('no confirma automáticamente cuando la tabla de intentos todavía no existe', async () => {
    const db = database({ missing: true })
    const recovery = await inspectConfirmRecovery({
      userClient: db.user as never,
      adminClient: db.admin as never,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })
    expect(recovery.status).toBe('unavailable')
    await expect(completeSavedInvoice({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })).rejects.toMatchObject({ code: 'INTENT_NOT_PERSISTED' })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('si la página se cierra justo después de guardar, el intento ya está y no se rearma', async () => {
    const flags = { succeeded: false }
    const db = database(flags)
    const sourceLineId = 'linea-analisis'
    const mapped = mapConfirmIntentSourceLines(
      [{
        sourceLineId,
        action: 'create',
        create: { name: 'Azúcar', baseUnit: 'g' },
        conversionFactor: 1,
        receiveQuantity: 10000,
        receiveIdempotencyKey: RKEY,
      }],
      [{ id: LINE, sourceLineId }],
    )
    await persistConfirmIntentForNewDocument(db.admin as never, {
      purchaseDocumentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      actorUserId: USER,
      confirmIdempotencyKey: KEY,
      lines: mapped,
    })
    expect(db.rpc).not.toHaveBeenCalled()
    const recovery = await inspectConfirmRecovery({
      userClient: db.user as never,
      adminClient: db.admin as never,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })
    expect(recovery).toEqual({ status: 'recoverable', confirmIdempotencyKey: KEY })
    expect(shouldOfferCompleteSave(recovery.status)).toBe(true)

    db.rpc.mockResolvedValueOnce({ data: null, error: { message: 'STOCK_FAILED' } })
    await expect(completeSavedInvoice({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })).rejects.toThrow(/confirmar la recepción/i)

    await completeSavedInvoice({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })
    expect(db.rpc).toHaveBeenCalledTimes(2)
    expect(db.rpc.mock.calls[1]?.[1]).toMatchObject({
      p: expect.objectContaining({
        confirm_idempotency_key: KEY,
        lines: [expect.objectContaining({
          receive_idempotency_key: RKEY,
          receive_quantity: 10000,
        })],
      }),
    })

    await expect(confirmPurchaseInvoiceIntake({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: '55555555-5555-4555-8555-555555555555',
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: mapped[0].purchaseDocumentLineId,
        action: 'create',
        create: mapped[0].create,
        conversionFactor: mapped[0].conversionFactor,
        receiveQuantity: 1,
        receiveIdempotencyKey: OTHER_KEY,
      }],
      intentStore: createSupabaseConfirmIntentStore(db.admin as never),
    })).rejects.toMatchObject({ code: 'CONFIRM_INTENT_CONFLICT' })
    await expect(persistConfirmIntentForNewDocument(db.admin as never, {
      purchaseDocumentId: DOC,
      organizationId: ORG,
      locationId: OTHER_LOC,
      actorUserId: '55555555-5555-4555-8555-555555555555',
      confirmIdempotencyKey: OTHER_KEY,
      lines: [{ ...mapped[0], receiveQuantity: 1 }],
    })).rejects.toMatchObject({ code: 'CONFIRM_INTENT_CONFLICT' })
    expect(db.intents.get(DOC)?.location_id).toBe(LOC)
    expect(db.intents.get(DOC)?.actor_user_id).toBe(USER)
    expect(db.rpc).toHaveBeenCalledTimes(2)

    flags.succeeded = true
    db.rpc.mockClear()
    const replay = await completeSavedInvoice({
      userClient: db.user as never,
      adminClient: db.admin as never,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
    })
    expect(replay.idempotent).toBe(true)
    expect(db.rpc).not.toHaveBeenCalled()
    expect(shouldOfferCompleteSave('completed')).toBe(false)
  })
})

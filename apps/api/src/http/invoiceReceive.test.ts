import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { receiveInvoiceLine } from './invoiceReceive.js'

const DOC = 'fe8b3702-dea1-4e89-b86c-76ae42d700fc'
const LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_LINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER = 'user-receive-1'
const MOVEMENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function rpcRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    purchase_document_id: DOC,
    purchase_document_line_id: LINE,
    quantity: 40000,
    invoiced_quantity: 100000,
    received_quantity: 40000,
    remaining_quantity: 60000,
    document_status: 'reviewed',
    inventory_movement_id: MOVEMENT,
    idempotent: false,
    ...overrides,
  }
}

function clients(options: {
  invoice?: Record<string, unknown> | null
  line?: Record<string, unknown> | null
  rpcData?: Record<string, unknown> | null
  rpcError?: { code?: string; message?: string; details?: string } | null
}) {
  const from = vi.fn((table: string) => {
    if (table === 'purchase_documents') {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.is = () => chain
      chain.maybeSingle = async () => ({
        data: options.invoice === undefined ? { id: DOC } : options.invoice,
        error: null,
      })
      return chain
    }
    if (table === 'purchase_document_lines') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: options.line === undefined
                ? { id: LINE, purchase_document_id: DOC }
                : options.line,
              error: null,
            }),
          }),
        }),
      }
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'unexpected' } }) }) }),
    }
  })
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: options.rpcError ? null : (options.rpcData ?? rpcRow()),
    error: options.rpcError ?? null,
  }))
  return {
    from,
    rpc,
    user: { from } as unknown as SupabaseClient,
    admin: { rpc } as unknown as SupabaseClient,
  }
}

async function receive(
  db: ReturnType<typeof clients>,
  overrides: Partial<{
    userId: string
    documentId: string
    lineId: string
    quantity: unknown
    idempotencyKey: unknown
  }> = {},
) {
  return receiveInvoiceLine({
    userClient: db.user,
    adminClient: db.admin,
    userId: overrides.userId ?? USER,
    documentId: overrides.documentId ?? DOC,
    lineId: overrides.lineId ?? LINE,
    quantity: 'quantity' in overrides ? overrides.quantity : 40000,
    idempotencyKey: 'idempotencyKey' in overrides ? overrides.idempotencyKey : KEY,
  })
}

describe('receiveInvoiceLine', () => {
  it('recibe cantidad parcial en unidad física y conserva el pendiente', async () => {
    const db = clients({ rpcData: rpcRow() })
    const result = await receive(db)
    expect(result).toEqual({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      purchaseDocumentId: DOC,
      purchaseDocumentLineId: LINE,
      quantity: 40000,
      invoicedQuantity: 100000,
      receivedQuantity: 40000,
      remainingQuantity: 60000,
      documentStatus: 'reviewed',
      inventoryMovementId: MOVEMENT,
      idempotent: false,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_receive_purchase_document_line', {
      p_document_id: DOC,
      p_line_id: LINE,
      p_quantity: 40000,
      p_idempotency_key: KEY,
      p_actor_user_id: USER,
    })
    expect(JSON.stringify(db.rpc.mock.calls[0][1])).not.toMatch(/organizationId|actorUserId|forged/)
  })

  it('refleja received cuando la RPC completa la factura', async () => {
    const db = clients({
      rpcData: rpcRow({
        quantity: 100000,
        received_quantity: 100000,
        remaining_quantity: 0,
        document_status: 'received',
      }),
    })
    const result = await receive(db, { quantity: 100000 })
    expect(result.documentStatus).toBe('received')
    expect(result.remainingQuantity).toBe(0)
    expect(result.receivedQuantity).toBe(100000)
    expect(db.rpc.mock.calls[0][1].p_quantity).toBe(100000)
  })

  it('reintenta con la misma clave sin duplicar', async () => {
    const db = clients({
      rpcData: rpcRow({ idempotent: true }),
    })
    const result = await receive(db)
    expect(result.idempotent).toBe(true)
    expect(result.receivedQuantity).toBe(40000)
    expect(result.remainingQuantity).toBe(60000)
  })

  it('rechaza la misma clave con datos distintos', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'IDEMPOTENCY_CONFLICT' },
    })
    await expect(receive(db, { quantity: 10000 })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    })
  })

  it('rechaza una cantidad superior al pendiente', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'RECEIPT_EXCEEDS_INVOICED' },
    })
    await expect(receive(db, { quantity: 200000 })).rejects.toMatchObject({
      code: 'RECEIPT_EXCEEDS_INVOICED',
      status: 422,
    })
  })

  it('rechaza cantidad cero o negativa sin llamar a la RPC', async () => {
    const db = clients({})
    await expect(receive(db, { quantity: 0 })).rejects.toMatchObject({
      code: 'INVALID_QUANTITY',
      status: 422,
    })
    await expect(receive(db, { quantity: -5 })).rejects.toMatchObject({
      code: 'INVALID_QUANTITY',
      status: 422,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('no usa actor u organización del cliente', async () => {
    const db = clients({})
    await receive(db, { userId: USER })
    expect(db.rpc.mock.calls[0][1].p_actor_user_id).toBe(USER)
    expect(db.rpc.mock.calls[0][1].p_actor_user_id).not.toBe('user-forjado')
  })

  it('oculta una factura inaccesible por RLS y no llama a la RPC', async () => {
    const db = clients({ invoice: null })
    await expect(receive(db)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('rechaza una línea que no pertenece a la factura', async () => {
    const db = clients({
      line: { id: OTHER_LINE, purchase_document_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    })
    await expect(receive(db, { lineId: OTHER_LINE })).rejects.toMatchObject({
      code: 'LINE_NOT_FOUND',
      status: 404,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('explica el stock sin costo y no recibe', async () => {
    const db = clients({
      rpcError: {
        code: 'P0001',
        message: 'UNVALUED_STOCK: hay stock sin costo promedio. No se puede recibir esta compra hasta resolver el costo inicial. No se modificó el inventario.',
      },
    })
    await expect(receive(db)).rejects.toMatchObject({
      code: 'UNVALUED_STOCK',
      status: 422,
      message: expect.stringMatching(/costo inicial/),
    })
  })

  it('propaga NOT_A_MEMBER de la RPC como 403', async () => {
    const db = clients({ rpcError: { message: 'NOT_A_MEMBER' } })
    await expect(receive(db)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('exige clave de idempotencia UUID y no genera otra', async () => {
    const db = clients({})
    await expect(receive(db, { idempotencyKey: null })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      status: 400,
    })
    await expect(receive(db, { idempotencyKey: 'no-es-uuid' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      status: 400,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('no expone detalles internos si la RPC falla de forma inesperada', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'LOCATION_INVENTORY_MISSING', details: 'service_role leaked' },
    })
    await expect(receive(db)).rejects.toMatchObject({
      code: 'RECEIVE_FAILED',
      status: 500,
      message: 'No se pudo registrar la recepción.',
    })
  })

  it('bloquea la recepción del detalle si la línea sigue en revisión comercial', async () => {
    const source = 'line-17udio7-1'
    const db = clients({
      invoice: {
        id: DOC,
        original_analysis: {
          interpretation: { lines: [{ lineId: source, status: 'requires_review' }] },
        },
        reviewed_analysis: {
          interpretation: { lines: [{ lineId: source, status: 'requires_review' }] },
        },
      },
      line: { id: LINE, purchase_document_id: DOC, source_line_id: source },
    })
    await expect(receive(db)).rejects.toMatchObject({
      code: 'COMMERCIAL_REVIEW_REQUIRED',
      status: 422,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('permite recibir una línea cuya revisión comercial ya está confirmada', async () => {
    const source = 'line-sob5kx-1'
    const db = clients({
      invoice: {
        id: DOC,
        reviewed_analysis: {
          interpretation: { lines: [{ lineId: source, status: 'confirmed' }] },
        },
      },
      line: { id: LINE, purchase_document_id: DOC, source_line_id: source },
    })
    await receive(db)
    expect(db.rpc).toHaveBeenCalledTimes(1)
  })
})

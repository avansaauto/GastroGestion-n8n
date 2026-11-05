import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { deletePurchaseInvoice, isDeletePurchaseInvoiceRpcMissing } from './invoiceDelete.js'

const DOC = 'fe8b3702-dea1-4e89-b86c-76ae42d700fc'
const USER = 'user-delete-1'

function clients(options: {
  invoice?: Record<string, unknown> | null
  lookupError?: { code?: string; message?: string } | null
  rpcError?: { code?: string; message?: string; details?: string; hint?: string } | null
  rpcData?: Record<string, unknown> | null
} = {}) {
  const from = vi.fn((table: string) => {
    if (table === 'purchase_documents') {
      const result = {
        data: options.lookupError
          ? null
          : options.invoice === undefined
            ? { id: DOC, status: 'reviewed' }
            : options.invoice,
        error: options.lookupError ?? null,
      }
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.is = () => chain
      chain.maybeSingle = async () => result
      return chain
    }
    return {
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'unexpected' } }) }),
      }),
    }
  })
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: options.rpcData ?? {
      id: DOC,
      deleted_at: '2026-10-18T00:00:00Z',
      replay: false,
    },
    error: options.rpcError ?? null,
  }))
  return {
    from,
    rpc,
    user: { from } as unknown as SupabaseClient,
    admin: { rpc } as unknown as SupabaseClient,
  }
}

async function del(db: ReturnType<typeof clients>, overrides: { userId?: string; documentId?: string } = {}) {
  return deletePurchaseInvoice({
    userClient: db.user,
    adminClient: db.admin,
    userId: overrides.userId ?? USER,
    documentId: overrides.documentId ?? DOC,
  })
}

describe('deletePurchaseInvoice', () => {
  it('llama exactamente senda_delete_purchase_invoice(jsonb) con actor y document id', async () => {
    const db = clients()
    await expect(del(db)).resolves.toEqual({ id: DOC, deleted: true })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(db.rpc).toHaveBeenCalledWith('senda_delete_purchase_invoice', {
      p: {
        actor_user_id: USER,
        purchase_document_id: DOC,
      },
    })
  })

  it('permite eliminar facturas recibidas', async () => {
    const db = clients({ invoice: { id: DOC, status: 'received' } })
    await expect(del(db)).resolves.toEqual({ id: DOC, deleted: true })
  })

  it('mapea stock insuficiente con producto y cantidades', async () => {
    const db = clients({
      rpcError: {
        code: 'P0001',
        message: 'REVERSAL_INSUFFICIENT_STOCK:Lúpulo:12.5:3',
      },
    })
    await expect(del(db)).rejects.toMatchObject({
      code: 'REVERSAL_INSUFFICIENT_STOCK',
      status: 422,
      message: expect.stringMatching(/Lúpulo.*12\.5.*3/),
    })
  })

  it('mapea ADJUSTMENT_EXCEEDS_ON_HAND como stock insuficiente', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'ADJUSTMENT_EXCEEDS_ON_HAND' },
    })
    await expect(del(db)).rejects.toMatchObject({
      code: 'REVERSAL_INSUFFICIENT_STOCK',
      status: 422,
    })
  })

  it('mapea una anulación bloqueada por consumos sin borrar el documento', async () => {
    const db = clients({
      rpcError: {
        code: 'P0001',
        message: 'REVERSAL_DEPENDENT_MOVEMENTS: un consumo posterior depende de esta compra. No se puede anular automáticamente.',
      },
    })
    await expect(del(db)).rejects.toMatchObject({
      code: 'REVERSAL_DEPENDENT_MOVEMENTS',
      status: 422,
      message: expect.stringMatching(/No se eliminó el documento/),
    })
  })

  it('mapea libro desincronizado, historial incompleto, valor excedido y recepción ausente', async () => {
    const cases = [
      ['REVERSAL_LEDGER_MISMATCH: el stock valuado no coincide', 'REVERSAL_LEDGER_MISMATCH'],
      ['REVERSAL_COST_HISTORY_INCOMPLETE: el historial de esta compra no alcanza', 'REVERSAL_COST_HISTORY_INCOMPLETE'],
      ['REVERSAL_COST_EXCEEDS_VALUE: el importe de la compra supera el valor', 'REVERSAL_COST_EXCEEDS_VALUE'],
      ['REVERSAL_PURCHASE_MOVEMENT_MISSING: no está el movimiento', 'REVERSAL_PURCHASE_MOVEMENT_MISSING'],
    ] as const
    for (const [message, code] of cases) {
      const db = clients({ rpcError: { code: 'P0001', message } })
      await expect(del(db)).rejects.toMatchObject({
        code,
        status: 422,
        message: expect.stringMatching(/No se eliminó el documento/),
      })
    }
  })

  it('mapea REVERSAL_ABORTED cuando falla la reversión con inventario existente', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'REVERSAL_ABORTED:NOT_A_MEMBER' },
    })
    await expect(del(db)).rejects.toMatchObject({
      code: 'REVERSAL_ABORTED',
      status: 422,
      message: expect.stringMatching(/No se eliminó el documento/i),
    })
  })

  it('mapea REVERSAL_INVENTORY_REF_MISMATCH sin eliminar el documento', async () => {
    const db = clients({
      rpcError: {
        code: 'P0001',
        message: 'REVERSAL_INVENTORY_REF_MISMATCH:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:ffffffff-0000-4000-8000-111111111111',
      },
    })
    await expect(del(db)).rejects.toMatchObject({
      code: 'REVERSAL_INVENTORY_REF_MISMATCH',
      status: 422,
      message: expect.stringMatching(/inventario inconsistente/i),
    })
  })

  it('mapea NOT_A_MEMBER como FORBIDDEN', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'NOT_A_MEMBER' },
    })
    await expect(del(db)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('mapea RPC ausente (PGRST202) como DELETE_RPC_PENDING', async () => {
    const db = clients({
      rpcError: {
        code: 'PGRST202',
        message: 'Could not find the function public.senda_delete_purchase_invoice',
      },
    })
    await expect(del(db)).rejects.toMatchObject({
      code: 'DELETE_RPC_PENDING',
      status: 503,
    })
  })

  it('no expone detalles internos en errores de base de datos', async () => {
    const db = clients({
      rpcError: {
        code: 'XX000',
        message: 'permission denied for table inventory_valuations',
        details: 'internal stack',
      },
    })
    await expect(del(db)).rejects.toMatchObject({
      code: 'DELETE_FAILED',
      status: 500,
      message: 'No se pudo eliminar la factura por un error de base de datos.',
    })
  })

  it('trata documento ya eliminado como NOT_FOUND', async () => {
    const db = clients({ invoice: null })
    await expect(del(db)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(db.rpc).not.toHaveBeenCalled()
  })
})

describe('isDeletePurchaseInvoiceRpcMissing', () => {
  it('detecta PGRST202 y 42883', () => {
    expect(isDeletePurchaseInvoiceRpcMissing({
      code: 'PGRST202',
      message: 'Could not find the function senda_delete_purchase_invoice',
    })).toBe(true)
    expect(isDeletePurchaseInvoiceRpcMissing({
      code: '42883',
      message: 'function senda_delete_purchase_invoice(jsonb) does not exist',
    })).toBe(true)
    expect(isDeletePurchaseInvoiceRpcMissing({
      code: 'P0001',
      message: 'NOT_A_MEMBER',
    })).toBe(false)
  })
})

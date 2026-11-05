import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { cancelPurchaseInvoice } from './invoiceCancel.js'

const DOC = 'fe8b3702-dea1-4e89-b86c-76ae42d700fc'
const USER = 'user-cancel-1'

function clients(options: {
  invoice?: Record<string, unknown> | null
  rpcError?: { code?: string; message?: string; details?: string } | null
} = {}) {
  const from = vi.fn((table: string) => {
    if (table === 'purchase_documents') {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.is = () => chain
      chain.maybeSingle = async () => ({
        data: options.invoice === undefined
          ? { id: DOC, status: 'reviewed' }
          : options.invoice,
        error: null,
      })
      return chain
    }
    return {
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'unexpected' } }) }),
      }),
    }
  })
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: null,
    error: options.rpcError ?? null,
  }))
  return {
    from,
    rpc,
    user: { from } as unknown as SupabaseClient,
    admin: { rpc } as unknown as SupabaseClient,
  }
}

async function cancel(db: ReturnType<typeof clients>, overrides: { userId?: string; documentId?: string } = {}) {
  return cancelPurchaseInvoice({
    userClient: db.user,
    adminClient: db.admin,
    userId: overrides.userId ?? USER,
    documentId: overrides.documentId ?? DOC,
  })
}

describe('cancelPurchaseInvoice', () => {
  it('anula una factura revisada sin recepción y no copia actor del cliente', async () => {
    const db = clients()
    await expect(cancel(db)).resolves.toEqual({
      id: DOC,
      status: 'cancelled',
      replay: false,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_cancel_purchase_invoice', {
      p_id: DOC,
      p_actor_user_id: USER,
    })
    expect(JSON.stringify(db.rpc.mock.calls[0][1])).not.toMatch(/organizationId|actorUserId|forged/)
  })

  it('reintenta una factura ya anulada sin volver a llamar la RPC', async () => {
    const db = clients({ invoice: { id: DOC, status: 'cancelled' } })
    await expect(cancel(db)).resolves.toEqual({
      id: DOC,
      status: 'cancelled',
      replay: true,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('bloquea una factura recibida y no llama la RPC', async () => {
    const db = clients({ invoice: { id: DOC, status: 'received' } })
    await expect(cancel(db)).rejects.toMatchObject({
      code: 'INVOICE_RECEIVED_REVERSAL_UNAVAILABLE',
      status: 422,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('bloquea una factura con recepciones', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'CANCEL_HAS_RECEIPTS' },
    })
    await expect(cancel(db)).rejects.toMatchObject({
      code: 'CANCEL_HAS_RECEIPTS',
      status: 422,
    })
  })

  it('bloquea un borrador sin llamar a anular como si fuera éxito', async () => {
    const db = clients({ invoice: { id: DOC, status: 'draft' } })
    await expect(cancel(db)).rejects.toMatchObject({
      code: 'CANCEL_REQUIRES_REVIEWED',
      status: 422,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('oculta una factura inaccesible por RLS y no llama a la RPC', async () => {
    const db = clients({ invoice: null })
    await expect(cancel(db)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('rechaza un actor sin membresía', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'NOT_A_MEMBER' },
    })
    await expect(cancel(db)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    })
  })
})

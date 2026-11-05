import type { SupabaseClient } from '@supabase/supabase-js'
import { InvoiceQueryError } from './invoiceQueryError.js'
import { assertInvoiceDocumentId } from './invoiceQuery.js'

export type InvoiceCancelResult = {
  id: string
  status: 'cancelled'
  replay: boolean
}

export type CancelPurchaseInvoiceInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  documentId: string
}

export type InvoiceCancelPort = {
  cancelPurchaseInvoice(input: CancelPurchaseInvoiceInput): Promise<InvoiceCancelResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

async function loadVisibleInvoice(
  userClient: SupabaseClient,
  documentId: string,
): Promise<{ id: string; status: string }> {
  const { data, error } = await userClient
    .from('purchase_documents')
    .select('id, status')
    .eq('id', documentId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) {
    throw new InvoiceQueryError('No se pudieron consultar las facturas.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || !data.id) {
    throw new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)
  }
  return {
    id: String(data.id),
    status: asString(data.status) ?? 'reviewed',
  }
}

function mapRpcError(error: { code?: string; message?: string; details?: string } | null): never {
  const blob = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
  if (/NOT_A_MEMBER/i.test(blob)) {
    throw new InvoiceQueryError(
      'No tenés autorización para anular esta factura.',
      'FORBIDDEN',
      403,
    )
  }
  if (/DOCUMENT_NOT_FOUND/i.test(blob)) {
    throw new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)
  }
  if (/CANCEL_HAS_RECEIPTS/i.test(blob)) {
    throw new InvoiceQueryError(
      'Esta factura ya tiene recepciones de stock. Anularla dejaría movimientos de inventario sin compensar. No se anula ni se borra.',
      'CANCEL_HAS_RECEIPTS',
      422,
    )
  }
  if (/CANCEL_REQUIRES_REVIEWED|STATUS_TRANSITION_FORBIDDEN|CANCELLED_TERMINAL/i.test(blob)) {
    throw new InvoiceQueryError(
      'Solo se pueden anular facturas revisadas que todavía no recibieron mercadería.',
      'CANCEL_REQUIRES_REVIEWED',
      422,
    )
  }
  console.error(JSON.stringify({
    operation: 'senda_cancel_purchase_invoice',
    code: error?.code ?? 'UNHANDLED',
    message: error?.message ?? null,
    details: error?.details ?? null,
  }))
  throw new InvoiceQueryError('No se pudo anular la factura.', 'CANCEL_FAILED', 500)
}

export async function cancelPurchaseInvoice(
  input: CancelPurchaseInvoiceInput,
): Promise<InvoiceCancelResult> {
  if (!input.userId) {
    throw new InvoiceQueryError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  const documentId = assertInvoiceDocumentId(input.documentId)
  const visible = await loadVisibleInvoice(input.userClient, documentId)

  if (visible.status === 'cancelled') {
    return { id: documentId, status: 'cancelled', replay: true }
  }
  if (visible.status === 'received') {
    throw new InvoiceQueryError(
      'Esta factura ya fue recibida. Anularla requeriría revertir stock y costos; esa operación todavía no está habilitada. No se oculta ni se borra.',
      'INVOICE_RECEIVED_REVERSAL_UNAVAILABLE',
      422,
    )
  }
  if (visible.status !== 'reviewed') {
    throw new InvoiceQueryError(
      'Solo se pueden anular facturas revisadas que todavía no recibieron mercadería.',
      'CANCEL_REQUIRES_REVIEWED',
      422,
    )
  }

  const { error } = await input.adminClient.rpc('senda_cancel_purchase_invoice', {
    p_id: documentId,
    p_actor_user_id: input.userId,
  })
  if (error) mapRpcError(error)
  return { id: documentId, status: 'cancelled', replay: false }
}

export const invoiceCancel: InvoiceCancelPort = {
  cancelPurchaseInvoice,
}

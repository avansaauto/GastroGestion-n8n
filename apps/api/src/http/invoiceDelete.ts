import type { SupabaseClient } from '@supabase/supabase-js'
import { InvoiceQueryError } from './invoiceQueryError.js'
import {
  assertInvoiceDocumentId,
  isPurchaseDocumentsDeletedAtMissing,
} from './invoiceQuery.js'

export type InvoiceDeleteResult = {
  id: string
  deleted: true
}

export type DeletePurchaseInvoiceInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  documentId: string
}

export type InvoiceDeletePort = {
  deletePurchaseInvoice(input: DeletePurchaseInvoiceInput): Promise<InvoiceDeleteResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function rpcBlob(error: { code?: string; message?: string; details?: string; hint?: string } | null): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''}`
}

export function isDeletePurchaseInvoiceRpcMissing(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
): boolean {
  const blob = rpcBlob(error)
  if (/\bPGRST202\b/i.test(blob)) return true
  if (/\b42883\b/.test(blob) && /senda_delete_purchase_invoice/i.test(blob)) return true
  return /could not find the function/i.test(blob) && /senda_delete_purchase_invoice/i.test(blob)
}

async function loadVisibleInvoice(
  userClient: SupabaseClient,
  documentId: string,
): Promise<{ id: string; status: string }> {
  let { data, error } = await userClient
    .from('purchase_documents')
    .select('id, status')
    .eq('id', documentId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error && isPurchaseDocumentsDeletedAtMissing(error)) {
    // Esquema pre-migración: deleted_at no existe; reintentar sin filtro.
    console.error(JSON.stringify({
      operation: 'deletePurchaseInvoice.loadVisible.deleted_at_missing',
      code: error.code ?? null,
      message: error.message ?? null,
    }))
    ;({ data, error } = await userClient
      .from('purchase_documents')
      .select('id, status')
      .eq('id', documentId)
      .maybeSingle())
  }
  if (error) {
    console.error(JSON.stringify({
      operation: 'deletePurchaseInvoice.loadVisible',
      code: error.code ?? null,
      message: error.message ?? null,
      details: error.details ?? null,
    }))
    throw new InvoiceQueryError('No se pudieron consultar las facturas.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || !data.id) {
    throw new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)
  }

  return {
    id: String(data.id),
    status: asString(data.status) ?? '',
  }
}

function mapRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
): never {
  const blob = rpcBlob(error)

  if (isDeletePurchaseInvoiceRpcMissing(error)) {
    throw new InvoiceQueryError(
      'La eliminación de facturas todavía no está habilitada en la base de datos.',
      'DELETE_RPC_PENDING',
      503,
    )
  }

  if (/REVERSAL_INVENTORY_REF_MISMATCH/i.test(blob)) {
    throw new InvoiceQueryError(
      'La recepción apunta a un inventario inconsistente. No se eliminó el documento.',
      'REVERSAL_INVENTORY_REF_MISMATCH',
      422,
    )
  }

  if (/REVERSAL_DEPENDENT_MOVEMENTS/i.test(blob)) {
    throw new InvoiceQueryError(
      'Hay ajustes, mermas o consumos posteriores a esta recepción. No se eliminó el documento.',
      'REVERSAL_DEPENDENT_MOVEMENTS',
      422,
    )
  }

  if (/REVERSAL_LEDGER_MISMATCH/i.test(blob)) {
    throw new InvoiceQueryError(
      'El stock no coincide con el libro de movimientos. No se eliminó el documento.',
      'REVERSAL_LEDGER_MISMATCH',
      422,
    )
  }

  if (/REVERSAL_COST_HISTORY_INCOMPLETE/i.test(blob)) {
    throw new InvoiceQueryError(
      'El historial de esta compra no alcanza para revertir el promedio. No se eliminó el documento.',
      'REVERSAL_COST_HISTORY_INCOMPLETE',
      422,
    )
  }

  if (/REVERSAL_COST_EXCEEDS_VALUE/i.test(blob)) {
    throw new InvoiceQueryError(
      'El importe de la compra supera el valor del stock. No se eliminó el documento.',
      'REVERSAL_COST_EXCEEDS_VALUE',
      422,
    )
  }

  if (/REVERSAL_PURCHASE_MOVEMENT_MISSING/i.test(blob)) {
    throw new InvoiceQueryError(
      'No está el movimiento de la recepción. No se eliminó el documento.',
      'REVERSAL_PURCHASE_MOVEMENT_MISSING',
      422,
    )
  }

  if (/REVERSAL_ABORTED|REVERSAL_VALUATION_MISSING/i.test(blob)) {
    throw new InvoiceQueryError(
      'No se pudo revertir el stock de esta factura. No se eliminó el documento.',
      'REVERSAL_ABORTED',
      422,
    )
  }

  if (/NOT_A_MEMBER|DELETE_REQUIRES_SERVICE_ROLE/i.test(blob)) {
    throw new InvoiceQueryError(
      'No tenés autorización para eliminar esta factura.',
      'FORBIDDEN',
      403,
    )
  }

  if (/DOCUMENT_NOT_FOUND|DOCUMENT_ALREADY_DELETED/i.test(blob)) {
    throw new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)
  }

  const insufficient = blob.match(
    /REVERSAL_INSUFFICIENT_STOCK:([^:]+):([^:]+):([^\s]+)/i,
  )
  if (insufficient) {
    const product = insufficient[1]?.trim() || 'Producto'
    const needed = insufficient[2]?.trim() || '?'
    const available = insufficient[3]?.trim() || '?'
    throw new InvoiceQueryError(
      `No hay stock suficiente para revertir «${product}»: hacen falta ${needed} y hay ${available}.`,
      'REVERSAL_INSUFFICIENT_STOCK',
      422,
    )
  }
  if (/REVERSAL_INSUFFICIENT_STOCK|ADJUSTMENT_EXCEEDS_ON_HAND/i.test(blob)) {
    throw new InvoiceQueryError(
      'No hay stock suficiente para revertir los ingresos de esta factura.',
      'REVERSAL_INSUFFICIENT_STOCK',
      422,
    )
  }

  if (/INVALID_PAYLOAD/i.test(blob)) {
    throw new InvoiceQueryError('El identificador de la factura no es válido.', 'INVALID_PAYLOAD', 400)
  }

  console.error(JSON.stringify({
    operation: 'senda_delete_purchase_invoice',
    code: error?.code ?? 'UNHANDLED',
    message: error?.message ?? null,
    details: error?.details ?? null,
  }))
  throw new InvoiceQueryError(
    'No se pudo eliminar la factura por un error de base de datos.',
    'DELETE_FAILED',
    500,
  )
}

export async function deletePurchaseInvoice(
  input: DeletePurchaseInvoiceInput,
): Promise<InvoiceDeleteResult> {
  if (!input.userId) {
    throw new InvoiceQueryError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  const documentId = assertInvoiceDocumentId(input.documentId)
  await loadVisibleInvoice(input.userClient, documentId)

  const { error } = await input.adminClient.rpc('senda_delete_purchase_invoice', {
    p: {
      actor_user_id: input.userId,
      purchase_document_id: documentId,
    },
  })
  if (error) mapRpcError(error)

  // Eliminación lógica: conserva storage_object_path y el archivo para auditoría.
  return { id: documentId, deleted: true }
}

export const invoiceDelete: InvoiceDeletePort = {
  deletePurchaseInvoice,
}

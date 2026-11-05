import type { InvoiceListItem } from './types'

export const INVOICE_SELECT_ALL_VISIBLE_HINT =
  'Seleccionar todos marca solo las facturas visibles de esta página, no todos los resultados filtrados.'

export const INVOICE_BULK_DELETE_LABEL = 'Eliminar seleccionados'

export const INVOICE_RECEIVED_BLOCK =
  'Esta factura ya fue recibida. Anularla requeriría revertir stock y costos; esa operación todavía no está habilitada. No se oculta ni se borra.'

export const INVOICE_HAS_RECEIPTS_BLOCK =
  'Esta factura ya tiene recepciones de stock. Anularla dejaría movimientos de inventario sin compensar. No se anula ni se borra.'

export const INVOICE_STATUS_BLOCK =
  'Solo se pueden anular facturas revisadas que todavía no recibieron mercadería.'

export function invoiceHasReceipts(item: Pick<InvoiceListItem, 'hasReceipts'>) {
  return item.hasReceipts === true
}

export function invoiceCanCancel(item: Pick<InvoiceListItem, 'status' | 'hasReceipts'>) {
  return item.status === 'reviewed' && !invoiceHasReceipts(item)
}

export function invoiceCancelBlockReason(
  item: Pick<InvoiceListItem, 'status' | 'hasReceipts'>,
): string | null {
  if (invoiceCanCancel(item)) return null
  if (item.status === 'received') return INVOICE_RECEIVED_BLOCK
  if (invoiceHasReceipts(item)) return INVOICE_HAS_RECEIPTS_BLOCK
  if (item.status === 'cancelled') return 'Esta factura ya está anulada.'
  return INVOICE_STATUS_BLOCK
}

export function invoiceCancelSelectionLabel(count: number) {
  return count === 1
    ? '1 factura visible seleccionada'
    : `${count} facturas visibles seleccionadas`
}

export function toggleInvoiceSelection(selected: string[], invoiceId: string) {
  return selected.includes(invoiceId)
    ? selected.filter((id) => id !== invoiceId)
    : [...selected, invoiceId]
}

export function selectVisibleInvoices(visibleIds: string[], checked: boolean) {
  return checked ? [...visibleIds] : []
}

export function pruneInvoiceSelection(selected: string[], visibleIds: string[]) {
  const allowed = new Set(visibleIds)
  const next = selected.filter((id) => allowed.has(id))
  if (next.length === selected.length && next.every((id, index) => id === selected[index])) {
    return selected
  }
  return next
}

export function visibleInvoiceSelectionState(selected: string[], visibleIds: string[]) {
  if (visibleIds.length === 0 || selected.length === 0) return 'none' as const
  const selectedSet = new Set(selected)
  const selectedVisible = visibleIds.filter((id) => selectedSet.has(id)).length
  if (selectedVisible === 0) return 'none' as const
  if (selectedVisible === visibleIds.length) return 'all' as const
  return 'some' as const
}

export type InvoiceCancelClassification = {
  id: string
  label: string
  canCancel: boolean
  reason: string | null
}

export function classifyInvoiceForCancel(item: InvoiceListItem): InvoiceCancelClassification {
  const label = item.supplierName || item.documentNumber || item.id
  const reason = invoiceCancelBlockReason(item)
  return {
    id: item.id,
    label,
    canCancel: reason == null,
    reason,
  }
}

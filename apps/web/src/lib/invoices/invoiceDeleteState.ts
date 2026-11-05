import type { InvoiceListItem } from './types'

export const INVOICE_SELECT_ALL_VISIBLE_HINT =
  'Seleccionar todos marca solo las facturas visibles de esta página, no todos los resultados filtrados.'

export const INVOICE_BULK_DELETE_LABEL = 'Eliminar seleccionados'

export const INVOICE_DELETE_CONFIRM =
  '¿Eliminar esta factura?\n\nSe eliminará del listado y se revertirá el stock ingresado por ella. Esta acción no se puede deshacer.'

export const INVOICE_DELETE_CONFIRM_MANY = (count: number) => (
  count === 1
    ? INVOICE_DELETE_CONFIRM
    : `¿Eliminar ${count} facturas?\n\nSe eliminarán del listado y se revertirá el stock ingresado por cada una. Esta acción no se puede deshacer.`
)

export function invoiceCanDelete(item: Pick<InvoiceListItem, 'status' | 'hasReceipts'>) {
  void item.hasReceipts
  return (
    item.status === 'reviewed'
    || item.status === 'cancelled'
    || item.status === 'draft'
    || item.status === 'received'
  )
}

export function invoiceDeleteBlockReason(
  item: Pick<InvoiceListItem, 'status' | 'hasReceipts'>,
): string | null {
  if (invoiceCanDelete(item)) return null
  return 'Solo se pueden eliminar facturas del listado operativo.'
}

export function invoiceDeleteSelectionLabel(count: number) {
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

export type InvoiceDeleteClassification = {
  id: string
  label: string
  canDelete: boolean
  reason: string | null
}

export function classifyInvoiceForDelete(item: InvoiceListItem): InvoiceDeleteClassification {
  const label = item.supplierName || item.documentNumber || item.id
  const reason = invoiceDeleteBlockReason(item)
  return {
    id: item.id,
    label,
    canDelete: reason == null,
    reason,
  }
}

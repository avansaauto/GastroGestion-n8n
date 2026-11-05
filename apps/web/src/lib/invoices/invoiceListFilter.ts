import type { InvoiceListItem } from './types'

export type InvoiceListFilter = 'all' | 'to_map' | 'to_receive' | 'received'

export const INVOICE_LIST_FILTERS: Array<{ id: InvoiceListFilter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'to_map', label: 'Por vincular' },
  { id: 'to_receive', label: 'Por recibir' },
  { id: 'received', label: 'Recibidas' },
]

export function invoiceMatchesSearch(item: InvoiceListItem, search: string): boolean {
  const term = search.trim().toLocaleLowerCase('es')
  if (!term) return true
  return [item.supplierName, item.documentNumber, item.documentType]
    .some((value) => (value ?? '').toLocaleLowerCase('es').includes(term))
}

export function invoiceMatchesFilter(item: InvoiceListItem, filter: InvoiceListFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'to_map') return item.pendingConfiguration === true
  if (filter === 'to_receive') return item.pendingReceive === true
  return item.status === 'received'
}

export function invoiceListCounts(items: InvoiceListItem[]) {
  return {
    all: items.length,
    to_map: items.filter((item) => item.pendingConfiguration).length,
    to_receive: items.filter((item) => item.pendingReceive).length,
    received: items.filter((item) => item.status === 'received').length,
  }
}

export function invoicesListPath(locationId: string) {
  return `/api/invoices?${new URLSearchParams({ locationId }).toString()}`
}

export function invoicesForScope(
  loadedLocationId: string,
  locationId: string,
  invoices: InvoiceListItem[],
) {
  return loadedLocationId === locationId ? invoices : []
}

export function visibleInvoiceList(
  items: InvoiceListItem[],
  search: string,
  filter: InvoiceListFilter,
) {
  const searched = items.filter((item) => invoiceMatchesSearch(item, search))
  return {
    counts: invoiceListCounts(searched),
    rows: searched.filter((item) => invoiceMatchesFilter(item, filter)),
  }
}

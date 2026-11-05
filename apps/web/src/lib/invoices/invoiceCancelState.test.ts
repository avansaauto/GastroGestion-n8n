import { describe, expect, it } from 'vitest'
import type { InvoiceListItem } from './types'
import {
  INVOICE_HAS_RECEIPTS_BLOCK,
  INVOICE_RECEIVED_BLOCK,
  classifyInvoiceForCancel,
  invoiceCanCancel,
  invoiceCancelBlockReason,
  pruneInvoiceSelection,
  selectVisibleInvoices,
  toggleInvoiceSelection,
  visibleInvoiceSelectionState,
} from './invoiceCancelState'

function item(overrides: Partial<InvoiceListItem> = {}): InvoiceListItem {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    supplierName: 'LUPULO SRL',
    documentDate: '2026-10-01',
    documentNumber: '0001-00006046',
    documentType: 'invoice',
    status: 'reviewed',
    currency: 'ARS',
    total: 1500,
    locationId: 'loc-1',
    organizationId: 'org-1',
    pendingConfiguration: false,
    pendingReceive: true,
    hasReceipts: false,
    ...overrides,
  }
}

describe('invoiceCancelState', () => {
  it('permite anular solo revisadas sin recepciones', () => {
    expect(invoiceCanCancel(item())).toBe(true)
    expect(invoiceCancelBlockReason(item())).toBeNull()
    expect(invoiceCanCancel(item({ hasReceipts: true }))).toBe(false)
    expect(invoiceCancelBlockReason(item({ hasReceipts: true }))).toBe(INVOICE_HAS_RECEIPTS_BLOCK)
    expect(invoiceCanCancel(item({ status: 'received', pendingReceive: false, hasReceipts: true }))).toBe(false)
    expect(invoiceCancelBlockReason(item({
      status: 'received',
      pendingReceive: false,
      hasReceipts: true,
    }))).toBe(INVOICE_RECEIVED_BLOCK)
  })

  it('selecciona solo los ids visibles y recorta al filtrar', () => {
    const ids = ['a', 'b', 'c']
    expect(toggleInvoiceSelection([], 'a')).toEqual(['a'])
    expect(toggleInvoiceSelection(['a'], 'a')).toEqual([])
    expect(selectVisibleInvoices(ids, true)).toEqual(ids)
    expect(selectVisibleInvoices(ids, false)).toEqual([])
    expect(visibleInvoiceSelectionState(['a', 'b'], ids)).toBe('some')
    expect(visibleInvoiceSelectionState(ids, ids)).toBe('all')
    expect(pruneInvoiceSelection(['a', 'c', 'z'], ['a', 'b'])).toEqual(['a'])
  })

  it('clasifica elegibles y bloqueadas sin fingir éxito', () => {
    const eligible = classifyInvoiceForCancel(item())
    const received = classifyInvoiceForCancel(item({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'received',
      pendingReceive: false,
      hasReceipts: true,
    }))
    expect(eligible.canCancel).toBe(true)
    expect(received.canCancel).toBe(false)
    expect(received.reason).toBe(INVOICE_RECEIVED_BLOCK)
  })
})

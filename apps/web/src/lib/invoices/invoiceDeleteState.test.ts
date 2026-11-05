import { describe, expect, it } from 'vitest'
import type { InvoiceListItem } from './types'
import {
  INVOICE_DELETE_CONFIRM,
  classifyInvoiceForDelete,
  invoiceCanDelete,
  invoiceDeleteBlockReason,
} from './invoiceDeleteState'

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

describe('invoiceDeleteState', () => {
  it('permite eliminar revisadas, anuladas, borradores y recibidas', () => {
    expect(invoiceCanDelete(item())).toBe(true)
    expect(invoiceCanDelete(item({ status: 'cancelled' }))).toBe(true)
    expect(invoiceCanDelete(item({ status: 'draft' }))).toBe(true)
    expect(invoiceCanDelete(item({
      status: 'received',
      pendingReceive: false,
      hasReceipts: true,
    }))).toBe(true)
    expect(invoiceDeleteBlockReason(item({ hasReceipts: true }))).toBeNull()
    expect(INVOICE_DELETE_CONFIRM).toMatch(/revertirá el stock/)
  })

  it('clasifica elegibles incluyendo recibidas con stock', () => {
    const eligible = classifyInvoiceForDelete(item())
    const received = classifyInvoiceForDelete(item({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'received',
      pendingReceive: false,
      hasReceipts: true,
    }))
    expect(eligible.canDelete).toBe(true)
    expect(received.canDelete).toBe(true)
    expect(received.reason).toBeNull()
  })
})

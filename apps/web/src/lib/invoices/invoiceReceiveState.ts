import type { InvoiceDetail, InvoiceReceiveResult } from './types'

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  reviewed: 'Revisada',
  received: 'Recibida',
  draft: 'Borrador',
  cancelled: 'Anulada',
}

export function invoiceStatusTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'received') return 'success'
  if (status === 'reviewed' || status === 'draft') return 'warning'
  return 'neutral'
}

export function applyInvoiceReceiveResult(
  detail: InvoiceDetail,
  result: InvoiceReceiveResult,
): InvoiceDetail {
  return {
    ...detail,
    status: result.documentStatus || detail.status,
    lines: detail.lines.map((line) => (
      line.id === result.purchaseDocumentLineId
        ? {
          ...line,
          receivedQuantity: result.receivedQuantity,
          remainingQuantity: result.remainingQuantity,
          invoicedQuantity: result.invoicedQuantity,
        }
        : line
    )),
  }
}

import { isInventoriableAnalysisLine } from './mapping'
import { parseDisplayQuantity } from './receptionUnits'
import { formatQuantity, formatUnit } from './review'
import type { InvoiceAnalysisLine } from './types'

export type ReviewReceivedDrafts = Record<string, string>

export type ReviewReceivedView = {
  sourceLineId: string
  invoiced: number
  received: number | null
  remaining: number | null
  unit: string
  displayValue: string
  error: string | null
  showRemaining: boolean
}

export function receivedDisplayFromQuantity(quantity: number): string {
  return String(quantity).replace('.', ',')
}

export function initialReviewReceivedDrafts(lines: InvoiceAnalysisLine[]): ReviewReceivedDrafts {
  const drafts: ReviewReceivedDrafts = {}
  for (const line of lines) {
    if (!canEditReviewReceived(line) || line.quantity == null) continue
    drafts[line.id] = receivedDisplayFromQuantity(line.quantity)
  }
  return drafts
}

export function canEditReviewReceived(line: InvoiceAnalysisLine): boolean {
  return isInventoriableAnalysisLine(line) && line.quantity != null && line.quantity >= 0
}

export function reviewReceivedView(
  line: InvoiceAnalysisLine,
  displayValue?: string,
): ReviewReceivedView | null {
  if (!canEditReviewReceived(line) || line.quantity == null) return null
  const invoiced = line.quantity
  const value = displayValue ?? receivedDisplayFromQuantity(invoiced)
  const received = parseDisplayQuantity(value, { allowZero: true })
  if (received == null) {
    return {
      sourceLineId: line.id,
      invoiced,
      received: null,
      remaining: null,
      unit: formatUnit(line.unit),
      displayValue: value,
      error: 'Indicá una cantidad válida.',
      showRemaining: false,
    }
  }
  if (received > invoiced) {
    return {
      sourceLineId: line.id,
      invoiced,
      received: null,
      remaining: null,
      unit: formatUnit(line.unit),
      displayValue: value,
      error: 'La cantidad supera lo facturado.',
      showRemaining: false,
    }
  }
  const remaining = Number((invoiced - received).toFixed(6))
  return {
    sourceLineId: line.id,
    invoiced,
    received,
    remaining,
    unit: formatUnit(line.unit),
    displayValue: value,
    error: null,
    showRemaining: remaining > 0,
  }
}

export function reviewReceivedRemainingLabel(view: ReviewReceivedView): string {
  return `Pendiente: ${formatQuantity(view.remaining)} ${view.unit}`
}

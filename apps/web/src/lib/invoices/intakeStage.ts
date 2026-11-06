export type InvoiceIntakeStage = 'empty' | 'selected' | 'analyzing' | 'review'

export function invoiceIntakeStage(input: {
  hasFile: boolean
  analyzing: boolean
  hasReview: boolean
}): InvoiceIntakeStage {
  if (input.analyzing && input.hasFile) return 'analyzing'
  if (input.hasReview) return 'review'
  if (input.hasFile) return 'selected'
  return 'empty'
}

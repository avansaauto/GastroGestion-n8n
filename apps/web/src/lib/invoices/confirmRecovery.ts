export type ConfirmRecoveryStatus = 'completed' | 'recoverable' | 'unavailable'

export function shouldOfferCompleteSave(status: ConfirmRecoveryStatus | null | undefined) {
  return status === 'recoverable'
}

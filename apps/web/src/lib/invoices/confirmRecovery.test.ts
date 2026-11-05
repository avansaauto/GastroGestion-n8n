import { describe, expect, it } from 'vitest'
import { shouldOfferCompleteSave } from './confirmRecovery'

describe('Completar guardado', () => {
  it('solo aparece cuando la operación incompleta tiene un intento persistido', () => {
    expect(shouldOfferCompleteSave('recoverable')).toBe(true)
    expect(shouldOfferCompleteSave('completed')).toBe(false)
    expect(shouldOfferCompleteSave('unavailable')).toBe(false)
    expect(shouldOfferCompleteSave(null)).toBe(false)
  })
})

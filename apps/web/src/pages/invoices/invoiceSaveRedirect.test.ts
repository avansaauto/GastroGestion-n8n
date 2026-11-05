import { describe, expect, it } from 'vitest'
import { shouldRedirectAfterInvoiceSave } from './InvoiceNewPage'

describe('redirección tras guardar factura', () => {
  it('navega al listado cuando el guardado terminó sin reintentos', () => {
    expect(shouldRedirectAfterInvoiceSave({
      saveStatus: 'saved',
      canRetry: false,
      savedId: 'doc-1',
    })).toBe(true)
  })

  it('no navega si quedan operaciones retryables', () => {
    expect(shouldRedirectAfterInvoiceSave({
      saveStatus: 'saved',
      canRetry: true,
      savedId: 'doc-1',
    })).toBe(false)
  })

  it('no navega mientras está guardando', () => {
    expect(shouldRedirectAfterInvoiceSave({
      saveStatus: 'saving',
      canRetry: false,
      savedId: null,
    })).toBe(false)
  })
})

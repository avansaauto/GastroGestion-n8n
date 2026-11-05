import { describe, expect, it } from 'vitest'
import {
  normalizePurchaseDocumentType,
  PURCHASE_DOCUMENT_TYPE_ALLOWED,
} from './invoiceDocumentType.js'

describe('normalizePurchaseDocumentType', () => {
  it('solo admite valores confirmados por el esquema', () => {
    expect(PURCHASE_DOCUMENT_TYPE_ALLOWED).toEqual(['invoice'])
  })

  it.each([
    ['invoice', 'invoice'],
    ['INVOICE', 'invoice'],
    ['FACTURA', 'invoice'],
    ['Factura', 'invoice'],
    ['Factura A', 'invoice'],
    ['factura b', 'invoice'],
    ['FACTURA C', 'invoice'],
    ['Factura E', 'invoice'],
    ['Factura de servicio', 'invoice'],
  ])('normaliza %s a %s', (input, expected) => {
    expect(normalizePurchaseDocumentType(input)).toBe(expected)
  })

  it('rechaza notas de crédito o débito si el CHECK no las lista', () => {
    expect(() => normalizePurchaseDocumentType('Nota de crédito A')).toThrow(/no está permitido/)
    expect(() => normalizePurchaseDocumentType('NOTA DE DEBITO')).toThrow(/no está permitido/)
    try {
      normalizePurchaseDocumentType('nota de credito')
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_DOCUMENT_TYPE', status: 422 })
    }
  })

  it('rechaza tipos desconocidos sin convertirlos a invoice', () => {
    expect(() => normalizePurchaseDocumentType('LIQUIDACION DE SERVICIOS PUBLICOS')).toThrow(/no está permitido/)
    expect(() => normalizePurchaseDocumentType('Comprobante')).toThrow(/no está permitido/)
    expect(() => normalizePurchaseDocumentType('RECIBO')).toThrow(/no está permitido/)
    expect(() => normalizePurchaseDocumentType('ticket')).toThrow(/no está permitido/)
    expect(() => normalizePurchaseDocumentType('')).toThrow(/Falta el tipo/)
    expect(() => normalizePurchaseDocumentType(null)).toThrow(/Falta el tipo/)
  })
})

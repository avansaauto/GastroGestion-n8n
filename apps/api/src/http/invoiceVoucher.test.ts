import { describe, expect, it } from 'vitest'
import {
  isCompleteVoucherIdentity,
  parseArgentineVoucher,
  parseExplicitVoucherIdentity,
  parseVoucherIdentity,
} from './invoiceVoucher.js'
import { resolveInvoiceSaveIdempotency } from './invoiceSaveStrategy.js'

describe('parseArgentineVoucher', () => {
  it('conserva el formato de servicio A-0064-00658503', () => {
    expect(parseArgentineVoucher('A-0064-00658503')).toEqual({
      voucherType: 'A',
      pointOfSale: '0064',
      voucherNumber: '00658503',
    })
  })

  it('parte A-0001-00000001', () => {
    expect(parseArgentineVoucher('A-0001-00000001')).toEqual({
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    })
  })

  it('parte 0001-00000001 y toma el tipo de la cabecera', () => {
    expect(parseArgentineVoucher('0001-00000001', 'Factura A')).toEqual({
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    })
  })

  it('conserva ceros de un punto de venta de cuatro dígitos', () => {
    expect(parseArgentineVoucher('0007-00006046', 'Factura A')).toEqual({
      voucherType: 'A',
      pointOfSale: '0007',
      voucherNumber: '00006046',
    })
  })

  it('parte un punto de venta de cinco dígitos', () => {
    expect(parseArgentineVoucher('00007-00006046', 'Factura A')).toEqual({
      voucherType: 'A',
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })
  })

  it('parte un prefijo de letra con punto de venta de cinco dígitos', () => {
    expect(parseArgentineVoucher('A-00007-00006046')).toEqual({
      voucherType: 'A',
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })
  })

  it('no rellena el punto de venta de cuatro dígitos a cinco', () => {
    const four = parseArgentineVoucher('0007-00006046', 'Factura A')
    const five = parseArgentineVoucher('00007-00006046', 'Factura A')
    expect(four.pointOfSale).toBe('0007')
    expect(five.pointOfSale).toBe('00007')
    expect(four.pointOfSale).not.toBe(five.pointOfSale)
  })

  it('deja nulos si el número no matchea', () => {
    expect(parseArgentineVoucher('40000449274')).toEqual({
      voucherType: null,
      pointOfSale: null,
      voucherNumber: null,
    })
    expect(parseArgentineVoucher('0001-1')).toEqual({
      voucherType: null,
      pointOfSale: null,
      voucherNumber: null,
    })
    expect(parseArgentineVoucher('000007-00006046')).toEqual({
      voucherType: null,
      pointOfSale: null,
      voucherNumber: null,
    })
  })

  it('no inventa tipo si la cabecera no lo trae', () => {
    expect(parseArgentineVoucher('00007-00006046')).toEqual({
      voucherType: null,
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })
  })
})

describe('parseVoucherIdentity', () => {
  it('normaliza el CUIT a dígitos', () => {
    expect(parseVoucherIdentity({
      taxId: '30-12345678-1',
      documentNumber: 'A-0002-00000010',
    })).toMatchObject({
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0002',
      voucherNumber: '00000010',
    })
  })

  it('arma identidad completa de LUPULO 00007-00006046', () => {
    const identity = parseVoucherIdentity({
      taxId: '30-71432940-1',
      documentNumber: '00007-00006046',
      documentType: 'Factura A',
    })
    expect(identity).toEqual({
      issuerTaxIdNormalized: '30714329401',
      voucherType: 'A',
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })
    expect(isCompleteVoucherIdentity(identity)).toBe(true)
  })
})

describe('parseExplicitVoucherIdentity', () => {
  it('conserva punto de venta de cuatro y cinco dígitos', () => {
    const four = parseExplicitVoucherIdentity({
      taxId: '30-71432940-1',
      voucherType: 'A',
      pointOfSale: '0007',
      voucherNumber: '00006046',
    })
    const five = parseExplicitVoucherIdentity({
      taxId: '30-71432940-1',
      voucherType: 'Factura A',
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })
    expect(four).toEqual({
      issuerTaxIdNormalized: '30714329401',
      voucherType: 'A',
      pointOfSale: '0007',
      voucherNumber: '00006046',
    })
    expect(five.pointOfSale).toBe('00007')
    expect(four.pointOfSale).not.toBe(five.pointOfSale)
    expect(isCompleteVoucherIdentity(four)).toBe(true)
    expect(isCompleteVoucherIdentity(five)).toBe(true)
  })
})

describe('isCompleteVoucherIdentity', () => {
  const complete = {
    issuerTaxIdNormalized: '30714329401',
    voucherType: 'A',
    pointOfSale: '00007',
    voucherNumber: '00006046',
  }

  it('exige CUIT, tipo, punto de venta y número', () => {
    expect(isCompleteVoucherIdentity(complete)).toBe(true)
    expect(isCompleteVoucherIdentity({ ...complete, issuerTaxIdNormalized: '30' })).toBe(false)
    expect(isCompleteVoucherIdentity({ ...complete, voucherType: null })).toBe(false)
    expect(isCompleteVoucherIdentity({ ...complete, pointOfSale: null })).toBe(false)
    expect(isCompleteVoucherIdentity({ ...complete, voucherNumber: null })).toBe(false)
    expect(isCompleteVoucherIdentity(parseVoucherIdentity({
      taxId: '30-71432940-1',
      documentNumber: '40000449274',
      documentType: 'Factura A',
    }))).toBe(false)
  })
})

describe('compatibilidad del guardado con la identidad fiscal', () => {
  const existing = [{
    id: 'doc-1',
    organizationId: 'org-1',
    fileSha256: 'aa'.repeat(32),
    issuerTaxIdNormalized: '30714329401',
    voucherType: 'A',
    pointOfSale: '00007',
    voucherNumber: '00006046',
    status: 'reviewed',
  }]

  it('rechaza otro archivo con el mismo comprobante de cinco dígitos', () => {
    const incoming = parseVoucherIdentity({
      taxId: '30-71432940-1',
      documentNumber: '00007-00006046',
      documentType: 'Factura A',
    })
    expect(resolveInvoiceSaveIdempotency(existing, {
      organizationId: 'org-1',
      fileSha256: 'bb'.repeat(32),
      ...incoming,
    })).toEqual({ action: 'reject_duplicate_voucher', id: 'doc-1' })
  })

  it('no trata como duplicado una identidad incompleta', () => {
    expect(resolveInvoiceSaveIdempotency(existing, {
      organizationId: 'org-1',
      fileSha256: 'bb'.repeat(32),
      issuerTaxIdNormalized: '30714329401',
      voucherType: null,
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })).toEqual({ action: 'insert' })
  })

  it('sigue rechazando el formato de cuatro dígitos ya admitido', () => {
    expect(resolveInvoiceSaveIdempotency([{
      ...existing[0]!,
      pointOfSale: '0001',
      voucherNumber: '00000001',
    }], {
      organizationId: 'org-1',
      fileSha256: 'bb'.repeat(32),
      issuerTaxIdNormalized: '30714329401',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    })).toEqual({ action: 'reject_duplicate_voucher', id: 'doc-1' })
  })
})

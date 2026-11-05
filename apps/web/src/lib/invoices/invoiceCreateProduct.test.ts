import { describe, expect, it } from 'vitest'
import {
  parseConversionFactorInput,
  preloadInventoryName,
  suggestInventoryBaseUnit,
} from './invoiceCreateProduct'

describe('invoiceCreateProduct helpers', () => {
  it('sugiere unidad base según descripción y unidad de factura', () => {
    expect(suggestInventoryBaseUnit('PANCETA AHUMADA', 'kg')).toBe('g')
    expect(suggestInventoryBaseUnit('ACEITE GIRASOL', 'L')).toBe('ml')
    expect(suggestInventoryBaseUnit('HUEVOS MAPLE', 'u')).toBe('unit')
    expect(suggestInventoryBaseUnit('TOMATE TRITURADO', 'caja')).toBe('g')
    expect(suggestInventoryBaseUnit('CERVEZA RUBIA', 'pack')).toBe('ml')
    expect(suggestInventoryBaseUnit('Sal', 'mg')).toBe('g')
    expect(suggestInventoryBaseUnit('Vino', 'cl')).toBe('ml')
    expect(suggestInventoryBaseUnit('Huevos', 'docena')).toBe('unit')
    expect(suggestInventoryBaseUnit('Pan Rallado Exclusivo Bolsa', 'bolsa', 'kg')).toBe('g')
    expect(suggestInventoryBaseUnit('Pan Rallado Exclusivo Bolsa', null, 'kg')).toBe('g')
  })

  it('precarga el nombre comercial editable', () => {
    expect(preloadInventoryName('  Panceta ahumada  ')).toBe('Panceta ahumada')
    expect(preloadInventoryName(null)).toBe('')
    expect(preloadInventoryName('x'.repeat(130)).endsWith('…')).toBe(true)
  })

  it('parsea el factor de conversión manual', () => {
    expect(parseConversionFactorInput('8000')).toBe(8000)
    expect(parseConversionFactorInput('1,444')).toBe(1.444)
    expect(parseConversionFactorInput('')).toBeNull()
    expect(parseConversionFactorInput('0')).toBeNull()
    expect(parseConversionFactorInput('-2')).toBeNull()
  })
})

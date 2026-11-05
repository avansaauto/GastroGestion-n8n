import { describe, expect, it } from 'vitest'
import {
  confirmedMemoryFromMappedLine,
  conversionFactorFromQuantities,
  normalizeInvoiceConcept,
  suggestFromConfirmedMemory,
} from './invoiceMemory.js'

const pilsen = { id: 'prod-pilsen', name: 'Cerveza Pilsen', baseUnit: 'l' }
const golden = { id: 'prod-golden', name: 'Golden Ale', baseUnit: 'l' }

const pilsenMemory = {
  descriptionNormalized: 'pilsen',
  inventoryProductId: pilsen.id,
  inventoryProduct: pilsen,
  conversionFactor: 1,
}

function unmapped(description: string) {
  return {
    original: { description, quantity: 10 },
    reviewed: { description, quantity: 10 },
    mappingStatus: 'unmapped' as const,
    inventoryProductId: null,
  }
}

describe('memoria de vinculaciones confirmadas', () => {
  it('normaliza el concepto sin alterar el texto original del llamador', () => {
    const original = 'PILSEN  '
    expect(normalizeInvoiceConcept(original)).toBe('pilsen')
    expect(original).toBe('PILSEN  ')
  })

  it('no aprende de líneas pendientes, rechazadas o sin producto', () => {
    expect(confirmedMemoryFromMappedLine({
      mappingStatus: 'unmapped',
      originalDescription: 'PILSEN',
      reviewedDescription: 'PILSEN',
      invoiceQuantity: 10,
      physicalQuantity: 10,
      inventoryProductId: pilsen.id,
      inventoryProduct: pilsen,
    })).toBeNull()
    expect(confirmedMemoryFromMappedLine({
      mappingStatus: 'not_applicable',
      originalDescription: 'IVA',
      reviewedDescription: 'IVA',
      invoiceQuantity: null,
      physicalQuantity: 0,
      inventoryProductId: null,
      inventoryProduct: null,
    })).toBeNull()
  })

  it('arma una memoria solo desde una vinculación confirmada', () => {
    expect(confirmedMemoryFromMappedLine({
      mappingStatus: 'mapped',
      originalDescription: 'PILSEN',
      reviewedDescription: 'PILSEN',
      invoiceQuantity: 2,
      physicalQuantity: 25,
      inventoryProductId: pilsen.id,
      inventoryProduct: pilsen,
    })).toEqual({
      descriptionNormalized: 'pilsen',
      inventoryProductId: pilsen.id,
      inventoryProduct: pilsen,
      conversionFactor: 12.5,
    })
  })

  it('preselecciona una coincidencia exacta y exige confirmación en una aproximada', () => {
    const exact = suggestFromConfirmedMemory(unmapped('PILSEN'), [pilsenMemory])
    expect(exact).toMatchObject({ kind: 'exact', inventoryProductId: pilsen.id, source: 'confirmed_mapping' })

    const approximate = suggestFromConfirmedMemory(unmapped('PILSEN RUBIA'), [pilsenMemory])
    expect(approximate).toMatchObject({ kind: 'approximate', inventoryProductId: pilsen.id })

    expect(suggestFromConfirmedMemory(unmapped('TOMATE TRITURADO'), [pilsenMemory])).toBeNull()
  })

  it('no sugiere si la línea ya está mapeada ni si hay conflicto exacto', () => {
    expect(suggestFromConfirmedMemory({
      ...unmapped('PILSEN'),
      mappingStatus: 'mapped',
      inventoryProductId: pilsen.id,
    }, [pilsenMemory])).toBeNull()

    const conflict = suggestFromConfirmedMemory(unmapped('PILSEN'), [
      pilsenMemory,
      { ...pilsenMemory, inventoryProductId: golden.id, inventoryProduct: golden },
    ])
    expect(conflict?.kind).not.toBe('exact')
  })

  it('calcula la equivalencia física confirmada', () => {
    expect(conversionFactorFromQuantities(2, 25)).toBe(12.5)
    expect(conversionFactorFromQuantities(0, 10)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import {
  inventoryUnitLabel,
  normalizeInventoryName,
  parseInventoryBaseUnit,
} from './inventoryUnits.js'

describe('unidades base de inventario', () => {
  it('acepta g, ml y unit y alias visibles del formulario', () => {
    expect(parseInventoryBaseUnit('g')).toBe('g')
    expect(parseInventoryBaseUnit('gramos')).toBe('g')
    expect(parseInventoryBaseUnit('ml')).toBe('ml')
    expect(parseInventoryBaseUnit('mililitros')).toBe('ml')
    expect(parseInventoryBaseUnit('unit')).toBe('unit')
    expect(parseInventoryBaseUnit('u')).toBe('unit')
    expect(parseInventoryBaseUnit('unidades')).toBe('unit')
    expect(inventoryUnitLabel('g')).toBe('Gramos')
    expect(inventoryUnitLabel('ml')).toBe('Mililitros')
    expect(inventoryUnitLabel('unit')).toBe('Unidades')
  })

  it('mantiene etiquetas de insumos existentes con unidades previas', () => {
    expect(inventoryUnitLabel('l')).toBe('Litros')
    expect(inventoryUnitLabel('kg')).toBe('Kilogramos')
    expect(inventoryUnitLabel('u')).toBe('Unidades')
  })

  it('rechaza unidades incompatibles con el CHECK de Supabase', () => {
    expect(() => parseInventoryBaseUnit('caja')).toThrow('INVALID_BASE_UNIT')
    expect(() => parseInventoryBaseUnit('kg')).toThrow('INVALID_BASE_UNIT')
    expect(() => parseInventoryBaseUnit('litros')).toThrow('INVALID_BASE_UNIT')
    expect(() => parseInventoryBaseUnit('l')).toThrow('INVALID_BASE_UNIT')
  })

  it('detecta duplicados evidentes por nombre normalizado', () => {
    expect(normalizeInventoryName('Golden Ale')).toBe(normalizeInventoryName('golden   ale'))
    expect(normalizeInventoryName('Tomate')).toBe('tomate')
  })
})

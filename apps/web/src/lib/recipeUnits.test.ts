import { describe, expect, it } from 'vitest'
import {
  convertQuantityToBase,
  defaultInputUnit,
  formatRecipeQuantity,
  inputUnitsForBase,
  lookupPhysicalConversion,
} from './recipeUnits'

describe('unidades de receta', () => {
  it('convierte 500 ml a 0,5 litros cuando el insumo está en litros', () => {
    expect(convertQuantityToBase(500, 'ml', 'l')).toEqual({
      kind: 'ok',
      quantity: 0.5,
      baseUnit: 'l',
    })
    expect(formatRecipeQuantity(0.5, 'l')).toBe('0,5 l')
  })

  it('no inventa una equivalencia para barril', () => {
    expect(lookupPhysicalConversion('ml', 'barril')).toEqual({ kind: 'equivalence_required' })
    expect(convertQuantityToBase(500, 'ml', 'barril')).toEqual({ kind: 'equivalence_required' })
  })

  it('rechaza familias incompatibles y ofrece unidades reales del insumo', () => {
    expect(convertQuantityToBase(1, 'g', 'l')).toEqual({ kind: 'incompatible' })
    expect(inputUnitsForBase('l').map((unit) => unit.value)).toEqual(['ml', 'l'])
    expect(defaultInputUnit('Litros')).toBe('l')
    expect(defaultInputUnit('unit')).toBe('unit')
  })
})

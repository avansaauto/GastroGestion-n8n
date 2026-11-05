import { describe, expect, it } from 'vitest'
import {
  consumptionModeFromComponentCount,
  estimateRecipeCost,
} from './recipeCost.js'

describe('consumptionModeFromComponentCount', () => {
  it('infiere none / direct / compound sin usar recipe_type', () => {
    expect(consumptionModeFromComponentCount(0)).toBe('none')
    expect(consumptionModeFromComponentCount(1)).toBe('direct')
    expect(consumptionModeFromComponentCount(2)).toBe('compound')
  })
})

describe('estimateRecipeCost', () => {
  it('sin componentes el costo es 0 y está completo', () => {
    expect(estimateRecipeCost({ yieldQuantity: 1, lines: [] })).toEqual({
      costPerYield: 0,
      costIncomplete: false,
      lineCosts: [],
    })
  })

  it('no reemplaza un costo faltante por cero', () => {
    const result = estimateRecipeCost({
      yieldQuantity: 1,
      lines: [
        { quantity: 100, unitCost: 2 },
        { quantity: 50, unitCost: null },
      ],
    })
    expect(result.costIncomplete).toBe(true)
    expect(result.costPerYield).toBeNull()
    expect(result.lineCosts[0]).toBe(200)
    expect(result.lineCosts[1]).toBeNull()
    expect(result.lineCosts).not.toContain(0)
  })

  it('calcula 500 ml de IPA a $1,80 y no usa cero si falta valuación', () => {
    expect(estimateRecipeCost({
      yieldQuantity: 1,
      lines: [{ quantity: 500, unitCost: 1.8 }],
    })).toMatchObject({
      costPerYield: 900,
      costIncomplete: false,
    })
    expect(estimateRecipeCost({
      yieldQuantity: 1,
      lines: [{ quantity: 500, unitCost: 2 }],
    })).toMatchObject({
      costPerYield: 1000,
      costIncomplete: false,
    })
    expect(estimateRecipeCost({
      yieldQuantity: 1,
      lines: [{ quantity: 500, unitCost: null }],
    })).toMatchObject({
      costPerYield: null,
      costIncomplete: true,
    })
  })

  it('divide la suma por el rinde cuando todos los costos existen', () => {
    const result = estimateRecipeCost({
      yieldQuantity: 2,
      lines: [
        { quantity: 10, unitCost: 1.5 },
        { quantity: 4, unitCost: 2 },
      ],
    })
    expect(result.costIncomplete).toBe(false)
    expect(result.costPerYield).toBe(11.5)
    expect(result.lineCosts).toEqual([15, 8])
  })

  it('una línea con cantidad inválida deja el costo incompleto y no lo convierte en cero', () => {
    const result = estimateRecipeCost({
      yieldQuantity: 1,
      lines: [
        { quantity: 10, unitCost: 2 },
        { quantity: 0, unitCost: 5 },
      ],
    })
    expect(result.costIncomplete).toBe(true)
    expect(result.costPerYield).toBeNull()
    expect(result.lineCosts).toEqual([20, null])
  })

  it('10 kg a $200.000 dejan 200 g de receta en $4.000', () => {
    const unitCost = 200000 / 10000
    expect(unitCost).toBe(20)
    expect(estimateRecipeCost({
      yieldQuantity: 1,
      lines: [{ quantity: 200, unitCost }],
    })).toMatchObject({
      costPerYield: 4000,
      costIncomplete: false,
    })
    expect(estimateRecipeCost({
      yieldQuantity: 1,
      lines: [{ quantity: 200, unitCost: 250000 / 10000 }],
    })).toMatchObject({
      costPerYield: 5000,
      costIncomplete: false,
    })
  })

  it('no inventa costo si el rinde no es válido', () => {
    const result = estimateRecipeCost({
      yieldQuantity: 0,
      lines: [{ quantity: 1, unitCost: 10 }],
    })
    expect(result.costIncomplete).toBe(true)
    expect(result.costPerYield).toBeNull()
  })
})

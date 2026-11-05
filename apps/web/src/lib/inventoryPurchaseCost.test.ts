import { describe, expect, it } from 'vitest'
import {
  inventoryPurchaseInputUnits,
  inventoryUnitCostLabel,
  planInventoryPurchaseCost,
} from './inventoryPurchaseCost'

describe('planInventoryPurchaseCost', () => {
  it('convierte 100.000 ml a $180.000 en $1,80 por ml', () => {
    expect(planInventoryPurchaseCost({
      quantity: '100000',
      inputUnit: 'ml',
      baseUnit: 'ml',
      purchaseCost: 180000,
    })).toEqual({
      ok: true,
      quantityInBase: 100000,
      purchaseCost: 180000,
      unitCost: 1.8,
    })
  })

  it('convierte 100 litros a mililitros antes de calcular el costo', () => {
    expect(planInventoryPurchaseCost({
      quantity: '100',
      inputUnit: 'l',
      baseUnit: 'ml',
      purchaseCost: 180000,
    })).toMatchObject({
      ok: true,
      quantityInBase: 100000,
      unitCost: 1.8,
    })
  })

  it('acepta costo cero y no usa el stock como precio', () => {
    expect(planInventoryPurchaseCost({
      quantity: '100000',
      inputUnit: 'ml',
      baseUnit: 'ml',
      purchaseCost: 0,
    })).toMatchObject({ ok: true, unitCost: 0 })
    expect(planInventoryPurchaseCost({
      quantity: '',
      inputUnit: 'ml',
      baseUnit: 'ml',
      purchaseCost: 180000,
    }).ok).toBe(false)
    expect(planInventoryPurchaseCost({
      quantity: '100000',
      inputUnit: 'ml',
      baseUnit: 'ml',
      purchaseCost: null,
    }).ok).toBe(false)
  })

  it('muestra sin valuación si el costo por unidad no existe', () => {
    expect(inventoryUnitCostLabel(null, 'ml', (value) => `$${value}`)).toBe('Sin valuación')
    expect(inventoryUnitCostLabel(1.8, 'ml', (value) => `$${value}`)).toBe('$1.8 / ml')
    expect(inventoryPurchaseInputUnits('ml').map((unit) => unit.value)).toEqual(['ml', 'l'])
  })
})

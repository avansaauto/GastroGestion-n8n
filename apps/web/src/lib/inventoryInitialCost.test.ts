import { describe, expect, it } from 'vitest'
import {
  canRegisterInitialValuation,
  commercialQuantityFromOnHand,
  defaultInitialCostBasis,
  planInitialAcquisitionCost,
} from './inventoryInitialCost'

describe('planInitialAcquisitionCost', () => {
  it('omite el costo si el campo está vacío (no inventa 0)', () => {
    expect(planInitialAcquisitionCost({
      costDisplay: '',
      basis: 'presentation',
      stockUnit: 'u',
      quantityDisplay: '10',
      contentEnabled: true,
      contentQuantity: '330',
      contentUnit: 'ml',
    })).toEqual({ ok: true, skip: true })
  })

  it('Coca-Cola: 10 u × 330 ml a $900/u → 3300 ml y $2,727…/ml', () => {
    const plan = planInitialAcquisitionCost({
      costDisplay: '900',
      basis: 'presentation',
      stockUnit: 'u',
      quantityDisplay: '10',
      contentEnabled: true,
      contentQuantity: '330',
      contentUnit: 'ml',
    })
    expect(plan).toMatchObject({
      ok: true,
      skip: false,
      purchaseQuantity: 3300,
      purchaseCost: 9000,
    })
    if (plan.ok && !plan.skip) {
      expect(plan.unitCost).toBeCloseTo(900 / 330, 8)
      expect(plan.unitCost * 330).toBeCloseTo(900, 5)
    }
  })

  it('cuesta por unidad base sin presentación', () => {
    expect(planInitialAcquisitionCost({
      costDisplay: '1.8',
      basis: 'stock',
      stockUnit: 'ml',
      quantityDisplay: '100000',
    })).toEqual({
      ok: true,
      skip: false,
      purchaseQuantity: 100000,
      purchaseCost: 180000,
      unitCost: 1.8,
      costLabel: 'Costo inicial por ml',
    })
  })

  it('convierte kg a g al costear por stock', () => {
    const plan = planInitialAcquisitionCost({
      costDisplay: '500',
      basis: 'stock',
      stockUnit: 'kg',
      quantityDisplay: '2',
    })
    expect(plan).toMatchObject({
      ok: true,
      skip: false,
      purchaseQuantity: 2000,
      purchaseCost: 1000,
      unitCost: 0.5,
    })
  })

  it('sin cantidad valoriza 1 unidad de la base elegida', () => {
    const plan = planInitialAcquisitionCost({
      costDisplay: '900',
      basis: 'presentation',
      stockUnit: 'u',
      quantityDisplay: '',
      conversionFactor: 330,
    })
    expect(plan.ok && !plan.skip).toBe(true)
    if (plan.ok && !plan.skip) {
      expect(plan.purchaseQuantity).toBe(330)
      expect(plan.purchaseCost).toBe(900)
      expect(plan.unitCost).toBeCloseTo(900 / 330, 8)
    }
  })

  it('rechaza presentación sin factor', () => {
    expect(planInitialAcquisitionCost({
      costDisplay: '900',
      basis: 'presentation',
      stockUnit: 'u',
      quantityDisplay: '10',
    }).ok).toBe(false)
  })
})

describe('helpers de valuación inicial', () => {
  it('elige presentation cuando hay contenido por u', () => {
    expect(defaultInitialCostBasis({
      stockUnit: 'u',
      contentEnabled: true,
      conversionFactor: 330,
    })).toBe('presentation')
    expect(defaultInitialCostBasis({ stockUnit: 'ml' })).toBe('stock')
  })

  it('bloquea doble valuación cuando ya hay CPP', () => {
    expect(canRegisterInitialValuation(null)).toBe(true)
    expect(canRegisterInitialValuation(2.72)).toBe(false)
  })

  it('deriva u comerciales desde el stock base', () => {
    expect(commercialQuantityFromOnHand(3300, 330)).toBe(10)
    expect(commercialQuantityFromOnHand(0, 330)).toBeNull()
  })
})

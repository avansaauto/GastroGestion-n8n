import { describe, expect, it } from 'vitest'
import {
  classifyInventoryMovement,
  prepareInventoryAdjustment,
  wasteReason,
} from './inventoryMovementKind.js'

describe('inventario operativo', () => {
  it('distingue compra, consumo, merma, ajuste y anulación', () => {
    expect(classifyInventoryMovement({ movementType: 'purchase' }).label).toBe('Compra')
    expect(classifyInventoryMovement({ movementType: 'sale' }).label).toBe('Consumo de venta')
    expect(classifyInventoryMovement({
      movementType: 'adjustment',
      reason: 'Merma: se venció',
      quantity: -500,
    }).label).toBe('Merma')
    expect(classifyInventoryMovement({ movementType: 'adjustment', reason: 'Conteo físico' }).label).toBe('Ajuste')
    expect(classifyInventoryMovement({
      movementType: 'adjustment',
      reason: 'Reversion por eliminacion de factura',
    }).label).toBe('Anulación de compra')
  })

  it('no clasifica como Merma un ajuste positivo aunque el motivo diga merma', () => {
    const positiveLegacy = classifyInventoryMovement({
      movementType: 'adjustment',
      reason: 'merma',
      quantity: 1000,
    })
    expect(positiveLegacy).toEqual({ kind: 'adjustment', label: 'Ajuste' })

    const positivePrefixed = classifyInventoryMovement({
      movementType: 'adjustment',
      reason: 'Merma: se venció',
      quantity: 1000,
    })
    expect(positivePrefixed).toEqual({ kind: 'adjustment', label: 'Ajuste' })
  })

  it('clasifica como Merma solo ajustes negativos con motivo de merma', () => {
    expect(classifyInventoryMovement({
      movementType: 'adjustment',
      reason: 'Merma: se venció',
      quantity: -200,
    })).toEqual({ kind: 'waste', label: 'Merma' })

    expect(classifyInventoryMovement({
      movementType: 'adjustment',
      reason: 'merma: rotura',
      quantity: -1,
    })).toEqual({ kind: 'waste', label: 'Merma' })
  })

  it('trata ajustes negativos sin motivo de merma como Ajuste', () => {
    expect(classifyInventoryMovement({
      movementType: 'adjustment',
      reason: 'Conteo físico',
      quantity: -100,
    })).toEqual({ kind: 'adjustment', label: 'Ajuste' })
  })

  it('conserva la clasificación de movimientos antiguos sin cantidad informada', () => {
    expect(classifyInventoryMovement({
      movementType: 'adjustment',
      reason: 'Merma: se venció',
    }).label).toBe('Merma')
  })

  it('guarda la merma con un motivo identificable y rechaza usarla como corrección', () => {
    expect(wasteReason('se venció')).toBe('Merma: se venció')
    expect(wasteReason('Merma')).toBeNull()
    const waste = prepareInventoryAdjustment({
      quantityDelta: -500,
      reason: 'se venció',
      kind: 'waste',
    })
    expect(waste).toEqual({ quantity: -500, reason: 'Merma: se venció' })
    const correction = prepareInventoryAdjustment({
      quantityDelta: -500,
      reason: 'Merma: se venció',
      kind: 'correction',
    })
    expect(correction).toMatchObject({ code: 'USE_WASTE_ACTION' })
  })

  it('no convierte una merma en entrada de stock y no repite el descuento si la cantidad es positiva', () => {
    const entry = prepareInventoryAdjustment({
      quantityDelta: 500,
      reason: 'se venció',
      kind: 'waste',
    })
    expect(entry).toMatchObject({ code: 'INVALID_QUANTITY' })
  })

  it('repite la misma corrección sin cambiar el motivo ni la cantidad', () => {
    const first = prepareInventoryAdjustment({
      quantityDelta: -2,
      reason: 'Conteo físico',
    })
    const second = prepareInventoryAdjustment({
      quantityDelta: -2,
      reason: 'Conteo físico',
    })
    expect(second).toEqual(first)
  })
})

import { describe, expect, it } from 'vitest'
import { assertRecipeComponentQuantities } from './recipeIndivisible.js'

const bottle = {
  id: '11111111-1111-4111-8111-111111111111',
  baseUnit: 'ml',
  presentationUnit: 'u',
  conversionFactor: 750,
  divisible: false as boolean | null,
  active: true,
}

describe('assertRecipeComponentQuantities', () => {
  it('acepta múltiplos enteros del factor', () => {
    expect(assertRecipeComponentQuantities([bottle], [
      { inventoryProductId: bottle.id, quantity: 750 },
    ])).toEqual({ ok: true })
    expect(assertRecipeComponentQuantities([bottle], [
      { inventoryProductId: bottle.id, quantity: 1500 },
    ])).toEqual({ ok: true })
  })

  it('rechaza parciales sobre indivisibles', () => {
    expect(assertRecipeComponentQuantities([bottle], [
      { inventoryProductId: bottle.id, quantity: 60 },
    ])).toEqual({ ok: false, code: 'INDIVISIBLE_QUANTITY' })
  })

  it('rechaza menos de 1 unidad', () => {
    expect(assertRecipeComponentQuantities([bottle], [
      { inventoryProductId: bottle.id, quantity: 0.5 },
    ]).ok).toBe(false)
  })

  it('permite parciales si divisible', () => {
    expect(assertRecipeComponentQuantities([
      { ...bottle, divisible: true },
    ], [
      { inventoryProductId: bottle.id, quantity: 60 },
    ])).toEqual({ ok: true })
  })

  it('permite parciales si divisible es null', () => {
    expect(assertRecipeComponentQuantities([
      { ...bottle, divisible: null },
    ], [
      { inventoryProductId: bottle.id, quantity: 60 },
    ])).toEqual({ ok: true })
  })

  it('falla si el producto no está en la org', () => {
    expect(assertRecipeComponentQuantities([], [
      { inventoryProductId: bottle.id, quantity: 750 },
    ])).toEqual({ ok: false, code: 'INGREDIENT_NOT_IN_ORG' })
  })
})

import { describe, expect, it } from 'vitest'
import { formatQuantity } from '@/lib/invoices/review'
import { formatInventoryStock } from './inventoryCatalog'
import {
  allowsPartialBaseConsumption,
  commercialPackagesForDisplay,
  commercialToPhysicalQty,
  formatCommercialQuantity,
  hasReliableCommercialPresentation,
  physicalToCommercial,
} from './inventoryPresentation'
import { convertRecipeQuantityToBase, inputUnitsForInventoryProduct } from './recipeUnits'

const coca = {
  baseUnit: 'ml',
  presentationUnit: 'u',
  conversionFactor: 330,
} as const

const fernet = {
  baseUnit: 'ml',
  presentationUnit: 'u',
  conversionFactor: 750,
} as const

const harina = {
  baseUnit: 'g',
  presentationUnit: 'u',
  conversionFactor: 1000,
} as const

/** Barril IPA 50 L — divisible. */
const barrilIpa = {
  baseUnit: 'ml',
  presentationUnit: 'u',
  conversionFactor: 50_000,
  divisible: true,
} as const

describe('inventoryPresentation', () => {
  it('Coca-Cola 10 u / mín 2 u se muestran en u, no en litros', () => {
    expect(hasReliableCommercialPresentation(coca)).toBe(true)
    expect(physicalToCommercial(3300, coca)).toBe(10)
    expect(physicalToCommercial(660, coca)).toBe(2)
    expect(formatCommercialQuantity(3300, coca, formatQuantity, { withBaseEquivalence: false })).toBe('10 u')
    expect(formatCommercialQuantity(660, coca, formatQuantity, { withBaseEquivalence: false })).toBe('2 u')
    expect(formatCommercialQuantity(3300, coca, formatQuantity, { withBaseEquivalence: true })).toContain('10 u')
    expect(formatCommercialQuantity(3300, coca, formatQuantity, { withBaseEquivalence: true })).toContain('L')
  })

  it('divisible: envases equivalentes con ceil; volumen exacto al lado', () => {
    // 2 barriles − 500 ml = 99.500 ml → 2 u · 99,5 L (no 1,99 u)
    expect(physicalToCommercial(99_500, barrilIpa)).toBe(1.99)
    expect(commercialPackagesForDisplay(100_000, barrilIpa)).toBe(2)
    expect(commercialPackagesForDisplay(99_500, barrilIpa)).toBe(2)
    expect(commercialPackagesForDisplay(50_000, barrilIpa)).toBe(1)
    expect(commercialPackagesForDisplay(49_500, barrilIpa)).toBe(1)
    expect(commercialPackagesForDisplay(0, barrilIpa)).toBe(0)
    expect(formatInventoryStock(99_500, barrilIpa, formatQuantity)).toBe('2 u · 99,5 L disponibles')
    expect(formatInventoryStock(100_000, barrilIpa, formatQuantity)).toBe('2 u · 100 L disponibles')
    expect(formatInventoryStock(50_000, barrilIpa, formatQuantity)).toBe('1 u · 50 L disponibles')
    expect(formatInventoryStock(49_500, barrilIpa, formatQuantity)).toBe('1 u · 49,5 L disponibles')
    expect(formatInventoryStock(0, barrilIpa, formatQuantity)).toBe('0 u · 0 L disponibles')
  })

  it('ceil display no contamina conversiones de cálculo', () => {
    expect(commercialToPhysicalQty(2, barrilIpa)).toBe(100_000)
    expect(physicalToCommercial(99_500, barrilIpa)).toBe(1.99)
  })

  it('indivisible muestra envases enteros (piso); null se trata como divisible (ceil)', () => {
    const bottle = { ...coca, divisible: false }
    expect(commercialPackagesForDisplay(500, bottle)).toBe(1)
    expect(formatCommercialQuantity(500, bottle, formatQuantity, { withBaseEquivalence: false })).toBe('1 u')
    // Barril sin flag explícito: ceil → 2 u (no 1)
    expect(commercialPackagesForDisplay(99_500, { ...barrilIpa, divisible: null })).toBe(2)
    expect(commercialPackagesForDisplay(3_300, { ...coca, divisible: true })).toBe(10)
    expect(commercialPackagesForDisplay(7_500, { ...fernet, divisible: true })).toBe(10)
  })

  it('tolerancia: no infla envases por ruido flotante en múltiplos exactos', () => {
    const almostTwo = 100_000 + 1e-6
    expect(commercialPackagesForDisplay(almostTwo, barrilIpa)).toBe(2)
  })

  it('sin presentación confiable no reinterpretar (sigue display SI)', () => {
    expect(hasReliableCommercialPresentation({ baseUnit: 'ml' })).toBe(false)
    expect(formatCommercialQuantity(3300, { baseUnit: 'ml' }, formatQuantity)).toBe('3,3 L')
  })

  it('entrada comercial 10 u Coca → 3.300 ml base', () => {
    expect(commercialToPhysicalQty(10, coca)).toBe(3300)
    expect(commercialToPhysicalQty(2, coca)).toBe(660)
  })
})


describe('consumo en recetas con presentación', () => {
  it('Fernet: venta 60 ml descuenta 60 ml', () => {
    expect(convertRecipeQuantityToBase({
      quantity: 60,
      fromUnit: 'ml',
      baseUnit: 'ml',
      presentationUnit: 'u',
      conversionFactor: 750,
    })).toEqual({ kind: 'ok', quantity: 60, baseUnit: 'ml' })
  })

  it('Coca-Cola: 1 u → 330 ml; fracciones de u inválidas', () => {
    expect(convertRecipeQuantityToBase({
      quantity: 1,
      fromUnit: 'unit',
      ...coca,
    })).toEqual({ kind: 'ok', quantity: 330, baseUnit: 'ml' })
    expect(convertRecipeQuantityToBase({
      quantity: 0.5,
      fromUnit: 'unit',
      ...coca,
    }).kind).toBe('invalid')
  })

  it('Harina: 200 g sobre u de 1 kg', () => {
    expect(convertRecipeQuantityToBase({
      quantity: 200,
      fromUnit: 'g',
      ...harina,
    })).toEqual({ kind: 'ok', quantity: 200, baseUnit: 'g' })
  })

  it('indivisible bloquea ml y ofrece solo u', () => {
    const units = inputUnitsForInventoryProduct({ ...coca, divisible: false })
    expect(units.map((u) => u.value)).toEqual(['unit'])
    expect(allowsPartialBaseConsumption({ ...coca, divisible: false })).toBe(false)
    expect(convertRecipeQuantityToBase({
      quantity: 60,
      fromUnit: 'ml',
      ...coca,
      divisible: false,
    }).kind).toBe('incompatible')
  })

  it('Fernet divisible ofrece u y ml', () => {
    expect(inputUnitsForInventoryProduct(fernet).map((u) => u.value)).toEqual(['unit', 'ml', 'l'])
  })
})

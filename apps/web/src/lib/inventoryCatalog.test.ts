import { describe, expect, it } from 'vitest'
import { formatQuantity } from '@/lib/invoices/review'
import { formatMoney } from '@/lib/invoices/review'
import {
  formatInventoryAverageCost,
  formatInventoryEstimatedValue,
  formatInventoryMinimumStock,
  formatInventoryStock,
  inventoryCategoryLabel,
  inventoryLowStockProducts,
  inventoryProductsActiveOnly,
  inventorySupplierLabel,
  INVENTORY_NO_CATEGORY,
  INVENTORY_NO_SUPPLIER,
  INVENTORY_UNKNOWN_COST,
} from './inventoryCatalog'

describe('inventoryCatalog', () => {
  it('muestra proveedor y categoría solo con datos reales', () => {
    expect(inventorySupplierLabel({ supplierName: 'LUPULO SRL' })).toBe('LUPULO SRL')
    expect(inventorySupplierLabel({ supplierName: null })).toBe(INVENTORY_NO_SUPPLIER)
    expect(inventoryCategoryLabel({ category: 'Carnes' })).toBe('Carnes')
    expect(inventoryCategoryLabel({ category: null })).toBe(INVENTORY_NO_CATEGORY)
  })

  it('muestra stock de 2000 g como 2 kg', () => {
    expect(formatInventoryStock(2000, 'g', formatQuantity)).toBe('2 kg')
    expect(formatInventoryStock(1000, 'g', formatQuantity)).toBe('1 kg')
  })

  it('con presentación comercial muestra u y no litros', () => {
    const coca = { baseUnit: 'ml', presentationUnit: 'u', conversionFactor: 330 }
    expect(formatInventoryStock(3300, coca, formatQuantity, { withBaseEquivalence: false })).toBe('10 u')
    expect(formatInventoryMinimumStock(660, coca, formatQuantity)).toBe('2 u')
  })

  it('divisible: stock visual con ceil de envases y volumen exacto', () => {
    const barril = {
      baseUnit: 'ml',
      presentationUnit: 'u',
      conversionFactor: 50_000,
      divisible: true,
    }
    expect(formatInventoryStock(99_500, barril, formatQuantity)).toBe('2 u · 99,5 L disponibles')
    expect(formatInventoryMinimumStock(49_500, barril, formatQuantity)).toBe('1 u')
  })

  it('no representa un costo desconocido como cero y avisa el mínimo', () => {
    expect(formatInventoryAverageCost(null, 'g', formatMoney)).toBe(INVENTORY_UNKNOWN_COST)
    expect(formatInventoryEstimatedValue(2000, null, formatMoney)).toBe(INVENTORY_UNKNOWN_COST)
    expect(formatInventoryEstimatedValue(2000, 12, formatMoney)).toBe(formatMoney(24000))
    expect(formatInventoryAverageCost(12, 'g', formatMoney)).toBe(`${formatMoney(12000)} / kg`)
    const low = inventoryLowStockProducts([
      { id: '1', organizationId: 'o', name: 'Harina', baseUnit: 'g', active: true, onHand: 1000, minimumStock: 5000 },
      { id: '2', organizationId: 'o', name: 'Arroz', baseUnit: 'g', active: true, onHand: 8000, minimumStock: 1000 },
      { id: '3', organizationId: 'o', name: 'Sal', baseUnit: 'g', active: true, onHand: 0, minimumStock: null },
    ])
    expect(low.map((row) => row.name)).toEqual(['Harina'])
  })

  it('oculta productos inactivos del listado activo', () => {
    expect(inventoryProductsActiveOnly([
      { id: '1', organizationId: 'o', name: 'A', baseUnit: 'g', active: true, onHand: 0 },
      { id: '2', organizationId: 'o', name: 'B', baseUnit: 'g', active: false, onHand: 0 },
    ]).map((row) => row.id)).toEqual(['1'])
  })
})

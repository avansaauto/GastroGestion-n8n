import type { InventoryProduct } from '@/lib/api'
import {
  formatCommercialQuantity,
  hasReliableCommercialPresentation,
  type InventoryPresentationLike,
} from '@/lib/inventoryPresentation'
import {
  formatDisplayQuantity,
  formatInventoryUnit,
  inventoryDisplayScale,
  physicalToDisplay,
} from '@/lib/invoices/receptionUnits'

export const INVENTORY_NO_SUPPLIER = 'Sin proveedor'
export const INVENTORY_NO_CATEGORY = 'Sin categoría'

export function inventorySupplierLabel(product: Pick<InventoryProduct, 'supplierName'>) {
  const name = product.supplierName?.trim()
  return name ? name : INVENTORY_NO_SUPPLIER
}

export function inventoryCategoryLabel(product: Pick<InventoryProduct, 'category'>) {
  const name = product.category?.trim()
  return name ? name : INVENTORY_NO_CATEGORY
}

type StockProduct = InventoryPresentationLike & {
  baseUnit?: string | null
}

export function formatInventoryStock(
  quantity: number | null | undefined,
  baseUnitOrProduct: string | null | undefined | StockProduct,
  formatNumber: (value: number | null | undefined) => string,
  options?: { withBaseEquivalence?: boolean },
) {
  if (quantity == null || !Number.isFinite(quantity)) return '—'

  if (baseUnitOrProduct != null && typeof baseUnitOrProduct === 'object') {
    return formatCommercialQuantity(quantity, baseUnitOrProduct, formatNumber, {
      withBaseEquivalence: options?.withBaseEquivalence ?? true,
    })
  }

  const baseUnit = baseUnitOrProduct
  const display = physicalToDisplay(quantity, baseUnit)
  if (display == null) {
    return `${formatNumber(quantity)} ${formatInventoryUnit(baseUnit)}`
  }
  return formatDisplayQuantity(quantity, baseUnit, formatNumber)
}

export function formatInventoryMinimumStock(
  quantity: number | null | undefined,
  baseUnitOrProduct: string | null | undefined | StockProduct,
  formatNumber: (value: number | null | undefined) => string,
) {
  if (quantity == null || !Number.isFinite(quantity)) return '—'
  // Mínimo en la misma unidad comercial que el stock (sin equivalencia secundaria).
  if (baseUnitOrProduct != null && typeof baseUnitOrProduct === 'object') {
    return formatCommercialQuantity(quantity, baseUnitOrProduct, formatNumber, {
      withBaseEquivalence: false,
    })
  }
  return formatInventoryStock(quantity, baseUnitOrProduct, formatNumber)
}

export function inventoryStockUnitColumnLabel(product: StockProduct) {
  if (hasReliableCommercialPresentation(product)) return 'Unidades'
  const key = product.baseUnit?.trim().toLowerCase()
  if (key === 'g' || key === 'gr' || key === 'gramos') return 'Gramos'
  if (key === 'ml' || key === 'mililitros') return 'Mililitros'
  if (key === 'unit' || key === 'u' || key === 'unidades') return 'Unidades'
  if (key === 'l' || key === 'litros') return 'Litros'
  if (key === 'kg' || key === 'kilogramos') return 'Kilogramos'
  return product.baseUnit?.trim() || '—'
}

export function inventoryProductsActiveOnly(products: InventoryProduct[]) {
  return products.filter((product) => product.active !== false)
}

export const INVENTORY_UNKNOWN_COST = 'Sin costo'

export function isInventoryBelowMinimum(
  onHand: number | null | undefined,
  minimumStock: number | null | undefined,
) {
  if (onHand == null || minimumStock == null) return false
  if (!Number.isFinite(onHand) || !Number.isFinite(minimumStock)) return false
  return onHand <= minimumStock
}

export function inventoryLowStockProducts(products: InventoryProduct[]) {
  return inventoryProductsActiveOnly(products).filter((product) => (
    isInventoryBelowMinimum(product.onHand, product.minimumStock)
  ))
}

export function formatInventoryAverageCost(
  averageUnitCost: number | null | undefined,
  baseUnit: string | null | undefined,
  formatMoney: (value: number | null | undefined) => string,
) {
  if (averageUnitCost == null || !Number.isFinite(averageUnitCost)) return INVENTORY_UNKNOWN_COST
  const scale = inventoryDisplayScale(baseUnit)
  const perDisplay = averageUnitCost * scale.factorToPhysical
  return `${formatMoney(perDisplay)} / ${scale.displayUnit}`
}

export function formatInventoryEstimatedValue(
  onHand: number | null | undefined,
  averageUnitCost: number | null | undefined,
  formatMoney: (value: number | null | undefined) => string,
) {
  if (averageUnitCost == null || !Number.isFinite(averageUnitCost)) return INVENTORY_UNKNOWN_COST
  if (onHand == null || !Number.isFinite(onHand)) return '—'
  return formatMoney(onHand * averageUnitCost)
}

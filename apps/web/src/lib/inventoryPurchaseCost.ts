import { convertQuantityToBase, inputUnitsForBase } from '@/lib/recipeUnits'

export const INVENTORY_PURCHASE_COST_MAX = 9999999999.99
export const INVENTORY_PURCHASE_QUANTITY_REQUIRED = 'Indicá el contenido de la compra.'
export const INVENTORY_PURCHASE_COST_REQUIRED = 'Indicá el costo de compra.'
export const INVENTORY_PURCHASE_COST_INVALID = 'Indicá un costo de compra válido.'
export const INVENTORY_PURCHASE_CONVERSION_FAILED =
  'No se puede convertir ese contenido a la unidad del insumo.'
export const INVENTORY_COST_RPC_PENDING =
  'Todavía no se puede guardar el costo de compra del inventario.'

const UNIT_COST_DP = 8

export type InventoryPurchaseCostPlan =
  | {
      ok: true
      quantityInBase: number
      unitCost: number
      purchaseCost: number
    }
  | { ok: false; error: string }

export function roundInventoryUnitCost(value: number) {
  const factor = 10 ** UNIT_COST_DP
  return Math.round(value * factor) / factor
}

export function planInventoryPurchaseCost(input: {
  quantity: string
  inputUnit: string
  baseUnit: string | null | undefined
  purchaseCost: number | null
}): InventoryPurchaseCostPlan {
  const quantity = Number(input.quantity.trim().replace(',', '.'))
  if (!Number.isFinite(quantity) || !(quantity > 0)) {
    return { ok: false, error: INVENTORY_PURCHASE_QUANTITY_REQUIRED }
  }
  const converted = convertQuantityToBase(quantity, input.inputUnit, input.baseUnit)
  if (converted.kind !== 'ok') {
    return { ok: false, error: INVENTORY_PURCHASE_CONVERSION_FAILED }
  }
  if (input.purchaseCost == null || !Number.isFinite(input.purchaseCost)) {
    return { ok: false, error: INVENTORY_PURCHASE_COST_REQUIRED }
  }
  const purchaseCost = Math.round(input.purchaseCost * 100) / 100
  if (purchaseCost < 0 || purchaseCost > INVENTORY_PURCHASE_COST_MAX) {
    return { ok: false, error: INVENTORY_PURCHASE_COST_INVALID }
  }
  return {
    ok: true,
    quantityInBase: converted.quantity,
    purchaseCost,
    unitCost: roundInventoryUnitCost(purchaseCost / converted.quantity),
  }
}

export function inventoryPurchaseInputUnits(baseUnit: string | null | undefined) {
  const units = inputUnitsForBase(baseUnit)
  return units.length > 0 ? units : [{ value: baseUnit?.trim() || 'ml', label: baseUnit?.trim() || 'ml' }]
}

export function inventoryUnitCostLabel(
  unitCost: number | null | undefined,
  baseUnit: string | null | undefined,
  formatCost: (value: number) => string,
) {
  if (unitCost == null || !Number.isFinite(unitCost)) return 'Sin valuación'
  const suffix = baseUnit?.trim() ? ` / ${baseUnit.trim()}` : ''
  return `${formatCost(unitCost)}${suffix}`
}

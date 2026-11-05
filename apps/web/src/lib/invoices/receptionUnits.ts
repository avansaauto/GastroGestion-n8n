export type InventoryDisplayScale = {
  physicalUnit: string
  displayUnit: string
  factorToPhysical: number
}

function canonicalInventoryUnit(unit: string | null | undefined): string {
  const key = unit?.trim().toLowerCase() ?? ''
  if (['ml', 'mililitro', 'mililitros'].includes(key)) return 'ml'
  if (['g', 'gr', 'grs', 'gramo', 'gramos'].includes(key)) return 'g'
  if (['unit', 'u', 'un', 'unid', 'unidad', 'unidades'].includes(key)) return 'unit'
  if (['l', 'lt', 'lts', 'litro', 'litros'].includes(key)) return 'l'
  if (['kg', 'kilo', 'kilos', 'kilogramo', 'kilogramos'].includes(key)) return 'kg'
  return key
}

export function inventoryDisplayScale(baseUnit: string | null | undefined): InventoryDisplayScale {
  const physical = canonicalInventoryUnit(baseUnit)
  if (physical === 'ml') return { physicalUnit: 'ml', displayUnit: 'L', factorToPhysical: 1000 }
  if (physical === 'g') return { physicalUnit: 'g', displayUnit: 'kg', factorToPhysical: 1000 }
  if (physical === 'unit') return { physicalUnit: 'unit', displayUnit: 'u', factorToPhysical: 1 }
  if (physical === 'l') return { physicalUnit: 'l', displayUnit: 'L', factorToPhysical: 1 }
  if (physical === 'kg') return { physicalUnit: 'kg', displayUnit: 'kg', factorToPhysical: 1 }
  return {
    physicalUnit: physical || 'u',
    displayUnit: physical || 'u',
    factorToPhysical: 1,
  }
}

export function physicalToDisplay(quantity: number | null | undefined, baseUnit: string | null | undefined): number | null {
  if (quantity == null || !Number.isFinite(quantity)) return null
  const scale = inventoryDisplayScale(baseUnit)
  return Number((quantity / scale.factorToPhysical).toFixed(6))
}

export function displayToPhysical(quantity: number, baseUnit: string | null | undefined): number {
  const scale = inventoryDisplayScale(baseUnit)
  return Number((quantity * scale.factorToPhysical).toFixed(6))
}

export function formatInventoryUnit(baseUnit: string | null | undefined): string {
  return inventoryDisplayScale(baseUnit).displayUnit
}

export function formatDisplayQuantity(
  quantity: number | null | undefined,
  baseUnit: string | null | undefined,
  formatNumber: (value: number | null | undefined) => string,
): string {
  return `${formatNumber(physicalToDisplay(quantity, baseUnit))} ${formatInventoryUnit(baseUnit)}`
}

export function parseDisplayQuantity(value: string, options?: { allowZero?: boolean }): number | null {
  const trimmed = value.trim().replace(',', '.')
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  if (parsed === 0) return options?.allowZero ? 0 : null
  return parsed
}

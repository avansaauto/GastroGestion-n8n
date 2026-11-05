export const INVENTORY_BASE_UNITS = ['g', 'ml', 'unit'] as const

export type InventoryBaseUnit = (typeof INVENTORY_BASE_UNITS)[number]

const UNIT_ALIASES: Record<string, InventoryBaseUnit> = {
  g: 'g',
  gr: 'g',
  gramo: 'g',
  gramos: 'g',
  ml: 'ml',
  mililitro: 'ml',
  mililitros: 'ml',
  unit: 'unit',
  u: 'unit',
  un: 'unit',
  unid: 'unit',
  unidad: 'unit',
  unidades: 'unit',
}

export function normalizeInventoryName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function parseInventoryBaseUnit(value: string): InventoryBaseUnit {
  const key = value.trim().toLowerCase()
  const unit = UNIT_ALIASES[key]
  if (!unit) {
    throw new Error('INVALID_BASE_UNIT')
  }
  return unit
}

export function inventoryUnitLabel(unit: string | null | undefined): string {
  const key = unit?.trim().toLowerCase()
  if (key === 'g' || key === 'gr' || key === 'gramo' || key === 'gramos') return 'Gramos'
  if (key === 'ml' || key === 'mililitro' || key === 'mililitros') return 'Mililitros'
  if (key === 'unit' || key === 'u' || key === 'unidad' || key === 'unidades') return 'Unidades'
  if (key === 'l' || key === 'lt' || key === 'lts' || key === 'litro' || key === 'litros') return 'Litros'
  if (key === 'kg' || key === 'kilo' || key === 'kilos' || key === 'kilogramo' || key === 'kilogramos') {
    return 'Kilogramos'
  }
  return unit?.trim() || '—'
}

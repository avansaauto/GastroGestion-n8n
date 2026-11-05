import type { InventoryProductOption } from './types'

export function filterCatalogProducts(products: InventoryProductOption[], search: string) {
  const term = search.trim().toLocaleLowerCase('es')
  if (!term) return products
  return products.filter((product) => product.name.toLocaleLowerCase('es').includes(term))
}

export function mappingPickerTriggerLabel(
  selected: Pick<InventoryProductOption, 'name'> | null,
  loading: boolean,
) {
  if (loading && !selected) return 'Cargando insumos…'
  if (!selected) return 'Seleccionar insumo'
  return selected.name
}

export type MappingPickerKeyAction = 'open' | 'close' | 'next' | 'prev' | 'select' | 'ignore'

export function mappingPickerKeyAction(key: string, open: boolean): MappingPickerKeyAction {
  if (key === 'Escape') return open ? 'close' : 'ignore'
  if (!open && (key === 'ArrowDown' || key === 'Enter' || key === ' ')) return 'open'
  if (!open) return 'ignore'
  if (key === 'ArrowDown') return 'next'
  if (key === 'ArrowUp') return 'prev'
  if (key === 'Enter') return 'select'
  return 'ignore'
}

export function cycleHighlight(current: number, delta: number, length: number) {
  if (length <= 0) return 0
  return (current + delta + length) % length
}

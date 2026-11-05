/**
 * Visualización y conversión comercial ↔ base.
 *
 * Con presentation_unit + conversion_factor confiables, el stock se muestra en
 * unidades comerciales (u). La base (g/ml) queda interna y como equivalencia
 * secundaria. Sin presentación persistida, se mantiene el display SI (g→kg, ml→L).
 *
 * Display comercial en `u`:
 * - `divisible !== false` (true o null) → ceil (envases equivalentes abiertos)
 * - `divisible === false` → floor (envases completos)
 * No usar en formularios / CPP / consumos (seguir physicalToCommercial).
 */

import {
  displayToPhysical,
  formatDisplayQuantity,
  formatInventoryUnit,
  physicalToDisplay,
} from '@/lib/invoices/receptionUnits'

export type InventoryPresentationLike = {
  baseUnit?: string | null
  presentationUnit?: string | null
  conversionFactor?: number | null
  /** Si false, solo consumos en unidad de presentación (enteros). */
  divisible?: boolean | null
}

/** Tolerancia para no subir de piso por ruido de punto flotante (p. ej. 2.0000000002 → 2). */
const COMMERCIAL_DISPLAY_EPS = 1e-9

function roundQty(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function canonicalPresentationUnit(unit: string | null | undefined): 'u' | null {
  const key = unit?.trim().toLowerCase() ?? ''
  if (['u', 'unit', 'un', 'unid', 'unidad', 'unidades'].includes(key)) return 'u'
  return null
}

/** Presentación recuperable: factor positivo + unidad comercial u. */
export function hasReliableCommercialPresentation(
  product: InventoryPresentationLike | null | undefined,
): boolean {
  if (!product) return false
  if (canonicalPresentationUnit(product.presentationUnit) == null) return false
  const factor = product.conversionFactor
  return factor != null && Number.isFinite(factor) && factor > 0
}

/** Misma semántica que allowsPartialBaseConsumption: null se trata como divisible. */
export function usesCommercialCeilDisplay(
  product: InventoryPresentationLike | null | undefined,
): boolean {
  return hasReliableCommercialPresentation(product) && product?.divisible !== false
}

export function commercialUnitLabel(product: InventoryPresentationLike | null | undefined): string {
  if (hasReliableCommercialPresentation(product)) return 'u'
  return formatInventoryUnit(product?.baseUnit)
}

export function physicalToCommercial(
  physical: number | null | undefined,
  product: InventoryPresentationLike | null | undefined,
): number | null {
  if (physical == null || !Number.isFinite(physical)) return null
  if (!hasReliableCommercialPresentation(product)) {
    return physicalToDisplay(physical, product?.baseUnit)
  }
  return roundQty(physical / Number(product!.conversionFactor))
}

/**
 * Cantidad comercial solo para UI.
 * Divisible (o null) + presentación u: ceil(stock_base / factor).
 * No usar en formularios, ajustes ni cálculos.
 */
export function commercialPackagesForDisplay(
  physical: number | null | undefined,
  product: InventoryPresentationLike | null | undefined,
): number | null {
  if (physical == null || !Number.isFinite(physical)) return null
  if (!hasReliableCommercialPresentation(product)) {
    return physicalToDisplay(physical, product?.baseUnit)
  }
  const factor = Number(product!.conversionFactor)
  if (!(factor > 0)) return null
  if (physical === 0) return 0

  const ceilDisplay = usesCommercialCeilDisplay(product)
  if (physical < 0) {
    if (ceilDisplay) {
      return -Math.ceil(Math.abs(physical) / factor - COMMERCIAL_DISPLAY_EPS)
    }
    return -Math.floor(Math.abs(physical) / factor + COMMERCIAL_DISPLAY_EPS)
  }

  // Barril 99500/50000 → 2 u (no 1,99 ni 1).
  if (ceilDisplay) {
    const packages = Math.ceil(physical / factor - COMMERCIAL_DISPLAY_EPS)
    return packages < 0 ? 0 : packages
  }

  const complete = Math.floor(physical / factor + COMMERCIAL_DISPLAY_EPS)
  return complete < 0 ? 0 : complete
}

export function commercialToPhysicalQty(
  commercial: number,
  product: InventoryPresentationLike | null | undefined,
): number | null {
  if (!Number.isFinite(commercial)) return null
  if (!hasReliableCommercialPresentation(product)) {
    return displayToPhysical(commercial, product?.baseUnit)
  }
  return roundQty(commercial * Number(product!.conversionFactor))
}

export function formatCommercialQuantity(
  physical: number | null | undefined,
  product: InventoryPresentationLike | null | undefined,
  formatNumber: (value: number | null | undefined) => string,
  options?: { withBaseEquivalence?: boolean },
): string {
  if (physical == null || !Number.isFinite(physical)) return '—'

  if (!hasReliableCommercialPresentation(product)) {
    return formatDisplayQuantity(physical, product?.baseUnit, formatNumber)
  }

  const commercial = commercialPackagesForDisplay(physical, product)
  const primary = `${formatNumber(commercial)} u`
  if (!options?.withBaseEquivalence) return primary

  const baseLabel = formatDisplayQuantity(physical, product?.baseUnit, formatNumber)
  if (physical >= 0) return `${primary} · ${baseLabel} disponibles`
  return `${primary} · ${baseLabel}`
}

export function allowsPartialBaseConsumption(
  product: InventoryPresentationLike | null | undefined,
): boolean {
  if (!hasReliableCommercialPresentation(product)) return true
  return product?.divisible !== false
}

export function isWholeCommercialQuantity(quantity: number): boolean {
  if (!Number.isFinite(quantity) || quantity <= 0) return false
  return Math.abs(quantity - Math.round(quantity)) < 1e-9
}

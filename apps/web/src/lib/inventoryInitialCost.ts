/**
 * Costo inicial de mercadería preexistente.
 * Reutiliza senda_set_inventory_purchase_cost (source=manual).
 * No inventa $0 si el campo está vacío. No mueve stock.
 */

import {
  quantityToStoredPhysical,
  showsContentPerUnitSection,
} from '@/lib/inventoryCreateForm'
import { roundInventoryUnitCost } from '@/lib/inventoryPurchaseCost'

export const INITIAL_COST_MAX = 9999999999.99

export type InitialCostBasis = 'presentation' | 'stock'

export type InitialAcquisitionCostPlan =
  | { ok: true; skip: true }
  | {
      ok: true
      skip: false
      purchaseQuantity: number
      purchaseCost: number
      unitCost: number
      costLabel: string
    }
  | { ok: false; error: string }

function parseCostDisplay(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(',', '.')
  if (!trimmed) return { ok: true, value: null }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: 'Indicá un costo inicial válido.' }
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0 || value > INITIAL_COST_MAX) {
    return { ok: false, error: 'Indicá un costo inicial válido.' }
  }
  return { ok: true, value }
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

export function defaultInitialCostBasis(input: {
  stockUnit: string
  contentEnabled?: boolean
  conversionFactor?: number | null
}): InitialCostBasis {
  if (
    showsContentPerUnitSection(input.stockUnit)
    && input.contentEnabled
    && input.conversionFactor != null
    && input.conversionFactor > 0
  ) {
    return 'presentation'
  }
  return 'stock'
}

export function initialCostBasisLabel(basis: InitialCostBasis, stockUnit: string, baseUnit?: string | null) {
  if (basis === 'presentation') return 'Costo inicial por u'
  const key = (stockUnit || baseUnit || '').trim()
  if (key === 'u' || key === 'unit') return 'Costo inicial por unidad'
  if (key === 'g') return 'Costo inicial por g'
  if (key === 'kg') return 'Costo inicial por kg'
  if (key === 'ml') return 'Costo inicial por ml'
  if (key === 'L' || key === 'l') return 'Costo inicial por L'
  return 'Costo inicial por unidad base'
}

/**
 * Planifica el payload de purchase-cost a partir del precio informado.
 * - Vacío → skip (no escribe valuación ni inventa 0).
 * - presentation → $ por u comercial; convierte a $/base con el factor.
 * - stock → $ por la unidad del formulario (u/g/kg/ml/L).
 */
export function planInitialAcquisitionCost(input: {
  costDisplay: string
  basis: InitialCostBasis
  stockUnit: string
  /** Cantidad en unidad de stock (alta) o unidades comerciales equivalentes al on-hand. */
  quantityDisplay: string
  contentEnabled?: boolean
  contentQuantity?: string
  contentUnit?: string
  /** Factor persistido (ml o g por u). Obliga basis=presentation. */
  conversionFactor?: number | null
}): InitialAcquisitionCostPlan {
  const parsedCost = parseCostDisplay(input.costDisplay)
  if (!parsedCost.ok) return parsedCost
  if (parsedCost.value == null) return { ok: true, skip: true }

  const unitPrice = parsedCost.value
  const stockUnit = input.stockUnit.trim() || 'u'
  const qtyRaw = input.quantityDisplay.trim().replace(',', '.')
  const qty = qtyRaw ? Number(qtyRaw) : null
  if (qtyRaw && (!Number.isFinite(qty) || qty == null || !(qty > 0))) {
    return { ok: false, error: 'Indicá una cantidad válida para el costo inicial.' }
  }

  const content = input.contentEnabled
    && showsContentPerUnitSection(stockUnit)
    && input.contentQuantity
    && Number(input.contentQuantity) > 0
    ? {
        quantity: Number(String(input.contentQuantity).replace(',', '.')),
        unit: (input.contentUnit ?? 'ml').trim() || 'ml',
      }
    : null

  if (input.basis === 'presentation') {
    let factor = input.conversionFactor ?? null
    if ((factor == null || !(factor > 0)) && content) {
      const probe = quantityToStoredPhysical(1, 'u', content)
      if (!probe.ok) return probe
      factor = probe.contentPerUnitPhysical
    }
    if (factor == null || !(factor > 0)) {
      return { ok: false, error: 'Para costear por u necesitás el contenido por unidad.' }
    }
    const units = qty != null && qty > 0 ? qty : 1
    const purchaseQuantity = Math.round(units * factor * 1_000_000) / 1_000_000
    const purchaseCost = roundMoney(unitPrice * units)
    return {
      ok: true,
      skip: false,
      purchaseQuantity,
      purchaseCost,
      unitCost: roundInventoryUnitCost(purchaseCost / purchaseQuantity),
      costLabel: initialCostBasisLabel('presentation', stockUnit),
    }
  }

  // basis = stock (unidad del formulario)
  const units = qty != null && qty > 0 ? qty : 1
  const converted = quantityToStoredPhysical(units, stockUnit, content)
  if (!converted.ok) return converted
  if (!(converted.physical > 0)) {
    return { ok: false, error: 'Indicá una cantidad válida para el costo inicial.' }
  }
  const purchaseCost = roundMoney(unitPrice * units)
  return {
    ok: true,
    skip: false,
    purchaseQuantity: converted.physical,
    purchaseCost,
    unitCost: roundInventoryUnitCost(purchaseCost / converted.physical),
    costLabel: initialCostBasisLabel('stock', stockUnit, converted.baseUnit),
  }
}

/** Equivalente comercial del stock físico (para edición posterior). */
export function commercialQuantityFromOnHand(
  onHand: number | null | undefined,
  conversionFactor: number | null | undefined,
): number | null {
  if (onHand == null || !Number.isFinite(onHand) || !(onHand > 0)) return null
  if (conversionFactor == null || !(conversionFactor > 0)) return null
  return Math.round((onHand / conversionFactor) * 1_000_000) / 1_000_000
}

export function canRegisterInitialValuation(averageUnitCost: number | null | undefined) {
  return averageUnitCost == null || !Number.isFinite(averageUnitCost)
}

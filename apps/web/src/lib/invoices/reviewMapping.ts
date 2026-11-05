import {
  matchExistingIngredient,
  suggestFromConfirmedMemory,
  type ConfirmedMappingMemory,
  type InvoiceMappingSuggestion,
} from './invoiceMemory'
import {
  declaredInventoryBaseUnit,
  preloadInventoryName,
  suggestInventoryBaseUnit,
} from './invoiceCreateProduct'
import {
  conversionMessage,
  previewPhysicalQuantity,
  resolvePhysicalConversion,
  type PhysicalConversion,
} from './mapping'
import { canEditReviewReceived } from './reviewReceived'
import { formatComprehensibleQuantity, presentationQuestion } from './presentation'
import type { InvoiceAnalysisLine, InventoryProductOption } from './types'

export type ReviewMappingCreateIntent = {
  name: string
  baseUnit: 'g' | 'ml' | 'unit'
  category: string | null
  minimumStock: number | null
  reactivateProductId?: string | null
  reactivateProductName?: string | null
}

export type ReviewMappingDraft = {
  inventoryProductId: string
  approximateAccepted: boolean
  /** Factor manual cuando la unidad de factura es empaque (caja, pack, pieza…). */
  conversionFactor: number | null
  action: 'link_existing' | 'create' | 'reactivate' | 'pending'
  /** Alta diferida: se materializa solo en confirm-intake. */
  createIntent: ReviewMappingCreateIntent | null
}

export type ReviewMappingDrafts = Record<string, ReviewMappingDraft>
export type ReviewMappingSuggestions = Record<string, InvoiceMappingSuggestion | null>

export function emptyReviewMappingDraft(): ReviewMappingDraft {
  return {
    inventoryProductId: '',
    approximateAccepted: false,
    conversionFactor: null,
    action: 'pending',
    createIntent: null,
  }
}

/** Factor = cantidad física analizada / cantidad comercial (si ambas existen). */
export function conversionFactorFromPhysical(line: InvoiceAnalysisLine): number | null {
  if (
    line.inventoryPhysicalQuantity == null
    || line.inventoryPhysicalQuantity <= 0
    || line.quantity == null
    || line.quantity <= 0
  ) {
    return null
  }
  // Física no enriquecida (igual a la comercial): no inventar factor 1.
  // La conversión SI (L→ml, kg→g) se resuelve aparte; acá solo vale presentación/Cant. KG.
  if (line.inventoryPhysicalQuantity === line.quantity) return null
  const factor = Number((line.inventoryPhysicalQuantity / line.quantity).toFixed(6))
  return Number.isFinite(factor) && factor > 0 ? factor : null
}

/** Costo unitario neto = importe de línea / cantidad física (sin IVA). */
export function estimateNetUnitCost(
  lineAmount: number | null | undefined,
  physicalQuantity: number | null | undefined,
): number | null {
  if (
    lineAmount == null
    || !Number.isFinite(lineAmount)
    || physicalQuantity == null
    || !Number.isFinite(physicalQuantity)
    || physicalQuantity <= 0
  ) {
    return null
  }
  return Number((lineAmount / physicalQuantity).toFixed(8))
}

/**
 * Resuelve factura → inventario usando, en orden:
 * 1) factor explícito del borrador
 * 2) conversión SI (kg→g, L→ml) cuando aplica
 * 3) inventoryPhysicalQuantity del análisis (barra/plancha/Cant. KG / uni con peso)
 *
 * Una familia distinta (kg→ml) sigue siendo incompatible aunque haya un número físico.
 * Empaque o unidad vacía usan el factor explícito o la cantidad física ya calculada.
 */
export function resolveLineInventoryConversion(
  line: InvoiceAnalysisLine,
  inventoryBaseUnit: string | null | undefined,
  draftFactor: number | null = null,
): { conversion: PhysicalConversion; factor: number | null; physical: number | null } {
  const fromPhysical = conversionFactorFromPhysical(line)
  const explicit =
    draftFactor != null && draftFactor > 0
      ? draftFactor
      : null

  const conversion = resolvePhysicalConversion(line.unit, inventoryBaseUnit)
  // SI (L→ml, kg→g): manda sobre un factor de memoria erróneo (p. ej. 1).
  // Empaque/uni→g (EQUIVALENCE) usa factor explícito o física analizada.
  if (conversion.ok) {
    return {
      conversion,
      factor: conversion.factor,
      physical: previewPhysicalQuantity(line.quantity, conversion.factor),
    }
  }
  if (conversion.code === 'INCOMPATIBLE_UNITS') {
    return { conversion, factor: null, physical: null }
  }

  if (explicit != null) {
    return {
      conversion: { ok: true, factor: explicit },
      factor: explicit,
      physical: previewPhysicalQuantity(line.quantity, explicit),
    }
  }

  if (fromPhysical != null && fromPhysical > 0) {
    return {
      conversion: { ok: true, factor: fromPhysical },
      factor: fromPhysical,
      physical: line.inventoryPhysicalQuantity > 0
        ? line.inventoryPhysicalQuantity
        : previewPhysicalQuantity(line.quantity, fromPhysical),
    }
  }

  // Física total conocida aunque conversionFactorFromPhysical la haya descartado.
  if (
    line.inventoryPhysicalQuantity > 0
    && line.quantity != null
    && line.quantity > 0
    && line.inventoryPhysicalQuantity !== line.quantity
  ) {
    const factor = Number((line.inventoryPhysicalQuantity / line.quantity).toFixed(6))
    if (Number.isFinite(factor) && factor > 0) {
      return {
        conversion: { ok: true, factor },
        factor,
        physical: line.inventoryPhysicalQuantity,
      }
    }
  }

  // kg→ml u otras familias distintas: INCOMPATIBLE (no pedir factor inventado).
  // Empaque sin física ya viene como EQUIVALENCE_REQUIRED desde resolvePhysicalConversion.
  return { conversion, factor: null, physical: null }
}

function lineContentUnit(line: InvoiceAnalysisLine): string | null {
  return line.contentUnit ?? null
}

export function proposeCreateMappingDraft(line: InvoiceAnalysisLine): ReviewMappingDraft {
  const name = preloadInventoryName(line.name || line.originalDescription)
  const baseUnit = suggestInventoryBaseUnit(
    line.name || line.originalDescription,
    line.unit,
    lineContentUnit(line),
  )
  const auto = resolvePhysicalConversion(line.unit, baseUnit)
  const resolved = resolveLineInventoryConversion(line, baseUnit, null)
  return {
    inventoryProductId: '',
    approximateAccepted: false,
    // Si SI no alcanza (barra→g), persistir el factor derivado de la física analizada.
    conversionFactor: auto.ok ? null : resolved.factor,
    action: name.trim().length >= 2 ? 'create' : 'pending',
    createIntent: name.trim().length >= 2
      ? {
        name,
        baseUnit,
        category: null,
        minimumStock: null,
      }
      : null,
  }
}

export function analysisLineForMemory(line: InvoiceAnalysisLine) {
  return {
    original: { description: line.originalDescription, quantity: line.quantity },
    reviewed: { description: line.name || line.originalDescription, quantity: line.quantity },
    mappingStatus: 'unmapped',
    inventoryProductId: null,
  }
}

function linkExistingDraft(
  line: InvoiceAnalysisLine,
  productId: string,
  baseUnit: string | null,
  preferredFactor: number | null,
): ReviewMappingDraft | null {
  const direct = resolvePhysicalConversion(line.unit, baseUnit)
  const declared = declaredInventoryBaseUnit(lineContentUnit(line))
    ?? declaredInventoryBaseUnit(line.unit)
  const baseCompatible = !declared || baseUnit === declared
  const incompatible = !direct.ok && direct.code === 'INCOMPATIBLE_UNITS'
  const resolved = resolveLineInventoryConversion(line, baseUnit, preferredFactor)
  if (!baseCompatible || incompatible || !resolved.conversion.ok || resolved.factor == null) return null
  return {
    inventoryProductId: productId,
    approximateAccepted: false,
    conversionFactor: direct.ok ? null : resolved.factor,
    action: 'link_existing',
    createIntent: null,
  }
}

export function hydrateReviewMappingDrafts(
  lines: InvoiceAnalysisLine[],
  memories: ConfirmedMappingMemory[],
  existing: ReviewMappingDrafts = {},
  products: InventoryProductOption[] = [],
  organizationId?: string | null,
): { drafts: ReviewMappingDrafts; suggestions: ReviewMappingSuggestions } {
  const drafts: ReviewMappingDrafts = {}
  const suggestions: ReviewMappingSuggestions = {}
  for (const line of lines) {
    if (!canEditReviewReceived(line)) continue
    const suggestion = suggestFromConfirmedMemory(analysisLineForMemory(line), memories)
    suggestions[line.id] = suggestion
    if (existing[line.id]) {
      const current = existing[line.id]
      if (current.action === 'create' && current.createIntent && products.length > 0) {
        const match = matchExistingIngredient(
          current.createIntent.name,
          current.createIntent.baseUnit,
          products,
          organizationId,
        )
        if (match.status === 'reuse') {
          const linked = linkExistingDraft(line, match.product.id, match.product.baseUnit, current.conversionFactor)
          drafts[line.id] = linked ?? current
          continue
        }
        if (match.status === 'ambiguous' || match.status === 'unit_mismatch') {
          drafts[line.id] = emptyReviewMappingDraft()
          continue
        }
      }
      drafts[line.id] = current
      continue
    }
    const exact = suggestion?.kind === 'exact' ? suggestion : null
    if (exact) {
      const memoryFactor = exact.conversionFactor != null && exact.conversionFactor > 0
        ? exact.conversionFactor
        : null
      const linked = linkExistingDraft(
        line,
        exact.inventoryProductId,
        exact.inventoryProduct.baseUnit,
        memoryFactor,
      )
      drafts[line.id] = linked ?? emptyReviewMappingDraft()
      continue
    }
    if (suggestion?.kind === 'approximate') {
      drafts[line.id] = emptyReviewMappingDraft()
      continue
    }
    const proposed = proposeCreateMappingDraft(line)
    const baseUnit = proposed.createIntent?.baseUnit
    const match = baseUnit
      ? matchExistingIngredient(
        proposed.createIntent?.name || line.name || line.originalDescription,
        baseUnit,
        products,
        organizationId,
      )
      : { status: 'none' as const }
    if (match.status === 'reuse') {
      const linked = linkExistingDraft(line, match.product.id, match.product.baseUnit, null)
      drafts[line.id] = linked ?? emptyReviewMappingDraft()
      continue
    }
    if (match.status === 'ambiguous' || match.status === 'unit_mismatch') {
      drafts[line.id] = emptyReviewMappingDraft()
      continue
    }
    drafts[line.id] = proposed
  }
  return { drafts, suggestions }
}

export function reviewMappingConversion(
  line: InvoiceAnalysisLine,
  product: Pick<InventoryProductOption, 'baseUnit'> | null,
  conversionFactor: number | null = null,
) {
  if (!product) {
    return { conversion: null as PhysicalConversion | null, physical: null as number | null }
  }
  const resolved = resolveLineInventoryConversion(line, product.baseUnit, conversionFactor)
  return { conversion: resolved.conversion, physical: resolved.physical }
}

export function reviewMappingPhysicalLabel(
  line: InvoiceAnalysisLine,
  product: Pick<InventoryProductOption, 'baseUnit'> | null,
  conversionFactor: number | null = null,
): string | null {
  const { conversion, physical } = reviewMappingConversion(line, product, conversionFactor)
  if (!product) return null
  if (conversion && !conversion.ok) {
    if (conversion.code === 'EQUIVALENCE_REQUIRED') {
      return presentationQuestion(line.unit, product.baseUnit)
        ?? conversionMessage(conversion.code)
    }
    return conversionMessage(conversion.code)
  }
  if (physical == null) return null
  return formatComprehensibleQuantity(physical, product.baseUnit)
}

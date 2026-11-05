import { recoverCommercialPresentation } from '../modules/invoice-intelligence/normalize.js'
import { canonicalUnit, type InventoryBaseUnit } from './invoiceUnits.js'

/**
 * Evidencia física ya persistida en el análisis original.
 * No recalcula cantidades a partir del nombre comercial.
 */
export type SavedLinePhysicalEvidence = {
  sourceLineId: string
  physicalQuantity: number
  baseUnit: InventoryBaseUnit
  factor: number
  commercialUnit: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positive(value: unknown): number | null {
  const parsed = asNumber(value)
  return parsed != null && parsed > 0 ? parsed : null
}

/** Familia de inventario declarada por la unidad de contenido. No interpreta el nombre. */
export function declaredBaseUnit(unit: string | null | undefined): InventoryBaseUnit | null {
  const key = canonicalUnit(unit)
  if (key === 'kg' || key === 'g' || key === 'mg') return 'g'
  if (key === 'l' || key === 'cl' || key === 'ml') return 'ml'
  if (key === 'unit' || key === 'docena') return 'unit'
  return null
}

function analysisLines(snapshot: unknown): Record<string, unknown>[] {
  if (!isRecord(snapshot)) return []
  const document = isRecord(snapshot.document) ? snapshot.document : snapshot
  const lines = document.lines
  return Array.isArray(lines) ? lines.filter(isRecord) : []
}

function lineId(line: Record<string, unknown>): string | null {
  return asString(line.id) ?? asString(line.lineId) ?? asString(line.line_id)
}

function findAnalysisLine(snapshot: unknown, sourceLineId: string): Record<string, unknown> | null {
  if (!sourceLineId) return null
  return analysisLines(snapshot).find((line) => lineId(line) === sourceLineId) ?? null
}

function interpretationStatus(snapshot: unknown, sourceLineId: string): string | null {
  if (!isRecord(snapshot) || !sourceLineId) return null
  const interpretation = isRecord(snapshot.interpretation) ? snapshot.interpretation : null
  const lines = interpretation && Array.isArray(interpretation.lines) ? interpretation.lines : []
  for (const item of lines) {
    if (!isRecord(item)) continue
    const id = asString(item.lineId) ?? asString(item.line_id)
    if (id === sourceLineId) return asString(item.status)
  }
  return null
}

/**
 * La revisión guardada manda si existe. Si no, se usa el análisis original.
 * requires_review bloquea la recepción hasta una resolución autorizada.
 */
export function commercialReceptionBlocked(
  reviewedAnalysis: unknown,
  originalAnalysis: unknown,
  sourceLineId: string,
): boolean {
  const reviewed = interpretationStatus(reviewedAnalysis, sourceLineId)
  const status = reviewed ?? interpretationStatus(originalAnalysis, sourceLineId)
  return status === 'requires_review'
}

const HISTORICAL_BILLED_KG = 8.88
const HISTORICAL_CONTENT_KG = 8.8
const HISTORICAL_PHYSICAL_G = 8880
const HISTORICAL_REINTERPRETED_G = 8800
const HISTORICAL_UNIT_PRICE = 8213.95
const HISTORICAL_AMOUNT = 72972.75
const HISTORICAL_QUANTITY = 1

function closeTo(value: unknown, expected: number): boolean {
  const parsed = asNumber(value)
  return parsed != null && Math.abs(parsed - expected) < 0.000001
}

function interpretationLine(snapshot: unknown, sourceLineId: string): Record<string, unknown> | null {
  if (!isRecord(snapshot) || !sourceLineId) return null
  const interpretation = isRecord(snapshot.interpretation) ? snapshot.interpretation : null
  const lines = interpretation && Array.isArray(interpretation.lines) ? interpretation.lines : []
  for (const item of lines) {
    if (!isRecord(item)) continue
    const id = asString(item.lineId) ?? asString(item.line_id)
    if (id === sourceLineId) return item
  }
  return null
}

function weightFieldsAbsent(line: Record<string, unknown>): boolean {
  const weight = line.billedWeight ?? line.billed_weight
  const unit = line.billedWeightUnit ?? line.billed_weight_unit
  return (weight == null || weight === '') && (unit == null || unit === '')
}

function sameCommercialIdentity(
  original: Record<string, unknown>,
  reviewed: Record<string, unknown>,
): boolean {
  const originalUnit = asString(original.unit)
  const reviewedUnit = asString(reviewed.unit)
  return originalUnit != null
    && originalUnit === reviewedUnit
    && closeTo(original.quantity, HISTORICAL_QUANTITY)
    && closeTo(reviewed.quantity, HISTORICAL_QUANTITY)
    && closeTo(original.unitPrice, HISTORICAL_UNIT_PRICE)
    && closeTo(reviewed.unitPrice, HISTORICAL_UNIT_PRICE)
    && closeTo(original.amount, HISTORICAL_AMOUNT)
    && closeTo(reviewed.amount, HISTORICAL_AMOUNT)
    && closeTo(original.contentPerUnit ?? original.content_per_unit, HISTORICAL_CONTENT_KG)
    && closeTo(reviewed.contentPerUnit ?? reviewed.content_per_unit, HISTORICAL_CONTENT_KG)
    && canonicalUnit(asString(original.contentUnit ?? original.content_unit)) === 'kg'
    && canonicalUnit(asString(reviewed.contentUnit ?? reviewed.content_unit)) === 'kg'
}

/**
 * Pérdida histórica de billedWeight 8,88 kg al reconstruir la revisión.
 * No autoriza otra discrepancia comercial.
 */
export function historicalBilledWeightLoss(
  originalAnalysis: unknown,
  reviewedAnalysis: unknown,
  sourceLineId: string,
): boolean {
  const original = findAnalysisLine(originalAnalysis, sourceLineId)
  const reviewed = findAnalysisLine(reviewedAnalysis, sourceLineId)
  const originalInterpretation = interpretationLine(originalAnalysis, sourceLineId)
  const reviewedInterpretation = interpretationLine(reviewedAnalysis, sourceLineId)
  if (!original || !reviewed || !originalInterpretation || !reviewedInterpretation) return false
  if (!sameCommercialIdentity(original, reviewed)) return false
  if (!weightFieldsAbsent(reviewed)) return false
  if (!closeTo(original.billedWeight ?? original.billed_weight, HISTORICAL_BILLED_KG)) return false
  if (canonicalUnit(asString(original.billedWeightUnit ?? original.billed_weight_unit)) !== 'kg') return false
  if (!closeTo(original.inventoryPhysicalQuantity ?? original.inventory_physical_quantity, HISTORICAL_PHYSICAL_G)) {
    return false
  }
  if (!closeTo(reviewed.inventoryPhysicalQuantity ?? reviewed.inventory_physical_quantity, HISTORICAL_REINTERPRETED_G)) {
    return false
  }

  const originalPhysical = isRecord(originalInterpretation.physical) ? originalInterpretation.physical : null
  const reviewedPhysical = isRecord(reviewedInterpretation.physical) ? reviewedInterpretation.physical : null
  if (!originalPhysical || !reviewedPhysical) return false
  return interpretationStatus(originalAnalysis, sourceLineId) === 'confirmed'
    && asString(originalPhysical.priceBasis) === 'weight'
    && closeTo(originalPhysical.billedWeight, HISTORICAL_BILLED_KG)
    && closeTo(originalPhysical.proposedQuantity, HISTORICAL_PHYSICAL_G)
    && interpretationStatus(reviewedAnalysis, sourceLineId) === 'requires_review'
    && asString(reviewedPhysical.priceBasis) === 'ambiguous'
    && (reviewedPhysical.billedWeight == null || reviewedPhysical.billedWeight === '')
    && closeTo(reviewedPhysical.proposedQuantity, HISTORICAL_REINTERPRETED_G)
}

export function lineCorrectionExplainsDifference(
  corrections: unknown,
  sourceLineId: string,
  documentLineId: string,
): boolean {
  if (!isRecord(corrections) || !Array.isArray(corrections.lines)) return false
  return corrections.lines.some((line) => {
    if (!isRecord(line)) return false
    const id = asString(line.id)
    return id === sourceLineId || id === documentLineId
  })
}

export function commercialDecisionTargetsLine(
  decisions: unknown,
  sourceLineId: string,
): boolean {
  if (!Array.isArray(decisions)) return false
  return decisions.some((decision) => {
    if (!isRecord(decision)) return false
    if (asString(decision.targetLineId) === sourceLineId) return true
    if (asString(decision.lineId) === sourceLineId) return true
    const adjustments = decision.adjustmentLineIds
    return Array.isArray(adjustments) && adjustments.some((id) => id === sourceLineId)
  })
}

export const HISTORICAL_BILLED_WEIGHT_RECEIVE_G = HISTORICAL_PHYSICAL_G

function billedPhysical(line: Record<string, unknown>): { quantity: number; baseUnit: InventoryBaseUnit } | null {
  const billed = positive(line.billedWeight ?? line.billed_weight)
  if (billed == null) return null
  const unit = asString(line.billedWeightUnit ?? line.billed_weight_unit) ?? 'kg'
  const base = declaredBaseUnit(unit)
  if (!base) return null
  if (base === 'g' && canonicalUnit(unit) === 'kg') return { quantity: billed * 1000, baseUnit: 'g' }
  if (base === 'ml' && canonicalUnit(unit) === 'l') return { quantity: billed * 1000, baseUnit: 'ml' }
  return { quantity: billed, baseUnit: base }
}

/**
 * Lee presentación, cantidad física, unidad base y factor desde el análisis original,
 * emparejando por source_line_id. Si no hay contenido o peso facturado persistido,
 * no inventa una equivalencia.
 */
export function recoveredPhysicalEvidence(
  originalAnalysis: unknown,
  sourceLineId: string,
  commercialQuantity: number,
): SavedLinePhysicalEvidence | null {
  if (!sourceLineId || !(commercialQuantity > 0)) return null
  const line = findAnalysisLine(originalAnalysis, sourceLineId)
  if (!line) return null

  const contentUnit = asString(line.contentUnit ?? line.content_unit)
  const content = positive(line.contentPerUnit ?? line.content_per_unit)
  const contentBase = declaredBaseUnit(contentUnit)
  const billed = billedPhysical(line)
  const hasEvidence = Boolean((content != null && contentBase) || billed)
  if (!hasEvidence) return null

  const baseUnit = contentBase ?? billed?.baseUnit ?? null
  if (!baseUnit) return null

  const persisted = positive(line.inventoryPhysicalQuantity ?? line.inventory_physical_quantity)
  const physicalQuantity = persisted ?? billed?.quantity ?? null
  if (physicalQuantity == null) return null

  const storedUnit = asString(line.unit)
  const description = asString(line.originalDescription)
    ?? asString(line.original_description)
    ?? asString(line.description_original)
    ?? asString(line.name)
  const commercialUnit = storedUnit ?? recoverCommercialPresentation(description, null)

  return {
    sourceLineId,
    physicalQuantity,
    baseUnit,
    factor: physicalQuantity / commercialQuantity,
    commercialUnit,
  }
}

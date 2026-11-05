import type {
  InvoiceAnalysisResult,
  InvoiceIssue,
  InvoiceLineInterpretation,
  NormalizedInvoiceLine,
} from './types.js'

/** Comprobaciones que esta función no puede resolver: no hay acceso a base ni a política. */
export const UNRESOLVED_ELIGIBILITY_CONTEXT = [
  'organization',
  'location',
  'exact_product_links',
  'duplicate_detection',
  'reception_policy',
] as const

export type UnresolvedEligibilityContext = (typeof UNRESOLVED_ELIGIBILITY_CONTEXT)[number]

export type EligibilityReason = {
  code: string
  message: string
  lineId?: string
}

/**
 * blocked: el comprobante no puede avanzar a una recepción automática.
 * preliminary_ok: las reglas del documento no bloquean. No autoriza a guardar ni a mover stock.
 */
export type DocumentEligibilityDecision = 'blocked' | 'preliminary_ok'

export type ReceptionEligibility = {
  documentDecision: DocumentEligibilityDecision
  /** Siempre undetermined: faltan organización, sucursal, vínculos, duplicados y política. */
  definitive: 'undetermined'
  /** Esta etapa nunca autoriza la recepción automática. */
  autoApprovable: false
  reasons: EligibilityReason[]
  unresolvedContext: readonly UnresolvedEligibilityContext[]
}

const INVENTORY_BASE_UNITS = new Set(['g', 'ml', 'unit'])

function reasonFromIssue(item: InvoiceIssue): EligibilityReason {
  return {
    code: item.code,
    message: item.message,
    ...(item.lineId ? { lineId: item.lineId } : {}),
  }
}

function isStockLine(line: NormalizedInvoiceLine): boolean {
  return line.classification === 'stock' && line.inventoryEligibility !== 'ineligible'
}

function physicalAndPriceResolved(
  line: NormalizedInvoiceLine,
  interpretation: InvoiceLineInterpretation | undefined,
): EligibilityReason | null {
  const label = line.name || line.originalDescription || 'línea'
  if (!interpretation) {
    return {
      code: 'LINE_INTERPRETATION_MISSING',
      message: `No hay interpretación comercial para "${label}".`,
      lineId: line.id,
    }
  }
  if (interpretation.pendingFields.length > 0 || interpretation.status === 'requires_review' || interpretation.status === 'proposed') {
    return {
      code: 'LINE_REVIEW_PENDING',
      message: `La línea "${label}" requiere revisión antes de una recepción automática.`,
      lineId: line.id,
    }
  }
  const quantity = interpretation.physical.proposedQuantity
  const unit = interpretation.physical.unit
  if (
    interpretation.physical.movement !== 'inbound'
    || quantity == null
    || quantity <= 0
    || !unit
    || !INVENTORY_BASE_UNITS.has(unit)
  ) {
    return {
      code: 'PHYSICAL_QUANTITY_UNRESOLVED',
      message: `No hay cantidad física en unidad de inventario para "${label}".`,
      lineId: line.id,
    }
  }
  if (interpretation.physical.priceBasis == null || interpretation.physical.priceBasis === 'ambiguous') {
    return {
      code: 'PRICE_BASIS_UNRESOLVED',
      message: `No se pudo determinar si el precio de "${label}" es por unidad comercial o por peso.`,
      lineId: line.id,
    }
  }
  if (line.unitPrice == null || line.amount == null) {
    return {
      code: 'PRICE_OR_AMOUNT_MISSING',
      message: `Falta precio o importe en "${label}".`,
      lineId: line.id,
    }
  }
  return null
}

/**
 * Evalúa solo el análisis ya calculado. No consulta organización, sucursal,
 * catálogo, duplicados ni política, y no escribe nada.
 */
export function evaluateReceptionEligibility(
  result: InvoiceAnalysisResult,
): ReceptionEligibility {
  const reasons: EligibilityReason[] = []

  for (const item of result.validation.errors) reasons.push(reasonFromIssue(item))
  for (const item of result.validation.warnings) {
    if (item.blocksReception) reasons.push(reasonFromIssue(item))
  }
  for (const item of result.validation.pendingConfirmations) {
    if (item.blocksReception) reasons.push(reasonFromIssue(item))
  }

  const openRelations = result.interpretation.relations.filter(
    (relation) => relation.status === 'proposed' || relation.status === 'requires_review',
  )
  if (result.interpretation.blocksReception || result.interpretation.unresolvedLineIds.length > 0 || openRelations.length > 0) {
    reasons.push({
      code: 'COMMERCIAL_RELATIONS_UNRESOLVED',
      message: 'Hay relaciones comerciales sin resolver.',
    })
  }

  const interpretationByLine = new Map(
    result.interpretation.lines.map((line) => [line.lineId, line]),
  )
  for (const line of result.document.lines) {
    if (!isStockLine(line)) continue
    const gap = physicalAndPriceResolved(line, interpretationByLine.get(line.id))
    if (gap) reasons.push(gap)
  }

  const unique = new Map<string, EligibilityReason>()
  for (const item of reasons) {
    const key = `${item.code}:${item.lineId ?? ''}:${item.message}`
    if (!unique.has(key)) unique.set(key, item)
  }

  return {
    documentDecision: unique.size > 0 ? 'blocked' : 'preliminary_ok',
    definitive: 'undetermined',
    autoApprovable: false,
    reasons: [...unique.values()],
    unresolvedContext: UNRESOLVED_ELIGIBILITY_CONTEXT,
  }
}

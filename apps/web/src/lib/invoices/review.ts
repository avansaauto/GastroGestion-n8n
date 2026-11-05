import { canonicalUnit } from './mapping'
import type {
  CommercialRelationDecision,
  InvoiceAnalysisApiResult,
  InvoiceAnalysisLine,
  InvoiceCommercialDecisionPayload,
  InvoiceCommercialRelation,
  LocalRelationDecision,
} from './types'

export const DOCUMENT_CLASSIFICATION_LABEL: Record<string, string> = {
  gastronomic_merchandise: 'Mercadería gastronómica',
  service: 'Servicio',
  public_service: 'Servicio',
  administrative_expense: 'Gasto administrativo',
  rent: 'Alquiler',
  professional_fees: 'Honorarios',
  maintenance: 'Mantenimiento',
  equipment: 'Equipamiento',
  logistics: 'Logística',
  tax: 'Impuesto',
  mixed: 'Mixta',
  ambiguous: 'Requiere clasificación',
}

export const LINE_CLASSIFICATION_LABEL: Record<string, string> = {
  stock: 'Mercadería',
  service: 'Servicio',
  expense: 'Gasto',
  logistics: 'Logística',
  fiscal: 'Fiscal',
  pending_review: 'Revisión pendiente',
  ignored: 'Ignorada',
}

export const SERVICE_TYPE_LABEL: Record<string, string> = {
  gas: 'Gas',
  electricity: 'Electricidad',
  internet: 'Internet',
  maintenance: 'Mantenimiento',
  other: 'Otro',
}

const UNIT_LABEL: Record<string, string> = {
  m3: 'm³',
  'm³': 'm³',
  'm^3': 'm³',
  kwh: 'kWh',
  'kw/h': 'kWh',
  'kw h': 'kWh',
  lts: 'L',
  l: 'L',
  lt: 'L',
  litro: 'L',
  litros: 'L',
  ml: 'ml',
  mililitro: 'ml',
  mililitros: 'ml',
  kg: 'kg',
  g: 'g',
  gr: 'g',
  grs: 'g',
  gramo: 'g',
  gramos: 'g',
  u: 'u',
  unit: 'unidades',
  unidad: 'u',
  unidades: 'unidades',
}

const STATUS_RANK: Record<string, number> = {
  inconsistent: 3,
  requires_review: 2,
  undetermined: 2,
  consistent: 1,
  not_applicable: 0,
}

export function formatMoney(value: number | null | undefined, currency = 'ARS') {
  if (value == null) return '—'
  const code = currency === '$' || !currency ? 'ARS' : currency
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: /^[A-Z]{3}$/.test(code) ? code : 'ARS',
    }).format(value)
  } catch {
    return `${value} ${currency}`
  }
}

export function formatQuantity(value: number | null | undefined) {
  if (value == null) return '—'
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(value)
}

export function formatUnit(unit: string | null | undefined) {
  if (!unit?.trim()) return '—'
  const key = unit.trim().toLowerCase()
  const canonical = canonicalUnit(unit)
  return UNIT_LABEL[key] ?? UNIT_LABEL[canonical] ?? unit.trim()
}

export function formatIssueDate(value: string | null) {
  if (!value) return '—'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-')
    return `${day}/${month}/${year}`
  }
  return value
}

export function lineDescription(line: InvoiceAnalysisLine) {
  const name = line.name.trim()
  const original = line.originalDescription.trim()
  if (!name) return { title: original || '—', detail: null }
  if (!original || original.localeCompare(name, 'es', { sensitivity: 'accent' }) === 0) {
    return { title: name, detail: null }
  }
  if (original.toLocaleLowerCase('es').startsWith(name.toLocaleLowerCase('es'))) {
    return { title: original, detail: null }
  }
  return { title: name, detail: original }
}

function lineLookupText(line: InvoiceAnalysisLine) {
  return `${line.name} ${line.originalDescription}`.trim().toLocaleLowerCase('es')
}

function isTotalOrSubtotalLine(line: InvoiceAnalysisLine) {
  return /^(subtotal|total)\b/.test(lineLookupText(line))
}

export function partitionReviewLines(
  lines: InvoiceAnalysisLine[],
  relations: InvoiceCommercialRelation[] = [],
) {
  const adjustmentIds = new Set(relations.flatMap((relation) => relation.adjustmentLineIds))
  const concepts: InvoiceAnalysisLine[] = []
  const adjustments: InvoiceAnalysisLine[] = []
  const taxes: InvoiceAnalysisLine[] = []
  const summary: InvoiceAnalysisLine[] = []
  for (const line of lines) {
    if (isTotalOrSubtotalLine(line) || line.classification === 'ignored') {
      summary.push(line)
      continue
    }
    if (line.classification === 'fiscal') {
      taxes.push(line)
      continue
    }
    if (adjustmentIds.has(line.id) || (line.amount ?? 0) < 0 || (line.unitPrice ?? 0) < 0) {
      adjustments.push(line)
      continue
    }
    concepts.push(line)
  }
  return { concepts, adjustments, taxes, summary }
}

function lineById(result: InvoiceAnalysisApiResult, id: string | null) {
  if (!id) return undefined
  return result.document.lines.find((line) => line.id === id)
}

export function relationEffectiveStatus(
  relation: InvoiceCommercialRelation,
  local: LocalRelationDecision | undefined,
): LocalRelationDecision {
  if (local) return local
  if (relation.status === 'confirmed') return 'confirm'
  if (relation.status === 'rejected') return 'reject'
  return 'pending'
}

export function bonusQuestion(
  relation: InvoiceCommercialRelation,
  result: InvoiceAnalysisApiResult,
) {
  const target = lineById(result, relation.targetLineId)
    ?? lineById(result, relation.candidateTargetLineIds[0] ?? null)
  const name = target?.name || target?.originalDescription || 'un producto'
  const quantity = relation.proposedPhysicalQuantity
  const unit = formatUnit(relation.unit || target?.unit || null)
  const percent = relation.bonusPercentage
  const quantityLabel =
    quantity != null
      ? `${formatQuantity(quantity)}${unit !== '—' ? ` ${unit}` : ''}`
      : null
  const percentLabel = percent != null ? `${formatQuantity(percent)}%` : null
  const kind = relation.type === 'discount' ? 'descuento' : 'bonificación'
  const article = relation.type === 'discount' ? 'un' : 'una'
  if (quantityLabel && percentLabel) {
    return `${name} figura con ${quantityLabel} facturados y ${article} ${kind} del ${percentLabel}.`
  }
  if (relation.type === 'discount') {
    return `Parece un descuento de ${formatMoney(relation.bonusAmount, result.document.header.currency)} sobre ${name}.`
  }
  return `Hay una ${kind} propuesta sobre ${name}.`
}

export function toCommercialRelationDecisions(
  result: InvoiceAnalysisApiResult,
  localDecisions: Record<string, LocalRelationDecision>,
): CommercialRelationDecision[] {
  return toCommercialDecisionPayload(result, localDecisions).map((payload) => {
    const adjustment = lineById(result, payload.adjustmentLineIds[0])
    const target = lineById(result, payload.targetLineId)
    const mapped: CommercialRelationDecision = {
      adjustmentSourceIndex: adjustment?.sourceIndex ?? -1,
      decision: payload.decision,
      type: payload.type,
    }
    if (target) mapped.targetSourceIndex = target.sourceIndex
    return mapped
  })
}

export function localDecisionsFromPayload(
  decisions: InvoiceCommercialDecisionPayload[] | null | undefined,
): Record<string, LocalRelationDecision> {
  const map: Record<string, LocalRelationDecision> = {}
  for (const item of decisions ?? []) {
    if (item.decision === 'confirm' || item.decision === 'reject') {
      map[item.relationId] = item.decision
    }
  }
  return map
}

export function toCommercialDecisionPayload(
  result: InvoiceAnalysisApiResult,
  localDecisions: Record<string, LocalRelationDecision>,
): InvoiceCommercialDecisionPayload[] {
  return result.interpretation.relations.flatMap((relation) => {
    const decision = localDecisions[relation.id]
    if (decision !== 'confirm' && decision !== 'reject') return []
    return [{
      relationId: relation.id,
      decision,
      type: relation.type,
      targetLineId: relation.targetLineId,
      adjustmentLineIds: relation.adjustmentLineIds,
      proposedPhysicalQuantity: relation.proposedPhysicalQuantity,
      unit: relation.unit,
      bonusAmount: relation.bonusAmount,
      grossAmount: relation.grossAmount,
      netAcquisitionAmount: relation.netAcquisitionAmount,
      originalAdjustmentAmounts: relation.adjustmentLineIds.map((lineId) => {
        const line = lineById(result, lineId)
        return {
          lineId,
          amount: line?.amount ?? null,
          unitPrice: line?.unitPrice ?? null,
          quantity: line?.quantity ?? null,
        }
      }),
    }]
  })
}

export function needsFiscalAcceptance(result: InvoiceAnalysisApiResult) {
  return displayedFiscalStatus(result) === 'inconsistent'
}

export function displayedFiscalStatus(result: InvoiceAnalysisApiResult) {
  const fiscal = result.validation.fiscalReconciliation
  const reconciliation = fiscal?.status ?? 'not_applicable'
  const dimension = result.validation.dimensions.fiscal.status
  // La conciliación fiscal (total + agregados) manda sobre ruido de dimensión
  // (p. ej. CUIT inválido) para no degradar “Consistente” cuando el total cierra
  // y los agregados están OK. Un mismatch de clasificación sigue en requires_review
  // vía fiscal.status y en fiscalReviewNotes.
  if (reconciliation === 'consistent') return 'consistent'
  if (reconciliation === 'inconsistent' || dimension === 'inconsistent') return 'inconsistent'
  const left = STATUS_RANK[reconciliation] ?? 0
  const right = STATUS_RANK[dimension] ?? 0
  return left >= right ? reconciliation : dimension
}

export function fiscalReviewNotes(result: InvoiceAnalysisApiResult) {
  const notes: string[] = []
  const reconciliation = result.validation.fiscalReconciliation
  if (reconciliation?.status === 'requires_review' && reconciliation.origin === 'aggregate_classification') {
    notes.push(
      'El total del comprobante cierra, pero IVA/percepciones de cabecera no coinciden con las líneas fiscales clasificadas. Se conservaron los importes originales.',
    )
  } else if (reconciliation?.status === 'requires_review' && reconciliation.origin === 'extracted_other_taxes') {
    notes.push(
      `Los otros impuestos extraídos (${formatMoney(reconciliation.extracted.otherTaxes, result.document.header.currency)}) no coinciden con las líneas fiscales (${formatMoney(reconciliation.calculated.otherTaxesFromFiscalLines, result.document.header.currency)}). Diferencia: ${formatMoney(reconciliation.differences.otherTaxes, result.document.header.currency)}. Se conservó el valor original.`,
    )
  } else if (reconciliation?.status === 'requires_review') {
    notes.push('Hay una diferencia fiscal entre los agregados extraídos y las líneas. Se conservó el valor original para revisión.')
  } else if (reconciliation?.status === 'inconsistent') {
    notes.push('La conciliación fiscal es inconsistente. Se conservó el valor extraído original.')
  }
  for (const item of [
    ...result.validation.errors,
    ...result.validation.warnings,
    ...result.validation.pendingConfirmations,
  ]) {
    if (item.code === 'FISCAL_AGGREGATE_REQUIRES_REVIEW' && notes.length > 0) continue
    notes.push(item.message)
  }
  return notes
}

export function dimensionLabel(status: string) {
  if (status === 'consistent') return 'Consistente'
  if (status === 'requires_review') return 'Requiere revisión'
  if (status === 'not_applicable') return 'No aplica'
  if (status === 'inconsistent') return 'Inconsistente'
  return status
}

export function quantityDisplay(line: InvoiceAnalysisLine) {
  const unit = formatUnit(line.unit)
  if (line.quantityKind === 'service_consumption') {
    return {
      quantity: formatQuantity(line.quantity),
      unit,
      hint: 'Consumo de servicio',
    }
  }
  if (line.quantityKind === 'charge') {
    return {
      quantity: formatQuantity(line.quantity),
      unit,
      hint: 'Cargo',
    }
  }
  return {
    quantity: formatQuantity(line.quantity),
    unit,
    hint: null,
  }
}

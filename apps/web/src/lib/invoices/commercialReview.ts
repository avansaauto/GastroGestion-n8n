import { relationEffectiveStatus } from './review'
import {
  initialReviewReceivedDrafts,
  type ReviewReceivedDrafts,
} from './reviewReceived'
import type {
  InvoiceAnalysisApiResult,
  InvoiceAnalysisLine,
  InvoiceCommercialRelation,
  LocalRelationDecision,
} from './types'

export function unresolvedCommercialRelations(
  relations: InvoiceCommercialRelation[],
): InvoiceCommercialRelation[] {
  return relations.filter(
    (relation) => relation.status === 'proposed' || relation.status === 'requires_review',
  )
}

function lineName(
  relation: InvoiceCommercialRelation,
  lines: InvoiceAnalysisLine[],
) {
  const target = lines.find((line) => line.id === relation.targetLineId)
    ?? lines.find((line) => relation.candidateTargetLineIds.includes(line.id))
  return target?.name?.trim() || target?.originalDescription?.trim() || ''
}

export function commercialRelationSaveBlockReason(
  relations: InvoiceCommercialRelation[],
  lines: InvoiceAnalysisLine[],
): string | null {
  const unresolved = unresolvedCommercialRelations(relations)
  if (unresolved.length === 0) return null
  const relation = unresolved[0]
  const kind = relation.type === 'discount' ? 'descuento' : 'bonificación'
  const name = lineName(relation, lines)

  if (!relation.targetLineId && relation.candidateTargetLineIds.length > 1) {
    return name
      ? `Hay más de un producto candidato para la ${kind} de ${name}. Resolvela antes de guardar.`
      : `Hay una ${kind} con más de un producto candidato. Resolvela antes de guardar.`
  }
  if (!relation.targetLineId) {
    return `Hay una ${kind} sin producto asignado. Resolvela antes de guardar.`
  }
  return name
    ? `Confirmá o rechazá la ${kind} de ${name} antes de guardar.`
    : `Confirmá o rechazá la ${kind} pendiente antes de guardar.`
}

export function isCommercialAdjustmentLine(
  line: InvoiceAnalysisLine,
  relations: InvoiceCommercialRelation[] = [],
) {
  if (relations.some((relation) => relation.adjustmentLineIds.includes(line.id))) return true
  return (line.amount ?? 0) < 0 || (line.unitPrice ?? 0) < 0
}

function cloneAnalysis(result: InvoiceAnalysisApiResult): InvoiceAnalysisApiResult {
  return JSON.parse(JSON.stringify(result)) as InvoiceAnalysisApiResult
}

export function applyCommercialReview(
  snapshot: InvoiceAnalysisApiResult,
  localDecisions: Record<string, LocalRelationDecision>,
): InvoiceAnalysisApiResult {
  const next = cloneAnalysis(snapshot)
  const adjustmentIds = new Set<string>()
  const pendingTargets = new Set<string>()
  const confirmedTargets = new Set<string>()
  const rejectedTargets = new Set<string>()

  for (const relation of next.interpretation.relations) {
    for (const lineId of relation.adjustmentLineIds) adjustmentIds.add(lineId)
    const effective = relationEffectiveStatus(relation, localDecisions[relation.id])
    if (effective === 'confirm') {
      if (!relation.targetLineId) {
        relation.status = relation.candidateTargetLineIds.length > 1 ? 'requires_review' : 'proposed'
        continue
      }
      relation.status = 'confirmed'
      relation.warnings = []
      confirmedTargets.add(relation.targetLineId)
      continue
    }
    if (effective === 'reject') {
      relation.status = 'rejected'
      relation.warnings = ['La propuesta fue rechazada. El ajuste negativo no ingresa al inventario.']
      if (relation.targetLineId) rejectedTargets.add(relation.targetLineId)
      continue
    }
    relation.status = relation.candidateTargetLineIds.length > 1 && !relation.targetLineId
      ? 'requires_review'
      : 'proposed'
    if (relation.targetLineId) pendingTargets.add(relation.targetLineId)
  }

  for (const line of next.document.lines) {
    if (adjustmentIds.has(line.id) || isCommercialAdjustmentLine(line, next.interpretation.relations)) {
      line.inventoryEligibility = 'ineligible'
      continue
    }
    if (pendingTargets.has(line.id)) {
      line.inventoryEligibility = 'pending_review'
      continue
    }
    if (
      (confirmedTargets.has(line.id) || rejectedTargets.has(line.id))
      && line.classification === 'stock'
      && (line.amount ?? 0) >= 0
    ) {
      line.inventoryEligibility = 'eligible'
    }
  }

  const interpByLine = new Map(next.interpretation.lines.map((line) => [line.lineId, line]))
  for (const relation of next.interpretation.relations) {
    for (const lineId of relation.adjustmentLineIds) {
      const interp = interpByLine.get(lineId)
      if (!interp) continue
      interp.operation = relation.status === 'rejected' ? 'commercial_adjustment' : relation.type
      interp.status = relation.status
    }
    if (relation.targetLineId) {
      const interp = interpByLine.get(relation.targetLineId)
      if (!interp) continue
      if (relation.status === 'confirmed') {
        interp.status = 'confirmed'
        interp.operation = 'normal_purchase'
      } else if (relation.status === 'rejected') {
        interp.status = 'confirmed'
        interp.operation = 'normal_purchase'
      } else {
        interp.status = 'requires_review'
      }
    }
  }

  const unresolved = unresolvedCommercialRelations(next.interpretation.relations)
  next.interpretation.unresolvedLineIds = [...new Set(unresolved.flatMap((relation) => [
    ...relation.adjustmentLineIds,
    ...(relation.targetLineId ? [relation.targetLineId] : relation.candidateTargetLineIds),
  ]))]
  next.interpretation.consistency = unresolved.length > 0 ? 'requires_review' : 'consistent'
  next.interpretation.blocksReception = unresolved.length > 0
  next.validation.dimensions.commercial = {
    status: unresolved.length > 0 ? 'requires_review' : 'consistent',
    issues: unresolved.length > 0 ? ['COMMERCIAL_RELATION_REQUIRES_CONFIRMATION'] : [],
  }

  const eligibleLines = next.document.lines.filter((line) => line.inventoryEligibility === 'eligible').length
  const pendingLines = next.document.lines.filter((line) => line.inventoryEligibility === 'pending_review').length
  next.inventory = {
    eligibleLines,
    pendingLines,
    receptionBlocked: unresolved.length > 0,
    shouldOfferFutureReceipt: eligibleLines > 0 && unresolved.length === 0,
  }
  return next
}

export function mergeReviewReceivedDrafts(
  existing: ReviewReceivedDrafts,
  lines: InvoiceAnalysisLine[],
): ReviewReceivedDrafts {
  const next = { ...existing }
  for (const [lineId, value] of Object.entries(initialReviewReceivedDrafts(lines))) {
    if (next[lineId] == null) next[lineId] = value
  }
  return next
}

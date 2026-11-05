/**
 * Contrato de decisiones comerciales temporales (Paso 282).
 *
 * El frontend solo puede confirmar o rechazar una relación ya propuesta por el
 * análisis. No puede cambiar importes originales ni autorizar stock.
 *
 * Al guardar, el backend debe:
 * 1. Cargar el snapshot original_analysis (inmutable).
 * 2. Ubicar la relación por relationId.
 * 3. Exigir que type, line ids, bonusAmount y proposedPhysicalQuantity coincidan.
 * 4. Aplicar únicamente decision = confirm | reject.
 * 5. Recalcular interpretación con interpretCommercialInvoice(..., { commercialDecisions }).
 * 6. Ignorar cualquier amount/quantity enviado que no coincida con el snapshot.
 * 7. No escribir purchase_items, receipts ni movimientos de inventario.
 */

export type InvoiceCommercialDecisionPayload = {
  relationId: string
  decision: 'confirm' | 'reject'
  type: 'bonus' | 'discount'
  targetLineId: string | null
  adjustmentLineIds: string[]
  proposedPhysicalQuantity: number | null
  unit: string | null
  bonusAmount: number
  grossAmount: number | null
  netAcquisitionAmount: number | null
  originalAdjustmentAmounts: Array<{
    lineId: string
    amount: number | null
    unitPrice: number | null
    quantity: number | null
  }>
}

export type OriginalCommercialRelation = {
  id: string
  type: 'bonus' | 'discount'
  targetLineId: string | null
  adjustmentLineIds: string[]
  proposedPhysicalQuantity: number | null
  unit: string | null
  bonusAmount: number
  grossAmount: number | null
  netAcquisitionAmount: number | null
}

export type OriginalAnalysisLine = {
  id: string
  amount: number | null
  unitPrice: number | null
  quantity: number | null
}

export class CommercialDecisionError extends Error {
  constructor(
    message: string,
    public readonly code: 'UNKNOWN_RELATION' | 'DECISION_TAMPERED' | 'INVALID_DECISION',
  ) {
    super(message)
    this.name = 'CommercialDecisionError'
  }
}

function sameNumber(left: number | null | undefined, right: number | null | undefined) {
  if (left == null && right == null) return true
  if (left == null || right == null) return false
  return Object.is(left, right)
}

function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export function assertCommercialDecisions(
  original: {
    relations: OriginalCommercialRelation[]
    lines: OriginalAnalysisLine[]
  },
  payload: InvoiceCommercialDecisionPayload[],
): void {
  const relations = new Map(original.relations.map((relation) => [relation.id, relation]))
  const lines = new Map(original.lines.map((line) => [line.id, line]))

  for (const decision of payload) {
    if (decision.decision !== 'confirm' && decision.decision !== 'reject') {
      throw new CommercialDecisionError('La decisión comercial no es válida.', 'INVALID_DECISION')
    }
    const relation = relations.get(decision.relationId)
    if (!relation) {
      throw new CommercialDecisionError('La relación comercial no existe en el análisis original.', 'UNKNOWN_RELATION')
    }
    const matchesRelation =
      decision.type === relation.type
      && decision.targetLineId === relation.targetLineId
      && sameStringList(decision.adjustmentLineIds, relation.adjustmentLineIds)
      && sameNumber(decision.bonusAmount, relation.bonusAmount)
      && sameNumber(decision.proposedPhysicalQuantity, relation.proposedPhysicalQuantity)
      && (decision.unit ?? null) === (relation.unit ?? null)
      && sameNumber(decision.grossAmount, relation.grossAmount)
      && sameNumber(decision.netAcquisitionAmount, relation.netAcquisitionAmount)
    if (!matchesRelation) {
      throw new CommercialDecisionError(
        'La decisión no coincide con la relación original del análisis.',
        'DECISION_TAMPERED',
      )
    }
    for (const echoed of decision.originalAdjustmentAmounts) {
      const line = lines.get(echoed.lineId)
      if (!line || !relation.adjustmentLineIds.includes(echoed.lineId)) {
        throw new CommercialDecisionError(
          'Las líneas de ajuste no coinciden con el análisis original.',
          'DECISION_TAMPERED',
        )
      }
      if (
        !sameNumber(echoed.amount, line.amount)
        || !sameNumber(echoed.unitPrice, line.unitPrice)
        || !sameNumber(echoed.quantity, line.quantity)
      ) {
        throw new CommercialDecisionError(
          'Los importes originales no pueden modificarse desde el navegador.',
          'DECISION_TAMPERED',
        )
      }
    }
  }
}

import { Decimal } from 'decimal.js'
import {
  analyzeInvoiceLinePricing,
  suggestPresentationPhysical,
} from '../../http/invoiceUnits.js'
import { normalizeText } from './classification.js'
import type {
  CommercialEvidence,
  CommercialRelation,
  CommercialRelationDecision,
  InvoiceAnalysisOptions,
  InvoiceCommercialInterpretation,
  InvoiceLineInterpretation,
  InterpretationStatus,
  NormalizedInvoiceDocument,
  NormalizedInvoiceLine,
} from './types.js'

const BONUS_PATTERN = /\b(bonif(?:icacion)?|regalo|promocion|promo|sin cargo|gratis)\b/i
const DISCOUNT_PATTERN = /\b(descuento|dto\.?|rebaja)\b/i
const RETURN_PATTERN = /\b(devolucion|devol\.?|retorno|mercaderia devuelta)\b/i
const GLOBAL_PATTERN = /\b(global|general|comercial)\b/i
const OPERATION_WORDS =
  /\b(bonif(?:icacion)?|regalo|promocion|promo|sin cargo|gratis|descuento|dto|rebaja|ajuste|devolucion|devol|retorno)\b/gi
const UNIT_WORDS = /\b(kg|g|lts?|litros?|ml|unidades?|uds?|u)\b/gi

function roundMoney(value: Decimal | number): number {
  return new Decimal(value).toDecimalPlaces(2).toNumber()
}

function roundPercentage(value: Decimal | number): number {
  return new Decimal(value).toDecimalPlaces(2).toNumber()
}

function productKey(line: NormalizedInvoiceLine): string {
  return normalizeText(line.name || line.originalDescription)
    .replace(OPERATION_WORDS, ' ')
    .replace(UNIT_WORDS, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenSimilarity(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean))
  const right = new Set(b.split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return 0
  const common = [...left].filter((token) => right.has(token)).length
  return common / Math.max(left.size, right.size)
}

function evidence(
  code: string,
  message: string,
  lineIds: string[],
): CommercialEvidence {
  return { code, message, lineIds }
}

function operationForClassification(
  line: NormalizedInvoiceLine,
): InvoiceLineInterpretation['operation'] {
  switch (line.classification) {
    case 'stock':
      return 'normal_purchase'
    case 'service':
      return 'service'
    case 'expense':
      return 'expense'
    case 'logistics':
      return 'logistics'
    case 'fiscal':
      return 'fiscal'
    case 'ignored':
      return 'ignored'
    default:
      return 'pending_review'
  }
}

function enrichStockPhysical(line: NormalizedInvoiceLine): {
  physical: InvoiceLineInterpretation['physical']
  evidence: CommercialEvidence[]
  warnings: string[]
  pendingFields: string[]
  requiresReview: boolean
} {
  const pricing = analyzeInvoiceLinePricing({
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    amount: line.amount,
    discount: line.discount,
    contentPerUnit: line.contentPerUnit,
    contentUnit: line.contentUnit,
    packageCount: line.packageCount,
    billedWeight: line.billedWeight,
    billedWeightUnit: line.billedWeightUnit,
  })
  const presentation = suggestPresentationPhysical({
    quantity: line.quantity,
    unit: line.unit,
    packageCount: line.packageCount,
    unitsPerPackage: line.unitsPerPackage,
    contentPerUnit: line.contentPerUnit,
    contentUnit: line.contentUnit,
    // Solo peso facturado EXPLÍCITO (Cant. KG). El derivado de content×qty
    // no debe pisar multipacks (10×1 kg → 10.000 g).
    billedWeight: line.billedWeight,
    billedWeightUnit: line.billedWeightUnit,
  })

  const evidence: CommercialEvidence[] = []
  const warnings = [...pricing.warnings]
  const pendingFields: string[] = []
  let requiresReview = false

  let proposedQuantity = line.quantity
  let proposedUnit = line.unit
  let billedWeight = pricing.billedWeight
  let billedWeightUnit = pricing.billedWeightUnit

  if (presentation) {
    proposedQuantity = presentation.physicalQuantity
    proposedUnit = presentation.physicalUnit
    evidence.push(
      evidenceItem(
        'PRESENTATION_PHYSICAL',
        `Presentación comercial ${presentation.commercialQuantity} ${presentation.commercialUnit ?? 'u'} → ${presentation.physicalQuantity} ${presentation.physicalUnit}.`,
        [line.id],
      ),
    )
    // Cantidad física calculada para inventario; no pisa quantity/unit originales.
    line.inventoryPhysicalQuantity = presentation.physicalQuantity
  }

  if (pricing.priceBasis === 'weight' && pricing.billedWeight != null) {
    evidence.push(
      evidenceItem(
        'PRICE_BASIS_WEIGHT',
        'El precio unitario se interpreta por peso facturado (p. ej. $/kg), no por la unidad comercial.',
        [line.id],
      ),
    )
    // Peso facturado real manda sobre el contenido aproximado de la descripción.
    if (pricing.billedWeightUnit === 'kg') {
      proposedQuantity = new Decimal(pricing.billedWeight).mul(1000).toDecimalPlaces(6).toNumber()
      proposedUnit = 'g'
      line.inventoryPhysicalQuantity = proposedQuantity
    } else if (pricing.billedWeightUnit === 'g') {
      proposedQuantity = pricing.billedWeight
      proposedUnit = 'g'
      line.inventoryPhysicalQuantity = proposedQuantity
    }
  } else if (pricing.priceBasis === 'commercial_unit') {
    evidence.push(
      evidenceItem(
        'PRICE_BASIS_COMMERCIAL',
        'El precio unitario corresponde a la unidad comercial facturada.',
        [line.id],
      ),
    )
  } else if (pricing.priceBasis === 'ambiguous' && (line.classification === 'stock')) {
    requiresReview = true
    pendingFields.push('unit_price_basis', 'billed_weight')
    warnings.push(
      'No se pudo confirmar si el precio es por unidad comercial o por peso; se requiere revisión.',
    )
  }

  if (
    line.packageCount != null &&
    line.unitsPerPackage == null &&
    line.contentPerUnit == null &&
    /\b(pack|caja|bolsa|plancha|barra)\b/i.test(`${line.unit ?? ''} ${line.originalDescription}`)
  ) {
    requiresReview = true
    if (!pendingFields.includes('presentation_content')) pendingFields.push('presentation_content')
    warnings.push('Falta el contenido de la presentación comercial para convertir a unidad de inventario.')
  }

  return {
    physical: {
      movement: 'inbound',
      proposedQuantity,
      unit: proposedUnit,
      commercialQuantity: line.quantity,
      commercialUnit: line.unit,
      billedWeight,
      billedWeightUnit,
      priceBasis: pricing.priceBasis,
    },
    evidence,
    warnings,
    pendingFields,
    requiresReview,
  }
}

function evidenceItem(
  code: string,
  message: string,
  lineIds: string[],
): CommercialEvidence {
  return { code, message, lineIds }
}

function physicalFields(
  line: NormalizedInvoiceLine,
  overrides: Partial<InvoiceLineInterpretation['physical']> &
    Pick<InvoiceLineInterpretation['physical'], 'movement' | 'proposedQuantity' | 'unit'>,
): InvoiceLineInterpretation['physical'] {
  return {
    commercialQuantity: line.quantity,
    commercialUnit: line.unit,
    billedWeight: null,
    billedWeightUnit: null,
    priceBasis: null,
    ...overrides,
  }
}

function baseInterpretation(line: NormalizedInvoiceLine): InvoiceLineInterpretation {
  const operation = operationForClassification(line)
  const isNormalStock =
    operation === 'normal_purchase' &&
    (line.amount ?? 0) >= 0 &&
    (line.unitPrice ?? 0) >= 0
  let status: InterpretationStatus =
    line.inventoryEligibility === 'pending_review' || operation === 'pending_review'
      ? 'requires_review'
      : 'confirmed'

  const emptyPhysical = {
    movement: 'none' as const,
    proposedQuantity: null as number | null,
    unit: line.unit,
    commercialQuantity: line.quantity,
    commercialUnit: line.unit,
    billedWeight: null as number | null,
    billedWeightUnit: null as string | null,
    priceBasis: null as InvoiceLineInterpretation['physical']['priceBasis'],
  }

  if (!isNormalStock) {
    return {
      lineId: line.id,
      operation,
      status,
      relatedLineIds: [],
      physical: {
        ...emptyPhysical,
        movement:
          operation === 'normal_purchase'
            ? 'pending_review'
            : operation === 'pending_review'
              ? 'pending_review'
              : operation === 'service'
                ? 'none'
                : 'none',
        proposedQuantity: operation === 'service' ? 0 : null,
      },
      economic: {
        grossAmount: line.amount,
        bonusAmount: 0,
        netAcquisitionAmount: line.amount,
        bonusPercentage: null,
        preserveCommercialReferenceCost: true,
      },
      evidence: [],
      warnings: [],
      pendingFields: status === 'requires_review' ? ['commercial_operation'] : [],
    }
  }

  const stock =
    line.inventoryEligibility === 'eligible' || line.inventoryEligibility === 'pending_review'
      ? enrichStockPhysical(line)
      : null

  if (stock?.requiresReview) status = 'requires_review'
  if (line.inventoryEligibility === 'pending_review') status = 'requires_review'

  // Cantidad física conocida (presentación / Cant. KG) → inbound aunque el criterio
  // de precio ($/kg vs presentación) quede en revisión. Solo bloquea inbound si falta
  // el contenido de la presentación para convertir.
  const physicalKnown =
    stock != null
    && stock.physical.proposedQuantity != null
    && stock.physical.proposedQuantity > 0
  const missingPresentation = stock?.pendingFields.includes('presentation_content') === true
  const allowInbound =
    physicalKnown
    && !missingPresentation
    && (line.amount ?? 0) >= 0
    && (
      line.inventoryEligibility === 'eligible'
      || line.inventoryEligibility === 'pending_review'
    )

  return {
    lineId: line.id,
    operation,
    status,
    relatedLineIds: [],
    physical: stock
      ? {
          ...stock.physical,
          movement: allowInbound ? 'inbound' : 'pending_review',
        }
      : {
          ...emptyPhysical,
          movement: 'pending_review',
          proposedQuantity: line.quantity,
        },
    economic: {
      grossAmount: line.amount,
      bonusAmount: 0,
      netAcquisitionAmount: line.amount,
      bonusPercentage: null,
      preserveCommercialReferenceCost: true,
    },
    evidence: stock?.evidence ?? [],
    warnings: stock?.warnings ?? [],
    pendingFields:
      status === 'requires_review'
        ? [...new Set(['commercial_operation', ...(stock?.pendingFields ?? [])])]
        : [],
  }
}

function candidateTargets(
  adjustment: NormalizedInvoiceLine,
  positiveStockLines: NormalizedInvoiceLine[],
): NormalizedInvoiceLine[] {
  const key = productKey(adjustment)
  if (!key) return []
  const exact = positiveStockLines.filter((line) => productKey(line) === key)
  if (exact.length > 0) return exact

  const scored = positiveStockLines
    .map((line) => ({ line, score: tokenSimilarity(key, productKey(line)) }))
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return []
  const best = scored[0].score
  return scored.filter(({ score }) => Math.abs(score - best) < 0.05).map(({ line }) => line)
}

function findDecision(
  decisions: CommercialRelationDecision[],
  adjustment: NormalizedInvoiceLine,
): CommercialRelationDecision | undefined {
  return decisions.find((decision) => decision.adjustmentSourceIndex === adjustment.sourceIndex)
}

function relationAmounts(
  adjustment: NormalizedInvoiceLine,
  target: NormalizedInvoiceLine | null,
): {
  grossAmount: number | null
  bonusAmount: number
  netAcquisitionAmount: number | null
  bonusPercentage: number | null
  proposedPhysicalQuantity: number | null
} {
  if (!target) {
    return {
      grossAmount: null,
      bonusAmount: Math.abs(adjustment.amount ?? 0),
      netAcquisitionAmount: null,
      bonusPercentage: null,
      proposedPhysicalQuantity: null,
    }
  }

  const targetAmount = new Decimal(target.amount ?? 0)
  const explicitAdjustment = Math.abs(adjustment.amount ?? 0)
  const isFreeUnits =
    explicitAdjustment === 0 &&
    (adjustment.quantity ?? 0) > 0 &&
    (target.unitPrice ?? 0) > 0
  const freeUnitsValue = isFreeUnits
    ? new Decimal(adjustment.quantity ?? 0).times(target.unitPrice ?? 0)
    : new Decimal(0)
  const bonus = isFreeUnits ? freeUnitsValue : new Decimal(explicitAdjustment)
  const gross = isFreeUnits ? targetAmount.plus(freeUnitsValue) : targetAmount
  const net = gross.minus(bonus)
  const physicalQuantity = isFreeUnits
    ? new Decimal(target.quantity ?? 0).plus(adjustment.quantity ?? 0).toNumber()
    : target.quantity

  return {
    grossAmount: roundMoney(gross),
    bonusAmount: roundMoney(bonus),
    netAcquisitionAmount: roundMoney(net),
    bonusPercentage: gross.isZero()
      ? null
      : roundPercentage(bonus.div(gross.abs()).times(100)),
    proposedPhysicalQuantity: physicalQuantity,
  }
}

function setRelationOnLines(
  relation: CommercialRelation,
  adjustment: NormalizedInvoiceLine,
  target: NormalizedInvoiceLine | null,
  lineInterpretations: Map<string, InvoiceLineInterpretation>,
): void {
  const adjustmentInterpretation = lineInterpretations.get(adjustment.id)
  if (adjustmentInterpretation) {
    adjustmentInterpretation.operation = relation.type
    adjustmentInterpretation.status = relation.status
    adjustmentInterpretation.relatedLineIds = target ? [target.id] : relation.candidateTargetLineIds
    adjustmentInterpretation.physical = physicalFields(adjustment, {
      movement: 'none',
      proposedQuantity: 0,
      unit: adjustment.unit,
    })
    adjustmentInterpretation.economic = {
      grossAmount: adjustment.amount,
      bonusAmount: relation.bonusAmount,
      netAcquisitionAmount: 0,
      bonusPercentage: relation.bonusPercentage,
      preserveCommercialReferenceCost: true,
    }
    adjustmentInterpretation.evidence = relation.evidence
    adjustmentInterpretation.warnings = relation.warnings
    adjustmentInterpretation.pendingFields =
      relation.status === 'confirmed' ? [] : ['commercial_relation']
  }

  if (!target) return
  const targetInterpretation = lineInterpretations.get(target.id)
  if (!targetInterpretation) return
  targetInterpretation.relatedLineIds = [
    ...new Set([...targetInterpretation.relatedLineIds, adjustment.id]),
  ]
  targetInterpretation.status =
    relation.status === 'confirmed' ? 'confirmed' : 'requires_review'
  targetInterpretation.physical = physicalFields(target, {
    movement: relation.status === 'confirmed' ? 'inbound' : 'pending_review',
    proposedQuantity: relation.proposedPhysicalQuantity,
    unit: target.unit,
    priceBasis: targetInterpretation.physical.priceBasis,
    billedWeight: targetInterpretation.physical.billedWeight,
    billedWeightUnit: targetInterpretation.physical.billedWeightUnit,
  })
  targetInterpretation.economic = {
    grossAmount: relation.grossAmount,
    bonusAmount: relation.bonusAmount,
    netAcquisitionAmount: relation.netAcquisitionAmount,
    bonusPercentage: relation.bonusPercentage,
    preserveCommercialReferenceCost: true,
  }
  targetInterpretation.evidence.push(...relation.evidence)
  targetInterpretation.warnings.push(...relation.warnings)
  targetInterpretation.pendingFields =
    relation.status === 'confirmed' ? [] : ['commercial_relation']
}

export function interpretCommercialInvoice(
  document: NormalizedInvoiceDocument,
  options: InvoiceAnalysisOptions = {},
): InvoiceCommercialInterpretation {
  const decisions = options.commercialDecisions ?? []
  const lineInterpretations = new Map(
    document.lines.map((line) => [line.id, baseInterpretation(line)]),
  )
  const relations: CommercialRelation[] = []
  const positiveStockLines = document.lines.filter(
    (line) =>
      line.classification === 'stock' &&
      (line.amount ?? 0) > 0 &&
      (line.quantity ?? 0) > 0,
  )
  const documentIsCreditNote = /nota\s*(?:de\s*)?credito|\bnc\b/i.test(
    normalizeText(document.document.type),
  )

  for (const line of document.lines) {
    if (
      line.classification === 'fiscal' ||
      line.classification === 'ignored' ||
      line.classification === 'service' ||
      line.classification === 'expense' ||
      line.classification === 'logistics'
    ) continue
    const text = normalizeText(`${line.name} ${line.originalDescription}`)
    const explicitBonus = BONUS_PATTERN.test(text)
    const explicitDiscount = DISCOUNT_PATTERN.test(text)
    const explicitReturn = RETURN_PATTERN.test(text)
    const negative = (line.amount ?? 0) < 0 || (line.unitPrice ?? 0) < 0
    const zeroValueBonus = explicitBonus && (line.amount ?? 0) === 0
    const interpretation = lineInterpretations.get(line.id)!

    if (documentIsCreditNote || explicitReturn) {
      interpretation.operation = 'return'
      interpretation.status = 'requires_review'
      interpretation.physical = physicalFields(line, {
        movement: 'pending_review',
        proposedQuantity: line.quantity == null ? null : Math.abs(line.quantity),
        unit: line.unit,
      })
      interpretation.evidence.push(
        evidence(
          documentIsCreditNote ? 'CREDIT_NOTE' : 'RETURN_WORDING',
          documentIsCreditNote
            ? 'El documento es una nota de crédito.'
            : 'La descripción indica una devolución.',
          [line.id],
        ),
      )
      interpretation.warnings.push('La salida física no se aplica sin confirmación.')
      interpretation.pendingFields = ['physical_movement']
      continue
    }

    if (!negative && !zeroValueBonus && !explicitDiscount) continue

    const candidates = candidateTargets(line, positiveStockLines.filter((target) => target.id !== line.id))
    const decision = findDecision(decisions, line)
    if (
      negative &&
      !explicitBonus &&
      !explicitDiscount &&
      candidates.length === 0 &&
      decision?.decision !== 'confirm'
    ) {
      interpretation.operation = 'commercial_adjustment'
      interpretation.status = 'requires_review'
      interpretation.physical = physicalFields(line, {
        movement: 'pending_review',
        proposedQuantity: null,
        unit: line.unit,
      })
      interpretation.evidence.push(
        evidence('NEGATIVE_AMOUNT', 'La línea tiene precio o importe negativo.', [line.id]),
      )
      interpretation.warnings.push(
        'No hay evidencia suficiente para decidir si es descuento, devolución u otro ajuste.',
      )
      interpretation.pendingFields = ['commercial_operation', 'physical_movement']
      continue
    }
    let target =
      decision?.targetSourceIndex == null
        ? candidates.length === 1
          ? candidates[0]
          : null
        : positiveStockLines.find(
            (candidate) => candidate.sourceIndex === decision.targetSourceIndex,
          ) ?? null
    let status: InterpretationStatus
    if (decision?.decision === 'reject') {
      status = 'rejected'
      target = null
    } else if (decision?.decision === 'confirm' && target) {
      status = 'confirmed'
    } else if ((explicitBonus || explicitDiscount) && target && candidates.length === 1) {
      status = 'confirmed'
    } else {
      status = candidates.length > 1 ? 'requires_review' : 'proposed'
    }

    const isGlobalDiscount =
      explicitDiscount && (GLOBAL_PATTERN.test(text) || productKey(line).length === 0)
    if (isGlobalDiscount) target = null

    const type: CommercialRelation['type'] =
      decision?.type ?? (explicitDiscount ? 'discount' : 'bonus')
    const amounts = relationAmounts(line, target)
    const relationEvidence: CommercialEvidence[] = []
    if (negative) {
      relationEvidence.push(
        evidence('NEGATIVE_AMOUNT', 'La línea tiene precio o importe negativo.', [line.id]),
      )
    }
    if (explicitBonus || explicitDiscount) {
      relationEvidence.push(
        evidence(
          explicitBonus ? 'EXPLICIT_BONUS_WORDING' : 'EXPLICIT_DISCOUNT_WORDING',
          explicitBonus
            ? 'La descripción contiene una referencia explícita a bonificación.'
            : 'La descripción contiene una referencia explícita a descuento.',
          [line.id],
        ),
      )
    }
    if (target) {
      relationEvidence.push(
        evidence(
          'PRODUCT_MATCH',
          'La línea de ajuste coincide con una línea positiva del mismo producto.',
          [line.id, target.id],
        ),
      )
      if (
        line.amount != null &&
        target.amount != null &&
        Math.abs(Math.abs(line.amount) - Math.abs(target.amount)) <= 0.05
      ) {
        relationEvidence.push(
          evidence(
            'FULL_AMOUNT_OFFSET',
            'Los importes positivo y negativo se compensan completamente.',
            [line.id, target.id],
          ),
        )
      }
    }
    if (decision?.decision === 'confirm') {
      relationEvidence.push(
        evidence(
          'USER_CONFIRMED',
          'La relación fue confirmada explícitamente por el usuario.',
          [line.id, ...(target ? [target.id] : [])],
        ),
      )
    }
    if (decision?.decision === 'reject') {
      relationEvidence.push(
        evidence(
          'USER_REJECTED',
          'La relación fue rechazada explícitamente por el usuario.',
          [line.id],
        ),
      )
    }

    const warnings: string[] = []
    if (!target) {
      warnings.push(
        isGlobalDiscount
          ? 'El descuento es global y no debe distribuirse sin una regla confirmada.'
          : candidates.length > 1
            ? 'Hay más de un producto candidato para esta bonificación.'
            : 'No se encontró una línea positiva relacionada de forma inequívoca.',
      )
    } else if (status === 'rejected') {
      warnings.push('La propuesta fue rechazada. El ajuste negativo no ingresa al inventario.')
    } else if (status !== 'confirmed') {
      warnings.push('La relación propuesta debe confirmarse antes de recibir mercadería.')
    }

    const relation: CommercialRelation = {
      id: `relation-${line.id}`,
      type,
      status,
      targetLineId: target?.id ?? null,
      adjustmentLineIds: [line.id],
      candidateTargetLineIds: candidates.map((candidate) => candidate.id),
      ...amounts,
      unit: target?.unit ?? line.unit,
      preserveCommercialReferenceCost: true,
      evidence: relationEvidence,
      warnings,
    }
    relations.push(relation)
    setRelationOnLines(relation, line, target, lineInterpretations)

    if (relation.status === 'rejected') {
      const rejected = lineInterpretations.get(line.id)!
      rejected.operation = 'commercial_adjustment'
      rejected.status = 'rejected'
      rejected.physical = {
        movement: 'none',
        proposedQuantity: 0,
        unit: line.unit,
        commercialQuantity: line.quantity,
        commercialUnit: line.unit,
        billedWeight: null,
        billedWeightUnit: null,
        priceBasis: null,
      }
      rejected.pendingFields = []
    }
  }

  for (const line of document.lines) {
    const interpretation = lineInterpretations.get(line.id)!
    if (
      interpretation.operation === 'normal_purchase' &&
      ((line.amount ?? 0) < 0 || (line.unitPrice ?? 0) < 0)
    ) {
      interpretation.operation = 'commercial_adjustment'
      interpretation.status = 'requires_review'
      interpretation.physical = physicalFields(line, {
        movement: 'pending_review',
        proposedQuantity: null,
        unit: line.unit,
      })
      interpretation.warnings.push('El importe negativo no tiene una relación comercial clara.')
      interpretation.pendingFields = ['commercial_operation', 'physical_movement']
    }
  }

  const interpretedLines = document.lines.map((line) => lineInterpretations.get(line.id)!)
  const openRelations = relations.filter(
    (relation) => relation.status === 'proposed' || relation.status === 'requires_review',
  )
  const unresolvedLineIds = [
    ...new Set([
      ...interpretedLines
        .filter((line) => line.status === 'requires_review' || line.status === 'proposed')
        .map((line) => line.lineId),
      ...openRelations.flatMap((relation) => [
        ...relation.adjustmentLineIds,
        ...(relation.targetLineId ? [relation.targetLineId] : relation.candidateTargetLineIds),
      ]),
    ]),
  ]

  return {
    version: 'senda-commercial-v1',
    lines: interpretedLines,
    relations,
    consistency: unresolvedLineIds.length > 0 ? 'requires_review' : 'consistent',
    blocksReception: unresolvedLineIds.length > 0 || documentIsCreditNote,
    unresolvedLineIds,
  }
}

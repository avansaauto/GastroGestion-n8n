import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeExtractedInvoice } from './analyze.js'

type CommercialCases = Record<string, Record<string, unknown>>

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/commercial-cases.json', import.meta.url), 'utf8'),
) as CommercialCases

describe('interpretación comercial de facturas', () => {
  it('propone la bonificación total de PILSEN sin alterar líneas ni importes fiscales', () => {
    const result = analyzeExtractedInvoice(cases.pilsenFullBonus)
    const relation = result.interpretation.relations[0]
    const negative = result.interpretation.lines.find((line) =>
      relation.adjustmentLineIds.includes(line.lineId),
    )!
    const target = result.interpretation.lines.find(
      (line) => line.lineId === relation.targetLineId,
    )!

    expect(result.document.lines).toHaveLength(10)
    expect(result.document.lines.filter((line) => line.classification !== 'fiscal')).toHaveLength(6)
    expect(result.document.amounts).toMatchObject({
      subtotal: 611032,
      taxes: 128316.72,
      otherTaxes: 53159.78,
      total: 792508.5,
    })
    expect(result.document.document.currency).toBe('ARS')
    expect(result.document.classification).toBe('gastronomic_merchandise')
    expect(result.validation.differences).toEqual({
      linesVsSubtotal: 0,
      calculatedVsTotal: 0,
    })
    expect(relation).toMatchObject({
      type: 'bonus',
      status: 'proposed',
      grossAmount: 82500,
      bonusAmount: 82500,
      netAcquisitionAmount: 0,
      bonusPercentage: 100,
      proposedPhysicalQuantity: 50,
      unit: 'lts',
      preserveCommercialReferenceCost: true,
    })
    expect(negative.physical).toMatchObject({ movement: 'none', proposedQuantity: 0 })
    expect(target.physical).toMatchObject({
      movement: 'pending_review',
      proposedQuantity: 50,
    })
    expect(result.document.lines.find((line) => line.id === relation.targetLineId)?.inventoryEligibility).toBe('pending_review')
    expect(result.document.lines.find((line) => relation.adjustmentLineIds.includes(line.id))?.inventoryEligibility).toBe('ineligible')
    expect(result.validation.mathematicallyConsistent).toBe(true)
    expect(result.validation.dimensions.commercial.status).toBe('requires_review')
    expect(result.validation.blocksReception).toBe(true)
    expect(result.inventorySummary).toMatchObject({
      receptionBlocked: true,
      shouldOfferFutureReceipt: false,
    })
    expect(result.document.reviewStatus).toBe('requires_review')
  })

  it('permite confirmar explícitamente la relación PILSEN sin proponer costo de referencia cero', () => {
    const result = analyzeExtractedInvoice(
      cases.pilsenFullBonus,
      {},
      {
        commercialDecisions: [{
          adjustmentSourceIndex: 3,
          targetSourceIndex: 4,
          decision: 'confirm',
          type: 'bonus',
        }],
      },
    )
    const relation = result.interpretation.relations[0]
    const target = result.interpretation.lines.find(
      (line) => line.lineId === relation.targetLineId,
    )!

    expect(relation.status).toBe('confirmed')
    expect(relation.netAcquisitionAmount).toBe(0)
    expect(relation.preserveCommercialReferenceCost).toBe(true)
    expect(target.physical).toMatchObject({ movement: 'inbound', proposedQuantity: 50 })
    expect(result.document.lines.find((line) => line.id === relation.targetLineId)?.inventoryEligibility).toBe('eligible')
    expect(result.document.lines.find((line) => relation.adjustmentLineIds.includes(line.id))?.inventoryEligibility).toBe('ineligible')
    expect(result.validation.dimensions.commercial.status).toBe('consistent')
    expect(result.validation.blocksReception).toBe(false)
  })

  it('cierra el rechazo de PILSEN sin convertir el negativo en mercadería', () => {
    const result = analyzeExtractedInvoice(
      cases.pilsenFullBonus,
      {},
      {
        commercialDecisions: [{
          adjustmentSourceIndex: 3,
          targetSourceIndex: 4,
          decision: 'reject',
          type: 'bonus',
        }],
      },
    )
    const relation = result.interpretation.relations[0]
    const adjustment = result.interpretation.lines.find((line) =>
      relation.adjustmentLineIds.includes(line.lineId),
    )!
    const pilsen = result.document.lines.find((line) => line.name === 'PILSEN' && (line.amount ?? 0) > 0)!
    const negative = result.document.lines.find((line) => (line.amount ?? 0) < 0)!

    expect(relation.status).toBe('rejected')
    expect(adjustment).toMatchObject({
      operation: 'commercial_adjustment',
      status: 'rejected',
      physical: { movement: 'none', proposedQuantity: 0 },
    })
    expect(pilsen.inventoryEligibility).toBe('eligible')
    expect(negative.inventoryEligibility).toBe('ineligible')
    expect(result.interpretation.unresolvedLineIds).not.toContain(pilsen.id)
    expect(result.validation.blocksReception).toBe(false)
  })

  it('mantiene una compra normal sin relaciones comerciales', () => {
    const result = analyzeExtractedInvoice(cases.normalPurchase)

    expect(result.interpretation.relations).toHaveLength(0)
    expect(result.interpretation.lines[0]).toMatchObject({
      operation: 'normal_purchase',
      status: 'confirmed',
      physical: {
        movement: 'inbound',
        commercialQuantity: 10,
        // 10 kg → 10.000 g sugeridos para inventario; la cantidad facturada se conserva.
        proposedQuantity: 10000,
        unit: 'g',
      },
    })
    expect(result.document.lines[0].quantity).toBe(10)
    expect(result.document.lines[0].unit).toBe('kg')
    expect(result.validation.blocksReception).toBe(false)
  })

  it('reconoce una bonificación parcial explícita del 20%', () => {
    const result = analyzeExtractedInvoice(cases.partialBonus)
    const relation = result.interpretation.relations[0]

    expect(relation).toMatchObject({
      type: 'bonus',
      status: 'confirmed',
      grossAmount: 1000,
      bonusAmount: 200,
      netAcquisitionAmount: 800,
      bonusPercentage: 20,
    })
  })

  it('representa diez unidades compradas y dos sin cargo', () => {
    const result = analyzeExtractedInvoice(cases.freeUnits)
    const relation = result.interpretation.relations[0]

    expect(relation).toMatchObject({
      status: 'confirmed',
      grossAmount: 1200,
      bonusAmount: 200,
      netAcquisitionAmount: 1000,
      bonusPercentage: 16.67,
      proposedPhysicalQuantity: 12,
    })
  })

  it('no distribuye un descuento global entre productos', () => {
    const result = analyzeExtractedInvoice(cases.globalDiscount)
    const relation = result.interpretation.relations[0]

    expect(relation).toMatchObject({
      type: 'discount',
      status: 'proposed',
      targetLineId: null,
    })
    expect(result.validation.pendingConfirmations.some(
      (pending) => pending.code === 'COMMERCIAL_ADJUSTMENT_UNALLOCATED',
    )).toBe(true)
    expect(result.validation.blocksReception).toBe(true)
  })

  it('mantiene una línea negativa sin relación como ajuste desconocido', () => {
    const result = analyzeExtractedInvoice(cases.unknownNegative)
    const adjustment = result.interpretation.lines[1]

    expect(result.interpretation.relations).toHaveLength(0)
    expect(adjustment).toMatchObject({
      operation: 'commercial_adjustment',
      status: 'requires_review',
      physical: { movement: 'pending_review', proposedQuantity: null },
    })
    expect(result.validation.blocksReception).toBe(true)
  })

  it('distingue una devolución explícita de una bonificación', () => {
    const result = analyzeExtractedInvoice(cases.realReturn)

    expect(result.interpretation.relations).toHaveLength(0)
    expect(result.interpretation.lines[0]).toMatchObject({
      operation: 'return',
      status: 'requires_review',
      physical: { movement: 'pending_review', proposedQuantity: 2 },
    })
  })

  it('trata una nota de crédito como operación física pendiente, no como compra', () => {
    const result = analyzeExtractedInvoice(cases.creditNote)

    expect(result.interpretation.lines[0].operation).toBe('return')
    expect(result.interpretation.blocksReception).toBe(true)
    expect(result.validation.pendingConfirmations.some(
      (pending) => pending.code === 'RETURN_REQUIRES_CONFIRMATION',
    )).toBe(true)
  })

  it('mantiene mixed cuando hay bonificación y flete real', () => {
    const result = analyzeExtractedInvoice(cases.bonusWithFreight)

    expect(result.document.classification).toBe('mixed')
    expect(result.document.lines.map((line) => line.classification)).toEqual([
      'stock',
      'stock',
      'logistics',
    ])
    expect(result.interpretation.relations).toHaveLength(1)
  })

  it('mantiene servicios públicos fuera del inventario', () => {
    const result = analyzeExtractedInvoice(cases.publicService)

    expect(result.document.classification).toBe('service')
    expect(result.interpretation.lines[0]).toMatchObject({
      operation: 'service',
      physical: { movement: 'none' },
    })
    expect(result.inventorySummary.shouldOfferFutureReceipt).toBe(false)
  })

  it('no clasifica como mixed una compra que solo agrega IVA e impuestos internos', () => {
    const result = analyzeExtractedInvoice(cases.ordinaryTaxes)

    expect(result.document.classification).toBe('gastronomic_merchandise')
    expect(result.document.document.currency).toBe('ARS')
    expect(result.document.lines.slice(1).every((line) => line.classification === 'fiscal')).toBe(true)
  })

  it('mantiene una moneda ambigua pendiente de confirmación', () => {
    const result = analyzeExtractedInvoice(cases.ambiguousCurrency)

    expect(result.document.document).toMatchObject({
      currency: '$',
      currencyNeedsConfirmation: true,
    })
    expect(result.validation.pendingConfirmations.some(
      (pending) => pending.code === 'CURRENCY_REQUIRES_CONFIRMATION',
    )).toBe(true)
  })

  it('no elige entre dos productos similares para asignar una bonificación', () => {
    const result = analyzeExtractedInvoice(cases.similarProducts)
    const relation = result.interpretation.relations[0]

    expect(relation.targetLineId).toBeNull()
    expect(relation.candidateTargetLineIds).toHaveLength(2)
    expect(relation.status).toBe('requires_review')
    expect(result.validation.blocksReception).toBe(true)
  })

  it('no interpreta una cantidad positiva con importe negativo como salida física', () => {
    const result = analyzeExtractedInvoice(cases.positiveQuantityNegativeAmount)
    const relation = result.interpretation.relations[0]
    const adjustment = result.interpretation.lines.find(
      (line) => relation.adjustmentLineIds.includes(line.lineId),
    )!

    expect(relation.status).toBe('proposed')
    expect(adjustment.physical).toMatchObject({
      movement: 'none',
      proposedQuantity: 0,
      unit: 'kg',
      commercialUnit: 'kg',
    })
  })

  it('separa consistencia matemática de ambigüedad comercial', () => {
    const result = analyzeExtractedInvoice(cases.mathCorrectCommerciallyAmbiguous)

    expect(result.validation.mathematicallyConsistent).toBe(true)
    expect(result.validation.dimensions.mathematical.status).toBe('consistent')
    expect(result.validation.dimensions.commercial.status).toBe('requires_review')
    expect(result.document.reviewStatus).toBe('requires_review')
    expect(result.validation.blocksReception).toBe(true)
  })
})

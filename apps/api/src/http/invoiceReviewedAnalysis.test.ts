import { describe, expect, it } from 'vitest'
import { recalculateReviewedAnalysis } from './invoiceReviewedAnalysis.js'
import type { InvoiceIntegritySnapshot } from './invoiceIntegrity.js'

const AURORA_AMOUNT = 72972.75
const AURORA_PRICE = 8213.95

function auroraSnapshot(linePatch: Record<string, unknown> = {}): InvoiceIntegritySnapshot {
  return {
    document: {
      supplier: { name: 'MAYORISTANET', taxId: '30-00000000-0' },
      header: {
        type: 'Factura A',
        number: '0012-00610241',
        issueDate: '2026-10-20',
        currency: 'ARS',
      },
      amounts: {
        subtotal: AURORA_AMOUNT,
        discounts: 0,
        taxes: 0,
        otherTaxes: 0,
        total: AURORA_AMOUNT,
        taxesIncluded: false,
      },
      classification: 'food',
      mainCategory: 'Alimentos',
      reviewStatus: 'ready',
      lines: [{
        id: 'line-aurora',
        sourceIndex: 0,
        originalDescription: 'Queso P/Fetead Barra Doña Aurora Plancha x Kg',
        name: 'Queso P/Fetead Barra Doña Aurora Plancha x Kg',
        quantity: 1,
        unit: 'plancha',
        contentPerUnit: 8.8,
        contentUnit: 'kg',
        billedWeight: 8.88,
        billedWeightUnit: 'kg',
        unitPrice: AURORA_PRICE,
        amount: AURORA_AMOUNT,
        classification: 'stock',
        inventoryEligibility: 'eligible',
        quantityKind: 'inventory',
        inventoryPhysicalQuantity: 8880,
        missingFields: [],
        ambiguities: [],
        ...linePatch,
      }],
    },
    interpretation: {},
    validation: {},
    inventory: {},
  }
}

function auroraLine(snapshot: ReturnType<typeof recalculateReviewedAnalysis>) {
  const line = snapshot.result.document.lines.find((item) => item.id === 'line-aurora')
  const interpretation = snapshot.result.interpretation.lines.find((item) => item.lineId === 'line-aurora')
  if (!line || !interpretation) throw new Error('falta la línea de Doña Aurora')
  return { line, interpretation, validation: snapshot.result.validation }
}

describe('recalculateReviewedAnalysis', () => {
  it('conserva el peso facturado al reconstruir el análisis revisado', () => {
    const reviewed = recalculateReviewedAnalysis({
      snapshot: auroraSnapshot(),
      corrections: {},
      commercialDecisions: [],
    })
    const { line, interpretation, validation } = auroraLine(reviewed)
    expect(line.billedWeight).toBe(8.88)
    expect(line.billedWeightUnit).toBe('kg')
    expect(line.contentPerUnit).toBe(8.8)
    expect(line.quantity).toBe(1)
    expect(line.unit).toBe('plancha')
    expect(line.unitPrice).toBe(AURORA_PRICE)
    expect(line.amount).toBe(AURORA_AMOUNT)
    expect(line.inventoryPhysicalQuantity).toBe(8880)
    expect(interpretation.physical.priceBasis).toBe('weight')
    expect(interpretation.physical.proposedQuantity).toBe(8880)
    expect(interpretation.physical.unit).toBe('g')
    expect(interpretation.physical.billedWeight).toBe(8.88)
    expect(interpretation.status).toBe('confirmed')
    expect(interpretation.economic.netAcquisitionAmount).toBe(AURORA_AMOUNT)
    expect(validation.dimensions.commercial.status).toBe('consistent')
    expect(validation.blocksReception).toBe(false)
    expect(reviewed.result.interpretation.unresolvedLineIds).not.toContain('line-aurora')
  })

  it('no reemplaza el peso facturado por el contenido aproximado', () => {
    const reviewed = recalculateReviewedAnalysis({
      snapshot: auroraSnapshot(),
      corrections: {},
      commercialDecisions: [],
    })
    const { line, interpretation } = auroraLine(reviewed)
    expect(line.billedWeight).toBe(8.88)
    expect(line.inventoryPhysicalQuantity).not.toBe(8800)
    expect(interpretation.physical.proposedQuantity).not.toBe(8800)
    expect(interpretation.physical.priceBasis).toBe('weight')
  })

  it('mantiene bloqueada una diferencia comercial importante', () => {
    const reviewed = recalculateReviewedAnalysis({
      snapshot: auroraSnapshot({ amount: 65000, inventoryPhysicalQuantity: 8880 }),
      corrections: {},
      commercialDecisions: [],
    })
    const { line, interpretation, validation } = auroraLine(reviewed)
    expect(line.billedWeight).toBe(8.88)
    expect(line.amount).toBe(65000)
    expect(line.unitPrice).toBe(AURORA_PRICE)
    expect(interpretation.physical.priceBasis).toBe('ambiguous')
    expect(interpretation.status).toBe('requires_review')
    expect(validation.dimensions.commercial.status).not.toBe('consistent')
    expect(validation.blocksReception).toBe(true)
    expect(reviewed.result.interpretation.unresolvedLineIds).toContain('line-aurora')
  })

  it('prioriza la corrección explícita del importe y conserva el peso facturado', () => {
    const reviewed = recalculateReviewedAnalysis({
      snapshot: auroraSnapshot(),
      corrections: {
        lines: [{ id: 'line-aurora', amount: 65000 }],
      },
      commercialDecisions: [],
    })
    const { line, interpretation, validation } = auroraLine(reviewed)
    expect(line.amount).toBe(65000)
    expect(line.billedWeight).toBe(8.88)
    expect(line.billedWeightUnit).toBe('kg')
    expect(line.unitPrice).toBe(AURORA_PRICE)
    expect(interpretation.status).toBe('requires_review')
    expect(validation.blocksReception).toBe(true)
  })

  it('una corrección de nombre no descarta el peso ni la consistencia', () => {
    const reviewed = recalculateReviewedAnalysis({
      snapshot: auroraSnapshot(),
      corrections: {
        lines: [{ id: 'line-aurora', name: 'Doña Aurora' }],
      },
      commercialDecisions: [],
    })
    const { line, interpretation, validation } = auroraLine(reviewed)
    expect(line.name).toBe('Doña Aurora')
    expect(line.billedWeight).toBe(8.88)
    expect(line.inventoryPhysicalQuantity).toBe(8880)
    expect(interpretation.status).toBe('confirmed')
    expect(validation.blocksReception).toBe(false)
  })
})

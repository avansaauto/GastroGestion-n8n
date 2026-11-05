import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeExtractedInvoice } from './analyze.js'
import {
  analyzeInvoiceLinePricing,
  suggestPresentationPhysical,
} from '../../http/invoiceUnits.js'
import { reconcileFiscalAmounts } from './fiscalReconciliation.js'

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/mayoristanet-0012-00610241.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function lineByName(result: ReturnType<typeof analyzeExtractedInvoice>, name: string) {
  return result.document.lines.find((line) => line.name === name || line.originalDescription === name)
}

function interpretationFor(
  result: ReturnType<typeof analyzeExtractedInvoice>,
  lineId: string,
) {
  return result.interpretation.lines.find((line) => line.lineId === lineId)
}

describe('MAYORISTANET 0012-00610241 — lectura de cantidades y fiscal', () => {
  const result = analyzeExtractedInvoice(fixture)

  it('preserva cabecera e importes originales de Gemini', () => {
    expect(result.document.supplier.name).toMatch(/MAYORISTANET/i)
    expect(result.document.document.number).toBe('0012-00610241')
    expect(result.document.amounts).toMatchObject({
      subtotal: 173014.64,
      taxes: 36333.07,
      otherTaxes: 5190.44,
      total: 214538.15,
    })
    expect(173014.64 + 36333.07 + 5190.44).toBeCloseTo(214538.15, 2)
  })

  it('concilia el total como consistente cuando subtotal+IVA+percepciones cierran', () => {
    const fiscal = result.validation.fiscalReconciliation
    expect(fiscal.checks.headerExplainsTotal).toBe(true)
    expect(fiscal.totalStatus).toBe('consistent')
    expect(fiscal.aggregatesStatus).toBe('consistent')
    expect(fiscal.status).toBe('consistent')
    expect(
      result.validation.errors.some((item) => item.code === 'DOCUMENT_TOTAL_MISMATCH'),
    ).toBe(false)
  })

  it('La Paulina: 2 barras × 3,5 kg → 7.000 g; precio por barra', () => {
    const line = lineByName(result, 'Queso Mozzarella para Fetear La Paulina')
    expect(line).toBeTruthy()
    expect(line!.quantity).toBe(2)
    expect(line!.unit).toBe('barra')
    expect(line!.contentPerUnit).toBe(3.5)
    expect(line!.unitPrice).toBe(13143.54)
    expect(line!.amount).toBe(26287.08)

    const presentation = suggestPresentationPhysical(line!)
    expect(presentation).toMatchObject({
      physicalQuantity: 7000,
      physicalUnit: 'g',
      commercialQuantity: 2,
    })

    const pricing = analyzeInvoiceLinePricing(line!)
    expect(pricing.priceBasis).toBe('commercial_unit')
    expect(pricing.amountExplainedByCommercial).toBe(true)

    const interp = interpretationFor(result, line!.id)!
    expect(interp.physical.proposedQuantity).toBe(7000)
    expect(interp.physical.unit).toBe('g')
    expect(interp.physical.commercialQuantity).toBe(2)
    expect(interp.physical.priceBasis).toBe('commercial_unit')
    expect(line!.inventoryPhysicalQuantity).toBe(7000)
  })

  it('Doña Aurora: 1 plancha / 8,884 kg a $/kg; no interpreta el precio como precio de plancha', () => {
    const line = lineByName(result, 'Queso Mozzarella Doña Aurora Plancha')
    expect(line).toBeTruthy()
    expect(line!.quantity).toBe(1)
    expect(line!.unit).toBe('plancha')
    expect(line!.unitPrice).toBe(8213.95)
    expect(line!.amount).toBe(72972.75)
    expect(line!.contentPerUnit).toBe(8.884)

    const pricing = analyzeInvoiceLinePricing(line!)
    expect(pricing.priceBasis).toBe('weight')
    expect(pricing.billedWeight).toBeCloseTo(8.884, 3)
    expect(pricing.amountExplainedByWeight).toBe(true)
    expect(pricing.amountExplainedByCommercial).toBe(false)

    const presentation = suggestPresentationPhysical(line!)
    expect(presentation?.physicalQuantity).toBeCloseTo(8884, 3)

    const interp = interpretationFor(result, line!.id)!
    expect(interp.physical.priceBasis).toBe('weight')
    expect(interp.physical.proposedQuantity).toBeCloseTo(8884, 3)
    expect(interp.physical.unit).toBe('g')
    expect(interp.physical.commercialQuantity).toBe(1)
    expect(interp.physical.commercialUnit).toBe('plancha')
    expect(interp.evidence.some((item) => item.code === 'PRICE_BASIS_WEIGHT')).toBe(true)
  })

  it('Azúcar Ledesma: 1 pack × 10 × 1 kg → 10.000 g', () => {
    const line = lineByName(result, 'Azucar Blanca Ledesma')!
    const presentation = suggestPresentationPhysical(line)
    expect(presentation).toMatchObject({
      physicalQuantity: 10000,
      physicalUnit: 'g',
      source: 'units_and_content',
    })
    expect(interpretationFor(result, line.id)!.physical.proposedQuantity).toBe(10000)
    expect(analyzeInvoiceLinePricing(line).priceBasis).toBe('commercial_unit')
  })

  it('Leche Trega: 1 pack × 12 × 1 L → 12.000 ml', () => {
    const line = lineByName(result, 'Leche Entera Larga Vida Trega')!
    const presentation = suggestPresentationPhysical(line)
    expect(presentation).toMatchObject({
      physicalQuantity: 12000,
      physicalUnit: 'ml',
    })
    expect(interpretationFor(result, line.id)!.physical.proposedQuantity).toBe(12000)
  })

  it('Pan Rallado: 10 kg → 10.000 g; precio por kg', () => {
    const line = lineByName(result, 'Pan Rallado Exclusivo')!
    expect(line.quantity).toBe(10)
    expect(line.unit).toBe('kg')
    const presentation = suggestPresentationPhysical(line)
    expect(presentation?.physicalQuantity).toBe(10000)
    expect(analyzeInvoiceLinePricing(line).priceBasis).toBe('commercial_unit')
  })

  it('Pimienta Marfeli: packs sin contenido → requiere revisión de presentación', () => {
    const line = lineByName(result, 'Pimienta Negra Molida Marfeli')!
    expect(suggestPresentationPhysical(line)).toBeNull()
    expect(line.inventoryEligibility).toBe('pending_review')
    expect(analyzeInvoiceLinePricing(line).priceBasis).toBe('commercial_unit')
  })

  it('no pisa los valores originales de cantidad/precio/importe', () => {
    const aurora = lineByName(result, 'Queso Mozzarella Doña Aurora Plancha')!
    expect(aurora.quantity).toBe(1)
    expect(aurora.unit).toBe('plancha')
    expect(aurora.unitPrice).toBe(8213.95)
    expect(aurora.amount).toBe(72972.75)
    expect(aurora.raw).toMatchObject({
      unit_price: 8213.95,
      amount: 72972.75,
      content_per_unit: 8.884,
    })
  })

  it('8,88 kg × precio cierra por redondeo de centésimos y no inventa otro peso', () => {
    const rounded = {
      ...fixture,
      lines: [
        {
          description_original: 'Queso Mozzarella Doña Aurora Plancha',
          name: 'Queso Mozzarella Doña Aurora Plancha',
          quantity: 1,
          unit: 'plancha',
          package_count: 1,
          content_per_unit: 8.88,
          content_unit: 'kg',
          unit_price: 8213.95,
          amount: 72972.75,
          category: 'Quesos',
          is_summary: false,
        },
      ],
    }
    const analyzed = analyzeExtractedInvoice(rounded)
    const line = analyzed.document.lines[0]!
    const pricing = analyzeInvoiceLinePricing(line)
    expect(pricing.priceBasis).toBe('weight')
    expect(pricing.amountExplainedByWeight).toBe(true)
    expect(pricing.amountExplainedByCommercial).toBe(false)
    expect(pricing.billedWeight).toBe(8.88)
    expect(line.inventoryPhysicalQuantity).toBe(8880)
    expect(line.quantity).toBe(1)
    expect(line.unit).toBe('plancha')
    expect(line.unitPrice).toBe(8213.95)
    expect(line.amount).toBe(72972.75)
    const interpretation = analyzed.interpretation.lines.find((item) => item.lineId === line.id)
    expect(interpretation?.economic.netAcquisitionAmount).toBe(72972.75)
    expect(interpretation?.status).toBe('confirmed')
    expect(
      analyzed.validation.pendingConfirmations.some(
        (item) => item.code === 'LINE_PRICE_BASIS_REQUIRES_REVIEW',
      ),
    ).toBe(false)
  })

  it('una diferencia comercial grande entre peso y importe sigue en revisión', () => {
    const mismatched = {
      ...fixture,
      lines: [
        {
          description_original: 'Queso Mozzarella Doña Aurora Plancha',
          name: 'Queso Mozzarella Doña Aurora Plancha',
          quantity: 1,
          unit: 'plancha',
          package_count: 1,
          content_per_unit: 8.88,
          content_unit: 'kg',
          unit_price: 8213.95,
          amount: 65000,
          category: 'Quesos',
          is_summary: false,
        },
      ],
    }
    const analyzed = analyzeExtractedInvoice(mismatched)
    const line = analyzed.document.lines[0]!
    const pricing = analyzeInvoiceLinePricing(line)
    expect(pricing.priceBasis).toBe('ambiguous')
    expect(pricing.billedWeight).toBe(8.88)
    expect(line.quantity).toBe(1)
    expect(line.unitPrice).toBe(8213.95)
    expect(line.amount).toBe(65000)
    expect(analyzed.interpretation.blocksReception).toBe(true)
    expect(
      analyzed.validation.pendingConfirmations.some(
        (item) => item.code === 'LINE_PRICE_BASIS_REQUIRES_REVIEW',
      ),
    ).toBe(true)
  })

  it('si el total cierra pero IVA de cabecera no matchea líneas, advierte sin DOCUMENT_TOTAL_MISMATCH', () => {
    const mismatched = {
      ...fixture,
      tax: 41523.51,
      other_taxes: 0,
    }
    const fiscal = reconcileFiscalAmounts(
      analyzeExtractedInvoice(mismatched).document,
    )
    // 173014.64 + 41523.51 = 214538.15 → total cierra con cabecera mal partida
    expect(fiscal.checks.headerExplainsTotal).toBe(true)
    expect(fiscal.totalStatus).toBe('consistent')
    expect(fiscal.aggregatesStatus).toBe('requires_review')
    expect(fiscal.origin).toBe('aggregate_classification')

    const analyzed = analyzeExtractedInvoice(mismatched)
    expect(
      analyzed.validation.errors.some((item) => item.code === 'DOCUMENT_TOTAL_MISMATCH'),
    ).toBe(false)
    expect(
      analyzed.validation.warnings.some(
        (item) => item.code === 'FISCAL_AGGREGATE_CLASSIFICATION_MISMATCH',
      ),
    ).toBe(true)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  analyzeInvoiceLinePricing,
  suggestPresentationPhysical,
} from '../../http/invoiceUnits.js'
import { analyzeExtractedInvoice } from './analyze.js'

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/mayoristanet-0012-00611278.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function lineByName(result: ReturnType<typeof analyzeExtractedInvoice>, name: string) {
  return result.document.lines.find(
    (line) => line.name === name || line.originalDescription === name || line.name.includes(name),
  )
}

describe('MAYORISTANET 0012-00611278 — conversión física y costo neto', () => {
  const result = analyzeExtractedInvoice(fixture)

  it('identifica las 7 líneas de mercadería elegibles', () => {
    expect(result.document.document.number).toBe('0012-00611278')
    const stock = result.document.lines.filter((line) => line.classification === 'stock')
    expect(stock).toHaveLength(7)
    expect(stock.every((line) => line.inventoryEligibility === 'eligible')).toBe(true)
  })

  it('fiscal: total cierra con subtotal+IVA+percepciones → conciliación consistente', () => {
    expect(result.document.amounts).toMatchObject({
      subtotal: 417212.19,
      taxes: 87614.56,
      otherTaxes: 12516.37,
      total: 517343.12,
    })
    expect(417212.19 + 87614.56 + 12516.37).toBeCloseTo(517343.12, 2)
    const fiscal = result.validation.fiscalReconciliation
    expect(fiscal.totalStatus).toBe('consistent')
    expect(fiscal.status).toBe('consistent')
    expect(fiscal.checks.headerExplainsTotal).toBe(true)
    expect(
      result.validation.errors.some((item) => item.code === 'DOCUMENT_TOTAL_MISMATCH'),
    ).toBe(false)
  })

  it('Panceta: prioriza Cant. KG=7,22 sobre 1,5 kg aprox → 7.220 g', () => {
    const line = lineByName(result, 'Panceta Ahumada')!
    expect(line.quantity).toBe(5)
    expect(line.unit).toBe('pieza')
    expect(line.billedWeight).toBe(7.22)
    expect(line.contentPerUnit).toBe(1.5)

    const presentation = suggestPresentationPhysical(line)
    expect(presentation?.physicalQuantity).toBeCloseTo(7220, 3)
    expect(line.inventoryPhysicalQuantity).toBeCloseTo(7220, 3)

    const pricing = analyzeInvoiceLinePricing(line)
    expect(pricing.priceBasis).toBe('weight')
    expect(pricing.billedWeight).toBeCloseTo(7.22, 3)
  })

  it('Mozzarella La Paulina: 1 barra × 3,5 kg → 3.500 g; costo ~7,51/g', () => {
    const line = lineByName(result, 'La Paulina')!
    expect(suggestPresentationPhysical(line)).toMatchObject({
      physicalQuantity: 3500,
      physicalUnit: 'g',
    })
    expect(line.inventoryPhysicalQuantity).toBe(3500)
    expect(analyzeInvoiceLinePricing(line).priceBasis).toBe('commercial_unit')
    const unitCost = Number((line.amount! / line.inventoryPhysicalQuantity).toFixed(2))
    expect(unitCost).toBeCloseTo(7.51, 2)
  })

  it('Doña Aurora: 2 planchas / Cant. KG=18,19 → 18.190 g (no 2×8,8)', () => {
    const line = lineByName(result, 'Doña Aurora')!
    expect(line.quantity).toBe(2)
    expect(line.billedWeight).toBe(18.19)
    expect(line.inventoryPhysicalQuantity).toBeCloseTo(18190, 3)
    expect(analyzeInvoiceLinePricing(line).priceBasis).toBe('weight')
  })

  it('Arroz / Tomate / Pan / Aros: presentación fija y multipack', () => {
    expect(lineByName(result, 'Arroz Parboil')!.inventoryPhysicalQuantity).toBe(5000)
    expect(lineByName(result, 'Tomate Triturado')!.inventoryPhysicalQuantity).toBe(16000)
    expect(lineByName(result, 'Pan Rallado')!.inventoryPhysicalQuantity).toBe(10000)
    expect(lineByName(result, 'Aros de Cebolla')!.inventoryPhysicalQuantity).toBe(10000)
    expect(
      suggestPresentationPhysical(lineByName(result, 'Aros de Cebolla')!).source,
    ).toBe('units_and_content')
  })

  it('no usa uni como equivalente a g sin contenido', () => {
    expect(
      suggestPresentationPhysical({
        quantity: 5,
        unit: 'uni',
        packageCount: 5,
        unitsPerPackage: null,
        contentPerUnit: null,
        contentUnit: null,
      }),
    ).toBeNull()
  })
})

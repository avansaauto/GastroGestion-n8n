import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeExtractedInvoice } from './analyze.js'
import { isServiceConsumptionUnit } from './classification.js'

type FixtureCases = Record<string, Record<string, unknown>>

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/service-cases.json', import.meta.url), 'utf8'),
) as FixtureCases

function expectServiceOnly(result: ReturnType<typeof analyzeExtractedInvoice>) {
  expect(result.document.classification).toBe('service')
  expect(result.document.service?.inventoryPhysicalQuantity).toBe(0)
  expect(result.document.lines.every((line) => line.inventoryEligibility === 'ineligible')).toBe(true)
  expect(result.document.lines.every((line) => line.inventoryPhysicalQuantity === 0)).toBe(true)
  expect(result.document.lines.every((line) => line.classification !== 'stock')).toBe(true)
  expect(result.inventorySummary.eligibleLines).toBe(0)
  expect(result.inventorySummary.shouldOfferFutureReceipt).toBe(false)
  expect(result.interpretation.lines.every((line) => line.physical.movement === 'none')).toBe(true)
  expect(
    result.interpretation.lines
      .filter((line) => line.operation === 'service')
      .every((line) => line.physical.proposedQuantity === 0),
  ).toBe(true)
}

describe('facturas de servicios', () => {
  it('usa el caso verificable de MetroGAS sin tratar m³ como inventario', () => {
    const result = analyzeExtractedInvoice(fixtures.metrogasReference)
    const consumption = result.document.lines.find((line) => line.unit === 'm3')

    expectServiceOnly(result)
    expect(result.document.supplier).toMatchObject({
      name: 'MetroGAS S.A.',
      taxId: '30-65786367-6',
    })
    expect(result.document.document).toMatchObject({
      number: 'A-0064-00658503',
      issueDate: '2026-07-15',
      dueDate: '2026-08-04',
      currency: 'ARS',
      clientNumber: '40000449274',
      meterNumber: '16383950',
      paymentCode: '040000449274',
    })
    expect(result.document.service).toMatchObject({
      type: 'gas',
      billingPeriod: '08/2026',
      periodStart: '2026-06-16',
      periodEnd: '2026-07-15',
      actualConsumption: { quantity: 307, unit: 'm3' },
      billedConsumption: { quantity: 332.74, unit: 'm3' },
      inventoryPhysicalQuantity: 0,
    })
    expect(result.document.amounts).toMatchObject({
      subtotal: 119602.56,
      taxes: 34302.14,
      otherTaxes: 20289.79,
      total: 174194.49,
    })
    expect(consumption).toMatchObject({
      classification: 'service',
      quantityKind: 'service_consumption',
      quantity: 332.74,
      inventoryPhysicalQuantity: 0,
      detectedUnits: null,
    })
    expect(isServiceConsumptionUnit(consumption?.unit)).toBe(true)
    expect(result.inventorySummary.shouldOfferFutureReceipt).toBe(false)
    expect(result.validation.fiscalReconciliation.status).toBe('consistent')
    expect(result.validation.dimensions.fiscal.status).toBe('consistent')
    expect(result.validation.errors).toEqual([])
    expect(
      result.validation.warnings.some((warning) => warning.code === 'DOCUMENT_NUMBER_LOOKS_LIKE_IDENTIFIER'),
    ).toBe(false)
  })

  it('clasifica electricidad, internet y mantenimiento como service no inventariable', () => {
    const electricity = analyzeExtractedInvoice(fixtures.electricityService)
    const internet = analyzeExtractedInvoice(fixtures.internetService)
    const maintenance = analyzeExtractedInvoice(fixtures.maintenanceService)

    expectServiceOnly(electricity)
    expectServiceOnly(internet)
    expectServiceOnly(maintenance)
    expect(electricity.document.service).toMatchObject({
      type: 'electricity',
      billingPeriod: '09/2026',
      actualConsumption: { quantity: 1200, unit: 'kwh' },
    })
    expect(electricity.document.lines.some((line) => line.quantityKind === 'service_consumption')).toBe(true)
    expect(internet.document.service?.type).toBe('internet')
    expect(internet.document.lines.some((line) => /descuento/i.test(line.originalDescription))).toBe(true)
    expect(internet.interpretation.relations).toHaveLength(0)
    expect(maintenance.document.service?.type).toBe('maintenance')
  })

  it('mantiene mixed cuando hay mercadería y un servicio de mantenimiento', () => {
    const result = analyzeExtractedInvoice(fixtures.mixedMerchandiseAndService)

    expect(result.document.classification).toBe('mixed')
    expect(result.document.lines.map((line) => line.classification)).toEqual([
      'stock',
      'service',
      'fiscal',
    ])
    expect(result.document.lines[0].inventoryEligibility).toBe('eligible')
    expect(result.document.lines[1].inventoryEligibility).toBe('ineligible')
    expect(result.document.lines[1].inventoryPhysicalQuantity).toBe(0)
    expect(result.inventorySummary.eligibleLines).toBe(1)
    expect(result.inventorySummary.shouldOfferFutureReceipt).toBe(true)
  })

  it('no depende del nombre del proveedor para detectar un servicio', () => {
    const result = analyzeExtractedInvoice(fixtures.serviceWithoutSupplierNameHint)

    expectServiceOnly(result)
    expect(result.document.supplier.name).toMatch(/Alimentos/)
    expect(result.document.lines.map((line) => line.classification)).toEqual(['service', 'service'])
    expect(result.document.lines[1]).toMatchObject({
      unit: 'kwh',
      quantityKind: 'service_consumption',
      inventoryPhysicalQuantity: 0,
    })
  })

  it('advierte si el número o la fecha del comprobante coinciden con identificadores auxiliares', () => {
    const result = analyzeExtractedInvoice(fixtures.confusedIdentifiers)

    expectServiceOnly(result)
    expect(
      result.validation.warnings.some((warning) => warning.code === 'DOCUMENT_NUMBER_LOOKS_LIKE_IDENTIFIER'),
    ).toBe(true)
    expect(
      result.validation.warnings.some((warning) => warning.code === 'ISSUE_DATE_EQUALS_DUE_DATE'),
    ).toBe(true)
  })

  it('concilia una diferencia de $2 en otros impuestos sin reemplazar el valor extraído', () => {
    const result = analyzeExtractedInvoice(fixtures.metrogasExtractedOtherTaxesOffByTwo)
    const reconciliation = result.validation.fiscalReconciliation

    expect(result.document.amounts.otherTaxes).toBe(20287.79)
    expect(result.document.amounts.total).toBe(174194.49)
    expect(reconciliation.extracted.otherTaxes).toBe(20287.79)
    expect(reconciliation.calculated.otherTaxesFromFiscalLines).toBe(20289.79)
    expect(reconciliation.differences.otherTaxes).toBe(2)
    expect(reconciliation.calculated.totalFromFiscalLines).toBe(174194.49)
    // Las líneas fiscales explican el total: no afirmar inconsistencia matemática del total.
    expect(reconciliation.totalStatus).toBe('consistent')
    expect(reconciliation.aggregatesStatus).toBe('requires_review')
    expect(reconciliation.origin).toBe('aggregate_classification')
    expect(reconciliation.status).toBe('requires_review')
    expect(result.validation.dimensions.fiscal.status).toBe('requires_review')
    expect(result.validation.dimensions.mathematical.status).toBe('consistent')
    expect(result.validation.errors.some((item) => item.code === 'DOCUMENT_TOTAL_MISMATCH')).toBe(false)
    expect(
      result.validation.warnings.some(
        (item) => item.code === 'FISCAL_AGGREGATE_CLASSIFICATION_MISMATCH',
      ),
    ).toBe(true)
    expect(
      result.validation.pendingConfirmations.some(
        (item) => item.code === 'FISCAL_AGGREGATE_REQUIRES_REVIEW',
      ),
    ).toBe(false)
    expect(result.inventorySummary.shouldOfferFutureReceipt).toBe(false)
  })

  it('interpreta $ como ARS en una liquidación de servicios argentina', () => {
    const result = analyzeExtractedInvoice({
      ...fixtures.metrogasReference,
      currency: '$',
    })

    expect(result.document.document.currency).toBe('ARS')
    expect(result.document.document.currencyNeedsConfirmation).toBe(false)
  })

  it('advierte un período faltante sin inventar fechas ni cantidades', () => {
    const result = analyzeExtractedInvoice(fixtures.serviceMissingPeriod)

    expectServiceOnly(result)
    expect(result.document.service?.billingPeriod).toBeNull()
    expect(result.document.service?.periodStart).toBeNull()
    expect(
      result.validation.warnings.some((warning) => warning.code === 'SERVICE_PERIOD_MISSING'),
    ).toBe(true)
  })
})

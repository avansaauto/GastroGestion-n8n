import { applyCommercialReview } from './commercialReview'
import type { InvoiceAnalysisApiResult, InvoiceSaveApiResult } from './types'

export function signedInvoiceResult(
  overrides: Partial<InvoiceAnalysisApiResult> = {},
): InvoiceAnalysisApiResult {
  const unsigned = baseInvoiceResult(overrides)
  return {
    ...unsigned,
    metadata: {
      ...unsigned.metadata,
      integrityToken: unsigned.metadata.integrityToken ?? 'integrity-token-test',
      snapshotSha256: unsigned.metadata.snapshotSha256 ?? 'a'.repeat(64),
      fileSha256: unsigned.metadata.fileSha256 ?? 'b'.repeat(64),
      integrityExpiresAt: unsigned.metadata.integrityExpiresAt ?? '2099-01-01T00:00:00.000Z',
    },
  }
}

export function savedInvoiceResult(overrides: Partial<InvoiceSaveApiResult> = {}) {
  return {
    id: 'doc-saved-1',
    status: 'reviewed' as const,
    locationId: 'loc-1',
    organizationId: 'org-1',
    fileSha256: 'b'.repeat(64),
    storagePath: 'org-1/invoices/bbbb.pdf',
    eligibleLineCount: 1,
    unmappedLineCount: 1,
    idempotent: false,
    ...overrides,
  }
}

export function baseInvoiceResult(
  overrides: Partial<InvoiceAnalysisApiResult> = {},
): InvoiceAnalysisApiResult {
  return {
    document: {
      supplier: { name: 'Alimentos Demo SA', taxId: '30-12345678-1' },
      header: {
        type: 'Factura A',
        number: '0001-00000001',
        issueDate: '2026-08-01',
        dueDate: null,
        currency: 'ARS',
        currencyNeedsConfirmation: false,
        clientNumber: null,
        meterNumber: null,
        paymentCode: null,
        printNumber: null,
      },
      amounts: { subtotal: 1000, discounts: 0, taxes: 210, otherTaxes: 0, total: 1210, taxesIncluded: false },
      classification: 'gastronomic_merchandise',
      mainCategory: 'gastronomic_merchandise',
      service: null,
      reviewStatus: 'ready',
      lines: [{
        id: 'line-harina',
        sourceIndex: 0,
        originalDescription: 'Harina',
        name: 'Harina',
        supplierSku: null,
        quantity: 10,
        unit: 'kg',
        unitPrice: 100,
        amount: 1000,
        classification: 'stock',
        inventoryEligibility: 'eligible',
        quantityKind: 'inventory',
        inventoryPhysicalQuantity: 10,
        missingFields: [],
        ambiguities: [],
      }],
    },
    interpretation: {
      version: 'senda-commercial-v1',
      lines: [{ lineId: 'line-harina', operation: 'normal_purchase', status: 'confirmed' }],
      relations: [],
      consistency: 'consistent',
      blocksReception: false,
      unresolvedLineIds: [],
    },
    validation: {
      status: 'ready',
      errors: [],
      warnings: [],
      pendingConfirmations: [],
      differences: { linesVsSubtotal: 0, calculatedVsTotal: 0 },
      fiscalReconciliation: {
        extracted: { tax: 210, otherTaxes: 0, total: 1210 },
        calculated: {
          taxFromIvaLines: 210,
          otherTaxesFromFiscalLines: 0,
          totalFromExtractedHeader: 1210,
          totalFromFiscalLines: 1210,
        },
        differences: { tax: 0, otherTaxes: 0, extractedHeaderVsTotal: 0, fiscalLinesVsTotal: 0 },
        origin: null,
        status: 'consistent',
      },
      consistency: 'consistent',
      dimensions: {
        mathematical: { status: 'consistent', issues: [] },
        fiscal: { status: 'consistent', issues: [] },
        commercial: { status: 'consistent', issues: [] },
        inventory: { status: 'consistent', issues: [] },
      },
      blocksReception: false,
      mathematicallyConsistent: true,
    },
    inventory: {
      eligibleLines: 1,
      pendingLines: 0,
      receptionBlocked: false,
      shouldOfferFutureReceipt: true,
    },
    metadata: {
      provider: 'fake-ai',
      model: 'fixture',
      promptVersion: 'senda-invoice-v2-service',
      processingTimeMs: 12,
    },
    ...overrides,
  }
}

export const bonusInvoiceResult = baseInvoiceResult({
  document: {
    ...baseInvoiceResult().document,
    reviewStatus: 'requires_review',
    lines: [
      {
        id: 'line-pilsen',
        sourceIndex: 0,
        originalDescription: 'PILSEN LTS 50',
        name: 'PILSEN',
        supplierSku: null,
        quantity: 50,
        unit: 'L',
        unitPrice: 1650,
        amount: 82500,
        classification: 'stock',
        inventoryEligibility: 'pending_review',
        quantityKind: 'inventory',
        inventoryPhysicalQuantity: 50,
        missingFields: [],
        ambiguities: [],
      },
      {
        id: 'line-bonus',
        sourceIndex: 1,
        originalDescription: 'PILSEN bonificación',
        name: 'PILSEN',
        supplierSku: null,
        quantity: 1,
        unit: 'L',
        unitPrice: -82500,
        amount: -82500,
        classification: 'stock',
        inventoryEligibility: 'ineligible',
        quantityKind: 'inventory',
        inventoryPhysicalQuantity: 0,
        missingFields: [],
        ambiguities: [],
      },
    ],
  },
  interpretation: {
    version: 'senda-commercial-v1',
    lines: [],
    relations: [{
      id: 'relation-line-bonus',
      type: 'bonus',
      status: 'proposed',
      targetLineId: 'line-pilsen',
      adjustmentLineIds: ['line-bonus'],
      candidateTargetLineIds: ['line-pilsen'],
      grossAmount: 82500,
      bonusAmount: 82500,
      netAcquisitionAmount: 0,
      bonusPercentage: 100,
      proposedPhysicalQuantity: 50,
      unit: 'L',
      warnings: [],
    }],
    consistency: 'requires_review',
    blocksReception: true,
    unresolvedLineIds: ['line-pilsen', 'line-bonus'],
  },
  inventory: {
    eligibleLines: 0,
    pendingLines: 1,
    receptionBlocked: true,
    shouldOfferFutureReceipt: false,
  },
  validation: {
    ...baseInvoiceResult().validation,
    status: 'requires_review',
    dimensions: {
      ...baseInvoiceResult().validation.dimensions,
      commercial: { status: 'requires_review', issues: ['COMMERCIAL_RELATION_REQUIRES_CONFIRMATION'] },
      inventory: { status: 'requires_review', issues: ['line-pilsen'] },
    },
    blocksReception: true,
  },
})

export const confirmedBonusInvoiceResult = applyCommercialReview(bonusInvoiceResult, {
  'relation-line-bonus': 'confirm',
})

export const serviceInvoiceResult = baseInvoiceResult({
  document: {
    ...baseInvoiceResult().document,
    supplier: { name: 'MetroGAS S.A.', taxId: '30-65786367-6' },
    header: {
      ...baseInvoiceResult().document.header,
      type: 'LIQUIDACION DE SERVICIOS PUBLICOS',
      number: 'A-0064-00658503',
      issueDate: '2026-07-15',
    },
    amounts: {
      subtotal: 119602.56,
      discounts: 0,
      taxes: 34302.14,
      otherTaxes: 20287.79,
      total: 174194.49,
      taxesIncluded: false,
    },
    classification: 'service',
    service: {
      type: 'gas',
      billingPeriod: '08/2026',
      periodStart: '2026-06-16',
      periodEnd: '2026-07-15',
      actualConsumption: { quantity: 307, unit: 'm3' },
      billedConsumption: { quantity: 332.74, unit: 'm3' },
      inventoryPhysicalQuantity: 0,
    },
    reviewStatus: 'requires_review',
    lines: [{
      id: 'line-consumo',
      sourceIndex: 1,
      originalDescription: 'CONSUMO TRAMO 1',
      name: 'CONSUMO TRAMO 1',
      supplierSku: null,
      quantity: 332.74,
      unit: 'm3',
      unitPrice: 292.435,
      amount: 97304.82,
      classification: 'service',
      inventoryEligibility: 'ineligible',
      quantityKind: 'service_consumption',
      inventoryPhysicalQuantity: 0,
      missingFields: [],
      ambiguities: [],
    }],
  },
  inventory: {
    eligibleLines: 0,
    pendingLines: 0,
    receptionBlocked: true,
    shouldOfferFutureReceipt: false,
  },
  validation: {
    ...baseInvoiceResult().validation,
    status: 'requires_review',
    pendingConfirmations: [],
    warnings: [{
      code: 'FISCAL_AGGREGATE_CLASSIFICATION_MISMATCH',
      severity: 'warning',
      message: 'El total del comprobante cierra, pero los agregados de IVA/percepciones no coinciden con las líneas fiscales clasificadas.',
      blocksReview: false,
      blocksReception: false,
      difference: 2,
    }],
    fiscalReconciliation: {
      extracted: { tax: 34302.14, otherTaxes: 20287.79, total: 174194.49 },
      calculated: {
        taxFromIvaLines: 34302.14,
        otherTaxesFromFiscalLines: 20289.79,
        totalFromExtractedHeader: 174192.49,
        totalFromFiscalLines: 174194.49,
      },
      differences: { tax: 0, otherTaxes: 2, extractedHeaderVsTotal: 2, fiscalLinesVsTotal: 0 },
      totalStatus: 'consistent',
      aggregatesStatus: 'requires_review',
      checks: {
        taxMatchesIvaLines: true,
        otherTaxesMatchPerceptionLines: false,
        headerExplainsTotal: false,
        fiscalLinesExplainTotal: true,
      },
      origin: 'aggregate_classification',
      status: 'requires_review',
    },
    dimensions: {
      mathematical: { status: 'consistent', issues: [] },
      fiscal: { status: 'requires_review', issues: ['FISCAL_AGGREGATE_CLASSIFICATION_MISMATCH'] },
      commercial: { status: 'consistent', issues: [] },
      inventory: { status: 'not_applicable', issues: [] },
    },
  },
})

export const serviceInvoiceConsistentResult = baseInvoiceResult({
  document: {
    ...serviceInvoiceResult.document,
    amounts: {
      ...serviceInvoiceResult.document.amounts,
      otherTaxes: 20289.79,
    },
    reviewStatus: 'ready',
  },
  inventory: serviceInvoiceResult.inventory,
  validation: {
    ...baseInvoiceResult().validation,
    fiscalReconciliation: {
      extracted: { tax: 34302.14, otherTaxes: 20289.79, total: 174194.49 },
      calculated: {
        taxFromIvaLines: 34302.14,
        otherTaxesFromFiscalLines: 20289.79,
        totalFromExtractedHeader: 174194.49,
        totalFromFiscalLines: 174194.49,
      },
      differences: { tax: 0, otherTaxes: 0, extractedHeaderVsTotal: 0, fiscalLinesVsTotal: 0 },
      origin: null,
      status: 'consistent',
    },
    dimensions: {
      mathematical: { status: 'consistent', issues: [] },
      fiscal: { status: 'consistent', issues: [] },
      commercial: { status: 'consistent', issues: [] },
      inventory: { status: 'not_applicable', issues: [] },
    },
  },
})

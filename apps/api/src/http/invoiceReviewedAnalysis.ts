import { applyInterpretationEligibility } from '../modules/invoice-intelligence/analyze.js'
import { interpretCommercialInvoice } from '../modules/invoice-intelligence/commercialInterpretation.js'
import { validateInvoice } from '../modules/invoice-intelligence/validate.js'
import type {
  CommercialRelationDecision,
  InvoiceAnalysisResult,
  InvoiceLineClassification,
  InventoryEligibility,
  InvoiceQuantityKind,
  NormalizedInvoiceDocument,
  NormalizedInvoiceLine,
} from '../modules/invoice-intelligence/types.js'
import type { InvoiceCommercialDecisionPayload } from './invoiceCommercialDecisions.js'
import {
  applyInvoiceCorrections,
  parseInvoiceCorrections,
  type InvoiceDocumentSnapshot,
} from './invoiceCorrections.js'
import { InvoiceSaveError } from './invoiceSaveError.js'
import type { InvoiceIntegritySnapshot } from './invoiceIntegrity.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function snapshotDocument(snapshot: InvoiceIntegritySnapshot): InvoiceDocumentSnapshot {
  if (!isRecord(snapshot.document)) {
    throw new InvoiceSaveError('El análisis original no tiene documento.', 'INVALID_SNAPSHOT', 422)
  }
  const document = snapshot.document
  if (!isRecord(document.supplier) || !isRecord(document.header) || !Array.isArray(document.lines)) {
    throw new InvoiceSaveError('El análisis original está incompleto.', 'INVALID_SNAPSHOT', 422)
  }
  const lines = document.lines.flatMap((line) => {
    if (!isRecord(line) || typeof line.id !== 'string') return []
    return [line as Record<string, unknown> & { id: string }]
  })
  if (lines.length < 1) {
    throw new InvoiceSaveError('El análisis original no tiene líneas.', 'INVALID_SNAPSHOT', 422)
  }
  return {
    supplier: {
      name: asNullableString(document.supplier.name),
      taxId: asNullableString(document.supplier.taxId),
    },
    header: {
      type: asNullableString(document.header.type),
      number: asNullableString(document.header.number),
      issueDate: asNullableString(document.header.issueDate),
      dueDate: asNullableString(document.header.dueDate),
      currency: asString(document.header.currency, 'ARS'),
      currencyNeedsConfirmation: document.header.currencyNeedsConfirmation === true,
      clientNumber: asNullableString(document.header.clientNumber),
      meterNumber: asNullableString(document.header.meterNumber),
      paymentCode: asNullableString(document.header.paymentCode),
      printNumber: asNullableString(document.header.printNumber),
    },
    amounts: isRecord(document.amounts)
      ? {
          subtotal: asNumber(document.amounts.subtotal),
          discounts: asNumber(document.amounts.discounts) ?? 0,
          taxes: asNumber(document.amounts.taxes) ?? 0,
          otherTaxes: asNumber(document.amounts.otherTaxes) ?? 0,
          total: asNumber(document.amounts.total),
          taxesIncluded: document.amounts.taxesIncluded === true,
        }
      : {
          subtotal: null,
          discounts: 0,
          taxes: 0,
          otherTaxes: 0,
          total: null,
          taxesIncluded: false,
        },
    classification: asString(document.classification, 'ambiguous'),
    mainCategory: asString(document.mainCategory, 'General'),
    service: document.service ?? null,
    reviewStatus: asString(document.reviewStatus, 'requires_review'),
    lines,
  }
}

function toNormalizedLine(line: Record<string, unknown> & { id: string }, index: number): NormalizedInvoiceLine {
  const classification = asString(line.classification, 'pending_review') as InvoiceLineClassification
  const eligibility = asString(line.inventoryEligibility, 'ineligible') as InventoryEligibility
  return {
    id: line.id,
    sourceIndex: typeof line.sourceIndex === 'number' ? line.sourceIndex : index,
    originalDescription: asString(line.originalDescription),
    name: asString(line.name),
    supplierSku: asNullableString(line.supplierSku),
    quantity: asNumber(line.quantity),
    unit: asNullableString(line.unit),
    packageCount: asNumber(line.packageCount),
    unitsPerPackage: asNumber(line.unitsPerPackage),
    contentPerUnit: asNumber(line.contentPerUnit),
    contentUnit: asNullableString(line.contentUnit),
    billedWeight: asNumber(line.billedWeight ?? line.billed_weight),
    billedWeightUnit: asNullableString(line.billedWeightUnit ?? line.billed_weight_unit),
    detectedUnits: asNumber(line.detectedUnits),
    unitPrice: asNumber(line.unitPrice),
    amount: asNumber(line.amount),
    taxRate: asNumber(line.taxRate),
    discount: asNumber(line.discount),
    category: asNullableString(line.category),
    usageType: asNullableString(line.usageType),
    classification,
    inventoryEligibility: eligibility,
    quantityKind: (asString(line.quantityKind, 'none') as InvoiceQuantityKind),
    inventoryPhysicalQuantity: asNumber(line.inventoryPhysicalQuantity) ?? 0,
    missingFields: asStringArray(line.missingFields),
    ambiguities: asStringArray(line.ambiguities),
    raw: {},
  }
}

function toNormalizedDocument(snapshotDoc: InvoiceDocumentSnapshot): NormalizedInvoiceDocument {
  const lines = snapshotDoc.lines.map((line, index) => toNormalizedLine(line, index))
  return {
    supplier: snapshotDoc.supplier,
    document: {
      type: snapshotDoc.header.type,
      number: snapshotDoc.header.number,
      issueDate: snapshotDoc.header.issueDate,
      dueDate: snapshotDoc.header.dueDate,
      currency: snapshotDoc.header.currency,
      currencyNeedsConfirmation: snapshotDoc.header.currencyNeedsConfirmation,
      clientNumber: snapshotDoc.header.clientNumber,
      meterNumber: snapshotDoc.header.meterNumber,
      paymentCode: snapshotDoc.header.paymentCode,
      printNumber: snapshotDoc.header.printNumber,
    },
    amounts: snapshotDoc.amounts,
    mainCategory: snapshotDoc.mainCategory,
    classification: snapshotDoc.classification as NormalizedInvoiceDocument['classification'],
    service: snapshotDoc.service as NormalizedInvoiceDocument['service'],
    reviewStatus: snapshotDoc.reviewStatus as NormalizedInvoiceDocument['reviewStatus'],
    lines,
    raw: {},
  }
}

function refreshEligibility(document: NormalizedInvoiceDocument) {
  for (const line of document.lines) {
    if (line.classification === 'pending_review') {
      line.inventoryEligibility = 'pending_review'
    } else if (line.classification === 'stock') {
      line.inventoryEligibility = 'eligible'
    } else {
      line.inventoryEligibility = 'ineligible'
    }
  }
}

export function commercialDecisionsForInterpretation(
  document: NormalizedInvoiceDocument,
  payload: InvoiceCommercialDecisionPayload[],
): CommercialRelationDecision[] {
  return payload.map((decision) => {
    const adjustmentId = decision.adjustmentLineIds[0]
    const adjustment = document.lines.find((line) => line.id === adjustmentId)
    const target = decision.targetLineId
      ? document.lines.find((line) => line.id === decision.targetLineId)
      : undefined
    if (!adjustment) {
      throw new InvoiceSaveError(
        'La decisión comercial no coincide con las líneas del análisis.',
        'INVALID_DECISION',
        422,
      )
    }
    return {
      adjustmentSourceIndex: adjustment.sourceIndex,
      ...(target ? { targetSourceIndex: target.sourceIndex } : {}),
      decision: decision.decision,
      type: decision.type,
    }
  })
}

export function recalculateReviewedAnalysis(input: {
  snapshot: InvoiceIntegritySnapshot
  corrections: unknown
  commercialDecisions: InvoiceCommercialDecisionPayload[]
  metadata?: InvoiceAnalysisResult['metadata']
}): {
  originalDocument: InvoiceDocumentSnapshot
  reviewedDocument: InvoiceDocumentSnapshot
  result: InvoiceAnalysisResult
  corrections: ReturnType<typeof parseInvoiceCorrections>
} {
  const originalDocument = snapshotDocument(input.snapshot)
  const parsedCorrections = parseInvoiceCorrections(input.corrections)
  const reviewedSnapshot = applyInvoiceCorrections(originalDocument, parsedCorrections)
  const document = toNormalizedDocument(reviewedSnapshot)
  refreshEligibility(document)
  const interpretation = interpretCommercialInvoice(document, {
    commercialDecisions: commercialDecisionsForInterpretation(document, input.commercialDecisions),
  })
  applyInterpretationEligibility(document, interpretation)
  const validation = validateInvoice(document, interpretation)
  document.reviewStatus = validation.status
  const eligibleLines = document.lines.filter((line) => line.inventoryEligibility === 'eligible').length
  const pendingLines = document.lines.filter((line) => line.inventoryEligibility === 'pending_review').length
  const snapshotMeta = isRecord(input.snapshot.metadata) ? input.snapshot.metadata : {}
  const result: InvoiceAnalysisResult = {
    document,
    interpretation,
    validation,
    metadata: input.metadata ?? {
      provider: asString(snapshotMeta.provider, 'unknown'),
      model: asString(snapshotMeta.model, 'unknown'),
      promptVersion: asString(snapshotMeta.promptVersion, 'senda-invoice-v2-service'),
      processingTimeMs: asNumber(snapshotMeta.processingTimeMs) ?? 0,
    },
    inventorySummary: {
      eligibleLines,
      pendingLines,
      receptionBlocked: validation.blocksReception,
      shouldOfferFutureReceipt: eligibleLines > 0 && !validation.blocksReception,
    },
  }
  return {
    originalDocument,
    reviewedDocument: reviewedSnapshot,
    result,
    corrections: parsedCorrections,
  }
}

export type InvoiceDocumentClassification =
  | 'gastronomic_merchandise'
  | 'service'
  | 'public_service'
  | 'administrative_expense'
  | 'rent'
  | 'professional_fees'
  | 'maintenance'
  | 'equipment'
  | 'logistics'
  | 'tax'
  | 'mixed'
  | 'ambiguous'

export type InvoiceLineClassification =
  | 'stock'
  | 'service'
  | 'expense'
  | 'logistics'
  | 'fiscal'
  | 'pending_review'
  | 'ignored'

export type InventoryEligibility = 'eligible' | 'ineligible' | 'pending_review'
export type ReviewStatus = 'ready' | 'requires_review' | 'invalid'
export type ValidationSeverity = 'error' | 'warning' | 'pending'
export type InterpretationStatus = 'confirmed' | 'proposed' | 'requires_review' | 'rejected'
export type LocalRelationDecision = 'pending' | 'confirm' | 'reject'
export type InvoiceQuantityKind = 'inventory' | 'service_consumption' | 'charge' | 'none'

export type CommercialRelationDecision = {
  adjustmentSourceIndex: number
  targetSourceIndex?: number
  decision: 'confirm' | 'reject'
  type?: 'bonus' | 'discount'
}

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

export type InvoiceIssue = {
  code: string
  severity: ValidationSeverity
  message: string
  field?: string
  lineId?: string
  blocksReview: boolean
  blocksReception: boolean
  difference?: number
}

export type InvoiceAnalysisLine = {
  id: string
  sourceIndex: number
  originalDescription: string
  name: string
  supplierSku: string | null
  quantity: number | null
  unit: string | null
  contentPerUnit?: number | null
  contentUnit?: string | null
  billedWeight?: number | null
  billedWeightUnit?: string | null
  unitPrice: number | null
  amount: number | null
  classification: InvoiceLineClassification
  inventoryEligibility: InventoryEligibility
  quantityKind: InvoiceQuantityKind
  inventoryPhysicalQuantity: number
  missingFields: string[]
  ambiguities: string[]
}

export type InvoiceCommercialRelation = {
  id: string
  type: 'bonus' | 'discount'
  status: InterpretationStatus
  targetLineId: string | null
  adjustmentLineIds: string[]
  candidateTargetLineIds: string[]
  grossAmount: number | null
  bonusAmount: number
  netAcquisitionAmount: number | null
  bonusPercentage: number | null
  proposedPhysicalQuantity: number | null
  unit: string | null
  warnings: string[]
}

export type FiscalReconciliation = {
  extracted: {
    tax: number
    otherTaxes: number
    total: number | null
  }
  calculated: {
    taxFromIvaLines: number
    otherTaxesFromFiscalLines: number
    totalFromExtractedHeader: number | null
    totalFromFiscalLines: number | null
  }
  differences: {
    tax: number
    otherTaxes: number
    extractedHeaderVsTotal: number | null
    fiscalLinesVsTotal: number | null
  }
  totalStatus?: 'consistent' | 'inconsistent' | 'not_applicable'
  aggregatesStatus?: 'consistent' | 'requires_review' | 'not_applicable'
  checks?: {
    taxMatchesIvaLines: boolean | null
    otherTaxesMatchPerceptionLines: boolean | null
    headerExplainsTotal: boolean | null
    fiscalLinesExplainTotal: boolean | null
  }
  origin:
    | 'extracted_tax'
    | 'extracted_other_taxes'
    | 'extracted_tax_and_other_taxes'
    | 'unexplained_total'
    | 'aggregate_classification'
    | null
  status: 'consistent' | 'requires_review' | 'inconsistent' | 'not_applicable'
}

export type ConsistencyDimension = {
  status: 'consistent' | 'requires_review' | 'inconsistent' | 'not_applicable'
  issues: string[]
}

export type InvoiceAnalysisApiResult = {
  document: {
    supplier: { name: string | null; taxId: string | null }
    header: {
      type: string | null
      number: string | null
      issueDate: string | null
      dueDate: string | null
      currency: string
      currencyNeedsConfirmation: boolean
      clientNumber: string | null
      meterNumber: string | null
      paymentCode: string | null
      printNumber: string | null
    }
    amounts: {
      subtotal: number | null
      discounts: number
      taxes: number
      otherTaxes: number
      total: number | null
      taxesIncluded: boolean
    }
    classification: InvoiceDocumentClassification
    mainCategory: string
    service: {
      type: 'gas' | 'electricity' | 'internet' | 'maintenance' | 'other'
      billingPeriod: string | null
      periodStart: string | null
      periodEnd: string | null
      actualConsumption: { quantity: number; unit: string } | null
      billedConsumption: { quantity: number; unit: string } | null
      inventoryPhysicalQuantity: 0
    } | null
    reviewStatus: ReviewStatus
    lines: InvoiceAnalysisLine[]
  }
  interpretation: {
    version: string
    lines: Array<{
      lineId: string
      operation: string
      status: InterpretationStatus
    }>
    relations: InvoiceCommercialRelation[]
    consistency: 'consistent' | 'requires_review' | 'inconsistent'
    blocksReception: boolean
    unresolvedLineIds: string[]
  }
  validation: {
    status: ReviewStatus
    errors: InvoiceIssue[]
    warnings: InvoiceIssue[]
    pendingConfirmations: InvoiceIssue[]
    differences: {
      linesVsSubtotal: number | null
      calculatedVsTotal: number | null
    }
    fiscalReconciliation: FiscalReconciliation
    consistency: 'consistent' | 'inconsistent' | 'undetermined'
    dimensions: {
      mathematical: ConsistencyDimension
      fiscal: ConsistencyDimension
      commercial: ConsistencyDimension
      inventory: ConsistencyDimension
    }
    blocksReception: boolean
    mathematicallyConsistent: boolean
  }
  inventory: {
    eligibleLines: number
    pendingLines: number
    receptionBlocked: boolean
    shouldOfferFutureReceipt: boolean
  }
  metadata: {
    provider: string
    model: string
    promptVersion: string
    processingTimeMs: number
    fileSha256?: string
    snapshotSha256?: string
    integrityToken?: string
    integrityExpiresAt?: string
  }
}

export type InvoiceSaveCorrections = {
  supplier?: { name?: string; taxId?: string }
  header?: {
    type?: string
    number?: string
    issueDate?: string
    currency?: string
  }
  lines?: Array<{
    id: string
    name?: string
    quantity?: number | null
    unit?: string | null
    unitPrice?: number | null
    amount?: number | null
    classification?: InvoiceLineClassification
  }>
}

export type InvoiceSaveApiResult = {
  id: string
  status: 'reviewed'
  locationId: string
  organizationId: string
  fileSha256: string
  storagePath: string
  eligibleLineCount: number
  unmappedLineCount: number
  idempotent: boolean
  confirmIntentStored?: boolean
}

export type InvoiceDuplicateMatch = {
  id: string
  supplierName: string | null
  documentNumber: string | null
  documentDate: string | null
  status: string
  locationId: string
  disposition?: 'active' | 'deleted'
}

export type InvoiceListItem = {
  id: string
  supplierName: string | null
  documentDate: string | null
  documentNumber: string | null
  documentType: string | null
  status: string
  currency: string
  total: number | null
  locationId: string
  organizationId: string
  pendingConfiguration: boolean
  pendingReceive: boolean
  hasReceipts?: boolean
}

export type PendingReceptionLine = {
  invoiceId: string
  lineId: string
  supplierName: string | null
  documentNumber: string | null
  documentDate: string | null
  locationId: string
  ingredientId: string
  ingredientName: string
  baseUnit: string | null
  invoicedQuantity: number
  receivedQuantity: number
  remainingQuantity: number
}

export type PendingReceptionPage = {
  items: PendingReceptionLine[]
  nextCursor: string | null
}

export type InvoiceMappedProduct = {
  id: string
  name: string
  baseUnit: string | null
}

export type InvoiceMappingSuggestion = {
  kind: 'exact' | 'approximate'
  inventoryProductId: string
  inventoryProduct: InvoiceMappedProduct
  conversionFactor: number | null
  source: 'confirmed_mapping'
}

export type InvoiceStoredLine = {
  id: string
  sourceLineId: string
  sourceIndex: number | null
  original: {
    description: string | null
    quantity: number | null
    unit: string | null
    unitPrice: number | null
    amount: number | null
  }
  reviewed: {
    description: string | null
    quantity: number | null
    unit: string | null
    unitPrice: number | null
    amount: number | null
  }
  classification: string | null
  inventoryEligibility: string | null
  mappingStatus: string | null
  quantityKind: string | null
  inventoryPhysicalQuantity: number
  inventoryProductId: string | null
  inventoryProduct: InvoiceMappedProduct | null
  mappingSuggestion?: InvoiceMappingSuggestion | null
  invoicedQuantity?: number | null
  receivedQuantity?: number | null
  remainingQuantity?: number | null
  configurationStatus?: 'pending_configuration' | null
}

export type InventoryProductOption = InvoiceMappedProduct & {
  organizationId?: string
  active?: boolean
}

export type InvoiceMapResult = {
  id: string
  sourceLineId: string
  mappingStatus: 'mapped'
  inventoryProductId: string
  inventoryPhysicalQuantity: number
  inventoryProduct: InventoryProductOption
  unmappedLineCount: number
}

export type InvoiceReceiveResult = {
  id: string
  purchaseDocumentId: string
  purchaseDocumentLineId: string
  quantity: number
  invoicedQuantity: number
  receivedQuantity: number
  remainingQuantity: number
  documentStatus: string
  inventoryMovementId: string | null
  idempotent: boolean
}

export type InvoiceCancelResult = {
  id: string
  status: 'cancelled'
  replay: boolean
}

export type InvoiceDeleteResult = {
  id: string
  deleted: true
}

export type InvoiceFileAccess = {
  url: string
  expiresAt: string
  expiresInSeconds: number
  contentType: string | null
}

export type InvoiceDetail = {
  id: string
  status: string
  locationId: string
  organizationId: string
  supplierName: string | null
  issuerTaxId: string | null
  documentDate: string | null
  documentNumber: string | null
  documentType: string | null
  classification: string | null
  currency: string
  eligibleLineCount: number
  unmappedLineCount: number
  fiscalDifferenceAccepted: boolean
  originalAnalysis: InvoiceAnalysisApiResult | null
  reviewedAnalysis: InvoiceAnalysisApiResult | null
  corrections: InvoiceSaveCorrections | Record<string, unknown>
  commercialDecisions: InvoiceCommercialDecisionPayload[]
  lines: InvoiceStoredLine[]
  file: InvoiceFileAccess | null
}

export type SelectedInvoiceFile = {
  file: File
  name: string
  type: string
  size: number
}

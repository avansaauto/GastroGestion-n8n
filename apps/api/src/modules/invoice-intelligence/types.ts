export const INVOICE_PROMPT_VERSION = 'senda-invoice-v3-billed-weight' as const

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
export type CommercialOperation =
  | 'normal_purchase'
  | 'bonus'
  | 'discount'
  | 'commercial_adjustment'
  | 'return'
  | 'service'
  | 'expense'
  | 'logistics'
  | 'fiscal'
  | 'pending_review'
  | 'ignored'
export type InterpretationStatus =
  | 'confirmed'
  | 'proposed'
  | 'requires_review'
  | 'rejected'
export type PhysicalMovement = 'inbound' | 'outbound' | 'none' | 'pending_review'

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

export type ExtractedInvoiceLine = {
  description_original?: unknown
  descripcion_original?: unknown
  name?: unknown
  nombre?: unknown
  supplier_sku?: unknown
  codigo_proveedor?: unknown
  quantity?: unknown
  cantidad?: unknown
  cantidad_packs?: unknown
  package_count?: unknown
  cantidad_bultos?: unknown
  units_per_package?: unknown
  cantidad_unidades_por_bulto?: unknown
  pack?: unknown
  content_per_unit?: unknown
  contenido?: unknown
  content_unit?: unknown
  contenido_um?: unknown
  /** Peso/volumen facturado total (p. ej. Cant. KG), prioriza sobre el contenido aproximado de la descripción. */
  billed_weight?: unknown
  peso_facturado?: unknown
  cant_kg?: unknown
  billed_weight_unit?: unknown
  peso_facturado_um?: unknown
  unit?: unknown
  unidad?: unknown
  unit_price?: unknown
  precio_unitario?: unknown
  amount?: unknown
  subtotal?: unknown
  tax_rate?: unknown
  porcentaje_iva?: unknown
  discount?: unknown
  descuento?: unknown
  category?: unknown
  categoria?: unknown
  usage_type?: unknown
  tipo_uso?: unknown
  suitable_for_stock?: unknown
  apto_para_stock?: unknown
  is_summary?: unknown
  es_subtotal?: unknown
  quantity_kind?: unknown
  [key: string]: unknown
}

export type ExtractedInvoice = {
  supplier_name?: unknown
  proveedor_nombre?: unknown
  supplier_tax_id?: unknown
  proveedor_cuit?: unknown
  document_type?: unknown
  tipo_comprobante?: unknown
  tipo_comprobante_codigo?: unknown
  document_number?: unknown
  numero?: unknown
  numero_comprobante?: unknown
  issue_date?: unknown
  fecha_emision?: unknown
  currency?: unknown
  moneda?: unknown
  subtotal?: unknown
  discounts?: unknown
  descuentos?: unknown
  tax?: unknown
  iva?: unknown
  other_taxes?: unknown
  otros_impuestos?: unknown
  total?: unknown
  main_category?: unknown
  rubro_principal?: unknown
  expense_category?: unknown
  categoria_gasto?: unknown
  doubtful_fields?: unknown
  campos_dudosos?: unknown
  warnings?: unknown
  advertencias?: unknown
  taxes_included?: unknown
  impuestos_incluidos?: unknown
  lines?: unknown
  items?: unknown
  service_type?: unknown
  tipo_servicio?: unknown
  billing_period?: unknown
  periodo_facturado?: unknown
  billing_period_start?: unknown
  periodo_facturado_desde?: unknown
  billing_period_end?: unknown
  periodo_facturado_hasta?: unknown
  actual_consumption?: unknown
  consumo_real?: unknown
  billed_consumption?: unknown
  consumo_facturado?: unknown
  client_number?: unknown
  numero_cliente?: unknown
  meter_number?: unknown
  numero_medidor?: unknown
  due_date?: unknown
  fecha_vencimiento?: unknown
  payment_code?: unknown
  codigo_pago?: unknown
  print_number?: unknown
  numero_impresion?: unknown
  [key: string]: unknown
}

export type InvoiceServiceType = 'gas' | 'electricity' | 'internet' | 'maintenance' | 'other'
export type InvoiceQuantityKind = 'inventory' | 'service_consumption' | 'charge' | 'none'

export type InvoiceConsumption = {
  quantity: number
  unit: string
}

export type NormalizedInvoiceLine = {
  id: string
  sourceIndex: number
  originalDescription: string
  name: string
  supplierSku: string | null
  quantity: number | null
  unit: string | null
  packageCount: number | null
  unitsPerPackage: number | null
  contentPerUnit: number | null
  contentUnit: string | null
  /** Peso/volumen facturado total explícito (Cant. KG, etc.). Null si no vino en la extracción. */
  billedWeight: number | null
  billedWeightUnit: string | null
  detectedUnits: number | null
  unitPrice: number | null
  amount: number | null
  taxRate: number | null
  discount: number | null
  category: string | null
  usageType: string | null
  classification: InvoiceLineClassification
  inventoryEligibility: InventoryEligibility
  quantityKind: InvoiceQuantityKind
  inventoryPhysicalQuantity: number
  missingFields: string[]
  ambiguities: string[]
  raw: ExtractedInvoiceLine
}

export type NormalizedInvoiceDocument = {
  supplier: {
    name: string | null
    taxId: string | null
  }
  document: {
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
  mainCategory: string
  classification: InvoiceDocumentClassification
  service: {
    type: InvoiceServiceType
    billingPeriod: string | null
    periodStart: string | null
    periodEnd: string | null
    actualConsumption: InvoiceConsumption | null
    billedConsumption: InvoiceConsumption | null
    inventoryPhysicalQuantity: 0
  } | null
  reviewStatus: ReviewStatus
  lines: NormalizedInvoiceLine[]
  raw: ExtractedInvoice
}

export type CommercialEvidence = {
  code: string
  message: string
  lineIds: string[]
}

export type InvoicePriceBasis = 'commercial_unit' | 'weight' | 'ambiguous'

export type InvoiceLineInterpretation = {
  lineId: string
  operation: CommercialOperation
  status: InterpretationStatus
  relatedLineIds: string[]
  physical: {
    movement: PhysicalMovement
    /** Cantidad física sugerida para inventario (p. ej. g/ml), sin pisar la cantidad facturada. */
    proposedQuantity: number | null
    unit: string | null
    /** Cantidad comercial/facturada tal como en el comprobante. */
    commercialQuantity: number | null
    commercialUnit: string | null
    /** Peso facturado cuando el precio es por kg (u otra masa). */
    billedWeight: number | null
    billedWeightUnit: string | null
    priceBasis: InvoicePriceBasis | null
  }
  economic: {
    grossAmount: number | null
    bonusAmount: number
    netAcquisitionAmount: number | null
    bonusPercentage: number | null
    preserveCommercialReferenceCost: boolean
  }
  evidence: CommercialEvidence[]
  warnings: string[]
  pendingFields: string[]
}

export type CommercialRelation = {
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
  preserveCommercialReferenceCost: true
  evidence: CommercialEvidence[]
  warnings: string[]
}

export type InvoiceCommercialInterpretation = {
  version: 'senda-commercial-v1'
  lines: InvoiceLineInterpretation[]
  relations: CommercialRelation[]
  consistency: 'consistent' | 'requires_review' | 'inconsistent'
  blocksReception: boolean
  unresolvedLineIds: string[]
}

export type CommercialRelationDecision = {
  adjustmentSourceIndex: number
  targetSourceIndex?: number
  decision: 'confirm' | 'reject'
  type?: 'bonus' | 'discount'
}

export type InvoiceAnalysisOptions = {
  commercialDecisions?: CommercialRelationDecision[]
}

export type ConsistencyDimension = {
  status: 'consistent' | 'requires_review' | 'inconsistent' | 'not_applicable'
  issues: string[]
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
  /** Conciliación del total final (cabecera o líneas fiscales vs total). */
  totalStatus: 'consistent' | 'inconsistent' | 'not_applicable'
  /** IVA / percepciones: cabecera vs líneas fiscales clasificadas. */
  aggregatesStatus: 'consistent' | 'requires_review' | 'not_applicable'
  checks: {
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

export type InvoiceValidation = {
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

export type AiUsage = {
  promptTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type InvoiceAnalysisMetadata = {
  provider: string
  model: string
  promptVersion: string
  processingTimeMs: number
  usage?: AiUsage
}

export type InvoiceAnalysisResult = {
  document: NormalizedInvoiceDocument
  interpretation: InvoiceCommercialInterpretation
  validation: InvoiceValidation
  metadata: InvoiceAnalysisMetadata
  inventorySummary: {
    eligibleLines: number
    pendingLines: number
    receptionBlocked: boolean
    shouldOfferFutureReceipt: boolean
  }
}

export type InvoiceDocumentInput = {
  base64: string
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp'
  filename?: string
}

export type AiExtractionResult = {
  extracted: unknown
  provider: string
  model: string
  usage?: AiUsage
}

export interface InvoiceAiProvider {
  extract(input: InvoiceDocumentInput): Promise<AiExtractionResult>
}

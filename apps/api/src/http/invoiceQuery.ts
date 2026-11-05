import type { SupabaseClient } from '@supabase/supabase-js'
import {
  confirmedMemoryFromMappedLine,
  suggestFromConfirmedMemory,
  type ConfirmedMappingMemory,
  type InvoiceMappingSuggestion,
  type MemoryProduct,
} from './invoiceMemory.js'
import { InvoiceQueryError } from './invoiceQueryError.js'
import {
  INVOICE_SIGNED_URL_TTL_SECONDS,
  contentTypeFromStoragePath,
  createInvoiceSignedUrl,
} from './invoiceStorage.js'
import {
  isCompleteVoucherIdentity,
  parseExplicitVoucherIdentity,
  type CompleteVoucherIdentity,
} from './invoiceVoucher.js'

const DOCUMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FILE_SHA256_RE = /^[a-f0-9]{64}$/i

const EXCLUDED_CLASSIFICATIONS = new Set(['fiscal', 'service', 'ignored', 'expense', 'logistics'])
const EXCLUDED_QUANTITY_KINDS = new Set(['service_consumption', 'charge', 'none'])

export type InvoiceLineConfigurationStatus = 'pending_configuration' | null

const LIST_COLUMNS = [
  'id',
  'issuer_name',
  'document_date',
  'document_number',
  'document_type',
  'status',
  'currency',
  'location_id',
  'organization_id',
  'reviewed_analysis',
].join(', ')

const DETAIL_COLUMNS = [
  'id',
  'status',
  'location_id',
  'organization_id',
  'currency',
  'issuer_name',
  'issuer_tax_id_normalized',
  'document_number',
  'document_date',
  'document_type',
  'classification',
  'eligible_line_count',
  'unmapped_line_count',
  'original_analysis',
  'reviewed_analysis',
  'corrections',
  'commercial_decisions',
  'fiscal_difference_accepted',
  'storage_object_path',
  'file_sha256',
].join(', ')

const DUPLICATE_COLUMNS = [
  'id',
  'issuer_name',
  'document_number',
  'document_date',
  'status',
  'location_id',
  'organization_id',
].join(', ')

const LINE_COLUMNS = [
  'id',
  'source_line_id',
  'source_index',
  'original_description',
  'original_quantity',
  'original_unit',
  'original_unit_price',
  'original_amount',
  'reviewed_description',
  'reviewed_quantity',
  'reviewed_unit',
  'reviewed_unit_price',
  'reviewed_amount',
  'classification',
  'inventory_eligibility',
  'mapping_status',
  'quantity_kind',
  'inventory_physical_quantity',
  'inventory_product_id',
].join(', ')

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
  hasReceipts: boolean
}

export type InvoiceMappedProduct = {
  id: string
  name: string
  baseUnit: string | null
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
  mappingSuggestion: InvoiceMappingSuggestion | null
  invoicedQuantity: number | null
  receivedQuantity: number | null
  remainingQuantity: number | null
  configurationStatus: InvoiceLineConfigurationStatus
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
  originalAnalysis: unknown
  reviewedAnalysis: unknown
  corrections: unknown
  commercialDecisions: unknown
  lines: InvoiceStoredLine[]
  file: InvoiceFileAccess | null
}

export type InvoiceDuplicateMatch = {
  id: string
  supplierName: string | null
  documentNumber: string | null
  documentDate: string | null
  status: string
  locationId: string
  /** active bloquea el alta. deleted solo informa que la anterior fue eliminada. */
  disposition?: 'active' | 'deleted'
}

export type InvoiceDuplicateLookupInput = {
  userClient: SupabaseClient
  locationId: string
  fileSha256?: string | null
  issuerTaxId?: string | null
  voucherType?: string | null
  pointOfSale?: string | null
  voucherNumber?: string | null
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

export type ListPendingReceptionsInput = {
  userClient: SupabaseClient
  locationId: string
  cursor?: unknown
  limit?: unknown
}

export type ListSavedInvoicesInput = {
  userClient: SupabaseClient
  locationId: string
}

export type InvoiceQueryPort = {
  listSavedInvoices(input: ListSavedInvoicesInput): Promise<InvoiceListItem[]>
  lookupDuplicateInvoice(input: InvoiceDuplicateLookupInput): Promise<InvoiceDuplicateMatch | null>
  listPendingReceptions(input: ListPendingReceptionsInput): Promise<PendingReceptionPage>
  getSavedInvoice(input: {
    userClient: SupabaseClient
    adminClient: SupabaseClient | null
    id: string
    now?: Date
  }): Promise<InvoiceDetail>
  getSavedInvoiceFile(input: {
    userClient: SupabaseClient
    adminClient: SupabaseClient | null
    id: string
    now?: Date
  }): Promise<InvoiceFileAccess>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function analysisTotal(analysis: unknown): number | null {
  if (!isRecord(analysis) || !isRecord(analysis.document)) return null
  const amounts = analysis.document.amounts
  if (!isRecord(amounts)) return null
  return asNumber(amounts.total)
}

function stripIntegrity(analysis: unknown): unknown {
  if (!isRecord(analysis) || !isRecord(analysis.metadata)) return analysis
  const metadata = { ...analysis.metadata }
  delete metadata.integrityToken
  delete metadata.integrityExpiresAt
  delete metadata.snapshotSha256
  return { ...analysis, metadata }
}

function notFound(): never {
  throw new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)
}

type QueryErrorLike = {
  code?: string
  message?: string
  details?: string
  hint?: string
} | null

function queryErrorBlob(error: QueryErrorLike): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''}`
}

/** Columna deleted_at aún no instalada (migración proposed-senda-delete-purchase-invoice). */
export function isPurchaseDocumentsDeletedAtMissing(error: QueryErrorLike): boolean {
  const blob = queryErrorBlob(error)
  if (!/deleted_at/i.test(blob)) return false
  if (/\b(42703|PGRST204)\b/.test(blob)) return true
  if (/column .*deleted_at.* does not exist/i.test(blob)) return true
  if (/could not find.*deleted_at/i.test(blob)) return true
  return false
}

function logInvoiceQueryError(operation: string, error: QueryErrorLike) {
  console.error(JSON.stringify({
    operation,
    code: error?.code ?? null,
    message: error?.message ?? null,
    details: error?.details ?? null,
  }))
}

function lookupFailed(
  operation = 'invoice_query',
  error: QueryErrorLike = null,
  message = 'No se pudieron consultar las facturas.',
): never {
  logInvoiceQueryError(operation, error)
  throw new InvoiceQueryError(message, 'LOOKUP_FAILED', 500)
}

export function assertInvoiceDocumentId(id: string): string {
  const trimmed = id.trim()
  if (!DOCUMENT_ID_RE.test(trimmed)) {
    throw new InvoiceQueryError('El identificador de la factura no es válido.', 'DOCUMENT_ID_INVALID', 400)
  }
  return trimmed
}

function filled(value?: string | null): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

async function loadVisibleLocation(
  userClient: SupabaseClient,
  locationId: string,
): Promise<{ id: string; organizationId: string }> {
  if (!DOCUMENT_ID_RE.test(locationId)) {
    throw new InvoiceQueryError('El identificador del local no es válido.', 'LOCATION_ID_INVALID', 400)
  }
  const { data, error } = await userClient
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) {
    throw new InvoiceQueryError('No se pudieron consultar los locales.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || !data.id || !data.organization_id) {
    throw new InvoiceQueryError('El local no existe o no pertenece a tu organización.', 'FORBIDDEN', 403)
  }
  return {
    id: String(data.id),
    organizationId: String(data.organization_id),
  }
}

function mapDuplicateMatch(row: Record<string, unknown>): InvoiceDuplicateMatch {
  return {
    id: String(row.id),
    supplierName: asString(row.issuer_name),
    documentNumber: asString(row.document_number),
    documentDate: asString(row.document_date),
    status: asString(row.status) ?? '',
    locationId: String(row.location_id ?? ''),
  }
}

function visibleDuplicate(
  row: unknown,
  organizationId: string,
): InvoiceDuplicateMatch | null {
  if (!isRecord(row) || !row.id) return null
  if (asString(row.status) === 'cancelled') return null
  if (String(row.organization_id ?? '') !== organizationId) return null
  return mapDuplicateMatch(row)
}

export async function lookupDuplicateInvoice(
  input: InvoiceDuplicateLookupInput,
): Promise<InvoiceDuplicateMatch | null> {
  const locationId = filled(input.locationId)
  if (!locationId) {
    throw new InvoiceQueryError('El identificador del local es obligatorio.', 'LOCATION_ID_INVALID', 400)
  }

  const fileSha256 = filled(input.fileSha256)
  const issuerTaxId = filled(input.issuerTaxId)
  const voucherType = filled(input.voucherType)
  const pointOfSale = filled(input.pointOfSale)
  const voucherNumber = filled(input.voucherNumber)
  const fiscalCount = [issuerTaxId, voucherType, pointOfSale, voucherNumber].filter(Boolean).length

  if (fileSha256 && fiscalCount > 0) {
    throw new InvoiceQueryError(
      'Usá el hash del archivo o la identidad fiscal, no ambos.',
      'LOOKUP_AMBIGUOUS',
      400,
    )
  }
  if (!fileSha256 && fiscalCount === 0) {
    throw new InvoiceQueryError(
      'Indicá el hash del archivo o la identidad fiscal completa.',
      'LOOKUP_REQUIRED',
      400,
    )
  }

  let normalizedHash: string | null = null
  let identity: CompleteVoucherIdentity | null = null
  if (fileSha256) {
    if (!FILE_SHA256_RE.test(fileSha256)) {
      throw new InvoiceQueryError('El hash del archivo no es un SHA-256 válido.', 'HASH_INVALID', 400)
    }
    normalizedHash = fileSha256.toLowerCase()
  } else {
    if (fiscalCount !== 4) {
      throw new InvoiceQueryError(
        'La identidad fiscal está incompleta o no es válida.',
        'IDENTITY_INCOMPLETE',
        400,
      )
    }
    const parsed = parseExplicitVoucherIdentity({
      taxId: issuerTaxId,
      voucherType,
      pointOfSale,
      voucherNumber,
    })
    if (!isCompleteVoucherIdentity(parsed)) {
      throw new InvoiceQueryError(
        'La identidad fiscal está incompleta o no es válida.',
        'IDENTITY_INCOMPLETE',
        400,
      )
    }
    identity = parsed
  }

  const location = await loadVisibleLocation(input.userClient, locationId)

  async function findDuplicate(filterDeleted: boolean) {
    let documents = input.userClient
      .from('purchase_documents')
      .select(DUPLICATE_COLUMNS)
      .eq('organization_id', location.organizationId)
      .neq('status', 'cancelled')
    if (filterDeleted) {
      documents = documents.is('deleted_at', null)
    }
    if (normalizedHash) {
      return documents.eq('file_sha256', normalizedHash).maybeSingle()
    }
    if (!identity) {
      return { data: null, error: { message: 'IDENTITY_REQUIRED' } }
    }
    return documents
      .eq('issuer_tax_id_normalized', identity.issuerTaxIdNormalized)
      .eq('voucher_type', identity.voucherType)
      .eq('point_of_sale', identity.pointOfSale)
      .eq('voucher_number', identity.voucherNumber)
      .maybeSingle()
  }

  let deletedAtAvailable = true
  let { data, error } = await findDuplicate(true)
  if (error && isPurchaseDocumentsDeletedAtMissing(error)) {
    logInvoiceQueryError('lookupDuplicateInvoice.deleted_at_missing', error)
    deletedAtAvailable = false
    ;({ data, error } = await findDuplicate(false))
  }
  if (error) lookupFailed('lookupDuplicateInvoice', error)
  const active = visibleDuplicate(data, location.organizationId)
  if (active || !deletedAtAvailable) return active

  const prior = await findDeletedDuplicate()
  if (prior.error && isPurchaseDocumentsDeletedAtMissing(prior.error)) return null
  if (prior.error) lookupFailed('lookupDuplicateInvoice.deleted', prior.error)
  const deleted = visibleDuplicate(prior.data, location.organizationId)
  if (!deleted) return null
  return { ...deleted, disposition: 'deleted' }

  async function findDeletedDuplicate() {
    let documents = input.userClient
      .from('purchase_documents')
      .select(DUPLICATE_COLUMNS)
      .eq('organization_id', location.organizationId)
      .neq('status', 'cancelled')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(1)
    if (normalizedHash) {
      return documents.eq('file_sha256', normalizedHash).maybeSingle()
    }
    if (!identity) {
      return { data: null, error: { message: 'IDENTITY_REQUIRED' } }
    }
    return documents
      .eq('issuer_tax_id_normalized', identity.issuerTaxIdNormalized)
      .eq('voucher_type', identity.voucherType)
      .eq('point_of_sale', identity.pointOfSale)
      .eq('voucher_number', identity.voucherNumber)
      .maybeSingle()
  }
}

function mapListItem(row: Record<string, unknown>): InvoiceListItem {
  return {
    id: String(row.id),
    supplierName: asString(row.issuer_name),
    documentDate: asString(row.document_date),
    documentNumber: asString(row.document_number),
    documentType: asString(row.document_type),
    status: asString(row.status) ?? 'reviewed',
    currency: asString(row.currency) ?? 'ARS',
    total: analysisTotal(row.reviewed_analysis),
    locationId: String(row.location_id ?? ''),
    organizationId: String(row.organization_id ?? ''),
    pendingConfiguration: false,
    pendingReceive: false,
    hasReceipts: false,
  }
}

function mapLine(row: Record<string, unknown>): InvoiceStoredLine {
  return {
    id: String(row.id ?? ''),
    sourceLineId: String(row.source_line_id ?? ''),
    sourceIndex: asNumber(row.source_index),
    original: {
      description: asString(row.original_description),
      quantity: asNumber(row.original_quantity),
      unit: asString(row.original_unit),
      unitPrice: asNumber(row.original_unit_price),
      amount: asNumber(row.original_amount),
    },
    reviewed: {
      description: asString(row.reviewed_description),
      quantity: asNumber(row.reviewed_quantity),
      unit: asString(row.reviewed_unit),
      unitPrice: asNumber(row.reviewed_unit_price),
      amount: asNumber(row.reviewed_amount),
    },
    classification: asString(row.classification),
    inventoryEligibility: asString(row.inventory_eligibility),
    mappingStatus: asString(row.mapping_status),
    quantityKind: asString(row.quantity_kind),
    inventoryPhysicalQuantity: asNumber(row.inventory_physical_quantity) ?? 0,
    inventoryProductId: asString(row.inventory_product_id),
    inventoryProduct: null,
    mappingSuggestion: null,
    invoicedQuantity: null,
    receivedQuantity: null,
    remainingQuantity: null,
    configurationStatus: null,
  }
}

function isInventoriableQueryLine(line: InvoiceStoredLine): boolean {
  if (line.inventoryEligibility !== 'eligible') return false
  if (line.mappingStatus === 'not_applicable') return false
  if (line.classification && EXCLUDED_CLASSIFICATIONS.has(line.classification)) return false
  if (line.quantityKind && EXCLUDED_QUANTITY_KINDS.has(line.quantityKind)) return false
  const amount = line.reviewed.amount ?? line.original.amount ?? 0
  if (amount < 0) return false
  return true
}

function needsConfiguration(line: InvoiceStoredLine): boolean {
  return line.mappingStatus !== 'mapped' || line.inventoryProductId == null
}

const LIST_LINE_COLUMNS = [
  'id',
  'purchase_document_id',
  'classification',
  'inventory_eligibility',
  'mapping_status',
  'quantity_kind',
  'inventory_physical_quantity',
  'inventory_product_id',
  'original_amount',
  'reviewed_amount',
].join(', ')

export function summarizeInvoiceWorkflow(
  lines: InvoiceStoredLine[],
  receivedByLine: Map<string, number>,
): { pendingConfiguration: boolean; pendingReceive: boolean; hasReceipts: boolean } {
  let pendingConfiguration = false
  let pendingReceive = false
  let hasReceipts = false
  for (const line of lines) {
    const received = receivedByLine.get(line.id) ?? 0
    if (received > 0) hasReceipts = true
    if (!isInventoriableQueryLine(line)) continue
    if (needsConfiguration(line)) {
      pendingConfiguration = true
      continue
    }
    if (line.inventoryPhysicalQuantity - received > 0) pendingReceive = true
  }
  return { pendingConfiguration, pendingReceive, hasReceipts }
}

async function loadReceiptQuantitiesByLine(
  userClient: SupabaseClient,
  documentIds: string[],
): Promise<Map<string, number>> {
  if (documentIds.length === 0) return new Map()
  const query = userClient
    .from('purchase_document_receipts')
    .select('purchase_document_line_id, quantity')
  const { data, error } = documentIds.length === 1
    ? await query.eq('purchase_document_id', documentIds[0])
    : await query.in('purchase_document_id', documentIds)
  if (error) {
    lookupFailed('loadReceiptQuantitiesByLine', error, 'No se pudieron consultar las recepciones.')
  }
  const totals = new Map<string, number>()
  for (const row of Array.isArray(data) ? data : []) {
    if (!isRecord(row)) continue
    const lineId = asString(row.purchase_document_line_id)
    const quantity = asNumber(row.quantity)
    if (!lineId || quantity == null) continue
    totals.set(lineId, (totals.get(lineId) ?? 0) + quantity)
  }
  return totals
}

async function loadListLinesByDocument(
  userClient: SupabaseClient,
  documentIds: string[],
): Promise<Map<string, InvoiceStoredLine[]>> {
  const grouped = new Map<string, InvoiceStoredLine[]>()
  if (documentIds.length === 0) return grouped
  const { data, error } = await userClient
    .from('purchase_document_lines')
    .select(LIST_LINE_COLUMNS)
    .in('purchase_document_id', documentIds)
  if (error) lookupFailed('loadListLinesByDocument', error)
  for (const row of (Array.isArray(data) ? data as unknown[] : []).filter(isRecord)) {
    const documentId = asString(row.purchase_document_id)
    if (!documentId) continue
    const lines = grouped.get(documentId) ?? []
    lines.push(mapLine(row))
    grouped.set(documentId, lines)
  }
  return grouped
}

function attachReceptionQuantities(
  line: InvoiceStoredLine,
  receivedByLine: Map<string, number>,
): InvoiceStoredLine {
  if (!isInventoriableQueryLine(line)) {
    return {
      ...line,
      invoicedQuantity: null,
      receivedQuantity: null,
      remainingQuantity: null,
      configurationStatus: null,
    }
  }
  const receivedQuantity = receivedByLine.get(line.id) ?? 0
  const invoicedQuantity = line.inventoryPhysicalQuantity
  const pendingConfiguration = needsConfiguration(line)
  return {
    ...line,
    invoicedQuantity,
    receivedQuantity,
    remainingQuantity: pendingConfiguration ? null : invoicedQuantity - receivedQuantity,
    configurationStatus: pendingConfiguration ? 'pending_configuration' : null,
  }
}

function asMemoryProduct(row: Record<string, unknown>): MemoryProduct | null {
  const id = asString(row.id)
  if (!id) return null
  return {
    id,
    name: asString(row.name) ?? 'Producto',
    baseUnit: asString(row.base_unit),
  }
}

async function loadProductsById(
  userClient: SupabaseClient,
  productIds: string[],
): Promise<Map<string, MemoryProduct>> {
  const unique = [...new Set(productIds.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const { data } = await userClient
    .from('inventory_products')
    .select('id, name, base_unit')
    .in('id', unique)
  return new Map(
    (Array.isArray(data) ? data as unknown[] : [])
      .filter(isRecord)
      .map(asMemoryProduct)
      .filter((product): product is MemoryProduct => Boolean(product))
      .map((product) => [product.id, product]),
  )
}

export async function loadConfirmedMappingMemories(input: {
  userClient: SupabaseClient
  organizationId: string
  issuerTaxId: string | null
}): Promise<ConfirmedMappingMemory[]> {
  if (!input.issuerTaxId) return []
  try {
    let documentsQuery = input.userClient
      .from('purchase_documents')
      .select('id')
      .eq('organization_id', input.organizationId)
      .eq('issuer_tax_id_normalized', input.issuerTaxId)
      .neq('status', 'cancelled')
      .is('deleted_at', null)
    let { data: documents, error: documentError } = await documentsQuery
    if (documentError && isPurchaseDocumentsDeletedAtMissing(documentError)) {
      logInvoiceQueryError('loadConfirmedMappingMemories.deleted_at_missing', documentError)
      ;({ data: documents, error: documentError } = await input.userClient
        .from('purchase_documents')
        .select('id')
        .eq('organization_id', input.organizationId)
        .eq('issuer_tax_id_normalized', input.issuerTaxId)
        .neq('status', 'cancelled'))
    }
    if (documentError) return []

    const documentRows = Array.isArray(documents)
      ? documents as unknown[]
      : isRecord(documents) ? [documents] : []
    const documentIds = documentRows
      .filter(isRecord)
      .map((row) => asString(row.id))
      .filter((id): id is string => Boolean(id))
    if (documentIds.length === 0) return []

    const { data: lineRows, error: lineError } = await input.userClient
      .from('purchase_document_lines')
      .select(
        'mapping_status, original_description, reviewed_description, original_quantity, reviewed_quantity, inventory_physical_quantity, inventory_product_id',
      )
      .eq('mapping_status', 'mapped')
      .in('purchase_document_id', documentIds)
    if (lineError) return []

    const mappedRows = (Array.isArray(lineRows) ? lineRows as unknown[] : []).filter(isRecord)
    const productIds = mappedRows
      .map((row) => asString(row.inventory_product_id))
      .filter((id): id is string => Boolean(id))
    const products = await loadProductsById(input.userClient, productIds)

    return mappedRows
      .map((row) => confirmedMemoryFromMappedLine({
        mappingStatus: asString(row.mapping_status),
        originalDescription: asString(row.original_description),
        reviewedDescription: asString(row.reviewed_description),
        invoiceQuantity: asNumber(row.reviewed_quantity) ?? asNumber(row.original_quantity),
        physicalQuantity: asNumber(row.inventory_physical_quantity),
        inventoryProductId: asString(row.inventory_product_id),
        inventoryProduct: products.get(String(row.inventory_product_id ?? '')) ?? null,
      }))
      .filter((memory): memory is ConfirmedMappingMemory => Boolean(memory))
  } catch {
    return []
  }
}

async function loadVisibleDocument(
  userClient: SupabaseClient,
  id: string,
): Promise<Record<string, unknown>> {
  let { data, error } = await userClient
    .from('purchase_documents')
    .select(DETAIL_COLUMNS)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error && isPurchaseDocumentsDeletedAtMissing(error)) {
    logInvoiceQueryError('loadVisibleDocument.deleted_at_missing', error)
    ;({ data, error } = await userClient
      .from('purchase_documents')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle())
  }
  if (error) lookupFailed('loadVisibleDocument', error)
  if (!isRecord(data) || !data.id) notFound()
  return data
}

async function signFileAccess(
  adminClient: SupabaseClient | null,
  storagePath: string | null,
  now: Date,
): Promise<InvoiceFileAccess | null> {
  if (!storagePath) return null
  if (!adminClient) return null
  const signed = await createInvoiceSignedUrl(adminClient, storagePath, INVOICE_SIGNED_URL_TTL_SECONDS)
  return {
    url: signed.url,
    expiresAt: new Date(now.getTime() + signed.expiresInSeconds * 1000).toISOString(),
    expiresInSeconds: signed.expiresInSeconds,
    contentType: contentTypeFromStoragePath(storagePath),
  }
}

export async function listSavedInvoices(input: ListSavedInvoicesInput): Promise<InvoiceListItem[]> {
  const location = await loadVisibleLocation(input.userClient, input.locationId)

  async function fetchList(filterDeleted: boolean) {
    let query = input.userClient
      .from('purchase_documents')
      .select(LIST_COLUMNS)
      .neq('status', 'cancelled')
    if (filterDeleted) {
      query = query.is('deleted_at', null)
    }
    return query
      .eq('location_id', location.id)
      .order('document_date', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
  }

  let { data, error } = await fetchList(true)
  if (error && isPurchaseDocumentsDeletedAtMissing(error)) {
    // Migración de eliminación lógica aún no aplicada: listar sin filtrar deleted_at.
    logInvoiceQueryError('listSavedInvoices.deleted_at_missing', error)
    ;({ data, error } = await fetchList(false))
  }
  if (error) lookupFailed('listSavedInvoices', error)

  const items = (Array.isArray(data) ? data as unknown[] : []).filter(isRecord).map(mapListItem)
  if (items.length === 0) return items

  const documentIds = items.map((item) => item.id)
  const linesByDocument = await loadListLinesByDocument(input.userClient, documentIds)
  const receivedByLine = await loadReceiptQuantitiesByLine(input.userClient, documentIds)
  return items.map((item) => {
    const workflow = summarizeInvoiceWorkflow(linesByDocument.get(item.id) ?? [], receivedByLine)
    return { ...item, ...workflow }
  })
}

export async function getSavedInvoice(input: {
  userClient: SupabaseClient
  adminClient: SupabaseClient | null
  id: string
  now?: Date
}): Promise<InvoiceDetail> {
  const id = assertInvoiceDocumentId(input.id)
  const row = await loadVisibleDocument(input.userClient, id)
  const { data: lineRows, error: lineError } = await input.userClient
    .from('purchase_document_lines')
    .select(LINE_COLUMNS)
    .eq('purchase_document_id', id)
    .order('source_index', { ascending: true })
  if (lineError) lookupFailed('getSavedInvoice.lines', lineError)

  const storagePath = asString(row.storage_object_path)
  const now = input.now ?? new Date()
  const file = await signFileAccess(input.adminClient, storagePath, now)
  const mappedLines = (Array.isArray(lineRows) ? lineRows as unknown[] : []).filter(isRecord).map(mapLine)
  const receivedByLine = await loadReceiptQuantitiesByLine(input.userClient, [id])
  const lines = mappedLines.map((line) => attachReceptionQuantities(line, receivedByLine))
  const productIds = [...new Set(lines.map((line) => line.inventoryProductId).filter((id): id is string => Boolean(id)))]
  const byId = await loadProductsById(input.userClient, productIds)
  for (const line of lines) {
    if (line.inventoryProductId) {
      line.inventoryProduct = byId.get(line.inventoryProductId) ?? null
    }
  }

  const memories = await loadConfirmedMappingMemories({
    userClient: input.userClient,
    organizationId: String(row.organization_id ?? ''),
    issuerTaxId: asString(row.issuer_tax_id_normalized),
  })
  for (const line of lines) {
    line.mappingSuggestion = suggestFromConfirmedMemory(line, memories)
  }

  return {
    id: String(row.id),
    status: asString(row.status) ?? 'reviewed',
    locationId: String(row.location_id ?? ''),
    organizationId: String(row.organization_id ?? ''),
    supplierName: asString(row.issuer_name),
    issuerTaxId: asString(row.issuer_tax_id_normalized),
    documentDate: asString(row.document_date),
    documentNumber: asString(row.document_number),
    documentType: asString(row.document_type),
    classification: asString(row.classification),
    currency: asString(row.currency) ?? 'ARS',
    eligibleLineCount: asNumber(row.eligible_line_count) ?? 0,
    unmappedLineCount: asNumber(row.unmapped_line_count) ?? 0,
    fiscalDifferenceAccepted: row.fiscal_difference_accepted === true,
    originalAnalysis: stripIntegrity(row.original_analysis),
    reviewedAnalysis: stripIntegrity(row.reviewed_analysis),
    corrections: row.corrections ?? {},
    commercialDecisions: Array.isArray(row.commercial_decisions) ? row.commercial_decisions : [],
    lines,
    file,
  }
}

export async function getSavedInvoiceFile(input: {
  userClient: SupabaseClient
  adminClient: SupabaseClient | null
  id: string
  now?: Date
}): Promise<InvoiceFileAccess> {
  const id = assertInvoiceDocumentId(input.id)
  const row = await loadVisibleDocument(input.userClient, id)
  const storagePath = asString(row.storage_object_path)
  if (!storagePath) notFound()
  if (!input.adminClient) {
    throw new InvoiceQueryError(
      'Falta la clave de servicio para firmar el documento.',
      'SERVICE_ROLE_MISSING',
      503,
    )
  }
  const file = await signFileAccess(input.adminClient, storagePath, input.now ?? new Date())
  if (!file) {
    throw new InvoiceQueryError(
      'No se pudo generar el enlace al documento original.',
      'SIGNED_URL_FAILED',
      503,
    )
  }
  return file
}

export const PENDING_RECEPTION_DEFAULT_LIMIT = 50
export const PENDING_RECEPTION_MAX_LIMIT = 100
const PENDING_RECEPTION_SCAN_BATCH = 100
const PENDING_RECEPTION_MAX_SCAN = 2000

const PENDING_LINE_SELECT = [
  'id',
  'purchase_document_id',
  'classification',
  'inventory_eligibility',
  'mapping_status',
  'quantity_kind',
  'inventory_physical_quantity',
  'inventory_product_id',
  'original_amount',
  'reviewed_amount',
  'purchase_documents!inner(id, location_id, status, issuer_name, document_number, document_date)',
].join(', ')

function parsePendingLimit(value: unknown): number {
  if (value == null || value === '') return PENDING_RECEPTION_DEFAULT_LIMIT
  const raw = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(raw) || raw < 1 || raw > PENDING_RECEPTION_MAX_LIMIT) {
    throw new InvoiceQueryError('El límite de página no es válido.', 'LIMIT_INVALID', 400)
  }
  return raw
}

function parsePendingCursor(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') {
    throw new InvoiceQueryError('El cursor de paginación no es válido.', 'CURSOR_INVALID', 400)
  }
  const trimmed = value.trim()
  if (!DOCUMENT_ID_RE.test(trimmed)) {
    throw new InvoiceQueryError('El cursor de paginación no es válido.', 'CURSOR_INVALID', 400)
  }
  return trimmed
}

function embeddedRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return isRecord(value[0]) ? value[0] : null
  return isRecord(value) ? value : null
}

async function loadReceiptQuantitiesForLineIds(
  userClient: SupabaseClient,
  lineIds: string[],
): Promise<Map<string, number>> {
  if (lineIds.length === 0) return new Map()
  const { data, error } = await userClient
    .from('purchase_document_receipts')
    .select('purchase_document_line_id, quantity')
    .in('purchase_document_line_id', lineIds)
  if (error) {
    lookupFailed(
      'loadReceiptQuantitiesForLineIds',
      error,
      'No se pudieron consultar las recepciones.',
    )
  }
  const totals = new Map<string, number>()
  for (const row of Array.isArray(data) ? data : []) {
    if (!isRecord(row)) continue
    const lineId = asString(row.purchase_document_line_id)
    const quantity = asNumber(row.quantity)
    if (!lineId || quantity == null) continue
    totals.set(lineId, (totals.get(lineId) ?? 0) + quantity)
  }
  return totals
}

async function scanMappedPendingCandidates(
  userClient: SupabaseClient,
  locationId: string,
  afterId: string | null,
): Promise<Record<string, unknown>[]> {
  function buildQuery(filterDeleted: boolean) {
    let query = userClient
      .from('purchase_document_lines')
      .select(PENDING_LINE_SELECT)
      .eq('purchase_documents.location_id', locationId)
      .neq('purchase_documents.status', 'cancelled')
    if (filterDeleted) {
      query = query.is('purchase_documents.deleted_at', null)
    }
    query = query
      .eq('mapping_status', 'mapped')
      .eq('inventory_eligibility', 'eligible')
      .gt('inventory_physical_quantity', 0)
      .not('inventory_product_id', 'is', null)
      .order('id', { ascending: true })
      .limit(PENDING_RECEPTION_SCAN_BATCH)
    if (afterId) query = query.gt('id', afterId)
    return query
  }

  let { data, error } = await buildQuery(true)
  if (error && isPurchaseDocumentsDeletedAtMissing(error)) {
    logInvoiceQueryError('scanMappedPendingCandidates.deleted_at_missing', error)
    ;({ data, error } = await buildQuery(false))
  }
  if (error) lookupFailed('scanMappedPendingCandidates', error)
  return (Array.isArray(data) ? data as unknown[] : []).filter(isRecord)
}

export async function listPendingReceptions(
  input: ListPendingReceptionsInput,
): Promise<PendingReceptionPage> {
  const location = await loadVisibleLocation(input.userClient, input.locationId)
  const limit = parsePendingLimit(input.limit)
  let afterId = parsePendingCursor(input.cursor)
  const items: PendingReceptionLine[] = []
  let scanned = 0
  let nextCursor: string | null = null

  while (items.length < limit && scanned < PENDING_RECEPTION_MAX_SCAN) {
    const rows = await scanMappedPendingCandidates(input.userClient, location.id, afterId)
    if (rows.length === 0) break
    scanned += rows.length
    const lineIds = rows.map((row) => String(row.id ?? '')).filter(Boolean)
    const receivedByLine = await loadReceiptQuantitiesForLineIds(input.userClient, lineIds)
    const productIds = [...new Set(
      rows.map((row) => asString(row.inventory_product_id)).filter((id): id is string => Boolean(id)),
    )]
    const products = await loadProductsById(input.userClient, productIds)

    for (const row of rows) {
      const rowId = asString(row.id)
      if (rowId) afterId = rowId
      const document = embeddedRecord(row.purchase_documents)
      const invoiceId = asString(document?.id)
      if (!document || !invoiceId) continue
      if (asString(document.status) === 'cancelled') continue
      if (asString(document.location_id) !== location.id) continue
      const line = mapLine(row)
      const productId = line.inventoryProductId
      const product = productId ? products.get(productId) : undefined
      if (line.mappingStatus !== 'mapped' || !productId || !product) continue
      if (!isInventoriableQueryLine(line)) continue
      const invoicedQuantity = line.inventoryPhysicalQuantity
      if (invoicedQuantity <= 0) continue
      const receivedQuantity = receivedByLine.get(line.id) ?? 0
      const remainingQuantity = invoicedQuantity - receivedQuantity
      if (remainingQuantity <= 0) continue
      items.push({
        invoiceId,
        lineId: line.id,
        supplierName: asString(document.issuer_name),
        documentNumber: asString(document.document_number),
        documentDate: asString(document.document_date),
        locationId: location.id,
        ingredientId: product.id,
        ingredientName: product.name,
        baseUnit: product.baseUnit,
        invoicedQuantity,
        receivedQuantity,
        remainingQuantity,
      })
      if (items.length === limit) {
        nextCursor = line.id
        break
      }
    }

    if (items.length === limit) break
    if (rows.length < PENDING_RECEPTION_SCAN_BATCH) break
  }

  if (items.length < limit && scanned >= PENDING_RECEPTION_MAX_SCAN && afterId) {
    nextCursor = afterId
  }

  return { items, nextCursor }
}

export const invoiceQuery: InvoiceQueryPort = {
  listSavedInvoices,
  lookupDuplicateInvoice,
  listPendingReceptions,
  getSavedInvoice,
  getSavedInvoiceFile,
}

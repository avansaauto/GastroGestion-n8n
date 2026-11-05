import type { SupabaseClient } from '@supabase/supabase-js'
import { inspectInvoiceBuffer, InvoiceUploadError } from '../modules/invoice-intelligence/localInvoiceTool.js'
import { toInvoiceAnalysisApiResult } from './invoiceAnalysisResponse.js'
import {
  CommercialDecisionError,
  type InvoiceCommercialDecisionPayload,
} from './invoiceCommercialDecisions.js'
import { InvoiceIntegrityError, type InvoiceIntegritySnapshot } from './invoiceIntegrity.js'
import { recalculateReviewedAnalysis, snapshotDocument } from './invoiceReviewedAnalysis.js'
import { commercialRelationSaveBlockReason } from './invoiceCommercialGuard.js'
import { InvoiceSaveError } from './invoiceSaveError.js'
import { assertInvoiceSaveRequest } from './invoiceSaveGuard.js'
import {
  resolveInvoiceSaveIdempotency,
  type ExistingPurchaseDocumentIndex,
} from './invoiceSaveStrategy.js'
import { extensionFromMime, uploadInvoiceObject } from './invoiceStorage.js'
import { parseVoucherIdentity } from './invoiceVoucher.js'
import { normalizePurchaseDocumentType } from './invoiceDocumentType.js'
import {
  confirmIntentDigest,
  createSupabaseConfirmIntentStore,
  documentHasConfirmIntent,
  mapConfirmIntentSourceLines,
  type SaveConfirmIntentLine,
} from './confirmIntent.js'
import { InvoiceQueryError } from './invoiceQueryError.js'

export const DEFAULT_INVOICE_FISCAL_POLICY = {
  ARS: { rounding: '0.05', reviewMax: '2.00' },
} as const

export type InvoiceSaveResult = {
  id: string
  status: 'reviewed'
  locationId: string
  organizationId: string
  fileSha256: string
  storagePath: string
  eligibleLineCount: number
  unmappedLineCount: number
  idempotent: boolean
  confirmIntentStored: boolean
}

export type InvoiceSaveConfirmIntent = {
  confirmIdempotencyKey: string
  lines: SaveConfirmIntentLine[]
}

export type InvoiceSaveRpcLog = {
  operation: 'senda_save_purchase_invoice'
  code: string | null
  message: string | null
  details: string | null
  hint: string | null
}

export type InvoiceSaveDependencies = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  logRpcError?: (entry: InvoiceSaveRpcLog) => void
}

function clipRpcField(value: unknown, max = 500): string | null {
  if (value == null || value === '') return null
  let text = String(value)
  text = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  if (text.length > max) text = `${text.slice(0, max)}…`
  return text
}

export function toInvoiceSaveRpcLog(error: {
  code?: string
  message?: string
  details?: string
  hint?: string
}): InvoiceSaveRpcLog {
  return {
    operation: 'senda_save_purchase_invoice',
    code: clipRpcField(error.code, 64),
    message: clipRpcField(error.message),
    details: clipRpcField(error.details),
    hint: clipRpcField(error.hint),
  }
}

function reportInvoiceSaveRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string },
  log?: (entry: InvoiceSaveRpcLog) => void,
) {
  const entry = toInvoiceSaveRpcLog(error)
  if (log) {
    log(entry)
    return
  }
  console.error(JSON.stringify(entry))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonField(value: unknown, label: string): unknown {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    throw new InvoiceSaveError(`${label} no es JSON válido.`, 'INVALID_JSON', 400)
  }
}

function parseCommercialDecisions(value: unknown): InvoiceCommercialDecisionPayload[] {
  const parsed = value == null || value === '' ? [] : value
  if (!Array.isArray(parsed)) {
    throw new InvoiceSaveError('Las decisiones comerciales no son válidas.', 'INVALID_DECISIONS', 422)
  }
  return parsed as InvoiceCommercialDecisionPayload[]
}

function acceptFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === '1'
}

async function loadLocation(client: SupabaseClient, locationId: string) {
  const { data, error } = await client
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) {
    throw new InvoiceSaveError('No se pudo verificar el local.', 'LOCATION_LOOKUP_FAILED', 500)
  }
  if (!data?.id || !data.organization_id) {
    throw new InvoiceSaveError('El local no existe o no pertenece a tu organización.', 'FORBIDDEN', 403)
  }
  return { id: String(data.id), organizationId: String(data.organization_id) }
}

async function loadFiscalPolicy(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from('organizations')
    .select('invoice_fiscal_tolerances')
    .eq('id', organizationId)
    .maybeSingle()
  if (error || !isRecord(data)) return DEFAULT_INVOICE_FISCAL_POLICY
  const stored = data.invoice_fiscal_tolerances
  return isRecord(stored) ? stored : DEFAULT_INVOICE_FISCAL_POLICY
}

function mapDocumentRow(row: Record<string, unknown>): ExistingPurchaseDocumentIndex {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id ?? ''),
    fileSha256: typeof row.file_sha256 === 'string' ? row.file_sha256 : null,
    issuerTaxIdNormalized:
      typeof row.issuer_tax_id_normalized === 'string' ? row.issuer_tax_id_normalized : null,
    voucherType: typeof row.voucher_type === 'string' ? row.voucher_type : null,
    pointOfSale: typeof row.point_of_sale === 'string' ? row.point_of_sale : null,
    voucherNumber: typeof row.voucher_number === 'string' ? row.voucher_number : null,
    status: typeof row.status === 'string' ? row.status : 'reviewed',
  }
}

async function listOrgDocuments(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from('purchase_documents')
    .select(
      'id, organization_id, file_sha256, issuer_tax_id_normalized, voucher_type, point_of_sale, voucher_number, status',
    )
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
  if (error) {
    throw new InvoiceSaveError('No se pudieron consultar comprobantes existentes.', 'LOOKUP_FAILED', 500)
  }
  return (data ?? []).filter(isRecord).map(mapDocumentRow)
}

async function getDocumentById(
  client: SupabaseClient,
  id: string,
): Promise<InvoiceSaveResult | null> {
  const { data, error } = await client
    .from('purchase_documents')
    .select(
      'id, status, location_id, organization_id, file_sha256, storage_object_path, eligible_line_count, unmapped_line_count',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error || !data) return null
  return {
    id: String(data.id),
    status: 'reviewed',
    locationId: String(data.location_id),
    organizationId: String(data.organization_id),
    fileSha256: String(data.file_sha256 ?? ''),
    storagePath: String(data.storage_object_path ?? ''),
    eligibleLineCount: Number(data.eligible_line_count ?? 0),
    unmappedLineCount: Number(data.unmapped_line_count ?? 0),
    idempotent: true,
    confirmIntentStored: false,
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONFIRM_ACTIONS = new Set(['pending', 'create', 'link_existing', 'reactivate'])
const SAVE_WITH_INTENT_RPC = 'senda_save_purchase_invoice_with_confirm_intent'

function isMissingSaveWrapper(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false
  const blob = `${error.code ?? ''} ${error.message ?? ''}`
  return error.code === 'PGRST202'
    || error.code === '42883'
    || (
      /senda_save_purchase_invoice_with_confirm_intent/i.test(blob)
      && /does not exist|schema cache|could not find/i.test(blob)
    )
}

function assertConfirmIntent(intent: InvoiceSaveConfirmIntent | null | undefined) {
  if (!intent) return
  if (!UUID_PATTERN.test(intent.confirmIdempotencyKey)) {
    throw new InvoiceSaveError('La clave de confirmación no es válida.', 'IDEMPOTENCY_KEY_REQUIRED', 422)
  }
  if (!Array.isArray(intent.lines) || intent.lines.length < 1) {
    throw new InvoiceSaveError('Falta el plan de confirmación.', 'INVALID_PAYLOAD', 422)
  }
  for (const line of intent.lines) {
    if (!line?.sourceLineId || !CONFIRM_ACTIONS.has(line.action)) {
      throw new InvoiceSaveError('El plan de confirmación tiene una línea inválida.', 'INVALID_PAYLOAD', 422)
    }
    if (line.receiveQuantity != null && line.receiveQuantity > 0) {
      if (!line.receiveIdempotencyKey || !UUID_PATTERN.test(line.receiveIdempotencyKey)) {
        throw new InvoiceSaveError('Falta la clave de recepción del intento.', 'IDEMPOTENCY_KEY_REQUIRED', 422)
      }
    }
  }
}

function confirmIntentRpcLines(intent: InvoiceSaveConfirmIntent) {
  return intent.lines.map((line) => ({
    source_line_id: line.sourceLineId,
    action: line.action,
    inventoryProductId: line.inventoryProductId ?? null,
    create: line.create ?? null,
    conversionFactor: line.conversionFactor ?? null,
    receiveQuantity: line.receiveQuantity ?? null,
    receiveIdempotencyKey: line.receiveIdempotencyKey ?? null,
  }))
}

function rpcError(error: { code?: string; message?: string; details?: string } | null) {
  const blob = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
  return {
    unique: error?.code === '23505' || /23505|duplicate key/i.test(blob),
    hash: /file_sha256/i.test(blob),
    voucher: /voucher/i.test(blob),
    noInventory: /SAVE_NOT_ALLOWED_NO_INVENTORY/i.test(blob),
    notMember: /NOT_A_MEMBER/i.test(blob),
  }
}

function originalPayloadLines(
  original: ReturnType<typeof snapshotDocument>,
  reviewed: InvoiceAnalysisResultLike,
) {
  const reviewedById = new Map(reviewed.document.lines.map((line) => [line.id, line]))
  return original.lines.map((line) => {
    const reviewedLine = reviewedById.get(line.id)
    const eligibility = reviewedLine?.inventoryEligibility ?? 'ineligible'
    return {
      source_line_id: line.id,
      source_index: typeof line.sourceIndex === 'number' ? line.sourceIndex : null,
      original_description: line.originalDescription ?? line.name ?? null,
      original_quantity: line.quantity ?? null,
      original_unit: line.unit ?? null,
      original_unit_price: line.unitPrice ?? null,
      original_amount: line.amount ?? null,
      reviewed_description: reviewedLine?.name ?? line.name ?? null,
      reviewed_quantity: reviewedLine?.quantity ?? null,
      reviewed_unit: reviewedLine?.unit ?? null,
      reviewed_unit_price: reviewedLine?.unitPrice ?? null,
      reviewed_amount: reviewedLine?.amount ?? null,
      classification: reviewedLine?.classification ?? line.classification ?? null,
      inventory_eligibility: eligibility,
      quantity_kind: reviewedLine?.quantityKind ?? line.quantityKind ?? null,
      original_payload: {},
    }
  })
}

type InvoiceAnalysisResultLike = ReturnType<typeof recalculateReviewedAnalysis>['result']

export async function savePurchaseInvoice(input: {
  userId: string
  locationId: string
  fileBytes: Buffer
  filename?: string
  mimeType?: string
  integrityToken: string | null | undefined
  originalSnapshot: unknown
  corrections?: unknown
  commercialDecisions?: unknown
  acceptFiscalInconsistency?: unknown
  confirmIntent?: InvoiceSaveConfirmIntent | null
  secret: string
  now?: Date
  deps: InvoiceSaveDependencies
}): Promise<InvoiceSaveResult> {
  if (!input.userId) {
    throw new InvoiceSaveError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  if (!input.locationId) {
    throw new InvoiceSaveError('Indicá el local.', 'LOCATION_REQUIRED', 400)
  }
  if (!input.secret) {
    throw new InvoiceSaveError('Falta la clave de integridad para persistir.', 'SECRET_MISSING', 503)
  }
  assertConfirmIntent(input.confirmIntent)

  async function finish(
    result: Omit<InvoiceSaveResult, 'confirmIntentStored'>,
    known?: boolean,
  ): Promise<InvoiceSaveResult> {
    return {
      ...result,
      confirmIntentStored: known ?? await documentHasConfirmIntent(input.deps.adminClient, result.id),
    }
  }

  let inspected
  try {
    inspected = inspectInvoiceBuffer(input.fileBytes, {
      filename: input.filename,
      declaredMimeType: input.mimeType,
    })
  } catch (error) {
    if (error instanceof InvoiceUploadError) {
      const status = error.code === 'TOO_LARGE'
        ? 413
        : error.code === 'UNSUPPORTED_TYPE' || error.code === 'INVALID_SIGNATURE'
          ? 422
          : 400
      throw new InvoiceSaveError(error.message, error.code, status)
    }
    throw new InvoiceSaveError('No se pudo validar el archivo.', 'INVALID_UPLOAD', 400)
  }

  const location = await loadLocation(input.deps.userClient, input.locationId)
  const snapshot = parseJsonField(input.originalSnapshot, 'originalSnapshot') as InvoiceIntegritySnapshot
  if (!isRecord(snapshot)) {
    throw new InvoiceSaveError('Falta el análisis original firmado.', 'SNAPSHOT_REQUIRED', 400)
  }
  const commercialDecisions = parseCommercialDecisions(
    parseJsonField(input.commercialDecisions, 'commercialDecisions') ?? [],
  )
  const corrections = parseJsonField(input.corrections, 'corrections')

  const extension = extensionFromMime(inspected.mimeType)
  let guarded
  try {
    guarded = assertInvoiceSaveRequest({
      userId: input.userId,
      fileBytes: input.fileBytes,
      snapshot,
      integrityToken: input.integrityToken,
      commercialDecisions,
      organizationId: location.organizationId,
      extension,
      secret: input.secret,
      now: input.now,
    })
  } catch (error) {
    if (error instanceof InvoiceIntegrityError) {
      const status =
        error.code === 'SECRET_MISSING' ? 503
        : error.code === 'USER_MISMATCH' ? 403
        : error.code === 'TOKEN_EXPIRED' || error.code === 'FILE_MISMATCH' || error.code === 'SNAPSHOT_MISMATCH'
          ? 409
          : 400
      throw new InvoiceSaveError(error.message, error.code, status)
    }
    if (error instanceof CommercialDecisionError) {
      throw new InvoiceSaveError(error.message, error.code, 422)
    }
    throw error
  }

  const reviewed = recalculateReviewedAnalysis({
    snapshot,
    corrections,
    commercialDecisions,
  })
  if (reviewed.result.inventorySummary.eligibleLines < 1) {
    throw new InvoiceSaveError(
      'Este documento no tiene productos de inventario para guardar.',
      'SAVE_NOT_ALLOWED_NO_INVENTORY',
      422,
    )
  }

  const fiscalStatus = reviewed.result.validation.dimensions.fiscal.status
  const acceptFiscal = acceptFlag(input.acceptFiscalInconsistency)
  if (fiscalStatus === 'inconsistent' && !acceptFiscal) {
    throw new InvoiceSaveError(
      'La diferencia fiscal requiere confirmación explícita.',
      'FISCAL_INCONSISTENCY_REQUIRES_ACCEPTANCE',
      422,
    )
  }

  const voucher = parseVoucherIdentity({
    taxId: reviewed.result.document.supplier.taxId,
    documentNumber: reviewed.result.document.document.number,
    documentType: reviewed.result.document.document.type,
  })

  async function rejectIntentReplacement(documentId: string, documentLocationId: string) {
    if (documentLocationId !== location.id) {
      throw new InvoiceSaveError(
        'La factura no pertenece a esa sucursal.',
        'OUT_OF_SCOPE',
        422,
      )
    }
    if (!input.confirmIntent) return
    const from = (input.deps.adminClient as SupabaseClient & { from?: unknown }).from
    if (typeof from !== 'function') return
    const existing = await createSupabaseConfirmIntentStore(input.deps.adminClient).load(documentId)
    if (existing === 'missing_table' || !existing) return
    if (existing.organizationId !== location.organizationId || existing.locationId !== location.id) {
      throw new InvoiceSaveError(
        'Ya hay un intento de guardado para esta factura. No se reemplaza.',
        'CONFIRM_INTENT_CONFLICT',
        409,
      )
    }
    const { data: lineRows, error: lineError } = await input.deps.adminClient
      .from('purchase_document_lines')
      .select('id, source_line_id')
      .eq('purchase_document_id', documentId)
    if (lineError) {
      throw new InvoiceSaveError('No se pudieron asociar las líneas del intento.', 'LOOKUP_FAILED', 500)
    }
    const stored = (Array.isArray(lineRows) ? lineRows : [])
      .filter(isRecord)
      .map((row) => ({
        id: String(row.id ?? ''),
        sourceLineId: String(row.source_line_id ?? ''),
      }))
    let mapped
    try {
      mapped = mapConfirmIntentSourceLines(input.confirmIntent.lines, stored)
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        throw new InvoiceSaveError(error.message, error.code, error.status)
      }
      throw error
    }
    if (
      existing.confirmIdempotencyKey !== input.confirmIntent.confirmIdempotencyKey
      || confirmIntentDigest(existing.lines) !== confirmIntentDigest(mapped)
    ) {
      throw new InvoiceSaveError(
        'Ya hay un intento de guardado para esta factura. No se reemplaza.',
        'CONFIRM_INTENT_CONFLICT',
        409,
      )
    }
  }

  const existing = await listOrgDocuments(input.deps.userClient, location.organizationId)
  const idempotency = resolveInvoiceSaveIdempotency(existing, {
    organizationId: location.organizationId,
    fileSha256: guarded.fileSha256,
    issuerTaxIdNormalized: voucher.issuerTaxIdNormalized,
    voucherType: voucher.voucherType,
    pointOfSale: voucher.pointOfSale,
    voucherNumber: voucher.voucherNumber,
  })
  if (idempotency.action === 'return_existing') {
    const current = await getDocumentById(input.deps.userClient, idempotency.id)
    if (current) {
      await rejectIntentReplacement(current.id, current.locationId)
      return finish(current)
    }
    return finish({
      id: idempotency.id,
      status: 'reviewed',
      locationId: location.id,
      organizationId: location.organizationId,
      fileSha256: guarded.fileSha256,
      storagePath: guarded.storagePath,
      eligibleLineCount: reviewed.result.inventorySummary.eligibleLines,
      unmappedLineCount: reviewed.result.inventorySummary.eligibleLines,
      idempotent: true,
    })
  }
  if (idempotency.action === 'reject_duplicate_voucher') {
    throw new InvoiceSaveError(
      'Ya existe un comprobante con esa identidad fiscal.',
      'DUPLICATE_DOCUMENT',
      409,
    )
  }

  const commercialBlock = commercialRelationSaveBlockReason(
    reviewed.result.interpretation.relations,
    reviewed.result.document.lines,
  )
  if (commercialBlock) {
    throw new InvoiceSaveError(commercialBlock, 'COMMERCIAL_RELATION_UNRESOLVED', 422)
  }
  if (!input.confirmIntent) {
    throw new InvoiceSaveError(
      'Falta el plan de confirmación para guardar la factura.',
      'CONFIRM_INTENT_REQUIRED',
      422,
    )
  }

  const documentType = normalizePurchaseDocumentType(reviewed.result.document.document.type)

  const uploaded = await uploadInvoiceObject(input.deps.adminClient, {
    path: guarded.storagePath,
    bytes: input.fileBytes,
    contentType: inspected.mimeType,
  })
  const fiscalPolicy = await loadFiscalPolicy(input.deps.userClient, location.organizationId)
  const reviewedApi = toInvoiceAnalysisApiResult(reviewed.result, { fileSha256: guarded.fileSha256 })
  const payload = {
    actor_user_id: input.userId,
    location_id: location.id,
    supplier_id: null,
    document_type: documentType,
    document_number: reviewed.result.document.document.number,
    document_date: reviewed.result.document.document.issueDate,
    currency: reviewed.result.document.document.currency || 'ARS',
    notes: null,
    classification: reviewed.result.document.classification,
    issuer_name: reviewed.result.document.supplier.name,
    issuer_tax_id_normalized: voucher.issuerTaxIdNormalized,
    voucher_type: voucher.voucherType,
    point_of_sale: voucher.pointOfSale,
    voucher_number: voucher.voucherNumber,
    file_sha256: guarded.fileSha256,
    storage_bucket: uploaded.bucket,
    storage_object_path: uploaded.path,
    original_analysis: snapshot,
    reviewed_analysis: reviewedApi,
    corrections: reviewed.corrections,
    commercial_decisions: commercialDecisions,
    integrity_snapshot_sha256: guarded.claims.snapshotSha256,
    fiscal_policy_applied: fiscalPolicy,
    fiscal_difference_accepted: acceptFiscal,
    lines: originalPayloadLines(reviewed.originalDocument, reviewed.result),
  }

  const savedDocument = {
    status: 'reviewed' as const,
    locationId: location.id,
    organizationId: location.organizationId,
    fileSha256: guarded.fileSha256,
    storagePath: uploaded.path,
    eligibleLineCount: reviewed.result.inventorySummary.eligibleLines,
    unmappedLineCount: reviewed.result.inventorySummary.eligibleLines,
    idempotent: false as const,
  }

  const sourceIds = new Set(
    (payload.lines as Array<{ source_line_id: string }>).map((line) => line.source_line_id),
  )
  if (input.confirmIntent.lines.some((line) => !sourceIds.has(line.sourceLineId))) {
    throw new InvoiceSaveError(
      'El plan de confirmación no coincide con las líneas del comprobante.',
      'LINES_MISMATCH',
      422,
    )
  }

  const wrapped = await input.deps.adminClient.rpc(SAVE_WITH_INTENT_RPC, {
    p: {
      ...payload,
      confirm_intent: {
        confirm_idempotency_key: input.confirmIntent.confirmIdempotencyKey,
        lines: confirmIntentRpcLines(input.confirmIntent),
      },
    },
  })
  if (wrapped.error && isMissingSaveWrapper(wrapped.error)) {
    reportInvoiceSaveRpcError(wrapped.error, input.deps.logRpcError)
    throw new InvoiceSaveError(
      'Falta la función de guardado con intento de confirmación. No se guardó el comprobante.',
      'CONFIRM_INTENT_RPC_MISSING',
      503,
    )
  }
  const data = wrapped.data
  const error = wrapped.error
  if (error) {
    reportInvoiceSaveRpcError(error, input.deps.logRpcError)
  }
  if (!error) {
    return finish({ ...savedDocument, id: String(data) }, true)
  }

  const kind = rpcError(error)
  if (kind.noInventory) {
    throw new InvoiceSaveError(
      'Este documento no tiene productos de inventario para guardar.',
      'SAVE_NOT_ALLOWED_NO_INVENTORY',
      422,
    )
  }
  if (kind.notMember) {
    throw new InvoiceSaveError('No autorizado.', 'FORBIDDEN', 403)
  }
  if (kind.unique && kind.voucher && !kind.hash) {
    throw new InvoiceSaveError(
      'Ya existe un comprobante con esa identidad fiscal.',
      'DUPLICATE_DOCUMENT',
      409,
    )
  }
  if (kind.unique) {
    const after = await listOrgDocuments(input.deps.userClient, location.organizationId)
    const replay = resolveInvoiceSaveIdempotency(after, {
      organizationId: location.organizationId,
      fileSha256: guarded.fileSha256,
      issuerTaxIdNormalized: voucher.issuerTaxIdNormalized,
      voucherType: voucher.voucherType,
      pointOfSale: voucher.pointOfSale,
      voucherNumber: voucher.voucherNumber,
    })
    if (replay.action === 'return_existing') {
      const current = await getDocumentById(input.deps.userClient, replay.id)
      if (current) {
        await rejectIntentReplacement(current.id, current.locationId)
        return finish(current)
      }
    }
    if (replay.action === 'reject_duplicate_voucher') {
      throw new InvoiceSaveError(
        'Ya existe un comprobante con esa identidad fiscal.',
        'DUPLICATE_DOCUMENT',
        409,
      )
    }
  }
  throw new InvoiceSaveError('No se pudo guardar la factura.', 'SAVE_FAILED', 500)
}

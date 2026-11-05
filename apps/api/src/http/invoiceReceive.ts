import type { SupabaseClient } from '@supabase/supabase-js'
import { InvoiceQueryError } from './invoiceQueryError.js'
import {
  commercialDecisionTargetsLine,
  commercialReceptionBlocked,
  HISTORICAL_BILLED_WEIGHT_RECEIVE_G,
  historicalBilledWeightLoss,
  lineCorrectionExplainsDifference,
} from './savedIntakeRecovery.js'
import { assertInvoiceDocumentId } from './invoiceQuery.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

export type ReceiveInvoiceLineInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  documentId: string
  lineId: string
  quantity: unknown
  idempotencyKey: unknown
}

export type InvoiceReceivePort = {
  receiveInvoiceLine(input: ReceiveInvoiceLineInput): Promise<InvoiceReceiveResult>
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
    const parsed = Number(value.trim().replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function assertUuid(value: unknown, code: string, message: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!UUID_RE.test(trimmed)) {
    throw new InvoiceQueryError(message, code, 400)
  }
  return trimmed
}

function parsePositiveQuantity(value: unknown): number {
  const quantity = asNumber(value)
  if (quantity == null || quantity <= 0) {
    throw new InvoiceQueryError(
      'Indicá una cantidad física mayor a cero.',
      'INVALID_QUANTITY',
      422,
    )
  }
  return quantity
}

async function loadVisibleInvoice(
  userClient: SupabaseClient,
  documentId: string,
): Promise<{
  id: string
  locationId: string
  organizationId: string
  originalAnalysis: unknown
  reviewedAnalysis: unknown
  corrections: unknown
  commercialDecisions: unknown
}> {
  const { data, error } = await userClient
    .from('purchase_documents')
    .select('id, location_id, organization_id, original_analysis, reviewed_analysis, corrections, commercial_decisions')
    .eq('id', documentId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) {
    throw new InvoiceQueryError('No se pudieron consultar las facturas.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || !data.id) {
    throw new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)
  }
  return {
    id: String(data.id),
    locationId: asString(data.location_id) ?? '',
    organizationId: asString(data.organization_id) ?? '',
    originalAnalysis: data.original_analysis ?? null,
    reviewedAnalysis: data.reviewed_analysis ?? null,
    corrections: data.corrections ?? {},
    commercialDecisions: data.commercial_decisions ?? [],
  }
}

function commercialReviewRequired(): never {
  throw new InvoiceQueryError(
    'Esta línea tiene una discrepancia comercial sin resolver. No se puede recibir stock hasta resolverla.',
    'COMMERCIAL_REVIEW_REQUIRED',
    422,
  )
}

async function readRows(
  client: SupabaseClient,
  table: string,
  column: string,
  value: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client.from(table).select('*').eq(column, value)
  if (error) {
    throw new InvoiceQueryError('No se pudieron consultar las facturas.', 'LOOKUP_FAILED', 500)
  }
  return Array.isArray(data) ? data.filter(isRecord) : []
}

async function readOne(
  client: SupabaseClient,
  table: string,
  column: string,
  value: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client.from(table).select('*').eq(column, value).maybeSingle()
  if (error) {
    throw new InvoiceQueryError('No se pudieron consultar las facturas.', 'LOOKUP_FAILED', 500)
  }
  return isRecord(data) ? data : null
}

function intentReceiveLine(lines: unknown, documentLineId: string): Record<string, unknown> | null {
  if (!Array.isArray(lines)) return null
  for (const line of lines) {
    if (!isRecord(line)) continue
    const id = asString(line.purchaseDocumentLineId) ?? asString(line.purchase_document_line_id)
    if (id === documentLineId) return line
  }
  return null
}

/**
 * Única salida de requires_review: la revisión perdió 8,88 kg y la línea
 * sigue vinculada, sin recibir, con la clave pendiente del intent original.
 * Una recepción ya hecha con esa misma clave vuelve al RPC, que no duplica.
 */
async function historicalRecoveryAllowed(input: {
  userClient: SupabaseClient
  invoice: {
    locationId: string
    organizationId: string
    originalAnalysis: unknown
    reviewedAnalysis: unknown
    corrections: unknown
    commercialDecisions: unknown
  }
  documentId: string
  documentLineId: string
  sourceLineId: string
  quantity: number
  idempotencyKey: string
  lineRow: Record<string, unknown>
}): Promise<boolean> {
  if (!historicalBilledWeightLoss(
    input.invoice.originalAnalysis,
    input.invoice.reviewedAnalysis,
    input.sourceLineId,
  )) return false
  if (input.quantity !== HISTORICAL_BILLED_WEIGHT_RECEIVE_G) return false
  if (lineCorrectionExplainsDifference(
    input.invoice.corrections,
    input.sourceLineId,
    input.documentLineId,
  )) return false
  if (commercialDecisionTargetsLine(input.invoice.commercialDecisions, input.sourceLineId)) return false

  const physical = asNumber(input.lineRow.inventory_physical_quantity)
  const productId = asString(input.lineRow.inventory_product_id)
  if (
    input.lineRow.mapping_status !== 'mapped'
    || physical !== HISTORICAL_BILLED_WEIGHT_RECEIVE_G
    || !productId
  ) return false

  const product = await readOne(input.userClient, 'inventory_products', 'id', productId)
  if (
    !product
    || product.active !== true
    || asString(product.organization_id) !== input.invoice.organizationId
    || asString(product.base_unit) !== 'g'
  ) return false

  const receipts = await readRows(
    input.userClient,
    'purchase_document_receipts',
    'purchase_document_line_id',
    input.documentLineId,
  )
  const priorReceipt = receipts.length > 0
  if (priorReceipt) {
    const onlyThisKey = receipts.length === 1
      && asNumber(receipts[0]?.quantity) === HISTORICAL_BILLED_WEIGHT_RECEIVE_G
      && asString(receipts[0]?.idempotency_key) === input.idempotencyKey
    if (!onlyThisKey) return false
  }

  const intent = await readOne(
    input.userClient,
    'purchase_document_confirm_intents',
    'purchase_document_id',
    input.documentId,
  )
  if (
    !intent
    || asString(intent.location_id) !== input.invoice.locationId
    || asString(intent.organization_id) !== input.invoice.organizationId
    || !input.invoice.locationId
    || !input.invoice.organizationId
  ) return false
  const intentLine = intentReceiveLine(intent.lines, input.documentLineId)
  if (!intentLine) return false
  const intentKey = asString(intentLine.receiveIdempotencyKey) ?? asString(intentLine.receive_idempotency_key)
  const intentQuantity = asNumber(intentLine.receiveQuantity ?? intentLine.receive_quantity)
  return intentKey === input.idempotencyKey && intentQuantity === HISTORICAL_BILLED_WEIGHT_RECEIVE_G
}

function mapRpcError(error: { code?: string; message?: string; details?: string } | null): never {
  const blob = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
  if (/NOT_A_MEMBER/i.test(blob)) {
    throw new InvoiceQueryError(
      'No tenés autorización para recibir mercadería de esta factura.',
      'FORBIDDEN',
      403,
    )
  }
  if (/DOCUMENT_NOT_FOUND/i.test(blob)) {
    throw new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)
  }
  if (/LINE_NOT_FOUND/i.test(blob)) {
    throw new InvoiceQueryError('La línea no pertenece a esta factura.', 'LINE_NOT_FOUND', 404)
  }
  if (/RECEIVE_REQUIRES_REVIEWED/i.test(blob)) {
    throw new InvoiceQueryError(
      'Solo se puede recibir mercadería de facturas revisadas.',
      'RECEIVE_REQUIRES_REVIEWED',
      422,
    )
  }
  if (/LINE_NOT_INVENTORIABLE/i.test(blob)) {
    throw new InvoiceQueryError(
      'Esta línea no representa mercadería inventariable.',
      'LINE_NOT_INVENTORIABLE',
      422,
    )
  }
  if (/LINE_NOT_MAPPED/i.test(blob)) {
    throw new InvoiceQueryError('La línea no está vinculada a un insumo.', 'LINE_NOT_MAPPED', 422)
  }
  if (/RECEIPT_EXCEEDS_INVOICED/i.test(blob)) {
    throw new InvoiceQueryError(
      'La cantidad supera lo pendiente de esta línea.',
      'RECEIPT_EXCEEDS_INVOICED',
      422,
    )
  }
  if (/IDEMPOTENCY_CONFLICT/i.test(blob)) {
    throw new InvoiceQueryError(
      'Esa confirmación ya se usó con otros datos.',
      'IDEMPOTENCY_CONFLICT',
      409,
    )
  }
  if (/IDEMPOTENCY_KEY_REQUIRED/i.test(blob)) {
    throw new InvoiceQueryError('Falta la clave de idempotencia.', 'IDEMPOTENCY_KEY_REQUIRED', 400)
  }
  if (/INVALID_QUANTITY/i.test(blob)) {
    throw new InvoiceQueryError(
      'Indicá una cantidad física mayor a cero.',
      'INVALID_QUANTITY',
      422,
    )
  }
  if (/PRODUCT_NOT_FOUND/i.test(blob)) {
    throw new InvoiceQueryError('El producto no existe o no está disponible.', 'PRODUCT_NOT_FOUND', 422)
  }
  if (/PRODUCT_INACTIVE/i.test(blob)) {
    throw new InvoiceQueryError(
      'El producto está desactivado. Reactivalo en Inventario antes de recibir stock.',
      'PRODUCT_INACTIVE',
      422,
    )
  }
  if (/PRODUCT_ORG_MISMATCH|LOCATION_ORG_MISMATCH/i.test(blob)) {
    throw new InvoiceQueryError(
      'El producto no pertenece a la organización de la factura.',
      'PRODUCT_OUT_OF_SCOPE',
      422,
    )
  }
  if (/UNVALUED_STOCK/i.test(blob)) {
    throw new InvoiceQueryError(
      'Hay stock sin costo promedio. Cargá el costo inicial de ese insumo en Inventario antes de recibir esta compra. No se modificó el inventario.',
      'UNVALUED_STOCK',
      422,
    )
  }
  if (/VALUATION_AMOUNT_REQUIRED/i.test(blob)) {
    throw new InvoiceQueryError(
      'Esta línea no tiene importe. Revisá el neto antes de recibir mercadería.',
      'VALUATION_AMOUNT_REQUIRED',
      422,
    )
  }
  if (/INVALID_PURCHASE_COST/i.test(blob)) {
    throw new InvoiceQueryError(
      'El importe de la línea no es válido para valuar el stock.',
      'INVALID_PURCHASE_COST',
      422,
    )
  }
  console.error(JSON.stringify({
    operation: 'senda_receive_purchase_document_line',
    code: error?.code ?? 'UNHANDLED',
    message: error?.message ?? null,
    details: error?.details ?? null,
  }))
  throw new InvoiceQueryError('No se pudo registrar la recepción.', 'RECEIVE_FAILED', 500)
}

function mapReceiveResult(
  row: Record<string, unknown>,
  fallback: { documentId: string; lineId: string; quantity: number },
): InvoiceReceiveResult {
  const remaining = asNumber(row.remaining_quantity ?? row.remainingQuantity)
  const received = asNumber(row.received_quantity ?? row.receivedQuantity)
  const invoiced = asNumber(row.invoiced_quantity ?? row.invoicedQuantity)
  const quantity = asNumber(row.quantity) ?? fallback.quantity
  const status = asString(row.document_status ?? row.documentStatus)
  const id = asString(row.id)
  if (id == null || remaining == null || received == null || invoiced == null || !status) {
    throw new InvoiceQueryError('No se pudo registrar la recepción.', 'RECEIVE_FAILED', 500)
  }
  return {
    id,
    purchaseDocumentId: asString(row.purchase_document_id ?? row.purchaseDocumentId) ?? fallback.documentId,
    purchaseDocumentLineId: asString(row.purchase_document_line_id ?? row.purchaseDocumentLineId) ?? fallback.lineId,
    quantity,
    invoicedQuantity: invoiced,
    receivedQuantity: received,
    remainingQuantity: remaining,
    documentStatus: status,
    inventoryMovementId: asString(row.inventory_movement_id ?? row.inventoryMovementId),
    idempotent: row.idempotent === true,
  }
}

export async function receiveInvoiceLine(input: ReceiveInvoiceLineInput): Promise<InvoiceReceiveResult> {
  if (!input.userId) {
    throw new InvoiceQueryError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  const documentId = assertInvoiceDocumentId(input.documentId)
  const lineId = assertUuid(input.lineId, 'LINE_ID_INVALID', 'El identificador de la línea no es válido.')
  const idempotencyKey = assertUuid(
    input.idempotencyKey,
    'IDEMPOTENCY_KEY_REQUIRED',
    'Falta la clave de idempotencia.',
  )
  const quantity = parsePositiveQuantity(input.quantity)

  const invoice = await loadVisibleInvoice(input.userClient, documentId)

  const { data: lineRow, error: lineError } = await input.userClient
    .from('purchase_document_lines')
    .select('id, purchase_document_id, source_line_id, mapping_status, inventory_product_id, inventory_physical_quantity')
    .eq('id', lineId)
    .maybeSingle()
  if (lineError) {
    throw new InvoiceQueryError('No se pudieron consultar las líneas.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(lineRow) || String(lineRow.purchase_document_id) !== documentId) {
    throw new InvoiceQueryError('La línea no pertenece a esta factura.', 'LINE_NOT_FOUND', 404)
  }
  const sourceLineId = typeof lineRow.source_line_id === 'string' ? lineRow.source_line_id : ''
  if (commercialReceptionBlocked(invoice.reviewedAnalysis, invoice.originalAnalysis, sourceLineId)) {
    const allowed = await historicalRecoveryAllowed({
      userClient: input.userClient,
      invoice,
      documentId,
      documentLineId: lineId,
      sourceLineId,
      quantity,
      idempotencyKey,
      lineRow,
    })
    if (!allowed) commercialReviewRequired()
  }

  const { data, error } = await input.adminClient.rpc('senda_receive_purchase_document_line', {
    p_document_id: documentId,
    p_line_id: lineId,
    p_quantity: quantity,
    p_idempotency_key: idempotencyKey,
    p_actor_user_id: input.userId,
  })
  if (error) mapRpcError(error)
  if (!isRecord(data)) {
    throw new InvoiceQueryError('No se pudo registrar la recepción.', 'RECEIVE_FAILED', 500)
  }
  return mapReceiveResult(data, { documentId, lineId, quantity })
}

export const invoiceReceive: InvoiceReceivePort = {
  receiveInvoiceLine,
}

import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseConfirmIntentStore, type ConfirmIntentStore } from './confirmIntent.js'
import { InvoiceQueryError } from './invoiceQueryError.js'
import { normalizeInvoiceConcept } from './invoiceMemory.js'
import { assertInvoiceDocumentId } from './invoiceQuery.js'
import {
  commercialReceptionBlocked,
  recoveredPhysicalEvidence,
} from './savedIntakeRecovery.js'
import {
  computePhysicalQuantity,
  documentLineQuantity,
  documentLineUnit,
  resolveConversionFactor,
} from './invoiceUnits.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTIONS = new Set(['link_existing', 'create', 'reactivate', 'pending'])
const BASE_UNITS = new Set(['g', 'ml', 'unit'])

export type OrgIngredient = {
  id: string
  name: string
  baseUnit: string | null
  active: boolean
  organizationId: string
}

export type CreateReuseDecision =
  | { status: 'create' }
  | { status: 'reuse'; productId: string }
  | { status: 'ambiguous' }
  | { status: 'unit_mismatch' }

/** Un solo insumo activo, misma organización, mismo nombre normalizado y misma unidad base. */
export function decideCreateReuse(
  name: string,
  baseUnit: string,
  products: OrgIngredient[],
  organizationId: string,
): CreateReuseDecision {
  const target = normalizeInvoiceConcept(name)
  if (!target) return { status: 'create' }
  const sameName = products.filter((product) =>
    product.organizationId === organizationId
    && product.active
    && normalizeInvoiceConcept(product.name) === target
  )
  if (sameName.length === 0) return { status: 'create' }
  if (sameName.length > 1) return { status: 'ambiguous' }
  const [product] = sameName
  if (product.baseUnit !== baseUnit) return { status: 'unit_mismatch' }
  return { status: 'reuse', productId: product.id }
}

export type ConfirmIntakeLineInput = {
  purchaseDocumentLineId: string
  action: 'link_existing' | 'create' | 'reactivate' | 'pending'
  inventoryProductId?: string | null
  create?: {
    name: string
    baseUnit: string
    category?: string | null
    minimumStock?: number | null
  } | null
  conversionFactor?: number | null
  receiveQuantity?: number | null
  receiveIdempotencyKey?: string | null
}

export type ConfirmIntakeResult = {
  purchaseDocumentId: string
  documentStatus: string
  idempotent: boolean
  unmappedLineCount: number
  lines: Array<{
    purchaseDocumentLineId: string
    action: string
    inventoryProductId: string | null
    created: boolean
    reactivated: boolean
    mapped: boolean
    inventoryPhysicalQuantity: number | null
    receive: Record<string, unknown> | null
  }>
}

export type InvoiceConfirmIntakePort = {
  confirmPurchaseInvoiceIntake(input: {
    userClient: SupabaseClient
    adminClient: SupabaseClient
    userId: string
    documentId: string
    organizationId: string
    locationId: string
    confirmIdempotencyKey: string
    lines: ConfirmIntakeLineInput[]
    intentStore?: ConfirmIntentStore
  }): Promise<ConfirmIntakeResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
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

async function loadVisibleInvoice(
  userClient: SupabaseClient,
  documentId: string,
): Promise<{
  id: string
  status: string
  locationId: string
  organizationId: string
  originalAnalysis: unknown
  reviewedAnalysis: unknown
}> {
  const id = assertInvoiceDocumentId(documentId)
  const { data, error } = await userClient
    .from('purchase_documents')
    .select('id, status, location_id, organization_id, original_analysis, reviewed_analysis')
    .eq('id', id)
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
    status: asString(data.status) ?? '',
    locationId: String(data.location_id ?? ''),
    organizationId: String(data.organization_id ?? ''),
    originalAnalysis: data.original_analysis ?? null,
    reviewedAnalysis: data.reviewed_analysis ?? null,
  }
}

function mapRpcError(error: { code?: string; message?: string; details?: string } | null): never {
  const blob = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
  const pairs: Array<[RegExp, string, string, number]> = [
    [/NOT_A_MEMBER/i, 'FORBIDDEN', 'No tenés autorización para confirmar esta factura.', 403],
    [/DOCUMENT_NOT_FOUND/i, 'NOT_FOUND', 'No se encontró la factura.', 404],
    [/LINE_NOT_FOUND/i, 'LINE_NOT_FOUND', 'Hay una línea que no pertenece a esta factura.', 404],
    [/LINES_MISMATCH|DUPLICATE_LINE/i, 'LINES_MISMATCH', 'El conjunto de líneas no coincide con la factura revisada.', 422],
    [/CONFIRM_REQUIRES_REVIEWED/i, 'CONFIRM_REQUIRES_REVIEWED', 'Solo se pueden confirmar facturas revisadas.', 422],
    [/CONFIRM_IDEMPOTENCY_CONFLICT|IDEMPOTENCY_CONFLICT/i, 'IDEMPOTENCY_CONFLICT', 'Esa confirmación ya se usó con otros datos.', 409],
    [/PENDING_NOT_ALLOWED/i, 'PENDING_NOT_ALLOWED', 'Esa línea ya está vinculada o recibida; no puede quedar pendiente.', 422],
    [/LINE_ALREADY_MAPPED/i, 'LINE_ALREADY_MAPPED', 'Esa línea ya tiene un insumo vinculado.', 422],
    [/DUPLICATE_PRODUCT/i, 'DUPLICATE_PRODUCT', 'Ya existe un insumo activo con ese nombre.', 409],
    [/INACTIVE_PRODUCT_EXISTS/i, 'INACTIVE_PRODUCT_EXISTS', 'No se pudo crear el insumo nuevo con ese nombre.', 409],
    [/PRODUCT_INACTIVE/i, 'PRODUCT_INACTIVE', 'El insumo está desactivado.', 422],
    [/PRODUCT_REQUIRED|PRODUCT_NOT_FOUND/i, 'PRODUCT_REQUIRED', 'Falta el insumo de inventario.', 422],
    [/INVALID_QUANTITY|RECEIPT_EXCEEDS_INVOICED/i, 'INVALID_QUANTITY', 'La cantidad recibida no es válida.', 422],
    [/INVALID_CONVERSION|EQUIVALENCE_REQUIRED|INCOMPATIBLE_UNITS/i, 'INVALID_CONVERSION', 'La conversión de unidades no es válida.', 422],
    [/INVALID_NAME|INVALID_BASE_UNIT|INVALID_ACTION|INVALID_PAYLOAD/i, 'INVALID_PAYLOAD', 'El payload de confirmación no es válido.', 422],
    [/LOCATION_MISMATCH|ORGANIZATION_MISMATCH|PRODUCT_ORG_MISMATCH|LOCATION_ORG_MISMATCH/i, 'OUT_OF_SCOPE', 'La factura no pertenece a esa organización o sucursal.', 422],
    [/VALUATION_AMOUNT_REQUIRED|INVALID_PURCHASE_COST/i, 'VALUATION_AMOUNT_REQUIRED', 'Falta el importe para calcular el costo de compra.', 422],
    [/LINE_HAS_RECEIPTS/i, 'LINE_HAS_RECEIPTS', 'No se puede cambiar el vínculo de una línea ya recibida.', 422],
  ]
  for (const [re, code, message, status] of pairs) {
    if (re.test(blob)) throw new InvoiceQueryError(message, code, status)
  }
  console.error(JSON.stringify({
    operation: 'senda_confirm_purchase_invoice_intake',
    code: error?.code ?? 'UNHANDLED',
    message: error?.message ?? null,
    details: error?.details ?? null,
  }))
  throw new InvoiceQueryError('No se pudo confirmar la recepción de la factura.', 'CONFIRM_FAILED', 500)
}

function mapResult(data: Record<string, unknown>): ConfirmIntakeResult {
  const linesRaw = Array.isArray(data.lines) ? data.lines : []
  return {
    purchaseDocumentId: String(data.purchase_document_id ?? ''),
    documentStatus: String(data.document_status ?? ''),
    idempotent: Boolean(data.idempotent),
    unmappedLineCount: asNumber(data.unmapped_line_count) ?? 0,
    lines: linesRaw.map((row) => {
      const item = isRecord(row) ? row : {}
      return {
        purchaseDocumentLineId: String(item.purchase_document_line_id ?? ''),
        action: String(item.action ?? ''),
        inventoryProductId: asString(item.inventory_product_id),
        created: Boolean(item.created),
        reactivated: Boolean(item.reactivated),
        mapped: Boolean(item.mapped),
        inventoryPhysicalQuantity: asNumber(item.inventory_physical_quantity),
        receive: isRecord(item.receive) ? item.receive : null,
      }
    }),
  }
}

type StoredLineRow = {
  id: string
  source_line_id: string | null
  inventory_product_id: string | null
  mapping_status: string | null
  inventory_eligibility: string | null
  classification: string | null
  quantity_kind: string | null
  reviewed_quantity: number | null
  original_quantity: number | null
  reviewed_unit: string | null
  original_unit: string | null
  reviewed_amount: number | null
  original_amount: number | null
  base_unit: string | null
}

function inventoriable(row: StoredLineRow) {
  const eligibility = row.inventory_eligibility
  const mapping = row.mapping_status
  const classification = row.classification ?? ''
  const quantityKind = row.quantity_kind ?? ''
  const amount = row.reviewed_amount ?? row.original_amount ?? 0
  return eligibility === 'eligible'
    && mapping !== 'not_applicable'
    && !['fiscal', 'service', 'ignored', 'expense', 'logistics'].includes(classification)
    && !['service_consumption', 'charge', 'none'].includes(quantityKind)
    && amount >= 0
}

export async function confirmPurchaseInvoiceIntake(input: {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  documentId: string
  organizationId: string
  locationId: string
  confirmIdempotencyKey: string
  lines: ConfirmIntakeLineInput[]
  intentStore?: ConfirmIntentStore
}): Promise<ConfirmIntakeResult> {
  if (!input.userId) {
    throw new InvoiceQueryError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  const documentId = assertInvoiceDocumentId(input.documentId)
  const organizationId = assertUuid(input.organizationId, 'INVALID_PAYLOAD', 'Organización inválida.')
  const locationId = assertUuid(input.locationId, 'INVALID_PAYLOAD', 'Sucursal inválida.')
  const confirmKey = assertUuid(
    input.confirmIdempotencyKey,
    'IDEMPOTENCY_KEY_REQUIRED',
    'Falta la clave de idempotencia de confirmación.',
  )
  if (!Array.isArray(input.lines) || input.lines.length < 1) {
    throw new InvoiceQueryError('Indicá las líneas a confirmar.', 'INVALID_PAYLOAD', 422)
  }

  const invoice = await loadVisibleInvoice(input.userClient, documentId)
  if (invoice.organizationId !== organizationId || invoice.locationId !== locationId) {
    throw new InvoiceQueryError(
      'La factura no pertenece a esa organización o sucursal.',
      'OUT_OF_SCOPE',
      422,
    )
  }
  if (invoice.status !== 'reviewed' && invoice.status !== 'received') {
    throw new InvoiceQueryError(
      'Solo se pueden confirmar facturas revisadas.',
      'CONFIRM_REQUIRES_REVIEWED',
      422,
    )
  }

  const prepared = input.intentStore
    ? await input.intentStore.prepare({
      purchaseDocumentId: documentId,
      organizationId,
      locationId,
      actorUserId: input.userId,
      confirmIdempotencyKey: confirmKey,
      lines: input.lines,
    })
    : { lines: input.lines, confirmIdempotencyKey: confirmKey, persist: async () => undefined }
  const lines = prepared.lines as ConfirmIntakeLineInput[]
  const replay = await loadSucceededConfirmAttempt(
    input.adminClient,
    prepared.confirmIdempotencyKey,
    documentId,
  )
  if (replay) return replay

  const { data: lineRows, error: lineError } = await input.userClient
    .from('purchase_document_lines')
    .select(
      'id, source_line_id, inventory_product_id, mapping_status, inventory_eligibility, classification, quantity_kind, reviewed_quantity, original_quantity, reviewed_unit, original_unit, reviewed_amount, original_amount, inventory_product:inventory_products(base_unit)',
    )
    .eq('purchase_document_id', documentId)
  if (lineError) {
    throw new InvoiceQueryError('No se pudieron consultar las líneas.', 'LOOKUP_FAILED', 500)
  }

  const stored: StoredLineRow[] = (Array.isArray(lineRows) ? lineRows : []).map((row) => {
    const record: Record<string, unknown> = isRecord(row) ? row : {}
    const product = isRecord(record.inventory_product) ? record.inventory_product : null
    return {
      id: String(record.id ?? ''),
      source_line_id: asString(record.source_line_id),
      inventory_product_id: asString(record.inventory_product_id),
      mapping_status: asString(record.mapping_status),
      inventory_eligibility: asString(record.inventory_eligibility),
      classification: asString(record.classification),
      quantity_kind: asString(record.quantity_kind),
      reviewed_quantity: asNumber(record.reviewed_quantity),
      original_quantity: asNumber(record.original_quantity),
      reviewed_unit: asString(record.reviewed_unit),
      original_unit: asString(record.original_unit),
      reviewed_amount: asNumber(record.reviewed_amount),
      original_amount: asNumber(record.original_amount),
      base_unit: product ? asString(product.base_unit) : null,
    }
  })

  const expectedIds = new Set(stored.filter(inventoriable).map((row) => row.id))
  const seen = new Set<string>()
  for (const line of lines) {
    const id = assertUuid(line.purchaseDocumentLineId, 'LINE_ID_INVALID', 'Identificador de línea inválido.')
    if (seen.has(id)) {
      throw new InvoiceQueryError('Hay líneas duplicadas en la confirmación.', 'DUPLICATE_LINE', 422)
    }
    seen.add(id)
    if (!expectedIds.has(id)) {
      throw new InvoiceQueryError(
        'Hay una línea ajena o no inventariable en la confirmación.',
        'LINES_MISMATCH',
        422,
      )
    }
  }
  if (seen.size !== expectedIds.size) {
    throw new InvoiceQueryError(
      'Faltan líneas inventariables en la confirmación.',
      'LINES_MISMATCH',
      422,
    )
  }

  const byId = new Map(stored.map((row) => [row.id, row]))
  const needsReuseLookup = lines.some((line) => line.action === 'create')
  const orgProducts = needsReuseLookup
    ? await loadOrgIngredients(input.userClient, organizationId)
    : []
  const rpcLines: Record<string, unknown>[] = []

  for (const line of lines) {
    let action = line.action
    if (!ACTIONS.has(action)) {
      throw new InvoiceQueryError('Acción de línea inválida.', 'INVALID_ACTION', 422)
    }
    const row = byId.get(line.purchaseDocumentLineId)!
    const snapshot = {
      reviewed: { quantity: row.reviewed_quantity, unit: row.reviewed_unit, amount: row.reviewed_amount },
      original: { quantity: row.original_quantity, unit: row.original_unit, amount: row.original_amount },
    }

    if (action === 'pending') {
      rpcLines.push({
        purchase_document_line_id: line.purchaseDocumentLineId,
        action: 'pending',
      })
      continue
    }

    let baseUnit = row.base_unit
    let productId = asString(line.inventoryProductId)

    if (action === 'create') {
      const name = asString(line.create?.name)
      const unit = asString(line.create?.baseUnit)?.toLowerCase() ?? ''
      if (!name || name.length < 2) {
        throw new InvoiceQueryError(
          `Línea ${line.purchaseDocumentLineId}: indicá un nombre de insumo.`,
          'INVALID_NAME',
          422,
        )
      }
      if (!BASE_UNITS.has(unit)) {
        throw new InvoiceQueryError(
          `Línea ${line.purchaseDocumentLineId}: unidad base inválida.`,
          'INVALID_BASE_UNIT',
          422,
        )
      }
      const reuse = decideCreateReuse(name, unit, orgProducts, organizationId)
      if (reuse.status === 'ambiguous') {
        throw new InvoiceQueryError(
          `Línea ${line.purchaseDocumentLineId}: hay más de un insumo activo con ese nombre.`,
          'PRODUCT_AMBIGUOUS',
          422,
        )
      }
      if (reuse.status === 'unit_mismatch') {
        throw new InvoiceQueryError(
          `Línea ${line.purchaseDocumentLineId}: ya existe un insumo con ese nombre y otra unidad base.`,
          'PRODUCT_UNIT_MISMATCH',
          422,
        )
      }
      if (reuse.status === 'reuse') {
        baseUnit = unit
        productId = reuse.productId
        action = 'link_existing'
      } else {
        baseUnit = unit
        productId = null
      }
    } else if (action === 'reactivate' || action === 'link_existing') {
      if (!productId) {
        throw new InvoiceQueryError(
          `Línea ${line.purchaseDocumentLineId}: falta el insumo.`,
          'PRODUCT_REQUIRED',
          422,
        )
      }
      if (!baseUnit) {
        const { data: productRow, error: productError } = await input.userClient
          .from('inventory_products')
          .select('id, base_unit, active, organization_id')
          .eq('id', productId)
          .maybeSingle()
        if (productError || !isRecord(productRow)) {
          throw new InvoiceQueryError('No se pudo consultar el insumo.', 'PRODUCT_NOT_FOUND', 422)
        }
        if (String(productRow.organization_id) !== organizationId) {
          throw new InvoiceQueryError('El insumo no pertenece a la organización.', 'OUT_OF_SCOPE', 422)
        }
        if (action === 'link_existing' && productRow.active !== true) {
          throw new InvoiceQueryError('El insumo está desactivado.', 'PRODUCT_INACTIVE', 422)
        }
        baseUnit = asString(productRow.base_unit)
      }
    }

    const invoiceQty = documentLineQuantity(snapshot)
    if (invoiceQty == null) {
      throw new InvoiceQueryError(
        `Línea ${line.purchaseDocumentLineId}: cantidad inválida.`,
        'INVALID_QUANTITY',
        422,
      )
    }
    const factor = resolveConversionFactor({
      invoiceUnit: documentLineUnit(snapshot),
      inventoryUnit: baseUnit,
      conversionFactor: line.conversionFactor ?? null,
    })
    const physical = computePhysicalQuantity(invoiceQty, factor)

    const sourceLineId = row.source_line_id ?? ''
    const evidence = recoveredPhysicalEvidence(
      invoice.originalAnalysis,
      sourceLineId,
      invoiceQty,
    )
    if (evidence) {
      if (baseUnit !== evidence.baseUnit) {
        throw new InvoiceQueryError(
          `Línea ${line.purchaseDocumentLineId}: la unidad base no coincide con el análisis original.`,
          'INCOMPATIBLE_UNITS',
          422,
        )
      }
      if (Math.abs(physical - evidence.physicalQuantity) > 0.001) {
        throw new InvoiceQueryError(
          `Línea ${line.purchaseDocumentLineId}: la cantidad física no coincide con el análisis original.`,
          'INVALID_CONVERSION',
          422,
        )
      }
    }
    const receptionBlocked = commercialReceptionBlocked(
      invoice.reviewedAnalysis,
      invoice.originalAnalysis,
      sourceLineId,
    )
    const receiveQuantity = receptionBlocked || line.receiveQuantity == null
      ? null
      : asNumber(line.receiveQuantity)
    if (receiveQuantity != null && receiveQuantity < 0) {
      throw new InvoiceQueryError('Cantidad recibida inválida.', 'INVALID_QUANTITY', 422)
    }
    if (receiveQuantity != null && receiveQuantity > physical) {
      throw new InvoiceQueryError(
        'La cantidad recibida supera lo facturado en unidad base.',
        'RECEIPT_EXCEEDS_INVOICED',
        422,
      )
    }

    const payload: Record<string, unknown> = {
      purchase_document_line_id: line.purchaseDocumentLineId,
      action,
      inventory_physical_quantity: physical,
      // Factor efectivo ya validado (SI o empaque). El RPC lo revalida.
      conversion_factor: factor,
    }
    if (productId) payload.inventory_product_id = productId
    if (action === 'create' && line.create) {
      payload.create = {
        name: line.create.name.trim(),
        base_unit: line.create.baseUnit,
        category: line.create.category ?? null,
        minimum_stock: line.create.minimumStock ?? null,
      }
    }
    if (receiveQuantity != null && receiveQuantity > 0) {
      payload.receive_quantity = receiveQuantity
      payload.receive_idempotency_key = assertUuid(
        line.receiveIdempotencyKey,
        'IDEMPOTENCY_KEY_REQUIRED',
        `Línea ${line.purchaseDocumentLineId}: falta clave de recepción.`,
      )
    }
    rpcLines.push(payload)
  }

  await prepared.persist()

  const { data, error } = await input.adminClient.rpc('senda_confirm_purchase_invoice_intake', {
    p: {
      actor_user_id: input.userId,
      organization_id: organizationId,
      location_id: locationId,
      purchase_document_id: documentId,
      confirm_idempotency_key: prepared.confirmIdempotencyKey,
      lines: rpcLines,
    },
  })
  if (error) mapRpcError(error)
  if (!isRecord(data)) {
    throw new InvoiceQueryError('Respuesta de confirmación incompleta.', 'CONFIRM_FAILED', 500)
  }
  return mapResult(data)
}

async function loadSucceededConfirmAttempt(
  adminClient: SupabaseClient,
  confirmKey: string,
  documentId: string,
): Promise<ConfirmIntakeResult | null> {
  const from = (adminClient as SupabaseClient & { from?: unknown }).from
  if (typeof from !== 'function') return null
  try {
    const { data, error } = await adminClient
      .from('purchase_document_confirm_attempts')
      .select('purchase_document_id, status, result')
      .eq('confirm_idempotency_key', confirmKey)
      .maybeSingle()
    if (error || !isRecord(data)) return null
    if (String(data.purchase_document_id ?? '') !== documentId) {
      throw new InvoiceQueryError(
        'La clave de confirmación pertenece a otra factura.',
        'CONFIRM_IDEMPOTENCY_CONFLICT',
        409,
      )
    }
    if (data.status !== 'succeeded' || !isRecord(data.result)) return null
    return mapResult({ ...data.result, idempotent: true })
  } catch (error) {
    if (error instanceof InvoiceQueryError) throw error
    return null
  }
}

async function loadOrgIngredients(
  userClient: SupabaseClient,
  organizationId: string,
): Promise<OrgIngredient[]> {
  const { data, error } = await userClient
    .from('inventory_products')
    .select('id, name, base_unit, active, organization_id')
    .eq('organization_id', organizationId)
  if (error) {
    throw new InvoiceQueryError('No se pudieron consultar los insumos.', 'LOOKUP_FAILED', 500)
  }
  return (Array.isArray(data) ? data : [])
    .filter(isRecord)
    .map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      baseUnit: asString(row.base_unit),
      active: row.active === true,
      organizationId: String(row.organization_id ?? ''),
    }))
    .filter((product) => product.id && product.organizationId === organizationId)
}

export async function completeSavedInvoice(input: {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  documentId: string
  organizationId: string
  locationId: string
}): Promise<ConfirmIntakeResult> {
  const intentStore = createSupabaseConfirmIntentStore(input.adminClient)
  const loaded = await intentStore.load(input.documentId)
  if (loaded === 'missing_table' || !loaded) {
    throw new InvoiceQueryError(
      'No quedó un intento persistido para completar el guardado. No se confirma uno nuevo.',
      'INTENT_NOT_PERSISTED',
      409,
    )
  }
  if (loaded.organizationId !== input.organizationId || loaded.locationId !== input.locationId) {
    throw new InvoiceQueryError(
      'La factura no pertenece a esa organización o sucursal.',
      'OUT_OF_SCOPE',
      422,
    )
  }
  return confirmPurchaseInvoiceIntake({
    userClient: input.userClient,
    adminClient: input.adminClient,
    userId: input.userId,
    documentId: input.documentId,
    organizationId: input.organizationId,
    locationId: input.locationId,
    confirmIdempotencyKey: loaded.confirmIdempotencyKey,
    lines: loaded.lines as ConfirmIntakeLineInput[],
    intentStore,
  })
}

export const invoiceConfirmIntake: InvoiceConfirmIntakePort = {
  confirmPurchaseInvoiceIntake,
}

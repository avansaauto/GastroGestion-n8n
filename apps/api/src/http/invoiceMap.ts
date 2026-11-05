import type { SupabaseClient } from '@supabase/supabase-js'
import { InvoiceQueryError } from './invoiceQueryError.js'
import { assertInvoiceDocumentId, loadConfirmedMappingMemories } from './invoiceQuery.js'
import type { ConfirmedMappingMemory } from './invoiceMemory.js'
import { parseVoucherIdentity } from './invoiceVoucher.js'
import {
  computePhysicalQuantity,
  documentLineAmount,
  documentLineQuantity,
  documentLineUnit,
  resolveConversionFactor,
} from './invoiceUnits.js'

const LINE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const EXCLUDED_CLASSIFICATIONS = new Set(['fiscal', 'service', 'ignored', 'expense', 'logistics'])
const EXCLUDED_QUANTITY_KINDS = new Set(['service_consumption', 'charge', 'none'])

export type InventoryProductOption = {
  id: string
  name: string
  baseUnit: string | null
  organizationId: string
  active: boolean
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

export type InvoiceMapPort = {
  listInvoiceProducts(input: {
    userClient: SupabaseClient
    documentId: string
    search?: string
  }): Promise<InventoryProductOption[]>
  listCatalogProducts(input: {
    userClient: SupabaseClient
    locationId: string
    search?: string
  }): Promise<InventoryProductOption[]>
  listCatalogMappingMemories(input: {
    userClient: SupabaseClient
    locationId: string
    issuerTaxId?: string | null
  }): Promise<ConfirmedMappingMemory[]>
  mapInvoiceLine(input: {
    userClient: SupabaseClient
    adminClient: SupabaseClient
    userId: string
    documentId: string
    lineId: string
    inventoryProductId: string
    conversionFactor?: number | null
  }): Promise<InvoiceMapResult>
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

function assertUuid(value: string, code: string, message: string): string {
  const trimmed = value.trim()
  if (!LINE_ID_RE.test(trimmed)) {
    throw new InvoiceQueryError(message, code, 400)
  }
  return trimmed
}

function mapProduct(row: Record<string, unknown>): InventoryProductOption {
  return {
    id: String(row.id),
    name: asString(row.name) ?? 'Producto',
    baseUnit: asString(row.base_unit),
    organizationId: String(row.organization_id ?? ''),
    active: row.active !== false,
  }
}

function lineSnapshot(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    sourceLineId: String(row.source_line_id ?? ''),
    purchaseDocumentId: String(row.purchase_document_id ?? ''),
    classification: asString(row.classification),
    inventoryEligibility: asString(row.inventory_eligibility),
    mappingStatus: asString(row.mapping_status),
    quantityKind: asString(row.quantity_kind),
    original: {
      quantity: asNumber(row.original_quantity),
      unit: asString(row.original_unit),
      amount: asNumber(row.original_amount),
    },
    reviewed: {
      quantity: asNumber(row.reviewed_quantity),
      unit: asString(row.reviewed_unit),
      amount: asNumber(row.reviewed_amount),
    },
  }
}

export function isInventoriableStoredLine(line: ReturnType<typeof lineSnapshot>): boolean {
  if (line.inventoryEligibility !== 'eligible') return false
  if (line.mappingStatus === 'not_applicable') return false
  if (line.classification && EXCLUDED_CLASSIFICATIONS.has(line.classification)) return false
  if (line.quantityKind && EXCLUDED_QUANTITY_KINDS.has(line.quantityKind)) return false
  if (documentLineAmount(line) < 0) return false
  return true
}

async function loadVisibleLocation(
  userClient: SupabaseClient,
  locationId: string,
): Promise<{ id: string; organizationId: string }> {
  const id = assertUuid(locationId, 'LOCATION_ID_INVALID', 'El identificador del local no es válido.')
  const { data, error } = await userClient
    .from('locations')
    .select('id, organization_id')
    .eq('id', id)
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

async function loadVisibleInvoice(
  userClient: SupabaseClient,
  documentId: string,
): Promise<{ id: string; status: string; locationId: string; organizationId: string }> {
  const id = assertInvoiceDocumentId(documentId)
  const { data, error } = await userClient
    .from('purchase_documents')
    .select('id, status, location_id, organization_id')
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
  }
}

function mapRpcError(error: { code?: string; message?: string; details?: string } | null): never {
  const blob = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
  if (/NOT_A_MEMBER/i.test(blob)) {
    throw new InvoiceQueryError('No tenés autorización para vincular esta factura.', 'FORBIDDEN', 403)
  }
  if (/LINE_NOT_FOUND/i.test(blob)) {
    throw new InvoiceQueryError('La línea no pertenece a esta factura.', 'LINE_NOT_FOUND', 404)
  }
  if (/MAP_REQUIRES_REVIEWED/i.test(blob)) {
    throw new InvoiceQueryError('Solo se pueden vincular facturas revisadas.', 'MAP_REQUIRES_REVIEWED', 422)
  }
  if (/MAP_REQUIRES_ELIGIBLE/i.test(blob)) {
    throw new InvoiceQueryError(
      'Esta línea no representa mercadería inventariable.',
      'LINE_NOT_INVENTORIABLE',
      422,
    )
  }
  if (/PRODUCT_NOT_FOUND/i.test(blob)) {
    throw new InvoiceQueryError('El producto no existe o no está disponible.', 'PRODUCT_NOT_FOUND', 422)
  }
  if (/PRODUCT_ORG_MISMATCH/i.test(blob)) {
    throw new InvoiceQueryError(
      'El producto no pertenece a la organización de la factura.',
      'PRODUCT_OUT_OF_SCOPE',
      422,
    )
  }
  if (/LINE_HAS_RECEIPTS/i.test(blob)) {
    throw new InvoiceQueryError(
      'No se puede cambiar el insumo de una línea ya recibida.',
      'LINE_HAS_RECEIPTS',
      422,
    )
  }
  console.error(JSON.stringify({
    operation: 'senda_map_purchase_document_line',
    code: error?.code ?? 'UNHANDLED',
    message: error?.message ?? null,
    details: error?.details ?? null,
  }))
  throw new InvoiceQueryError('No se pudo vincular el producto.', 'MAP_FAILED', 500)
}

export async function listInvoiceProducts(input: {
  userClient: SupabaseClient
  documentId: string
  search?: string
}): Promise<InventoryProductOption[]> {
  const invoice = await loadVisibleInvoice(input.userClient, input.documentId)
  return listOrganizationProducts(input.userClient, invoice.organizationId, input.search)
}

async function listOrganizationProducts(
  userClient: SupabaseClient,
  organizationId: string,
  search?: string,
): Promise<InventoryProductOption[]> {
  let query = userClient
    .from('inventory_products')
    .select('id, organization_id, name, base_unit, active')
    .eq('organization_id', organizationId)
    .order('name', { ascending: true })

  const term = search?.trim()
  if (term) query = query.ilike('name', `%${term}%`)

  const { data, error } = await query
  if (error) {
    throw new InvoiceQueryError('No se pudieron consultar los productos.', 'LOOKUP_FAILED', 500)
  }
  return (Array.isArray(data) ? data as unknown[] : [])
    .filter(isRecord)
    .map(mapProduct)
    .filter((product) => product.organizationId === organizationId && product.active)
}

export async function listCatalogProducts(input: {
  userClient: SupabaseClient
  locationId: string
  search?: string
}): Promise<InventoryProductOption[]> {
  const location = await loadVisibleLocation(input.userClient, input.locationId)
  return listOrganizationProducts(input.userClient, location.organizationId, input.search)
}

export async function listCatalogMappingMemories(input: {
  userClient: SupabaseClient
  locationId: string
  issuerTaxId?: string | null
}): Promise<ConfirmedMappingMemory[]> {
  const location = await loadVisibleLocation(input.userClient, input.locationId)
  const issuerTaxId = parseVoucherIdentity({ taxId: input.issuerTaxId }).issuerTaxIdNormalized
  return loadConfirmedMappingMemories({
    userClient: input.userClient,
    organizationId: location.organizationId,
    issuerTaxId,
  })
}

export async function mapInvoiceLine(input: {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  documentId: string
  lineId: string
  inventoryProductId: string
  conversionFactor?: number | null
}): Promise<InvoiceMapResult> {
  if (!input.userId) {
    throw new InvoiceQueryError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  const documentId = assertInvoiceDocumentId(input.documentId)
  const lineId = assertUuid(input.lineId, 'LINE_ID_INVALID', 'El identificador de la línea no es válido.')
  const productId = assertUuid(
    input.inventoryProductId,
    'PRODUCT_ID_INVALID',
    'El identificador del producto no es válido.',
  )

  const invoice = await loadVisibleInvoice(input.userClient, documentId)
  if (invoice.status !== 'reviewed') {
    throw new InvoiceQueryError('Solo se pueden vincular facturas revisadas.', 'MAP_REQUIRES_REVIEWED', 422)
  }

  const { data: lineRow, error: lineError } = await input.userClient
    .from('purchase_document_lines')
    .select(
      'id, purchase_document_id, source_line_id, original_quantity, original_unit, original_amount, reviewed_quantity, reviewed_unit, reviewed_amount, classification, inventory_eligibility, mapping_status, quantity_kind',
    )
    .eq('id', lineId)
    .maybeSingle()
  if (lineError) {
    throw new InvoiceQueryError('No se pudieron consultar las líneas.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(lineRow) || String(lineRow.purchase_document_id) !== documentId) {
    throw new InvoiceQueryError('La línea no pertenece a esta factura.', 'LINE_NOT_FOUND', 404)
  }

  const line = lineSnapshot(lineRow)
  if (!isInventoriableStoredLine(line)) {
    throw new InvoiceQueryError(
      'Esta línea no representa mercadería inventariable.',
      'LINE_NOT_INVENTORIABLE',
      422,
    )
  }

  const { data: productRow, error: productError } = await input.userClient
    .from('inventory_products')
    .select('id, organization_id, name, base_unit, active')
    .eq('id', productId)
    .maybeSingle()
  if (productError) {
    throw new InvoiceQueryError('No se pudieron consultar los productos.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(productRow) || !productRow.id) {
    throw new InvoiceQueryError('El producto no existe o no está disponible.', 'PRODUCT_NOT_FOUND', 422)
  }
  const product = mapProduct(productRow)
  if (product.organizationId !== invoice.organizationId) {
    throw new InvoiceQueryError(
      'El producto no pertenece a la organización de la factura.',
      'PRODUCT_OUT_OF_SCOPE',
      422,
    )
  }
  if (!product.active) {
    throw new InvoiceQueryError('El producto no está activo.', 'PRODUCT_INACTIVE', 422)
  }

  const invoiceQuantity = documentLineQuantity(line)
  if (invoiceQuantity == null) {
    throw new InvoiceQueryError(
      'La cantidad de la línea no permite una equivalencia física.',
      'INVALID_QUANTITY',
      422,
    )
  }
  const factor = resolveConversionFactor({
    invoiceUnit: documentLineUnit(line),
    inventoryUnit: product.baseUnit,
    conversionFactor: input.conversionFactor ?? null,
  })
  const physicalQuantity = computePhysicalQuantity(invoiceQuantity, factor)

  const { error } = await input.adminClient.rpc('senda_map_purchase_document_line', {
    p_line_id: lineId,
    p_inventory_product_id: productId,
    p_inventory_physical_quantity: physicalQuantity,
    p_actor_user_id: input.userId,
  })
  if (error) mapRpcError(error)

  const { data: unmappedRows, error: unmappedError } = await input.userClient
    .from('purchase_document_lines')
    .select('id')
    .eq('purchase_document_id', documentId)
    .eq('mapping_status', 'unmapped')
  if (unmappedError) {
    throw new InvoiceQueryError('No se pudieron consultar las líneas.', 'LOOKUP_FAILED', 500)
  }

  return {
    id: line.id,
    sourceLineId: line.sourceLineId,
    mappingStatus: 'mapped',
    inventoryProductId: product.id,
    inventoryPhysicalQuantity: physicalQuantity,
    inventoryProduct: product,
    unmappedLineCount: Array.isArray(unmappedRows) ? unmappedRows.length : 0,
  }
}

export const invoiceMap: InvoiceMapPort = {
  listInvoiceProducts,
  listCatalogProducts,
  listCatalogMappingMemories,
  mapInvoiceLine,
}

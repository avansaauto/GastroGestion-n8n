import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAcquisitionCost } from './acquisitionCost.js'
import { InventoryError } from './inventoryError.js'

export const INVENTORY_PURCHASE_COST_WRITE_ENABLED = true
export const INVENTORY_PURCHASE_COST_MAX = 9999999999.99

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type InventoryPurchaseCostResult = {
  inventoryProductId: string
  locationId: string
  purchaseQuantity: number
  purchaseCost: number
  averageUnitCost: number
  lastPurchaseUnitCost: number
  onHand: number
  replay: boolean
}

export type InventoryPurchaseCostInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  locationId: string
  inventoryProductId: string
  body: unknown
  logRpcError?: (entry: InventoryPurchaseCostRpcLog) => void
  rpcEnabled?: boolean
}

export type InventoryPurchaseCostRpcLog = {
  operation: 'senda_set_inventory_purchase_cost'
  code: string | null
  message: string | null
  details: string | null
  hint: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clipRpcField(value: unknown, max = 500): string | null {
  if (value == null || value === '') return null
  let text = String(value)
  text = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  if (text.length > max) text = `${text.slice(0, max)}…`
  return text
}

export function toInventoryPurchaseCostRpcLog(error: {
  code?: string
  message?: string
  details?: string
  hint?: string
}): InventoryPurchaseCostRpcLog {
  return {
    operation: 'senda_set_inventory_purchase_cost',
    code: clipRpcField(error.code, 64),
    message: clipRpcField(error.message),
    details: clipRpcField(error.details),
    hint: clipRpcField(error.hint),
  }
}

function reportRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string },
  log?: (entry: InventoryPurchaseCostRpcLog) => void,
) {
  const entry = toInventoryPurchaseCostRpcLog(error)
  if (log) {
    log(entry)
    return
  }
  console.error(JSON.stringify(entry))
}

function rpcBlob(error: { code?: string; message?: string; details?: string } | null): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
}

export function isSetInventoryPurchaseCostRpcMissing(
  error: { code?: string; message?: string; details?: string } | null,
): boolean {
  const blob = rpcBlob(error)
  if (/\bPGRST202\b/i.test(blob)) return true
  if (/\b42883\b/.test(blob) && /senda_set_inventory_purchase_cost/i.test(blob)) return true
  return /could not find the function/i.test(blob) && /senda_set_inventory_purchase_cost/i.test(blob)
}

function rpcToken(error: { code?: string; message?: string; details?: string } | null): string {
  const match = rpcBlob(error).match(
    /\b(BACKEND_ROLE_REQUIRED|ACTOR_REQUIRED|NOT_A_MEMBER|ORGANIZATION_REQUIRED|ORGANIZATION_NOT_FOUND|LOCATION_REQUIRED|LOCATION_NOT_IN_ORG|PRODUCT_REQUIRED|PRODUCT_NOT_IN_ORG|INVALID_PURCHASE_QUANTITY|INVALID_PURCHASE_COST|INVALID_PAYLOAD|MANUAL_COST_WITH_ON_HAND)\b/,
  )
  return match?.[1] ?? ''
}

function mapRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
  log?: (entry: InventoryPurchaseCostRpcLog) => void,
): never {
  if (isSetInventoryPurchaseCostRpcMissing(error)) {
    throw new InventoryError(
      'Todavía no se puede guardar el costo de compra del inventario.',
      'INVENTORY_COST_RPC_PENDING',
      503,
    )
  }
  const token = rpcToken(error)
  switch (token) {
    case 'NOT_A_MEMBER':
      throw new InventoryError(
        'No tenés autorización para registrar costos en este local.',
        'NOT_A_MEMBER',
        403,
      )
    case 'ORGANIZATION_REQUIRED':
    case 'ORGANIZATION_NOT_FOUND':
      throw new InventoryError('Organización no disponible.', 'NOT_FOUND', 404)
    case 'LOCATION_REQUIRED':
    case 'LOCATION_NOT_IN_ORG':
      throw new InventoryError('Local no disponible.', 'NOT_FOUND', 404)
    case 'PRODUCT_REQUIRED':
    case 'PRODUCT_NOT_IN_ORG':
      throw new InventoryError('Insumo no disponible.', 'NOT_FOUND', 404)
    case 'INVALID_PURCHASE_QUANTITY':
      throw new InventoryError('Indicá el contenido de la compra.', 'INVALID_PURCHASE_QUANTITY', 400)
    case 'INVALID_PURCHASE_COST':
      throw new InventoryError('Indicá un costo de compra válido.', 'INVALID_PURCHASE_COST', 400)
    case 'INVALID_PAYLOAD':
      throw new InventoryError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
    case 'MANUAL_COST_WITH_ON_HAND':
      throw new InventoryError(
        'No se puede cargar un costo manual mientras hay stock con promedio. El promedio no se modificó.',
        'MANUAL_COST_WITH_ON_HAND',
        409,
      )
    default:
      reportRpcError(error ?? {}, log)
      throw new InventoryError('No se pudo guardar el costo de compra.', 'COST_SAVE_FAILED', 500)
  }
}

async function loadAuthorizedOrganization(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .maybeSingle()
  if (error) {
    throw new InventoryError('No se pudo consultar la organización.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || asString(data.id) !== organizationId) {
    throw new InventoryError('Organización no disponible.', 'NOT_FOUND', 404)
  }
}

async function loadAuthorizedLocation(
  client: SupabaseClient,
  locationId: string,
  organizationId: string,
) {
  const { data, error } = await client
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) {
    throw new InventoryError('No se pudo consultar el local.', 'LOOKUP_FAILED', 500)
  }
  if (
    !isRecord(data)
    || asString(data.id) !== locationId
    || asString(data.organization_id) !== organizationId
  ) {
    throw new InventoryError('Local no disponible.', 'NOT_FOUND', 404)
  }
}

async function loadAuthorizedProduct(
  client: SupabaseClient,
  inventoryProductId: string,
  organizationId: string,
) {
  const { data, error } = await client
    .from('inventory_products')
    .select('id, organization_id')
    .eq('id', inventoryProductId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) {
    throw new InventoryError('No se pudo consultar el insumo.', 'LOOKUP_FAILED', 500)
  }
  if (
    !isRecord(data)
    || asString(data.id) !== inventoryProductId
    || asString(data.organization_id) !== organizationId
  ) {
    throw new InventoryError('Insumo no disponible.', 'NOT_FOUND', 404)
  }
}

export function parseInventoryPurchaseCostBody(body: unknown): {
  purchaseQuantity: number
  purchaseCost: number
  unitCost: number
} {
  if (!isRecord(body)) {
    throw new InventoryError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }
  const purchaseQuantity = asFiniteNumber(body.purchaseQuantity ?? body.purchase_quantity)
  const purchaseCost = asFiniteNumber(body.purchaseCost ?? body.purchase_cost)
  const resolved = resolveAcquisitionCost({
    netAcquisitionAmount: purchaseCost,
    inventoryPhysicalQuantity: purchaseQuantity,
  })
  if (resolved.kind === 'indeterminate') {
    if (resolved.reason === 'zero_physical' || resolved.reason === 'invalid_physical') {
      throw new InventoryError('Indicá el contenido de la compra.', 'INVALID_PURCHASE_QUANTITY', 400)
    }
    throw new InventoryError('Indicá un costo de compra válido.', 'INVALID_PURCHASE_COST', 400)
  }
  const amount = Math.round(resolved.netAcquisitionAmount * 100) / 100
  if (amount > INVENTORY_PURCHASE_COST_MAX) {
    throw new InventoryError('Indicá un costo de compra válido.', 'INVALID_PURCHASE_COST', 400)
  }
  return {
    purchaseQuantity: resolved.inventoryPhysicalQuantity,
    purchaseCost: amount,
    unitCost: resolved.unitCost,
  }
}

function mapResult(
  data: unknown,
  locationId: string,
  inventoryProductId: string,
  parsed: { purchaseQuantity: number; purchaseCost: number; unitCost: number },
): InventoryPurchaseCostResult {
  if (!isRecord(data)) {
    throw new InventoryError('No se pudo guardar el costo de compra.', 'COST_SAVE_FAILED', 500)
  }
  const resultLocationId = asString(data.location_id)
  const resultProductId = asString(data.inventory_product_id)
  const averageUnitCost = asFiniteNumber(data.average_unit_cost)
  const lastPurchaseUnitCost = asFiniteNumber(data.last_purchase_unit_cost)
  const onHand = asFiniteNumber(data.quantity_on_hand)
  if (
    resultLocationId !== locationId
    || resultProductId !== inventoryProductId
    || averageUnitCost == null
    || !Number.isFinite(averageUnitCost)
    || lastPurchaseUnitCost == null
    || !Number.isFinite(lastPurchaseUnitCost)
    || onHand == null
    || onHand < 0
    || typeof data.replay !== 'boolean'
  ) {
    throw new InventoryError('No se pudo guardar el costo de compra.', 'COST_SAVE_FAILED', 500)
  }
  if (
    Math.abs(averageUnitCost - parsed.unitCost) > 1e-8
    || Math.abs(lastPurchaseUnitCost - parsed.unitCost) > 1e-8
  ) {
    throw new InventoryError('No se pudo guardar el costo de compra.', 'COST_SAVE_FAILED', 500)
  }
  return {
    inventoryProductId: resultProductId,
    locationId: resultLocationId,
    purchaseQuantity: parsed.purchaseQuantity,
    purchaseCost: parsed.purchaseCost,
    averageUnitCost,
    lastPurchaseUnitCost,
    onHand,
    replay: data.replay,
  }
}

export async function setInventoryPurchaseCost(
  input: InventoryPurchaseCostInput,
): Promise<InventoryPurchaseCostResult> {
  if (!input.userId) {
    throw new InventoryError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  if (!UUID.test(input.organizationId)) {
    throw new InventoryError('Organización inválida.', 'INVALID_ORGANIZATION', 400)
  }
  if (!UUID.test(input.locationId)) {
    throw new InventoryError('Local inválido.', 'INVALID_LOCATION', 400)
  }
  if (!UUID.test(input.inventoryProductId)) {
    throw new InventoryError('Insumo inválido.', 'INVALID_PRODUCT', 400)
  }

  const parsed = parseInventoryPurchaseCostBody(input.body)
  await loadAuthorizedOrganization(input.userClient, input.organizationId)
  await loadAuthorizedLocation(input.userClient, input.locationId, input.organizationId)
  await loadAuthorizedProduct(input.userClient, input.inventoryProductId, input.organizationId)

  const rpcEnabled = input.rpcEnabled ?? INVENTORY_PURCHASE_COST_WRITE_ENABLED
  if (!rpcEnabled) {
    throw new InventoryError(
      'Todavía no se puede guardar el costo de compra del inventario.',
      'INVENTORY_COST_RPC_PENDING',
      503,
    )
  }

  const payload = {
    actor_user_id: input.userId,
    organization_id: input.organizationId,
    location_id: input.locationId,
    inventory_product_id: input.inventoryProductId,
    purchase_quantity: parsed.purchaseQuantity,
    purchase_cost: parsed.purchaseCost,
    source: 'manual',
  }
  const { data, error } = await input.adminClient.rpc('senda_set_inventory_purchase_cost', { p: payload })
  if (error) {
    mapRpcError(error, input.logRpcError)
  }
  return mapResult(data, input.locationId, input.inventoryProductId, parsed)
}

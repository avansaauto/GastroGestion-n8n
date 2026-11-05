import type { SupabaseClient } from '@supabase/supabase-js'
import { InventoryError } from './inventoryError.js'
import { classifyInventoryMovement, type InventoryMovementKind } from './inventoryMovementKind.js'

export const INVENTORY_HISTORY_PAGE_SIZE = 15

export type InventoryMovementRecord = {
  id: string
  occurredAt: string | null
  productId: string
  productName: string
  /** false = soft-delete (`active=false`). null = no se puede afirmar el estado. */
  productActive: boolean | null
  baseUnit: string | null
  quantity: number
  kind: InventoryMovementKind
  label: string
  detail: string | null
}

export type InventoryMovementPage = {
  items: InventoryMovementRecord[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export function parseInventoryHistoryPage(value: unknown): number {
  const raw = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 1
  if (!Number.isFinite(raw) || raw < 1) return 1
  return Math.floor(raw)
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

/** Solo boolean real de `inventory_products.active`. No inventar soft-delete. */
function asProductActive(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function lookupFailed(): never {
  throw new InventoryError('No se pudo leer el historial de esta sucursal.', 'LOOKUP_FAILED', 500)
}

export type ListLocationInventoryMovementsOptions = {
  /**
   * Cliente con privilegio de lectura (service_role) para movements/adjustments.
   * La membresía se valida siempre con `client` (JWT). Sin SELECT RLS en
   * inventory_movements el JWT devuelve [] sin error y el historial queda vacío.
   */
  readClient?: SupabaseClient
  page?: number
  pageSize?: number
}

export async function listLocationInventoryMovements(
  client: SupabaseClient,
  organizationId: string,
  locationId: string,
  options: ListLocationInventoryMovementsOptions = {},
): Promise<InventoryMovementPage | null> {
  const readClient = options.readClient ?? client
  const pageSize = Math.min(
    50,
    Math.max(1, Math.floor(options.pageSize ?? INVENTORY_HISTORY_PAGE_SIZE)),
  )
  let page = parseInventoryHistoryPage(options.page)

  const { data: location, error: locationError } = await client
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (locationError) lookupFailed()
  if (!isRecord(location) || String(location.organization_id ?? '') !== organizationId) return null

  const { data: inventoryRows, error: inventoryError } = await client
    .from('location_inventory')
    .select('id, inventory_product_id, location_id')
    .eq('location_id', locationId)
  if (inventoryError) lookupFailed()

  const productByLocationInventory = new Map<string, string>()
  for (const row of Array.isArray(inventoryRows) ? inventoryRows as unknown[] : []) {
    if (!isRecord(row) || String(row.location_id ?? '') !== locationId) continue
    const id = asString(row.id)
    const productId = asString(row.inventory_product_id)
    if (!id || !productId) continue
    productByLocationInventory.set(id, productId)
  }
  const locationInventoryIds = [...productByLocationInventory.keys()]
  if (locationInventoryIds.length === 0) {
    return { items: [], page: 1, pageSize, total: 0, totalPages: 1 }
  }

  const productIds = [...new Set(productByLocationInventory.values())]
  const { data: productRows, error: productError } = await client
    .from('inventory_products')
    .select('id, organization_id, name, base_unit, active')
    .eq('organization_id', organizationId)
    .in('id', productIds)
  if (productError) lookupFailed()

  const productById = new Map<string, {
    name: string
    baseUnit: string | null
    active: boolean | null
  }>()
  for (const row of Array.isArray(productRows) ? productRows as unknown[] : []) {
    if (!isRecord(row) || String(row.organization_id ?? '') !== organizationId) continue
    const id = asString(row.id)
    if (!id) continue
    productById.set(id, {
      name: asString(row.name) ?? 'Insumo',
      baseUnit: asString(row.base_unit),
      active: asProductActive(row.active),
    })
  }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  const { data: movementRows, error: movementError, count } = await readClient
    .from('inventory_movements')
    .select('id, location_inventory_id, movement_type, quantity, occurred_at, created_at', {
      count: 'exact',
    })
    .in('location_inventory_id', locationInventoryIds)
    .order('occurred_at', { ascending: false })
    .range(from, to)
  if (movementError) lookupFailed()

  const total = typeof count === 'number' && count >= 0 ? count : 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1)
  if (page > totalPages) {
    page = totalPages
  }

  const movements = (Array.isArray(movementRows) ? movementRows as unknown[] : []).filter(isRecord)
  const movementIds = movements.map((row) => asString(row.id)).filter((id): id is string => Boolean(id))
  const reasonByMovement = new Map<string, string>()
  if (movementIds.length > 0) {
    const { data: adjustmentRows, error: adjustmentError } = await readClient
      .from('inventory_adjustments')
      .select('inventory_movement_id, location_id, reason')
      .eq('location_id', locationId)
      .in('inventory_movement_id', movementIds)
    if (adjustmentError) lookupFailed()
    for (const row of Array.isArray(adjustmentRows) ? adjustmentRows as unknown[] : []) {
      if (!isRecord(row) || String(row.location_id ?? '') !== locationId) continue
      const movementId = asString(row.inventory_movement_id)
      const reason = asString(row.reason)
      if (!movementId || !reason || reasonByMovement.has(movementId)) continue
      reasonByMovement.set(movementId, reason)
    }
  }

  const items = movements.flatMap((row) => {
    const id = asString(row.id)
    const locationInventoryId = asString(row.location_inventory_id)
    const quantity = asNumber(row.quantity)
    if (!id || !locationInventoryId || quantity == null) return []
    if (!productByLocationInventory.has(locationInventoryId)) return []
    const productId = productByLocationInventory.get(locationInventoryId) as string
    const product = productById.get(productId)
    // Sin fila de producto no afirmamos «Eliminado»; conservamos el movimiento por UUID.
    const productName = product?.name ?? 'Insumo'
    const productActive = product ? product.active : null
    const baseUnit = product?.baseUnit ?? null
    const reason = reasonByMovement.get(id) ?? null
    const classified = classifyInventoryMovement({
      movementType: asString(row.movement_type),
      reason,
      quantity,
    })
    return [{
      id,
      occurredAt: asString(row.occurred_at) ?? asString(row.created_at),
      productId,
      productName,
      productActive,
      baseUnit,
      quantity,
      kind: classified.kind,
      label: classified.label,
      detail: reason,
    }]
  })

  return { items, page, pageSize, total, totalPages }
}

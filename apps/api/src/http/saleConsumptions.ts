import type { SupabaseClient } from '@supabase/supabase-js'
import { InventoryError } from './inventoryError.js'

/**
 * Lectura de consumos de venta.
 * Base: inventory_movements (sale / sale_reversal) de register_sale_consumption.
 * Enriquecimiento opcional: sale_consumption_events cuando la migración está aplicada.
 * Sin evento, producto/receta quedan null (la UI muestra «No consta»).
 */

export type SaleConsumptionProcessStatus =
  | 'registered'
  | 'reversed'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'duplicate'

export type SaleConsumptionLineStatus = 'registered' | 'reversed' | 'failed' | 'duplicate'

export type SaleConsumptionLine = {
  id: string
  occurredAt: string | null
  productId: string | null
  productName: string
  baseUnit: string | null
  quantity: number
  status: SaleConsumptionLineStatus
  errorCode: string | null
}

export type SaleConsumptionGroup = {
  sourceType: string
  sourceId: string
  occurredAt: string | null
  status: SaleConsumptionProcessStatus
  soldProductName: string | null
  soldProductId: string | null
  recipeName: string | null
  recipeId: string | null
  soldQuantity: number | null
  soldUnit: string | null
  errorCode: string | null
  lines: SaleConsumptionLine[]
}

const SALE_MOVEMENT_TYPES = new Set(['sale', 'sale_reversal'])
const READ_LIMIT = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function lookupFailed(): never {
  throw new InventoryError('No se pudieron leer los consumos de esta sucursal.', 'LOOKUP_FAILED', 500)
}

function isSchemaMissing(error: { code?: string; message?: string } | null) {
  const blob = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase()
  return /42p01|pgrst205|could not find the table|does not exist|relation .* does not exist/.test(blob)
}

export function saleConsumptionStatus(movementType: string | null | undefined): SaleConsumptionLineStatus | null {
  const type = movementType?.trim().toLowerCase() ?? ''
  if (type === 'sale') return 'registered'
  if (type === 'sale_reversal') return 'reversed'
  return null
}

function laterOccurredAt(left: string | null, right: string | null) {
  if (!left) return right
  if (!right) return left
  return left > right ? left : right
}

function originKey(sourceType: string, sourceId: string) {
  return `${sourceType}\n${sourceId}`
}

export function mergeSaleConsumptionViews(input: {
  movements: Array<{
    sourceType: string
    sourceId: string
    line: SaleConsumptionLine
  }>
  events: Array<{
    sourceType: string
    sourceId: string
    occurredAt: string | null
    status: SaleConsumptionProcessStatus
    soldProductName: string | null
    soldProductId: string | null
    recipeName: string | null
    recipeId: string | null
    soldQuantity: number | null
    soldUnit: string | null
    errorCode: string | null
    lines: SaleConsumptionLine[]
  }>
}): SaleConsumptionGroup[] {
  const groups = new Map<string, SaleConsumptionGroup>()

  for (const event of input.events) {
    const key = originKey(event.sourceType, event.sourceId)
    groups.set(key, {
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      occurredAt: event.occurredAt,
      status: event.status,
      soldProductName: event.soldProductName,
      soldProductId: event.soldProductId,
      recipeName: event.recipeName,
      recipeId: event.recipeId,
      soldQuantity: event.soldQuantity,
      soldUnit: event.soldUnit,
      errorCode: event.errorCode,
      lines: [...event.lines],
    })
  }

  for (const movement of input.movements) {
    const key = originKey(movement.sourceType, movement.sourceId)
    const current = groups.get(key)
    if (!current) {
      groups.set(key, {
        sourceType: movement.sourceType,
        sourceId: movement.sourceId,
        occurredAt: movement.line.occurredAt,
        status: movement.line.status === 'reversed' ? 'reversed' : 'registered',
        soldProductName: null,
        soldProductId: null,
        recipeName: null,
        recipeId: null,
        soldQuantity: null,
        soldUnit: null,
        errorCode: null,
        lines: [movement.line],
      })
      continue
    }
    if (!current.lines.some((line) => line.id === movement.line.id)) {
      current.lines.push(movement.line)
    }
    current.occurredAt = laterOccurredAt(current.occurredAt, movement.line.occurredAt)
    if (current.status === 'registered' && movement.line.status === 'reversed') {
      current.status = 'reversed'
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      lines: [...group.lines].sort((left, right) => left.productName.localeCompare(right.productName, 'es')),
    }))
    .sort((left, right) => (right.occurredAt ?? '').localeCompare(left.occurredAt ?? ''))
}

/** Agrupa movimientos sin evento. Conservado para pruebas del contrato legado. */
export function groupSaleConsumptions(lines: SaleConsumptionLine[], source: {
  sourceType: string
  sourceId: string
}[]): SaleConsumptionGroup[] {
  if (lines.length !== source.length) return []
  return mergeSaleConsumptionViews({
    movements: lines.map((line, index) => ({
      sourceType: source[index]!.sourceType,
      sourceId: source[index]!.sourceId,
      line,
    })),
    events: [],
  })
}

async function loadSaleEvents(
  client: SupabaseClient,
  organizationId: string,
  locationId: string,
): Promise<{
  sourceType: string
  sourceId: string
  occurredAt: string | null
  status: SaleConsumptionProcessStatus
  soldProductName: string | null
  soldProductId: string | null
  recipeName: string | null
  recipeId: string | null
  soldQuantity: number | null
  soldUnit: string | null
  errorCode: string | null
  lines: SaleConsumptionLine[]
}[] | null> {
  const { data: eventRows, error: eventError } = await client
    .from('sale_consumption_events')
    .select(
      'id, organization_id, location_id, source_type, source_id, external_product_id, external_product_name, recipe_id, recipe_name, sold_quantity, sold_unit, status, error_code, created_at, updated_at',
    )
    .eq('location_id', locationId)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(READ_LIMIT)

  if (eventError) {
    if (isSchemaMissing(eventError)) return null
    lookupFailed()
  }

  const events = (Array.isArray(eventRows) ? eventRows as unknown[] : []).filter(isRecord)
  const eventIds = events.map((row) => asString(row.id)).filter((id): id is string => Boolean(id))
  const linesByEvent = new Map<string, SaleConsumptionLine[]>()

  if (eventIds.length > 0) {
    const { data: lineRows, error: lineError } = await client
      .from('sale_consumption_event_lines')
      .select('id, event_id, inventory_product_id, quantity, status, inventory_movement_id, error_code, created_at')
      .in('event_id', eventIds)
    if (lineError) {
      if (isSchemaMissing(lineError)) return null
      lookupFailed()
    }

    const productIds = [...new Set(
      (Array.isArray(lineRows) ? lineRows as unknown[] : [])
        .filter(isRecord)
        .map((row) => asString(row.inventory_product_id))
        .filter((id): id is string => Boolean(id)),
    )]
    const productName = new Map<string, { name: string; baseUnit: string | null }>()
    if (productIds.length > 0) {
      const { data: productRows, error: productError } = await client
        .from('inventory_products')
        .select('id, organization_id, name, base_unit')
        .eq('organization_id', organizationId)
        .in('id', productIds)
      if (productError) lookupFailed()
      for (const row of Array.isArray(productRows) ? productRows as unknown[] : []) {
        if (!isRecord(row) || String(row.organization_id ?? '') !== organizationId) continue
        const id = asString(row.id)
        if (!id) continue
        productName.set(id, {
          name: asString(row.name) ?? 'Insumo',
          baseUnit: asString(row.base_unit),
        })
      }
    }

    for (const row of Array.isArray(lineRows) ? lineRows as unknown[] : []) {
      if (!isRecord(row)) continue
      const eventId = asString(row.event_id)
      const id = asString(row.id) ?? asString(row.inventory_movement_id)
      const quantity = asNumber(row.quantity)
      const statusRaw = asString(row.status)
      if (!eventId || !id || quantity == null || !statusRaw) continue
      const status: SaleConsumptionLineStatus = statusRaw === 'failed' || statusRaw === 'duplicate' || statusRaw === 'registered'
        ? statusRaw
        : 'failed'
      const productId = asString(row.inventory_product_id)
      const product = productId ? productName.get(productId) : null
      const list = linesByEvent.get(eventId) ?? []
      list.push({
        id,
        occurredAt: asString(row.created_at),
        productId,
        productName: product?.name ?? 'Insumo',
        baseUnit: product?.baseUnit ?? null,
        quantity,
        status,
        errorCode: asString(row.error_code),
      })
      linesByEvent.set(eventId, list)
    }
  }

  return events.flatMap((row) => {
    if (String(row.organization_id ?? '') !== organizationId) return []
    if (String(row.location_id ?? '') !== locationId) return []
    const sourceType = asString(row.source_type)
    const sourceId = asString(row.source_id)
    const id = asString(row.id)
    const statusRaw = asString(row.status)
    if (!sourceType || !sourceId || !id || !statusRaw) return []
    const status = (
      statusRaw === 'complete'
      || statusRaw === 'partial'
      || statusRaw === 'failed'
      || statusRaw === 'duplicate'
      || statusRaw === 'reversed'
    ) ? statusRaw : 'failed'
    return [{
      sourceType,
      sourceId,
      occurredAt: asString(row.updated_at) ?? asString(row.created_at),
      status,
      soldProductName: asString(row.external_product_name),
      soldProductId: asString(row.external_product_id),
      recipeName: asString(row.recipe_name),
      recipeId: asString(row.recipe_id),
      soldQuantity: asNumber(row.sold_quantity),
      soldUnit: asString(row.sold_unit),
      errorCode: asString(row.error_code),
      lines: linesByEvent.get(id) ?? [],
    }]
  })
}

export type ListSaleConsumptionsOptions = {
  readClient?: SupabaseClient
}

export async function listSaleConsumptions(
  client: SupabaseClient,
  organizationId: string,
  locationId: string,
  options: ListSaleConsumptionsOptions = {},
): Promise<SaleConsumptionGroup[] | null> {
  const readClient = options.readClient ?? client
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

  const productName = new Map<string, { name: string; baseUnit: string | null }>()
  if (locationInventoryIds.length > 0) {
    const productIds = [...new Set(productByLocationInventory.values())]
    const { data: productRows, error: productError } = await client
      .from('inventory_products')
      .select('id, organization_id, name, base_unit')
      .eq('organization_id', organizationId)
      .in('id', productIds)
    if (productError) lookupFailed()
    for (const row of Array.isArray(productRows) ? productRows as unknown[] : []) {
      if (!isRecord(row) || String(row.organization_id ?? '') !== organizationId) continue
      const id = asString(row.id)
      if (!id) continue
      productName.set(id, {
        name: asString(row.name) ?? 'Insumo',
        baseUnit: asString(row.base_unit),
      })
    }
  }

  const movements: Array<{
    sourceType: string
    sourceId: string
    line: SaleConsumptionLine
  }> = []

  if (locationInventoryIds.length > 0) {
    const { data: movementRows, error: movementError } = await readClient
      .from('inventory_movements')
      .select('id, location_inventory_id, movement_type, quantity, source_type, source_id, occurred_at, created_at')
      .in('location_inventory_id', locationInventoryIds)
      .in('movement_type', ['sale', 'sale_reversal'])
      .order('occurred_at', { ascending: false })
      .limit(READ_LIMIT)
    if (movementError) lookupFailed()

    for (const row of Array.isArray(movementRows) ? movementRows as unknown[] : []) {
      if (!isRecord(row)) continue
      const status = saleConsumptionStatus(asString(row.movement_type))
      if (!status || !SALE_MOVEMENT_TYPES.has(asString(row.movement_type)?.toLowerCase() ?? '')) continue
      const id = asString(row.id)
      const locationInventoryId = asString(row.location_inventory_id)
      const quantity = asNumber(row.quantity)
      const sourceType = asString(row.source_type)
      const sourceId = asString(row.source_id)
      if (!id || !locationInventoryId || quantity == null || !sourceType || !sourceId) continue
      if (!productByLocationInventory.has(locationInventoryId)) continue
      const productId = productByLocationInventory.get(locationInventoryId) as string
      const product = productName.get(productId)
      if (!product) continue
      movements.push({
        sourceType,
        sourceId,
        line: {
          id,
          occurredAt: asString(row.occurred_at) ?? asString(row.created_at),
          productId,
          productName: product.name,
          baseUnit: product.baseUnit,
          quantity,
          status,
          errorCode: null,
        },
      })
    }
  }

  const events = await loadSaleEvents(client, organizationId, locationId)
  return mergeSaleConsumptionViews({
    movements,
    events: events ?? [],
  })
}

/**
 * Lógica pura de «Preparar Evento Consumo» (n8n Code node).
 * Agrupa ingredientes por ítem Fudo → payload de senda_register_sale_consumption_event.
 * Sin secretos. Sin I/O.
 */

export const PILOT_LOCATION_ID = '170ee5fa-6f8c-4a0f-830d-8322e76926f6' // SENDA - Pruebas

export type ConsumoLinea = {
  venta_id?: string | number | null
  item_id?: string | number | null
  producto_id?: string | number | null
  producto?: string | null
  cantidad_vendida?: number | string | null
  recipe_id?: string | null
  recipe_name?: string | null
  inventory_product_id?: string | null
  consumo_total?: number | string | null
}

export type InventarioRow = {
  id?: string | null
  inventory_product_id?: string | null
  location_id?: string | null
}

export type SaleConsumptionEventPayload = {
  location_id: string
  source_type: 'fudo'
  source_id: string
  external_sale_id: string
  external_item_id: string
  external_product_id: string
  external_product_name: string | null
  recipe_id: string | null
  recipe_name: string | null
  sold_quantity: number
  sold_unit: 'unit'
  lines: Array<{ location_inventory_id: string; quantity: number }>
}

export type PrepareResult =
  | { ok: true; events: SaleConsumptionEventPayload[] }
  | { ok: false; error: string }

function asText(value: unknown): string {
  return String(value ?? '').trim()
}

function asNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : Number.NaN
}

/**
 * Agrupa consumos + inventarios en un evento por item_id (source_id).
 * Acumula ingredientes repetidos. Exige location_id del piloto.
 */
export function prepareSaleConsumptionEvents(
  consumos: ConsumoLinea[],
  inventarios: InventarioRow[],
  locationId: string = PILOT_LOCATION_ID,
): PrepareResult {
  if (!locationId) {
    return { ok: false, error: 'LOCATION_REQUIRED' }
  }

  const inventariosPorProducto = new Map<string, InventarioRow>()
  for (const inventario of inventarios) {
    if (inventario.id && inventario.inventory_product_id) {
      inventariosPorProducto.set(String(inventario.inventory_product_id), inventario)
    }
  }

  type Acc = {
    meta: {
      venta_id: string
      item_id: string
      producto_id: string
      producto: string | null
      cantidad_vendida: number
      recipe_id: string | null
      recipe_name: string | null
    }
    lines: Map<string, number>
  }

  const porItem = new Map<string, Acc>()

  for (const consumo of consumos) {
    const itemId = asText(consumo.item_id)
    const ventaId = asText(consumo.venta_id)
    const productoId = asText(consumo.producto_id)
    const cantidadVendida = asNumber(consumo.cantidad_vendida)
    const qty = asNumber(consumo.consumo_total)
    const productKey = asText(consumo.inventory_product_id)

    if (!itemId) return { ok: false, error: 'MISSING_ITEM_ID' }
    if (!ventaId) return { ok: false, error: 'MISSING_SALE_ID' }
    if (!productoId) return { ok: false, error: 'MISSING_PRODUCT_ID' }
    if (!Number.isFinite(cantidadVendida) || cantidadVendida <= 0) {
      return { ok: false, error: 'INVALID_SOLD_QUANTITY' }
    }
    if (!Number.isFinite(qty) || qty >= 0) {
      return { ok: false, error: 'INVALID_CONSUMPTION_QTY' }
    }
    if (!productKey) return { ok: false, error: 'MISSING_INVENTORY_PRODUCT' }

    const inventario = inventariosPorProducto.get(productKey)
    if (!inventario?.id) return { ok: false, error: 'INVENTORY_NOT_FOUND' }
    if (asText(inventario.location_id) !== locationId) {
      return { ok: false, error: 'INVENTORY_LOCATION_MISMATCH' }
    }

    let acc = porItem.get(itemId)
    if (!acc) {
      acc = {
        meta: {
          venta_id: ventaId,
          item_id: itemId,
          producto_id: productoId,
          producto: consumo.producto ? asText(consumo.producto) : null,
          cantidad_vendida: cantidadVendida,
          recipe_id: consumo.recipe_id ? asText(consumo.recipe_id) : null,
          recipe_name: consumo.recipe_name ? asText(consumo.recipe_name) : null,
        },
        lines: new Map(),
      }
      porItem.set(itemId, acc)
    }

    const prev = acc.lines.get(inventario.id) ?? 0
    acc.lines.set(inventario.id, prev + qty)
  }

  const events: SaleConsumptionEventPayload[] = []
  for (const acc of porItem.values()) {
    const lines = [...acc.lines.entries()].map(([location_inventory_id, quantity]) => ({
      location_inventory_id,
      quantity,
    }))
    if (lines.length === 0) return { ok: false, error: 'EMPTY_LINES' }

    events.push({
      location_id: locationId,
      source_type: 'fudo',
      source_id: acc.meta.item_id,
      external_sale_id: acc.meta.venta_id,
      external_item_id: acc.meta.item_id,
      external_product_id: acc.meta.producto_id,
      external_product_name: acc.meta.producto,
      recipe_id: acc.meta.recipe_id,
      recipe_name: acc.meta.recipe_name,
      sold_quantity: acc.meta.cantidad_vendida,
      sold_unit: 'unit',
      lines,
    })
  }

  return { ok: true, events }
}

/** True solo si canceled es boolean true o string "true" (case-insensitive). */
export function isFudoItemCanceled(canceled: unknown): boolean {
  if (canceled === true) return true
  if (typeof canceled === 'string' && canceled.trim().toLowerCase() === 'true') return true
  return false
}

import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { InventoryError } from './inventoryError.js'
import {
  INVENTORY_PURCHASE_COST_WRITE_ENABLED,
  isSetInventoryPurchaseCostRpcMissing,
  parseInventoryPurchaseCostBody,
  setInventoryPurchaseCost,
} from './inventoryPurchaseCost.js'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const LOCATION = '22222222-2222-4222-8222-222222222222'
const PRODUCT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function filterable(rows: Record<string, unknown>[], error: { message?: string } | null = null) {
  let filtered = [...rows]
  const builder: Record<string, unknown> = {}
  const self = () => builder
  builder.select = self
  builder.eq = (column: string, value: string) => {
    filtered = filtered.filter((row) => String(row[column] ?? '') === value)
    return builder
  }
  builder.maybeSingle = async () => ({
    data: error ? null : filtered[0] ?? null,
    error,
  })
  return builder
}

function clients(options: {
  organization?: Record<string, unknown> | null
  locations?: Record<string, unknown>[]
  products?: Record<string, unknown>[]
  rpcData?: Record<string, unknown> | null
  rpcError?: { code?: string; message?: string; details?: string } | null
} = {}) {
  const tables: string[] = []
  const from = vi.fn((table: string) => {
    tables.push(table)
    if (
      table === 'inventory_movements'
      || table === 'inventory_valuations'
      || table === 'inventory_cost_history'
      || table === 'purchase_documents'
      || table === 'recipes'
    ) {
      throw new Error(`${table} no debe consultarse`)
    }
    if (table === 'organizations') {
      return filterable(
        options.organization === undefined
          ? [{ id: ORGANIZATION }]
          : options.organization
            ? [options.organization]
            : [],
      )
    }
    if (table === 'locations') {
      return filterable(
        options.locations ?? [{ id: LOCATION, organization_id: ORGANIZATION }],
      )
    }
    if (table === 'inventory_products') {
      return filterable(
        options.products ?? [{ id: PRODUCT, organization_id: ORGANIZATION }],
      )
    }
    throw new Error(`tabla inesperada: ${table}`)
  })
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: options.rpcError ? null : (options.rpcData ?? {
      inventory_product_id: PRODUCT,
      location_id: LOCATION,
      purchase_quantity: 100000,
      purchase_cost: 180000,
      average_unit_cost: 1.8,
      last_purchase_unit_cost: 1.8,
      quantity_on_hand: 100000,
      replay: false,
    }),
    error: options.rpcError ?? null,
  }))
  return {
    from,
    rpc,
    tables,
    user: { from } as unknown as SupabaseClient,
    admin: { rpc } as unknown as SupabaseClient,
  }
}

async function saveCost(
  db: ReturnType<typeof clients>,
  overrides: Partial<{
    userId: string
    organizationId: string
    locationId: string
    inventoryProductId: string
    body: unknown
    rpcEnabled: boolean
  }> = {},
) {
  return setInventoryPurchaseCost({
    userClient: db.user,
    adminClient: db.admin,
    userId: 'userId' in overrides ? overrides.userId ?? '' : USER,
    organizationId: overrides.organizationId ?? ORGANIZATION,
    locationId: overrides.locationId ?? LOCATION,
    inventoryProductId: overrides.inventoryProductId ?? PRODUCT,
    body: 'body' in overrides ? overrides.body : { purchaseQuantity: 100000, purchaseCost: 180000 },
    rpcEnabled: overrides.rpcEnabled,
  })
}

describe('parseInventoryPurchaseCostBody', () => {
  it('calcula 1,80 por ml con 100.000 ml a $180.000', () => {
    expect(parseInventoryPurchaseCostBody({
      purchaseQuantity: 100000,
      purchaseCost: 180000,
    })).toEqual({
      purchaseQuantity: 100000,
      purchaseCost: 180000,
      unitCost: 1.8,
    })
  })

  it('acepta costo cero y rechaza contenido inválido', () => {
    expect(parseInventoryPurchaseCostBody({
      purchaseQuantity: 100000,
      purchaseCost: 0,
    }).unitCost).toBe(0)
    expect(() => parseInventoryPurchaseCostBody({
      purchaseQuantity: 0,
      purchaseCost: 180000,
    })).toThrow(InventoryError)
    expect(() => parseInventoryPurchaseCostBody({
      purchaseQuantity: 100000,
      purchaseCost: null,
    })).toThrow(InventoryError)
  })
})

describe('setInventoryPurchaseCost', () => {
  it('llama el RPC con cantidad base y no escribe movimientos', async () => {
    expect(INVENTORY_PURCHASE_COST_WRITE_ENABLED).toBe(true)
    const db = clients()
    const result = await saveCost(db)
    expect(result).toEqual({
      inventoryProductId: PRODUCT,
      locationId: LOCATION,
      purchaseQuantity: 100000,
      purchaseCost: 180000,
      averageUnitCost: 1.8,
      lastPurchaseUnitCost: 1.8,
      onHand: 100000,
      replay: false,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_set_inventory_purchase_cost', {
      p: {
        actor_user_id: USER,
        organization_id: ORGANIZATION,
        location_id: LOCATION,
        inventory_product_id: PRODUCT,
        purchase_quantity: 100000,
        purchase_cost: 180000,
        source: 'manual',
      },
    })
    expect(db.tables).toEqual(['organizations', 'locations', 'inventory_products'])
    expect(db.rpc.mock.calls[0]?.[0]).not.toBe('senda_receive_purchase_document_line')
  })

  it('no toma el origen ni el local del body del browser', async () => {
    const db = clients()
    await saveCost(db, {
      body: {
        purchaseQuantity: 100000,
        purchaseCost: 180000,
        source: 'invoice',
        organization_id: '99999999-9999-4999-8999-999999999999',
        location_id: '88888888-8888-4888-8888-888888888888',
      },
    })
    expect(db.rpc.mock.calls[0]?.[1]).toEqual({
      p: {
        actor_user_id: USER,
        organization_id: ORGANIZATION,
        location_id: LOCATION,
        inventory_product_id: PRODUCT,
        purchase_quantity: 100000,
        purchase_cost: 180000,
        source: 'manual',
      },
    })
  })

  it('trata un reintento idéntico como replay y un costo nuevo como reemplazo', async () => {
    const replay = clients({
      rpcData: {
        inventory_product_id: PRODUCT,
        location_id: LOCATION,
        average_unit_cost: 1.8,
        last_purchase_unit_cost: 1.8,
        quantity_on_hand: 100000,
        replay: true,
      },
    })
    expect((await saveCost(replay)).replay).toBe(true)

    const updated = clients({
      rpcData: {
        inventory_product_id: PRODUCT,
        location_id: LOCATION,
        average_unit_cost: 2,
        last_purchase_unit_cost: 2,
        quantity_on_hand: 100000,
        replay: false,
      },
    })
    const next = await saveCost(updated, { body: { purchaseQuantity: 100000, purchaseCost: 200000 } })
    expect(next.averageUnitCost).toBe(2)
    expect(next.lastPurchaseUnitCost).toBe(2)
    expect(next.purchaseCost).toBe(200000)
    expect(next.onHand).toBe(100000)
  })

  it('rechaza un costo manual cuando ya hay stock con promedio', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'MANUAL_COST_WITH_ON_HAND' },
    })
    await expect(saveCost(db)).rejects.toMatchObject({
      code: 'MANUAL_COST_WITH_ON_HAND',
      status: 409,
      message: expect.stringMatching(/no se modificó/i),
    })
  })

  it('no inventa un costo si el RPC falta o está deshabilitado', async () => {
    expect(isSetInventoryPurchaseCostRpcMissing({
      code: 'PGRST202',
      message: 'Could not find the function senda_set_inventory_purchase_cost',
    })).toBe(true)
    await expect(saveCost(clients(), { rpcEnabled: false })).rejects.toMatchObject({
      code: 'INVENTORY_COST_RPC_PENDING',
      status: 503,
    })
    await expect(saveCost(clients({
      rpcError: { code: 'PGRST202', message: 'Could not find the function senda_set_inventory_purchase_cost' },
    }))).rejects.toMatchObject({
      code: 'INVENTORY_COST_RPC_PENDING',
      status: 503,
    })
  })

  it('no mezcla locales ni organizaciones', async () => {
    await expect(saveCost(clients({ locations: [] }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    })
    await expect(saveCost(clients({ products: [] }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    })
  })
})

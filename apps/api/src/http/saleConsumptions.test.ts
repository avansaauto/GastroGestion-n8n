import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { InventoryError } from './inventoryError.js'
import {
  groupSaleConsumptions,
  listSaleConsumptions,
  mergeSaleConsumptionViews,
} from './saleConsumptions.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const LOCATION = '33333333-3333-4333-8333-333333333333'
const LI = '44444444-4444-4444-8444-444444444444'
const LI_2 = '44444444-4444-4444-8444-444444444445'
const PRODUCT = '55555555-5555-4555-8555-555555555555'
const PRODUCT_2 = '55555555-5555-4555-8555-555555555556'
const EVENT = '77777777-7777-4777-8777-777777777777'

function client(tables: Record<string, unknown>, calls: string[] = []) {
  return {
    from(table: string) {
      calls.push(table)
      const rows = tables[table]
      const builder = {
        select() { return builder },
        eq() { return builder },
        in() { return builder },
        order() { return builder },
        limit() { return builder },
        maybeSingle: async () => ({
          data: Array.isArray(rows) ? null : rows,
          error: rows instanceof Error ? { message: rows.message } : null,
        }),
        then(resolve: (value: { data: unknown; error: { message: string; code?: string } | null }) => void) {
          if (rows instanceof Error) {
            resolve({
              data: null,
              error: {
                message: rows.message,
                code: /does not exist|PGRST205/i.test(rows.message) ? 'PGRST205' : undefined,
              },
            })
          } else resolve({ data: rows, error: null })
        },
      }
      return builder
    },
    rpc() {
      calls.push('rpc')
      return Promise.resolve({ data: null, error: null })
    },
  } as unknown as SupabaseClient
}

const base = {
  locations: { id: LOCATION, organization_id: ORG },
  location_inventory: [
    { id: LI, inventory_product_id: PRODUCT, location_id: LOCATION },
    { id: LI_2, inventory_product_id: PRODUCT_2, location_id: LOCATION },
  ],
  inventory_products: [
    { id: PRODUCT, organization_id: ORG, name: 'Harina', base_unit: 'g' },
    { id: PRODUCT_2, organization_id: ORG, name: 'Mozzarella', base_unit: 'g' },
  ],
}

describe('consumos de venta', () => {
  it('agrupa por origen y no inventa la receta vendida', async () => {
    const calls: string[] = []
    const rows = await listSaleConsumptions(client({
      ...base,
      inventory_movements: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          location_inventory_id: LI,
          movement_type: 'sale',
          quantity: -200,
          source_type: 'fudo',
          source_id: '884211',
          occurred_at: '2026-10-31T18:00:00.000Z',
        },
        {
          id: '66666666-6666-4666-8666-666666666667',
          location_inventory_id: LI_2,
          movement_type: 'sale',
          quantity: -80,
          source_type: 'fudo',
          source_id: '884211',
          occurred_at: '2026-10-31T18:00:01.000Z',
        },
        {
          id: '66666666-6666-4666-8666-666666666668',
          location_inventory_id: LI,
          movement_type: 'purchase',
          quantity: 1000,
          source_type: 'invoice',
          source_id: 'factura',
          occurred_at: '2026-10-31T12:00:00.000Z',
        },
      ],
      sale_consumption_events: new Error('relation "sale_consumption_events" does not exist'),
      recipes: [{ id: 'recipe', name: 'Pizza' }],
      sales_product_mappings: [{ external_product_id: '12', recipe_id: 'recipe' }],
    }, calls), ORG, LOCATION)

    expect(rows).toEqual([
      expect.objectContaining({
        sourceType: 'fudo',
        sourceId: '884211',
        status: 'registered',
        soldProductName: null,
        recipeName: null,
        lines: [
          expect.objectContaining({ productName: 'Harina', quantity: -200, status: 'registered' }),
          expect.objectContaining({ productName: 'Mozzarella', quantity: -80, status: 'registered' }),
        ],
      }),
    ])
    expect(calls).not.toContain('rpc')
    expect(JSON.stringify(rows)).not.toContain('Pizza')
  })

  it('enriquece producto, receta y estado cuando existe el evento', async () => {
    const rows = await listSaleConsumptions(client({
      ...base,
      inventory_movements: [{
        id: '66666666-6666-4666-8666-666666666666',
        location_inventory_id: LI,
        movement_type: 'sale',
        quantity: -1,
        source_type: 'fudo',
        source_id: '144382',
        occurred_at: '2026-10-11T13:57:00.000Z',
      }],
      sale_consumption_events: [{
        id: EVENT,
        organization_id: ORG,
        location_id: LOCATION,
        source_type: 'fudo',
        source_id: '144382',
        external_product_id: '183',
        external_product_name: 'Coca Cola Zero',
        recipe_id: '21780f18-ab91-44c9-92d1-800b0c40c4c6',
        recipe_name: 'Coca Cola Zero',
        sold_quantity: 1,
        sold_unit: 'unit',
        status: 'complete',
        error_code: null,
        created_at: '2026-10-11T13:57:00.000Z',
        updated_at: '2026-10-11T13:57:00.000Z',
      }],
      sale_consumption_event_lines: [{
        id: '88888888-8888-4888-8888-888888888888',
        event_id: EVENT,
        inventory_product_id: PRODUCT,
        quantity: -1,
        status: 'registered',
        inventory_movement_id: '66666666-6666-4666-8666-666666666666',
        error_code: null,
        created_at: '2026-10-11T13:57:00.000Z',
      }],
    }), ORG, LOCATION)

    expect(rows).toEqual([
      expect.objectContaining({
        sourceId: '144382',
        status: 'complete',
        soldProductName: 'Coca Cola Zero',
        soldProductId: '183',
        recipeName: 'Coca Cola Zero',
        soldQuantity: 1,
        soldUnit: 'unit',
      }),
    ])
  })

  it('muestra un rechazo SALE_EXCEEDS_ON_HAND sin inventar movimiento', async () => {
    const rows = await listSaleConsumptions(client({
      ...base,
      inventory_movements: [],
      sale_consumption_events: [{
        id: EVENT,
        organization_id: ORG,
        location_id: LOCATION,
        source_type: 'fudo',
        source_id: '999001',
        external_product_id: '183',
        external_product_name: 'Coca Cola Zero',
        recipe_id: null,
        recipe_name: null,
        sold_quantity: 1,
        sold_unit: 'unit',
        status: 'failed',
        error_code: 'SALE_EVENT_FAILED',
        created_at: '2026-11-02T12:00:00.000Z',
        updated_at: '2026-11-02T12:00:00.000Z',
      }],
      sale_consumption_event_lines: [{
        id: '88888888-8888-4888-8888-888888888889',
        event_id: EVENT,
        inventory_product_id: PRODUCT,
        quantity: -1,
        status: 'failed',
        inventory_movement_id: null,
        error_code: 'SALE_EXCEEDS_ON_HAND',
        created_at: '2026-11-02T12:00:00.000Z',
      }],
    }), ORG, LOCATION)

    expect(rows).toEqual([
      expect.objectContaining({
        sourceId: '999001',
        status: 'failed',
        soldProductName: 'Coca Cola Zero',
        lines: [
          expect.objectContaining({
            status: 'failed',
            errorCode: 'SALE_EXCEEDS_ON_HAND',
            quantity: -1,
          }),
        ],
      }),
    ])
  })

  it('mezcla evento parcial con movimientos registrados', () => {
    const groups = mergeSaleConsumptionViews({
      events: [{
        sourceType: 'fudo',
        sourceId: '100010',
        occurredAt: '2026-11-01T00:00:00.000Z',
        status: 'partial',
        soldProductName: 'Pizza',
        soldProductId: '46',
        recipeName: 'Pizza Napolitana',
        recipeId: 'r1',
        soldQuantity: 1,
        soldUnit: 'unit',
        errorCode: null,
        lines: [{
          id: 'fail',
          occurredAt: '2026-11-01T00:00:00.000Z',
          productId: PRODUCT_2,
          productName: 'Mozzarella',
          baseUnit: 'g',
          quantity: -80,
          status: 'failed',
          errorCode: 'SALE_EXCEEDS_ON_HAND',
        }],
      }],
      movements: [{
        sourceType: 'fudo',
        sourceId: '100010',
        line: {
          id: 'ok',
          occurredAt: '2026-11-01T00:00:00.000Z',
          productId: PRODUCT,
          productName: 'Harina',
          baseUnit: 'g',
          quantity: -200,
          status: 'registered',
          errorCode: null,
        },
      }],
    })
    expect(groups[0]).toMatchObject({
      status: 'partial',
      soldProductName: 'Pizza',
      recipeName: 'Pizza Napolitana',
    })
    expect(groups[0]?.lines.map((line) => line.status).sort()).toEqual(['failed', 'registered'])
  })

  it('separa orígenes distintos y marca una reversión', () => {
    const groups = groupSaleConsumptions(
      [
        {
          id: 'a',
          occurredAt: '2026-10-01T00:00:00.000Z',
          productId: PRODUCT,
          productName: 'Harina',
          baseUnit: 'g',
          quantity: -10,
          status: 'registered',
          errorCode: null,
        },
        {
          id: 'b',
          occurredAt: '2026-10-02T00:00:00.000Z',
          productId: PRODUCT,
          productName: 'Harina',
          baseUnit: 'g',
          quantity: 10,
          status: 'reversed',
          errorCode: null,
        },
      ],
      [
        { sourceType: 'fudo', sourceId: '100001' },
        { sourceType: 'fudo', sourceId: '100002' },
      ],
    )
    expect(groups.map((group) => [group.sourceId, group.status])).toEqual([
      ['100002', 'reversed'],
      ['100001', 'registered'],
    ])
  })

  it('no devuelve consumos de otra organización', async () => {
    const rows = await listSaleConsumptions(client({
      locations: { id: LOCATION, organization_id: OTHER },
    }), ORG, LOCATION)
    expect(rows).toBeNull()
  })

  it('no inventa consumos si la consulta falla', async () => {
    await expect(listSaleConsumptions(client({
      locations: { id: LOCATION, organization_id: ORG },
      location_inventory: new Error('permission denied'),
    }), ORG, LOCATION)).rejects.toBeInstanceOf(InventoryError)
  })

  it('repite la lectura sin escribir', async () => {
    const tables = {
      locations: { id: LOCATION, organization_id: ORG },
      location_inventory: [],
      sale_consumption_events: [],
      sale_consumption_event_lines: [],
    }
    const calls: string[] = []
    const first = await listSaleConsumptions(client(tables, calls), ORG, LOCATION)
    const second = await listSaleConsumptions(client(tables, calls), ORG, LOCATION)
    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(calls).not.toContain('rpc')
  })
})

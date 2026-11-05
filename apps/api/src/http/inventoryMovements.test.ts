import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { InventoryError } from './inventoryError.js'
import {
  INVENTORY_HISTORY_PAGE_SIZE,
  listLocationInventoryMovements,
  parseInventoryHistoryPage,
} from './inventoryMovements.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const LOCATION = '33333333-3333-4333-8333-333333333333'
const LI = '44444444-4444-4444-8444-444444444444'
const PRODUCT = '55555555-5555-4555-8555-555555555555'
const MOVEMENT = '66666666-6666-4666-8666-666666666666'

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
        range() { return builder },
        maybeSingle: async () => ({
          data: Array.isArray(rows) ? null : rows,
          error: rows instanceof Error ? { message: rows.message } : null,
        }),
        then(resolve: (value: {
          data: unknown
          error: { message: string } | null
          count: number | null
        }) => void) {
          if (rows instanceof Error) {
            resolve({ data: null, error: { message: rows.message }, count: null })
          } else {
            const list = Array.isArray(rows) ? rows : rows
            resolve({
              data: list,
              error: null,
              count: Array.isArray(rows) ? rows.length : null,
            })
          }
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

describe('historial de inventario', () => {
  it('parsea la página pedida', () => {
    expect(parseInventoryHistoryPage('2')).toBe(2)
    expect(parseInventoryHistoryPage(0)).toBe(1)
    expect(parseInventoryHistoryPage('abc')).toBe(1)
    expect(INVENTORY_HISTORY_PAGE_SIZE).toBe(15)
  })

  it('lee solo la sucursal pedida y clasifica la merma', async () => {
    const calls: string[] = []
    const page = await listLocationInventoryMovements(client({
      locations: { id: LOCATION, organization_id: ORG },
      location_inventory: [{ id: LI, inventory_product_id: PRODUCT, location_id: LOCATION }],
      inventory_products: [{
        id: PRODUCT, organization_id: ORG, name: 'Harina', base_unit: 'g', active: true,
      }],
      inventory_movements: [{
        id: MOVEMENT,
        location_inventory_id: LI,
        movement_type: 'adjustment',
        quantity: -200,
        occurred_at: '2026-10-31T12:00:00.000Z',
      }],
      inventory_adjustments: [{
        inventory_movement_id: MOVEMENT,
        location_id: LOCATION,
        reason: 'Merma: se venció',
      }],
    }, calls), ORG, LOCATION)
    expect(page).toEqual({
      items: [
        expect.objectContaining({
          id: MOVEMENT,
          productId: PRODUCT,
          productName: 'Harina',
          productActive: true,
          quantity: -200,
          kind: 'waste',
          label: 'Merma',
          detail: 'Merma: se venció',
        }),
      ],
      page: 1,
      pageSize: 15,
      total: 1,
      totalPages: 1,
    })
    expect(calls).not.toContain('insert')
    expect(calls.filter((table) => table === 'inventory_movements')).toHaveLength(1)
  })

  it('no devuelve una sucursal de otra organización', async () => {
    const rows = await listLocationInventoryMovements(client({
      locations: { id: LOCATION, organization_id: OTHER },
    }), ORG, LOCATION)
    expect(rows).toBeNull()
  })

  it('no inventa movimientos si la consulta falla', async () => {
    await expect(listLocationInventoryMovements(client({
      locations: { id: LOCATION, organization_id: ORG },
      location_inventory: new Error('permission denied'),
    }), ORG, LOCATION)).rejects.toBeInstanceOf(InventoryError)
  })

  it('repite la lectura sin escribir', async () => {
    const tables = {
      locations: { id: LOCATION, organization_id: ORG },
      location_inventory: [],
    }
    const first = await listLocationInventoryMovements(client(tables), ORG, LOCATION)
    const second = await listLocationInventoryMovements(client(tables), ORG, LOCATION)
    expect(first).toEqual({ items: [], page: 1, pageSize: 15, total: 0, totalPages: 1 })
    expect(second).toEqual(first)
  })

  it('no etiqueta como Merma un ajuste positivo con motivo merma', async () => {
    const page = await listLocationInventoryMovements(client({
      locations: { id: LOCATION, organization_id: ORG },
      location_inventory: [{ id: LI, inventory_product_id: PRODUCT, location_id: LOCATION }],
      inventory_products: [{
        id: PRODUCT, organization_id: ORG, name: 'Arroz', base_unit: 'g', active: true,
      }],
      inventory_movements: [{
        id: MOVEMENT,
        location_inventory_id: LI,
        movement_type: 'adjustment',
        quantity: 1000,
        occurred_at: '2026-10-27T15:12:24.748196+00:00',
      }],
      inventory_adjustments: [{
        inventory_movement_id: MOVEMENT,
        location_id: LOCATION,
        reason: 'merma',
      }],
    }), ORG, LOCATION)
    expect(page?.items).toEqual([
      expect.objectContaining({
        id: MOVEMENT,
        productActive: true,
        quantity: 1000,
        kind: 'adjustment',
        label: 'Ajuste',
        detail: 'merma',
      }),
    ])
  })

  it('marca productActive=false por UUID soft-deleted sin confundir homónimos activos', async () => {
    const PRODUCT_NEW = '77777777-7777-4777-8777-777777777777'
    const LI_NEW = '88888888-8888-4888-8888-888888888888'
    const MOVEMENT_NEW = '99999999-9999-4999-8999-999999999999'
    const page = await listLocationInventoryMovements(client({
      locations: { id: LOCATION, organization_id: ORG },
      location_inventory: [
        { id: LI, inventory_product_id: PRODUCT, location_id: LOCATION },
        { id: LI_NEW, inventory_product_id: PRODUCT_NEW, location_id: LOCATION },
      ],
      inventory_products: [
        { id: PRODUCT, organization_id: ORG, name: 'Harina', base_unit: 'g', active: false },
        { id: PRODUCT_NEW, organization_id: ORG, name: 'Harina', base_unit: 'g', active: true },
      ],
      inventory_movements: [
        {
          id: MOVEMENT,
          location_inventory_id: LI,
          movement_type: 'purchase',
          quantity: 500,
          occurred_at: '2026-09-01T12:00:00.000Z',
        },
        {
          id: MOVEMENT_NEW,
          location_inventory_id: LI_NEW,
          movement_type: 'purchase',
          quantity: 800,
          occurred_at: '2026-11-01T12:00:00.000Z',
        },
      ],
      inventory_adjustments: [],
    }), ORG, LOCATION)

    expect(page?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: MOVEMENT,
        productId: PRODUCT,
        productName: 'Harina',
        productActive: false,
        quantity: 500,
      }),
      expect.objectContaining({
        id: MOVEMENT_NEW,
        productId: PRODUCT_NEW,
        productName: 'Harina',
        productActive: true,
        quantity: 800,
      }),
    ]))
  })

  it('no inventa Eliminado si falta active o la fila del producto', async () => {
    const LI_ORPHAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const PRODUCT_ORPHAN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const MOVEMENT_ORPHAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const page = await listLocationInventoryMovements(client({
      locations: { id: LOCATION, organization_id: ORG },
      location_inventory: [
        { id: LI, inventory_product_id: PRODUCT, location_id: LOCATION },
        { id: LI_ORPHAN, inventory_product_id: PRODUCT_ORPHAN, location_id: LOCATION },
      ],
      inventory_products: [
        { id: PRODUCT, organization_id: ORG, name: 'Azúcar', base_unit: 'g' },
      ],
      inventory_movements: [
        {
          id: MOVEMENT,
          location_inventory_id: LI,
          movement_type: 'purchase',
          quantity: 100,
          occurred_at: '2026-10-01T12:00:00.000Z',
        },
        {
          id: MOVEMENT_ORPHAN,
          location_inventory_id: LI_ORPHAN,
          movement_type: 'purchase',
          quantity: 50,
          occurred_at: '2026-10-02T12:00:00.000Z',
        },
      ],
      inventory_adjustments: [],
    }), ORG, LOCATION)

    expect(page?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: MOVEMENT,
        productId: PRODUCT,
        productName: 'Azúcar',
        productActive: null,
      }),
      expect.objectContaining({
        id: MOVEMENT_ORPHAN,
        productId: PRODUCT_ORPHAN,
        productName: 'Insumo',
        productActive: null,
      }),
    ]))
  })

  it('usa readClient para movements y adjustments tras validar la sucursal', async () => {
    const userCalls: string[] = []
    const readCalls: string[] = []
    const user = client({
      locations: { id: LOCATION, organization_id: ORG },
      location_inventory: [{ id: LI, inventory_product_id: PRODUCT, location_id: LOCATION }],
      inventory_products: [{
        id: PRODUCT, organization_id: ORG, name: 'Harina', base_unit: 'g', active: true,
      }],
      inventory_movements: [],
      inventory_adjustments: [],
    }, userCalls)
    const reader = client({
      inventory_movements: [{
        id: MOVEMENT,
        location_inventory_id: LI,
        movement_type: 'purchase',
        quantity: 1000,
        occurred_at: '2026-10-24T12:00:00.000Z',
      }],
      inventory_adjustments: [],
    }, readCalls)
    const page = await listLocationInventoryMovements(user, ORG, LOCATION, { readClient: reader })
    expect(page?.items).toEqual([
      expect.objectContaining({
        id: MOVEMENT,
        productName: 'Harina',
        productActive: true,
        quantity: 1000,
        label: 'Compra',
      }),
    ])
    expect(userCalls).toContain('locations')
    expect(userCalls).not.toContain('inventory_movements')
    expect(readCalls).toContain('inventory_movements')
  })
})

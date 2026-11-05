import { describe, expect, it } from 'vitest'
import {
  PILOT_LOCATION_ID,
  isFudoItemCanceled,
  prepareSaleConsumptionEvents,
} from './prepareSaleConsumptionEvent.js'

const LI_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LI_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PROD_A = '11111111-1111-4111-8111-111111111111'
const PROD_B = '22222222-2222-4222-8222-222222222222'
const OTHER_LOC = 'd8d78b7d-eec5-4e90-8f2d-98268a875d00'

const inventarios = [
  { id: LI_A, inventory_product_id: PROD_A, location_id: PILOT_LOCATION_ID },
  { id: LI_B, inventory_product_id: PROD_B, location_id: PILOT_LOCATION_ID },
]

describe('prepareSaleConsumptionEvents', () => {
  it('agrupa varios ingredientes de un ítem en un solo evento (source_id=item_id)', () => {
    const r = prepareSaleConsumptionEvents(
      [
        {
          venta_id: '9001',
          item_id: '5001',
          producto_id: '183',
          producto: 'Pizza',
          cantidad_vendida: 1,
          recipe_id: 'r1',
          recipe_name: 'Pizza',
          inventory_product_id: PROD_A,
          consumo_total: -200,
        },
        {
          venta_id: '9001',
          item_id: '5001',
          producto_id: '183',
          producto: 'Pizza',
          cantidad_vendida: 1,
          recipe_id: 'r1',
          recipe_name: 'Pizza',
          inventory_product_id: PROD_B,
          consumo_total: -100,
        },
      ],
      inventarios,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.events).toHaveLength(1)
    expect(r.events[0].source_id).toBe('5001')
    expect(r.events[0].external_sale_id).toBe('9001')
    expect(r.events[0].external_item_id).toBe('5001')
    expect(r.events[0].lines).toHaveLength(2)
    expect(r.events[0].lines.every((l) => l.quantity < 0)).toBe(true)
  })

  it('dos ítems de la misma venta → dos eventos', () => {
    const r = prepareSaleConsumptionEvents(
      [
        {
          venta_id: '9001',
          item_id: '5001',
          producto_id: '10',
          cantidad_vendida: 1,
          inventory_product_id: PROD_A,
          consumo_total: -50,
        },
        {
          venta_id: '9001',
          item_id: '5002',
          producto_id: '11',
          cantidad_vendida: 2,
          inventory_product_id: PROD_B,
          consumo_total: -80,
        },
      ],
      inventarios,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.events.map((e) => e.source_id).sort()).toEqual(['5001', '5002'])
  })

  it('acumula ingredientes repetidos sin perder cantidad', () => {
    const r = prepareSaleConsumptionEvents(
      [
        {
          venta_id: '1',
          item_id: '9',
          producto_id: '1',
          cantidad_vendida: 1,
          inventory_product_id: PROD_A,
          consumo_total: -10,
        },
        {
          venta_id: '1',
          item_id: '9',
          producto_id: '1',
          cantidad_vendida: 1,
          inventory_product_id: PROD_A,
          consumo_total: -15,
        },
      ],
      inventarios,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.events[0].lines).toEqual([{ location_inventory_id: LI_A, quantity: -25 }])
  })

  it('rechaza inventario de otra sucursal', () => {
    const r = prepareSaleConsumptionEvents(
      [
        {
          venta_id: '1',
          item_id: '9',
          producto_id: '1',
          cantidad_vendida: 1,
          inventory_product_id: PROD_A,
          consumo_total: -10,
        },
      ],
      [{ id: LI_A, inventory_product_id: PROD_A, location_id: OTHER_LOC }],
    )
    expect(r).toEqual({ ok: false, error: 'INVENTORY_LOCATION_MISMATCH' })
  })

  it('rechaza cantidad no negativa', () => {
    const r = prepareSaleConsumptionEvents(
      [
        {
          venta_id: '1',
          item_id: '9',
          producto_id: '1',
          cantidad_vendida: 1,
          inventory_product_id: PROD_A,
          consumo_total: 10,
        },
      ],
      inventarios,
    )
    expect(r).toEqual({ ok: false, error: 'INVALID_CONSUMPTION_QTY' })
  })
})

describe('isFudoItemCanceled', () => {
  it('trata boolean y string sin usar notEmpty', () => {
    expect(isFudoItemCanceled(true)).toBe(true)
    expect(isFudoItemCanceled('true')).toBe(true)
    expect(isFudoItemCanceled('TRUE')).toBe(true)
    expect(isFudoItemCanceled(false)).toBe(false)
    expect(isFudoItemCanceled('false')).toBe(false)
    expect(isFudoItemCanceled('')).toBe(false)
    expect(isFudoItemCanceled(null)).toBe(false)
    expect(isFudoItemCanceled(undefined)).toBe(false)
  })
})

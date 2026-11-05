import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-update-inventory-product.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-update-inventory-product.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-update-inventory-product.md', import.meta.url),
  'utf8',
)

describe('proposed-senda-update-inventory-product.sql', () => {
  it('no se aplica sola y no escribe stock ni costos', () => {
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/create or replace function public\.senda_update_inventory_product\(p jsonb\)/)
    const start = SQL.search(/create or replace function public\.senda_update_inventory_product\(p jsonb\)/i)
    const end = SQL.indexOf('revoke all on function public.senda_update_inventory_product', start)
    const body = SQL.slice(start, end >= 0 ? end : undefined).replace(/--[^\n]*/g, '')
    expect(body).not.toMatch(/quantity_on_hand/i)
    expect(body).not.toMatch(/average_unit_cost/i)
    expect(SQL).toMatch(/grant execute on function public\.senda_update_inventory_product\(jsonb\)\s+to service_role/)
  })

  it('actualiza mínimo sin reactivar producto ni location_inventory', () => {
    expect(SQL).toMatch(/coalesce\(v_row\.active, false\)/)
    expect(SQL).toMatch(/do update\s+set minimum_stock = coalesce\(v_minimum, 0\)/)
    expect(DOC).toMatch(/No reactiva/)
    expect(VERIFY).toMatch(/min_stock_does_not_force_active/)
  })
})

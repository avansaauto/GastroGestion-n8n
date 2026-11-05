import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-set-inventory-product-active.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-set-inventory-product-active.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-set-inventory-product-active.md', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

describe('proposed-senda-set-inventory-product-active.sql', () => {
  it('no se aplica sola y no borra stock ni facturas', () => {
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/INVENTORY_PRODUCT_ACTIVE_RPC_EXISTS/)
    expect(SQL).toMatch(/create function public\.senda_set_inventory_product_active\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_set_inventory_product_active/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_receive_purchase_document_line/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_cancel_purchase_invoice/)
    const start = SQL.search(/create function public\.senda_set_inventory_product_active\(p jsonb\)/i)
    const end = SQL.indexOf('comment on function public.senda_set_inventory_product_active', start)
    const body = withoutComments(SQL.slice(start, end >= 0 ? end : undefined))
    expect(body).not.toMatch(/delete from public\.inventory_products/i)
    expect(body).not.toMatch(/set quantity_on_hand/i)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
  })

  it('desactiva con membresía, recetas activas y execute service_role', () => {
    expect(SQL).toMatch(/security definer/)
    expect(SQL).toMatch(/senda_require_backend_actor/)
    expect(SQL).toMatch(/role in \('admin', 'operator'\)/)
    expect(SQL).toMatch(/PRODUCT_IN_USE/)
    expect(SQL).toMatch(/expected_active/)
    expect(SQL).toMatch(/grant execute on function public\.senda_set_inventory_product_active\(jsonb\)\s+to service_role/)
    expect(SQL).toMatch(/revoke all on function public\.senda_set_inventory_product_active\(jsonb\)\s+from public, anon, authenticated/)
    expect(DOC).toMatch(/No es vaciar existencias/)
    expect(DOC).toMatch(/PRODUCT_INACTIVE/)
    expect(DOC).toMatch(/proposed-senda-receive-require-active-product/)
    expect(SQL).toMatch(/proposed-senda-receive-require-active-product/)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/blocks_product_in_use/)
    expect(VERIFY).toMatch(/receive_blocks_inactive_product/)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-receive-require-active-product.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-receive-require-active-product.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-receive-require-active-product.md', import.meta.url),
  'utf8',
)
const MIGRATE = readFileSync(
  new URL('../../sql/migrate-inventory-reception.sql', import.meta.url),
  'utf8',
)

describe('proposed-senda-receive-require-active-product.sql', () => {
  it('es un parche independiente y no reinstala la migración completa', () => {
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/RECEIVE_ACTIVE_ABORT/)
    expect(SQL).toMatch(/PRODUCT_INACTIVE/)
    expect(SQL).toMatch(/pg_get_functiondef/)
    expect(SQL).toMatch(/RECEIVE_ACTIVE_SKIP/)
    // Solo menciones en guardias/comentarios; no DDL ejecutable de receipts.
    expect(SQL).not.toMatch(/^\s*create table public\.purchase_document_receipts/im)
    expect(SQL).not.toMatch(/^\s*create or replace function public\.senda_set_inventory_purchase_cost/im)
    expect(SQL).toMatch(/No reejecutar migrate-inventory-reception/)
    expect(DOC).toMatch(/No reejecuta/)
    expect(DOC).toMatch(/migrate-inventory-reception/)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/blocks_product_inactive/)
    expect(VERIFY).toMatch(/no_full_migrate_reinstall/)
  })

  it('no modifica migrate-inventory-reception para instalar el guard', () => {
    expect(MIGRATE).not.toMatch(/raise exception 'PRODUCT_INACTIVE'/)
    expect(SQL).toMatch(/senda_receive_purchase_document_line/)
  })
})

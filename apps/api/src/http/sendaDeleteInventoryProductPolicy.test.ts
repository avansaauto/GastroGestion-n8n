import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-delete-inventory-product.sql', import.meta.url),
  'utf8',
)
const HOTFIX = readFileSync(
  new URL('../../sql/proposed-senda-delete-inventory-product-hotfix.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-delete-inventory-product.sql', import.meta.url),
  'utf8',
)
const VERIFY_HOTFIX = readFileSync(
  new URL('../../sql/verify-senda-delete-inventory-product-hotfix.sql', import.meta.url),
  'utf8',
)

describe('senda_delete_inventory_product', () => {
  it('no referencia purchase_product_memory (evita 42P01)', () => {
    function functionBody(sql: string) {
      const start = sql.search(/create or replace function public\.senda_delete_inventory_product/i)
      const end = sql.search(/revoke all on function public\.senda_delete_inventory_product/i)
      return sql.slice(start, end >= 0 ? end : undefined).replace(/--[^\n]*/g, '')
    }
    expect(functionBody(SQL)).not.toMatch(/purchase_product_memory/)
    expect(functionBody(HOTFIX)).not.toMatch(/purchase_product_memory/)
    expect(HOTFIX).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(HOTFIX).toMatch(/create or replace function public\.senda_delete_inventory_product/)
    expect(HOTFIX).toMatch(/PRODUCT_HAS_HISTORY/)
    expect(HOTFIX).toMatch(/execute/)
    expect(VERIFY).toMatch(/no_purchase_product_memory_ref/)
    expect(VERIFY_HOTFIX).toMatch(/no_purchase_product_memory_ref/)
    expect(VERIFY_HOTFIX).toMatch(/SOLO LECTURA/)
  })

  it('conserva comprobaciones de historial reales', () => {
    for (const body of [SQL, HOTFIX]) {
      expect(body).toMatch(/purchase_document_receipts/)
      expect(body).toMatch(/purchase_document_lines/)
      expect(body).toMatch(/recipe_components/)
      expect(body).toMatch(/inventory_movements/)
      expect(body).toMatch(/inventory_cost_history/)
      expect(body).toMatch(/inventory_adjustments/)
      expect(body).not.toMatch(/exception when foreign_key_violation/i)
    }
  })
})

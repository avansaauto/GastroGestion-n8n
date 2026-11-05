import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/inspect-recipes-save-guards.sql', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

describe('inspect-recipes-save-guards.sql', () => {
  it('es inspección de solo lectura y no se ejecuta sola', () => {
    expect(SQL).toMatch(/Paso 415/)
    expect(SQL).toMatch(/SOLO LECTURA/)
    expect(SQL).toMatch(/NO EJECUTAR/)
    const body = withoutComments(SQL)
    expect(body).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop|truncate|call)\b/im)
    expect(body).not.toMatch(/\b(insert into|update\s+\w+\s+set|delete from|truncate table)\b/i)
  })

  it('no lee filas de negocio ni llama RPC de recetas o ventas', () => {
    const body = withoutComments(SQL)
    expect(body).not.toMatch(
      /\bfrom\s+(only\s+)?(public\.)?(recipes|recipe_components|pending_product_mappings|sales_product_mappings)\b/i,
    )
    expect(body).not.toMatch(/\bresolve_pending_product_mappings\s*\(/)
    expect(body).not.toMatch(/\bregister_sale_consumption\s*\(/)
    expect(body).not.toMatch(/\bsenda_save_fudo_recipe\s*\(/)
  })

  it('confirma las guardias de UNIQUE, CHECK, FK y membresía', () => {
    expect(SQL).toMatch(/recipes_unique_org_name/)
    expect(SQL).toMatch(/sales_unique_fudo_terna/)
    expect(SQL).toMatch(/pending_unique_fudo_terna/)
    expect(SQL).toMatch(/components_check_quantity_positive/)
    expect(SQL).toMatch(/recipes_check_yield_quantity/)
    expect(SQL).toMatch(/recipes_check_yield_unit/)
    expect(SQL).toMatch(/components_check_xor/)
    expect(SQL).toMatch(/confdeltype/)
    expect(SQL).toMatch(/senda_actor_is_purchase_member/)
    expect(SQL).toMatch(/senda_actor_is_org_inventory_manager/)
    expect(SQL).toMatch(/senda_require_backend_actor/)
    expect(SQL).toMatch(/senda_is_org_active_member/)
    expect(SQL).toMatch(/pending_product_mappings/)
    expect(SQL).toMatch(/pg_get_triggerdef/)
  })
})

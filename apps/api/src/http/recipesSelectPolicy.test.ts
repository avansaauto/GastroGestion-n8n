import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-recipes-select-policy.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-recipes-select-policy.sql', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

describe('proposed-recipes-select-policy.sql', () => {
  it('es SELECT autenticado por membresía de org, sin escritura', () => {
    expect(SQL).toMatch(/Paso 406/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/create policy recipes_member_select/)
    expect(SQL).toMatch(/create policy recipe_components_member_select/)
    expect(SQL).toMatch(/create policy sales_product_mappings_member_select/)
    expect(SQL).toMatch(/for select/)
    expect(SQL).toMatch(/to authenticated/)
    expect(SQL).toMatch(/senda_is_org_active_member\(organization_id\)/)
    expect(SQL).toMatch(/senda_is_org_active_member\(r\.organization_id\)/)
    expect(SQL).toMatch(/senda_is_org_active_member\(l\.organization_id\)/)
    expect(SQL).toMatch(/RECIPES_SELECT_POLICY_EXISTS/)
    expect(SQL).toMatch(/enable row level security/)
    expect(withoutComments(SQL)).not.toMatch(/disable row level security/i)
    expect(SQL).not.toMatch(/for insert/i)
    expect(SQL).not.toMatch(/for update/i)
    expect(SQL).not.toMatch(/for delete/i)
    expect(SQL).not.toMatch(/create policy \w+[\s\S]{0,80}\bfor all\b/i)
  })

  it('no usa permisos de compras ni de alta de insumos', () => {
    const body = withoutComments(SQL)
    expect(body).not.toMatch(/senda_is_purchase_member\s*\(/)
    expect(body).not.toMatch(/senda_is_org_inventory_manager\s*\(/)
    expect(body).not.toMatch(/create or replace function public\.senda_is_org_active_member/)
    expect(body).not.toMatch(/create or replace function public\.senda_is_purchase_member/)
  })

  it('otorga solo SELECT a authenticated y no toca service_role', () => {
    expect(SQL).toMatch(/revoke all on table public\.recipes from authenticated/)
    expect(SQL).toMatch(/revoke all on table public\.recipe_components from authenticated/)
    expect(SQL).toMatch(/revoke all on table public\.sales_product_mappings from authenticated/)
    expect(SQL).toMatch(/grant select on table public\.recipes to authenticated/)
    expect(SQL).toMatch(/grant select on table public\.recipe_components to authenticated/)
    expect(SQL).toMatch(/grant select on table public\.sales_product_mappings to authenticated/)
    expect(SQL).toMatch(/revoke all on table public\.recipes from public, anon/)
    expect(SQL).toMatch(/TRUNCATE\/REFERENCES\/TRIGGER\/MAINTAIN/)
    expect(SQL).toMatch(/RECIPES_SERVICE_ROLE_GRANTS_CHANGED/)
    expect(SQL).toMatch(/RECIPES_AUTH_EXTRA_PRIVILEGE/)
    expect(withoutComments(SQL)).not.toMatch(/grant execute on function/i)
    expect(SQL).not.toMatch(/grant insert on table public\.recipes/i)
    expect(SQL).not.toMatch(/grant select on table public\.recipes to anon/i)
    expect(withoutComments(SQL)).not.toMatch(/\brevoke\b[\s\S]{0,80}service_role/i)
    expect(withoutComments(SQL)).not.toMatch(/\bgrant\b[\s\S]{0,80}service_role/i)
  })

  it('no toca pendientes, inventario ni RPC de ventas', () => {
    const body = withoutComments(SQL)
    expect(body).not.toMatch(/pending_product_mappings/)
    expect(body).not.toMatch(/inventory_movements/)
    expect(body).not.toMatch(/register_sale_consumption/)
    expect(body).not.toMatch(/resolve_pending_product_mappings/)
    expect(body).not.toMatch(/drop policy/i)
  })
})

describe('verify-recipes-select-policy.sql', () => {
  it('es inspección de solo lectura', () => {
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/Paso 406/)
    const body = withoutComments(VERIFY)
    expect(body).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop|truncate|call)\b/im)
    expect(VERIFY).toMatch(/pg_policies/)
    expect(VERIFY).toMatch(/no_write_policies/)
    expect(VERIFY).toMatch(/anon_no_select/)
    expect(VERIFY).toMatch(/auth_only_select/)
    expect(VERIFY).toMatch(/service_role_kept/)
    expect(VERIFY).toMatch(/TRUNCATE/)
    expect(VERIFY).toMatch(/Plan de aislamiento/)
    expect(VERIFY).toMatch(/string_agg\(distinct a\.privilege_type, ',' order by a\.privilege_type\)/)
    expect(VERIFY).not.toMatch(/string_agg\(distinct [^)]*order by 1\)/)
  })
})

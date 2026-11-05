import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-save-fudo-recipe.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe.md', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

describe('proposed-senda-save-fudo-recipe.sql', () => {
  it('no se ejecuta sola y aborta si el RPC ya existe', () => {
    expect(SQL).toMatch(/Paso 418/)
    expect(SQL).toMatch(/Paso 420/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/RECIPE_SAVE_RPC_EXISTS/)
    expect(SQL).toMatch(/create function public\.senda_save_fudo_recipe\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_save_fudo_recipe/)
  })

  it('copia el patrón DEFINER de compras sin tocar membresía ni ventas', () => {
    expect(SQL).toMatch(/security definer/)
    expect(SQL).toMatch(/set search_path = pg_catalog, public/)
    expect(SQL).toMatch(/v_actor := public\.senda_require_backend_actor\(\(p->>'actor_user_id'\)::uuid\)/)
    expect(SQL).toMatch(/senda_actor_is_purchase_member\(v_location, v_actor\)/)
    expect(SQL).toMatch(/grant execute on function public\.senda_save_fudo_recipe\(jsonb\)\s+to service_role/)
    expect(SQL).toMatch(/revoke all on function public\.senda_save_fudo_recipe\(jsonb\)\s+from public, anon, authenticated/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_save_fudo_recipe\(jsonb\) to authenticated/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_actor_is_purchase_member/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_require_backend_actor/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_actor_is_purchase_member/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_require_backend_actor/)
    expect(SQL).not.toMatch(/revoke all on function public\.senda_actor_is_purchase_member/)
    expect(SQL).not.toMatch(/revoke all on function public\.senda_require_backend_actor/)
    const body = withoutComments(SQL)
    expect(body).not.toMatch(/register_sale_consumption\s*\(/)
    expect(body).not.toMatch(/resolve_pending_product_mappings\s*\(/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
  })

  it('bloquea el pendiente antes de insertar y no pisa un mapping ajeno', () => {
    const fn = SQL.slice(SQL.indexOf('create function public.senda_save_fudo_recipe'))
    expect(fn).toMatch(/from public\.pending_product_mappings[\s\S]*for update/)
    expect(fn).toMatch(/from public\.sales_product_mappings[\s\S]*for update/)
    expect(fn.indexOf('for update')).toBeLessThan(fn.indexOf('insert into public.recipes'))
    expect(fn).toMatch(/raise exception 'ALREADY_LINKED'/)
    expect(fn).toMatch(/raise exception 'DUPLICATE_RECIPE_NAME'/)
    expect(fn).toMatch(/raise exception 'PENDING_NOT_FOUND'/)
    expect(fn).toMatch(/raise exception 'RECIPE_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'INGREDIENT_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'INVALID_QUANTITY'/)
    expect(fn).toMatch(/raise exception 'LINK_DOES_NOT_EDIT_BOM'/)
    expect(fn).toMatch(/raise exception 'CONCURRENT_UPDATE'/)
    expect(fn).toMatch(/recipe_type[\s\S]*'sale_product'/)
    expect(fn).toMatch(/status = 'resolved'/)
    expect(fn).not.toMatch(/status = 'pending'/)
  })

  it('CREATE y LINK rechazan mapping inactivo sin reactivar', () => {
    const fn = SQL.slice(SQL.indexOf('create function public.senda_save_fudo_recipe'))
    const inactiveAt = fn.indexOf("raise exception 'MAPPING_INACTIVE'")
    const mappingLockAt = fn.indexOf('from public.sales_product_mappings')
    const insertMappingAt = fn.indexOf('insert into public.sales_product_mappings')
    const insertRecipeAt = fn.indexOf('insert into public.recipes')
    const resolveAt = fn.indexOf("status = 'resolved'")
    expect(inactiveAt).toBeGreaterThan(-1)
    expect(fn).toMatch(/v_mapping\.active is distinct from true/)
    expect(inactiveAt).toBeGreaterThan(mappingLockAt)
    expect(inactiveAt).toBeLessThan(insertMappingAt)
    expect(inactiveAt).toBeLessThan(insertRecipeAt)
    expect(inactiveAt).toBeLessThan(resolveAt)
    expect(fn).not.toMatch(/update\s+public\.sales_product_mappings[\s\S]{0,120}set\s+active\s*=\s*true/i)
    expect(withoutComments(fn)).not.toMatch(/\bset\s+active\s*=\s*true\b/i)
    expect(DOC).toMatch(/MAPPING_INACTIVE/)
    expect(DOC).toMatch(/No reactivar/)
  })

  it('distingue replay CREATE por huella y LINK por recipe_id', () => {
    expect(SQL).toMatch(/v_replay boolean := false/)
    expect(SQL).toMatch(/v_recipe\.name = v_name/)
    expect(SQL).toMatch(/v_recipe\.yield_quantity is not distinct from v_yield/)
    expect(SQL).toMatch(/c\.quantity is distinct from \(e->>'quantity'\)::numeric/)
    expect(SQL).toMatch(/c\.inventory_product_id = \(e->>'inventory_product_id'\)::uuid/)
    expect(SQL).toMatch(/v_mapping\.recipe_id is distinct from v_existing/)
    expect(SQL).toMatch(/'replay', v_replay/)
    expect(DOC).toMatch(/la terna sola no identifica un reintento/)
    expect(DOC).toMatch(/ALREADY_LINKED/)
  })

  it('exige UNIQUE confirmados y no apila políticas de tabla', () => {
    expect(SQL).toMatch(/falta UNIQUE \(organization_id, name\) en recipes/)
    expect(SQL).toMatch(/falta UNIQUE \(location_id, source, external_product_id\) en sales_product_mappings/)
    expect(SQL).toMatch(/falta UNIQUE \(location_id, source, external_product_id\) en pending_product_mappings/)
    expect(SQL).not.toMatch(/create policy/)
    expect(SQL).not.toMatch(/grant insert on table public\.recipes/i)
    expect(SQL).not.toMatch(/grant update on table public\.pending_product_mappings/i)
  })
})

describe('verify-senda-save-fudo-recipe.sql', () => {
  it('es solo lectura y controla EXECUTE', () => {
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/has_function_privilege/)
    expect(VERIFY).toMatch(/execute_service_only/)
    expect(VERIFY).toMatch(/actor_still_closed/)
    const body = withoutComments(VERIFY)
    expect(body).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop)\b/im)
    expect(body).not.toMatch(/\b(select|perform|call)\s+public\.senda_save_fudo_recipe\s*\(/i)
  })
})

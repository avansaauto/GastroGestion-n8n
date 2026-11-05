import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-create-recipe.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-create-recipe.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-create-recipe.md', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

describe('proposed-senda-create-recipe.sql', () => {
  it('no se ejecuta sola y aborta si el RPC ya existe', () => {
    expect(SQL).toMatch(/Pasos 428 y 429/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/RECIPE_CREATE_RPC_EXISTS/)
    expect(SQL).toMatch(/create function public\.senda_create_recipe\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_create_recipe/)
  })

  it('copia el patrón DEFINER de compras sin tocar membresía auxiliar ni ventas', () => {
    expect(SQL).toMatch(/security definer/)
    expect(SQL).toMatch(/set search_path = pg_catalog, public/)
    expect(SQL).toMatch(/v_actor := public\.senda_require_backend_actor\(\(p->>'actor_user_id'\)::uuid\)/)
    expect(SQL).toMatch(/from public\.organization_members m/)
    expect(SQL).toMatch(/m\.role in \('admin', 'operator'\)/)
    expect(SQL).toMatch(/grant execute on function public\.senda_create_recipe\(jsonb\)\s+to service_role/)
    expect(SQL).toMatch(/revoke all on function public\.senda_create_recipe\(jsonb\)\s+from public, anon, authenticated/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_create_recipe\(jsonb\) to authenticated/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_require_backend_actor/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_actor_is_purchase_member/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_is_org_active_member/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_require_backend_actor/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_actor_is_purchase_member/)
    expect(SQL).not.toMatch(/revoke all on function public\.senda_require_backend_actor/)
    expect(SQL).not.toMatch(/revoke all on function public\.senda_actor_is_purchase_member/)
    const body = withoutComments(SQL)
    expect(body).not.toMatch(/register_sale_consumption\s*\(/)
    expect(body).not.toMatch(/resolve_pending_product_mappings\s*\(/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
    expect(body).not.toMatch(/insert into public\.sales_product_mappings/i)
    expect(body).not.toMatch(/insert into public\.pending_product_mappings/i)
    expect(body).not.toMatch(/update\s+public\.pending_product_mappings/i)
    expect(body).not.toMatch(/insert into public\.location_inventory/i)
  })

  it('crea sale_product con BOM opcional y nombre único, sin Fudo', () => {
    const fn = SQL.slice(
      SQL.indexOf('create function public.senda_create_recipe'),
      SQL.indexOf('comment on function public.senda_create_recipe'),
    )
    expect(fn).toMatch(/recipe_type[\s\S]*'sale_product'/)
    expect(fn).toMatch(/raise exception 'DUPLICATE_RECIPE_NAME'/)
    expect(fn).toMatch(/raise exception 'INGREDIENT_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'INVALID_QUANTITY'/)
    expect(fn).toMatch(/raise exception 'NOT_A_MEMBER'/)
    expect(fn).toMatch(/raise exception 'ORGANIZATION_NOT_FOUND'/)
    expect(fn).toMatch(/raise exception 'CONCURRENT_UPDATE'/)
    expect(fn).toMatch(/insert into public\.recipes/)
    expect(fn).toMatch(/insert into public\.recipe_components/)
    expect(fn).toMatch(/jsonb_array_elements\(v_components\)/)
    expect(fn).not.toMatch(/pending_product_mappings/)
    expect(fn).not.toMatch(/sales_product_mappings/)
    expect(fn).not.toMatch(/status = 'resolved'/)
    expect(DOC).toMatch(/todavía no existen en\s+Supabase/)
    expect(DOC).toMatch(/CREATE_RECIPE_RPC_MISSING/)
    expect(DOC).toMatch(/No hay `replay`/)
  })

  it('guarda categoría y receta en la misma transacción, sin categorías predefinidas', () => {
    const fn = SQL.slice(
      SQL.indexOf('create function public.senda_create_recipe'),
      SQL.indexOf('comment on function public.senda_create_recipe'),
    )
    expect(SQL).toMatch(/create table public\.recipe_categories/)
    expect(SQL).toMatch(/lower\(btrim\(name\)\)/)
    expect(SQL).toMatch(/recipes_category_organization_fk/)
    expect(SQL).toMatch(/create policy recipe_categories_member_select/)
    expect(SQL).toMatch(/grant select on table public\.recipe_categories to authenticated/)
    expect(SQL).not.toMatch(/grant insert on table public\.recipe_categories/i)
    expect(fn).toMatch(/insert into public\.recipe_categories/)
    expect(fn.indexOf('insert into public.recipe_categories')).toBeLessThan(
      fn.indexOf('insert into public.recipes'),
    )
    expect(fn).toMatch(/raise exception 'CATEGORY_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'DUPLICATE_RECIPE_NAME'/)
    expect(fn).not.toMatch(/autonomous transaction/i)
    expect(SQL).not.toMatch(/values\s*\([^)]*'Entradas'/i)
    expect(SQL).not.toMatch(/'Platos principales'/)
    expect(DOC).toMatch(/no queda categoría huérfana/)
  })

  it('exige UNIQUE de nombre y no apila políticas de escritura', () => {
    expect(SQL).toMatch(/falta UNIQUE \(organization_id, name\) en recipes/)
    expect(SQL).not.toMatch(/create policy recipes_/)
    expect(SQL).not.toMatch(/grant insert on table public\.recipes/i)
    expect(SQL).not.toMatch(/grant insert on table public\.recipe_components/i)
  })
})

describe('verify-senda-create-recipe.sql', () => {
  it('es solo lectura y controla EXECUTE', () => {
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/has_function_privilege/)
    expect(VERIFY).toMatch(/execute_service_only/)
    expect(VERIFY).toMatch(/actor_still_closed/)
    expect(VERIFY).toMatch(/no_fudo_or_stock_in_body/)
    expect(VERIFY).toMatch(/categories_table/)
    expect(VERIFY).toMatch(/creates_category_in_rpc/)
    expect(VERIFY).toMatch(/categories_unique_ci/)
    expect(VERIFY).toMatch(/recipes_category_org_fk/)
    expect(VERIFY).toMatch(/categories_grants/)
    expect(VERIFY).toMatch(/RECIPE_CREATE_VERIFY_FAILED/)
    const body = withoutComments(VERIFY)
    expect(body).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop)\b/im)
    expect(body).not.toMatch(/\b(select|perform|call)\s+public\.senda_create_recipe\s*\(/i)
  })
})

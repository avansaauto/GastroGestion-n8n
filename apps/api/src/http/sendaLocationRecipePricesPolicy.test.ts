import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-location-recipe-prices.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-location-recipe-prices.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-location-recipe-prices.md', import.meta.url),
  'utf8',
)
const CREATE = readFileSync(
  new URL('../../sql/proposed-senda-create-recipe.sql', import.meta.url),
  'utf8',
)
const UPDATE = readFileSync(
  new URL('../../sql/proposed-senda-update-recipe.sql', import.meta.url),
  'utf8',
)
const STATUS = readFileSync(
  new URL('../../sql/proposed-senda-set-recipe-active.sql', import.meta.url),
  'utf8',
)
const FUDO = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe-link-active.sql', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

function fnBody(sql: string) {
  const start = sql.search(/create function public\.senda_set_location_recipe_price\(p jsonb\)/i)
  if (start < 0) return sql
  const end = sql.indexOf('comment on function public.senda_set_location_recipe_price', start)
  return end >= 0 ? sql.slice(start, end) : sql.slice(start)
}

describe('proposed-senda-location-recipe-prices.sql', () => {
  it('no se aplica sola y no REPLACE CREATE, UPDATE, STATUS ni Fudo', () => {
    expect(SQL).toMatch(/Paso 442/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/RECIPE_PRICE_TABLE_EXISTS/)
    expect(SQL).toMatch(/RECIPE_PRICE_RPC_EXISTS/)
    expect(SQL).toMatch(/create table public\.location_recipe_prices/)
    expect(SQL).toMatch(/create function public\.senda_set_location_recipe_price\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_set_location_recipe_price/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_create_recipe/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_update_recipe/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_set_recipe_active/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_save_fudo_recipe/)
    expect(CREATE).toMatch(/create function public\.senda_create_recipe\(p jsonb\)/)
    expect(UPDATE).toMatch(/create function public\.senda_update_recipe\(p jsonb\)/)
    expect(STATUS).toMatch(/create function public\.senda_set_recipe_active\(p jsonb\)/)
    expect(FUDO).toMatch(/create or replace function public\.senda_save_fudo_recipe\(p jsonb\)/)
  })

  it('guarda precio por local × receta, con org y sale_price > 0', () => {
    expect(SQL).toMatch(/organization_id uuid not null/)
    expect(SQL).toMatch(/unique \(location_id, recipe_id\)/)
    expect(SQL).toMatch(/sale_price numeric\(12, 2\) not null/)
    expect(SQL).toMatch(/check \(sale_price > 0\)/)
    expect(SQL).toMatch(/location_recipe_prices_location_org_fk/)
    expect(SQL).toMatch(/location_recipe_prices_recipe_org_fk/)
    expect(SQL).toMatch(/references public\.locations \(id, organization_id\)/)
    expect(SQL).toMatch(/references public\.recipes \(id, organization_id\)/)
    expect(SQL).toMatch(/alter table public\.location_recipe_prices enable row level security/)
    expect(SQL).toMatch(/grant select on table public\.location_recipe_prices to authenticated/)
    expect(SQL).toMatch(/grant select, insert, update on table public\.location_recipe_prices to service_role/)
    expect(SQL).toMatch(/revoke delete, truncate on table public\.location_recipe_prices from service_role/)
    expect(SQL).not.toMatch(/grant insert on table public\.location_recipe_prices to authenticated/)
    expect(SQL).not.toMatch(/add column[\s\S]*sale_price/)
    const recipesAlter = SQL.match(/alter table public\.recipes[\s\S]{0,120}/gi) ?? []
    expect(recipesAlter.join('\n')).not.toMatch(/sale_price|precio/)
  })

  it('escribe solo la tabla de precios, con membresía y concurrencia', () => {
    const fn = fnBody(SQL)
    expect(fn).toMatch(/security definer/)
    expect(fn).toMatch(/set search_path = pg_catalog, public/)
    expect(fn).toMatch(/v_actor := public\.senda_require_backend_actor\(\(p->>'actor_user_id'\)::uuid\)/)
    expect(fn).toMatch(/m\.role in \('admin', 'operator'\)/)
    expect(fn).toMatch(/raise exception 'LOCATION_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'RECIPE_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'RECIPE_INACTIVE'/)
    expect(fn).toMatch(/raise exception 'RECIPE_NOT_SALE_PRODUCT'/)
    expect(fn).toMatch(/raise exception 'INVALID_SALE_PRICE'/)
    expect(fn).toMatch(/raise exception 'CONCURRENT_UPDATE'/)
    expect(fn).toMatch(/raise exception 'EXPECTED_REQUIRED'/)
    expect(fn).toMatch(/expected_version/)
    expect(fn).toMatch(/for share/)
    expect(fn).toMatch(/for update/)
    expect(fn).toMatch(/insert into public\.location_recipe_prices/)
    expect(fn).toMatch(/update public\.location_recipe_prices/)
    expect(SQL).toMatch(
      /grant execute on function public\.senda_set_location_recipe_price\(jsonb\)\s+to service_role/,
    )
    expect(SQL).toMatch(
      /revoke all on function public\.senda_set_location_recipe_price\(jsonb\)\s+from public, anon, authenticated/,
    )
    const body = withoutComments(fn)
    expect(body).not.toMatch(/update\s+public\.recipes/i)
    expect(body).not.toMatch(/delete from public\.location_recipe_prices/i)
    expect(body).not.toMatch(/register_sale_consumption\s*\(/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
    expect(body).not.toMatch(/insert into public\.sales_product_mappings/i)
    expect(body).not.toMatch(/update\s+public\.sales_product_mappings/i)
    expect(body).not.toMatch(/delete from public\.sales_product_mappings/i)
    expect(body).not.toMatch(/pending_product_mappings/)
    expect(body).not.toMatch(/inventory_valuations/)
  })

  it('bloquea location → recipe → price y no choca con STATUS ni LINK', () => {
    const fn = fnBody(SQL)
    const locAt = fn.search(/from public\.locations l[\s\S]{0,80}for share/i)
    const recipeAt = fn.search(/from public\.recipes r[\s\S]{0,120}for update/i)
    const priceAt = fn.search(/from public\.location_recipe_prices[\s\S]{0,120}for update/i)
    expect(locAt).toBeGreaterThan(0)
    expect(recipeAt).toBeGreaterThan(locAt)
    expect(priceAt).toBeGreaterThan(recipeAt)
    expect(fn).not.toMatch(/sales_product_mappings[\s\S]{0,80}for update/i)
    expect(STATUS).not.toMatch(/location_recipe_prices/)
    expect(STATUS).not.toMatch(/sales_product_mappings[\s\S]{0,80}for update/i)
    expect(FUDO).not.toMatch(/location_recipe_prices/)
  })

  it('rechaza round a cero, overflow de numeric(12,2) y UPDATE sin NOT FOUND', () => {
    const fn = fnBody(SQL)
    expect(fn).toMatch(/v_raw := round\(\(p->>'sale_price'\)::numeric, 2\)/)
    expect(fn).toMatch(/v_raw > 9999999999\.99/)
    expect(fn).toMatch(/v_raw <= 0/)
    expect(fn).toMatch(/if not found then/)
    expect(fn).toMatch(/unique_violation/)
    expect(fn).toMatch(/v_expected_raw <> trunc\(v_expected_raw\)/)
    expect(fn).not.toMatch(/v_desired := round\(/)
    expect(DOC).toMatch(/0\.004/)
    expect(DOC).toMatch(/9999999999\.99/)
    expect(VERIFY).toMatch(/sale_price_bounds/)
  })

  it('documenta pendiente, verify de solo lectura y semántica sin cero', () => {
    expect(DOC).toMatch(/RECIPE_PRICE_RPC_PENDING/)
    expect(DOC).toMatch(/No hay fila/)
    expect(DOC).toMatch(/`0` no es un precio válido/)
    expect(DOC).toMatch(/organization_id/)
    expect(DOC).toMatch(/expected_version/)
    expect(DOC).toMatch(/RECIPE_INACTIVE/)
    expect(DOC).toMatch(/No se agrega columna de precio a `recipes`/)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/keeps_inactive_price/)
    expect(VERIFY).toMatch(/No modifica tablas/)
    expect(VERIFY).toMatch(/unique_location_recipe/)
    const body = withoutComments(VERIFY)
    expect(body).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop)\b/im)
  })
})

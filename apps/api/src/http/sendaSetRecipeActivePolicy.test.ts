import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-set-recipe-active.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-set-recipe-active.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-set-recipe-active.md', import.meta.url),
  'utf8',
)
const UPDATE = readFileSync(
  new URL('../../sql/proposed-senda-update-recipe.sql', import.meta.url),
  'utf8',
)
const FUDO = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe-category.sql', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

function fnBody(sql: string) {
  const start = sql.search(/create function public\.senda_set_recipe_active\(p jsonb\)/i)
  if (start < 0) return sql
  const end = sql.indexOf('comment on function public.senda_set_recipe_active', start)
  return end >= 0 ? sql.slice(start, end) : sql.slice(start)
}

describe('proposed-senda-set-recipe-active.sql', () => {
  it('no se aplica sola y no REPLACE CREATE, UPDATE ni Fudo', () => {
    expect(SQL).toMatch(/Paso 437/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/RECIPE_STATUS_RPC_EXISTS/)
    expect(SQL).toMatch(/create function public\.senda_set_recipe_active\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_set_recipe_active/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_create_recipe/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_update_recipe/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_save_fudo_recipe/)
    expect(UPDATE).toMatch(/create function public\.senda_update_recipe\(p jsonb\)/)
    expect(FUDO).toMatch(/create or replace function public\.senda_save_fudo_recipe\(p jsonb\)/)
  })

  it('cambia solo recipes.active, con membresía y sin stock ni mappings', () => {
    const fn = fnBody(SQL)
    expect(fn).toMatch(/security definer/)
    expect(fn).toMatch(/set search_path = pg_catalog, public/)
    expect(fn).toMatch(/v_actor := public\.senda_require_backend_actor\(\(p->>'actor_user_id'\)::uuid\)/)
    expect(fn).toMatch(/m\.role in \('admin', 'operator'\)/)
    expect(fn).toMatch(/raise exception 'RECIPE_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'RECIPE_IN_USE'/)
    expect(fn).toMatch(/raise exception 'CONCURRENT_UPDATE'/)
    expect(fn).toMatch(/raise exception 'EXPECTED_REQUIRED'/)
    expect(fn).toMatch(/for update/)
    expect(fn).toMatch(/set active = v_desired/)
    expect(SQL).toMatch(/grant execute on function public\.senda_set_recipe_active\(jsonb\)\s+to service_role/)
    expect(SQL).toMatch(/revoke all on function public\.senda_set_recipe_active\(jsonb\)\s+from public, anon, authenticated/)
    const body = withoutComments(fn)
    expect(body).not.toMatch(/register_sale_consumption\s*\(/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
    expect(body).not.toMatch(/delete from public\.recipe_components/i)
    expect(body).not.toMatch(/insert into public\.sales_product_mappings/i)
    expect(body).not.toMatch(/update\s+public\.sales_product_mappings/i)
    expect(body).not.toMatch(/delete from public\.sales_product_mappings/i)
    expect(body).not.toMatch(/pending_product_mappings/)
  })

  it('documenta el 503 pendiente y verify de solo lectura', () => {
    expect(DOC).toMatch(/RECIPE_STATUS_RPC_PENDING/)
    expect(DOC).toMatch(/mappings Fudo/)
    expect(DOC).toMatch(/RECIPE_IN_USE/)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/keeps_bom_and_fudo/)
    expect(VERIFY).toMatch(/No modifica tablas/)
    const body = withoutComments(VERIFY)
    expect(body).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop)\b/im)
  })
})

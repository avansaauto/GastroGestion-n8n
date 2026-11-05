import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-update-recipe.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-update-recipe.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-update-recipe.md', import.meta.url),
  'utf8',
)
const CREATE = readFileSync(
  new URL('../../sql/proposed-senda-create-recipe.sql', import.meta.url),
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
  const start = sql.search(/create function public\.senda_update_recipe\(p jsonb\)/i)
  if (start < 0) return sql
  const end = sql.indexOf('comment on function public.senda_update_recipe', start)
  return end >= 0 ? sql.slice(start, end) : sql.slice(start)
}

describe('proposed-senda-update-recipe.sql', () => {
  it('no se aplica sola y no REPLACE los RPC de CREATE o Fudo', () => {
    expect(SQL).toMatch(/Paso 435/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/RECIPE_UPDATE_RPC_EXISTS/)
    expect(SQL).toMatch(/create function public\.senda_update_recipe\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_update_recipe/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_create_recipe/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_save_fudo_recipe/)
    expect(CREATE).toMatch(/create function public\.senda_create_recipe\(p jsonb\)/)
    expect(FUDO).toMatch(/create or replace function public\.senda_save_fudo_recipe\(p jsonb\)/)
  })

  it('conserva permisos, membresía y no escribe stock ni mappings Fudo', () => {
    const fn = fnBody(SQL)
    expect(fn).toMatch(/security definer/)
    expect(fn).toMatch(/set search_path = pg_catalog, public/)
    expect(fn).toMatch(/v_actor := public\.senda_require_backend_actor\(\(p->>'actor_user_id'\)::uuid\)/)
    expect(fn).toMatch(/m\.role in \('admin', 'operator'\)/)
    expect(fn).toMatch(/raise exception 'RECIPE_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'RECIPE_INACTIVE'/)
    expect(fn).toMatch(/raise exception 'CONCURRENT_UPDATE'/)
    expect(fn).toMatch(/raise exception 'EXPECTED_REQUIRED'/)
    expect(fn).toMatch(/raise exception 'DUPLICATE_RECIPE_NAME'/)
    expect(fn).toMatch(/for update/)
    expect(SQL).toMatch(/grant execute on function public\.senda_update_recipe\(jsonb\)\s+to service_role/)
    expect(SQL).toMatch(/revoke all on function public\.senda_update_recipe\(jsonb\)\s+from public, anon, authenticated/)
    const body = withoutComments(fn)
    expect(body).not.toMatch(/register_sale_consumption\s*\(/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
    expect(body).not.toMatch(/insert into public\.sales_product_mappings/i)
    expect(body).not.toMatch(/update\s+public\.sales_product_mappings/i)
    expect(body).not.toMatch(/delete from public\.sales_product_mappings/i)
  })

  it('actualiza receta, categoría y BOM en la misma transacción', () => {
    const fn = fnBody(SQL)
    expect(fn).toMatch(/update public\.recipes/)
    expect(fn).toMatch(/delete from public\.recipe_components/)
    expect(fn).toMatch(/insert into public\.recipe_components/)
    expect(fn).toMatch(/insert into public\.recipe_categories/)
    expect(fn.indexOf('insert into public.recipe_categories')).toBeLessThan(fn.indexOf('update public.recipes'))
    expect(fn.indexOf('update public.recipes')).toBeLessThan(fn.indexOf('delete from public.recipe_components'))
    expect(DOC).toMatch(/mappings Fudo/)
    expect(DOC).toMatch(/recipes\.updated_at/)
    expect(DOC).toMatch(/RECIPE_UPDATE_RPC_PENDING/)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/keeps_fudo_mappings/)
    expect(VERIFY).toMatch(/No modifica tablas/)
    const body = withoutComments(VERIFY)
    expect(body).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop)\b/im)
  })
})

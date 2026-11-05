import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe-category.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-save-fudo-recipe-category.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe-category.md', import.meta.url),
  'utf8',
)
const INSTALLED = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe.sql', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

function fnBody(sql: string) {
  const start = sql.search(/create or replace function public\.senda_save_fudo_recipe\(p jsonb\)/i)
  if (start < 0) return sql
  const end = sql.indexOf('comment on function public.senda_save_fudo_recipe', start)
  return end >= 0 ? sql.slice(start, end) : sql.slice(start)
}

describe('proposed-senda-save-fudo-recipe-category.sql', () => {
  it('no se aplica sola y REPLACE el RPC instalado de forma explícita', () => {
    expect(SQL).toMatch(/Paso 432/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/RECIPE_SAVE_CATEGORY_ABORT: falta senda_save_fudo_recipe/)
    expect(SQL).toMatch(/create or replace function public\.senda_save_fudo_recipe\(p jsonb\)/)
    expect(SQL).not.toMatch(/RECIPE_SAVE_RPC_EXISTS/)
    expect(SQL).not.toMatch(/RECIPE_SAVE_CATEGORY_NOT_AUTHORIZED/)
    expect(INSTALLED).toMatch(/create function public\.senda_save_fudo_recipe\(p jsonb\)/)
    expect(INSTALLED).not.toMatch(/create or replace function public\.senda_save_fudo_recipe/)
  })

  it('conserva validaciones, permisos e identidad Fudo del RPC instalado', () => {
    const fn = fnBody(SQL)
    expect(fn).toMatch(/security definer/)
    expect(fn).toMatch(/set search_path = pg_catalog, public/)
    expect(fn).toMatch(/v_actor := public\.senda_require_backend_actor\(\(p->>'actor_user_id'\)::uuid\)/)
    expect(fn).toMatch(/senda_actor_is_purchase_member\(v_location, v_actor\)/)
    expect(fn).toMatch(/raise exception 'PENDING_NOT_FOUND'/)
    expect(fn).toMatch(/raise exception 'MAPPING_INACTIVE'/)
    expect(fn).toMatch(/raise exception 'ALREADY_LINKED'/)
    expect(fn).toMatch(/raise exception 'DUPLICATE_RECIPE_NAME'/)
    expect(fn).toMatch(/raise exception 'RECIPE_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'LINK_DOES_NOT_EDIT_BOM'/)
    expect(fn).toMatch(/raise exception 'INGREDIENT_NOT_IN_ORG'/)
    expect(fn).toMatch(/status = 'resolved'/)
    expect(SQL).toMatch(/grant execute on function public\.senda_save_fudo_recipe\(jsonb\)\s+to service_role/)
    expect(SQL).toMatch(/revoke all on function public\.senda_save_fudo_recipe\(jsonb\)\s+from public, anon, authenticated/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_require_backend_actor/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_actor_is_purchase_member/)
    const body = withoutComments(fn)
    expect(body).not.toMatch(/register_sale_consumption\s*\(/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
    expect(body).not.toMatch(/update\s+public\.recipes/i)
  })

  it('CREATE resuelve categoría en la misma transacción y LINK no la modifica', () => {
    const fn = fnBody(SQL)
    const linkAt = fn.indexOf("if v_intent = 'link' then")
    const createCategoryAt = fn.indexOf("raise exception 'CATEGORY_NOT_IN_ORG'")
    const insertRecipeAt = fn.indexOf('insert into public.recipes')
    expect(fn).toMatch(/raise exception 'CATEGORY_NOT_IN_ORG'/)
    expect(fn).toMatch(/raise exception 'CATEGORY_CONFLICT'/)
    expect(fn).toMatch(/insert into public\.recipe_categories/)
    expect(fn).toMatch(/v_recipe\.category_id is not distinct from v_category_id/)
    expect(fn).toMatch(/category_id/)
    expect(createCategoryAt).toBeGreaterThan(linkAt)
    expect(insertRecipeAt).toBeGreaterThan(createCategoryAt)
    expect(fn).toMatch(/LINK_DOES_NOT_EDIT_BOM/)
    expect(withoutComments(fn)).not.toMatch(/update\s+public\.recipes/i)
    expect(DOC).toMatch(/No lee `category_id`/)
    expect(VERIFY).toMatch(/solo lectura|SOLO LECTURA/i)
    expect(VERIFY).toMatch(/link_does_not_update_recipe/)
    expect(VERIFY).toMatch(/create_resolves_category/)
    expect(VERIFY).toMatch(/No modifica tablas/)
  })
})

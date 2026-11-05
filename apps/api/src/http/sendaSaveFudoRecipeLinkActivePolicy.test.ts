import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe-link-active.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-save-fudo-recipe-link-active.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe-link-active.md', import.meta.url),
  'utf8',
)
const CATEGORY = readFileSync(
  new URL('../../sql/proposed-senda-save-fudo-recipe-category.sql', import.meta.url),
  'utf8',
)
const STATUS = readFileSync(
  new URL('../../sql/proposed-senda-set-recipe-active.sql', import.meta.url),
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

function linkOperation(sql: string) {
  const fn = fnBody(sql)
  const mappingLock = fn.indexOf('from public.sales_product_mappings')
  const linkAt = fn.indexOf("if v_intent = 'link' then", mappingLock)
  const createAt = fn.indexOf('select count(*) into v_count', linkAt)
  return fn.slice(linkAt, createAt > 0 ? createAt : undefined)
}

describe('proposed-senda-save-fudo-recipe-link-active.sql', () => {
  it('no se aplica sola y REPLACE solo el RPC Fudo instalado', () => {
    expect(SQL).toMatch(/Paso 438/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/RECIPE_SAVE_LINK_ACTIVE_ABORT: falta senda_save_fudo_recipe/)
    expect(SQL).toMatch(/create or replace function public\.senda_save_fudo_recipe\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_create_recipe/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_update_recipe/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_set_recipe_active/)
    expect(CATEGORY).toMatch(/create or replace function public\.senda_save_fudo_recipe\(p jsonb\)/)
    expect(STATUS).toMatch(/create function public\.senda_set_recipe_active\(p jsonb\)/)
  })

  it('LINK nuevo exige receta activa y el replay histórico no', () => {
    const link = linkOperation(SQL)
    expect(link).toMatch(/for update/)
    expect(link).toMatch(/raise exception 'RECIPE_NOT_IN_ORG'/)
    expect(link).toMatch(/raise exception 'RECIPE_INACTIVE'/)
    expect(link).toMatch(/v_recipe\.active is not true/)
    const replayAt = link.indexOf('v_replay := true')
    const inactiveAt = link.indexOf("raise exception 'RECIPE_INACTIVE'")
    const insertAt = link.indexOf('insert into public.sales_product_mappings')
    expect(replayAt).toBeGreaterThan(0)
    expect(inactiveAt).toBeGreaterThan(replayAt)
    expect(insertAt).toBeGreaterThan(inactiveAt)
    const create = fnBody(SQL).slice(fnBody(SQL).indexOf('select count(*) into v_count'))
    expect(create).not.toMatch(/RECIPE_INACTIVE/)
    expect(create).toMatch(/insert into public\.recipes/)
    expect(create).toMatch(/insert into public\.recipe_categories/)
  })

  it('conserva identidad Fudo, categorías, locks y sin stock', () => {
    const fn = fnBody(SQL)
    expect(fn).toMatch(/security definer/)
    expect(fn).toMatch(/set search_path = pg_catalog, public/)
    expect(fn).toMatch(/v_actor := public\.senda_require_backend_actor\(\(p->>'actor_user_id'\)::uuid\)/)
    expect(fn).toMatch(/senda_actor_is_purchase_member\(v_location, v_actor\)/)
    expect(fn).toMatch(/raise exception 'PENDING_NOT_FOUND'/)
    expect(fn).toMatch(/raise exception 'MAPPING_INACTIVE'/)
    expect(fn).toMatch(/raise exception 'ALREADY_LINKED'/)
    expect(fn).toMatch(/raise exception 'LINK_DOES_NOT_EDIT_BOM'/)
    expect(fn).toMatch(/raise exception 'CATEGORY_NOT_IN_ORG'/)
    expect(fn).toMatch(/status = 'resolved'/)
    const pendingLock = fn.indexOf('from public.pending_product_mappings')
    const mappingLock = fn.indexOf('from public.sales_product_mappings')
    const recipeLock = fn.indexOf('from public.recipes r')
    expect(pendingLock).toBeGreaterThan(0)
    expect(mappingLock).toBeGreaterThan(pendingLock)
    expect(recipeLock).toBeGreaterThan(mappingLock)
    const statusFn = STATUS.slice(STATUS.search(/create function public\.senda_set_recipe_active\(p jsonb\)/i))
    expect(withoutComments(statusFn)).not.toMatch(/sales_product_mappings[\s\S]{0,120}for update/i)
    expect(withoutComments(statusFn)).toMatch(/from public\.recipes r[\s\S]{0,200}for update/)
    expect(DOC).toMatch(/RECIPE_INACTIVE/)
    expect(DOC).toMatch(/replay/)
    expect(DOC).toMatch(/senda_set_recipe_active/)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/link_rejects_inactive/)
    expect(VERIFY).toMatch(/No modifica tablas/)
    const body = withoutComments(fn)
    expect(body).not.toMatch(/register_sale_consumption\s*\(/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
    expect(body).not.toMatch(/update\s+public\.recipes/i)
    expect(body).not.toMatch(/update\s+public\.sales_product_mappings/i)
    expect(withoutComments(VERIFY)).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop)\b/im)
  })
})

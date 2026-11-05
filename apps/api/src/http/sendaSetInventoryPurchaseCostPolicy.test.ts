import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-set-inventory-purchase-cost.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-set-inventory-purchase-cost.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-set-inventory-purchase-cost.md', import.meta.url),
  'utf8',
)
const RECEIVE = readFileSync(
  new URL('../../sql/migrate-inventory-reception.sql', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

function fnBody(sql: string) {
  const start = sql.search(/create function public\.senda_set_inventory_purchase_cost\(p jsonb\)/i)
  if (start < 0) return sql
  const end = sql.indexOf('comment on function public.senda_set_inventory_purchase_cost', start)
  return end >= 0 ? sql.slice(start, end) : sql.slice(start)
}

describe('proposed-senda-set-inventory-purchase-cost.sql', () => {
  it('no se aplica sola y no REPLACE recepción ni recetas', () => {
    expect(SQL).toMatch(/Paso 447/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/INVENTORY_COST_RPC_EXISTS/)
    expect(SQL).toMatch(/INVENTORY_COST_HISTORY_EXISTS/)
    expect(SQL).toMatch(/create table public\.inventory_cost_history/)
    expect(SQL).toMatch(/create function public\.senda_set_inventory_purchase_cost\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_set_inventory_purchase_cost/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_receive_purchase_document_line/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_create_recipe/)
    expect(RECEIVE).toMatch(/No toca average_unit_cost/)
  })

  it('persiste el último costo por unidad, historial, y no mueve stock ni facturas', () => {
    const fn = fnBody(SQL)
    expect(fn).toMatch(/security definer/)
    expect(fn).toMatch(/set search_path = pg_catalog, public/)
    expect(fn).toMatch(/v_actor := public\.senda_require_backend_actor\(\(p->>'actor_user_id'\)::uuid\)/)
    expect(fn).toMatch(/senda_actor_is_purchase_member\(v_location, v_actor\)/)
    expect(fn).toMatch(/round\(v_cost \/ v_qty, 8\)/)
    expect(fn).toMatch(/set average_unit_cost = excluded\.average_unit_cost/)
    expect(fn).toMatch(/last_purchase_unit_cost = excluded\.last_purchase_unit_cost/)
    expect(fn).toMatch(/insert into public\.inventory_cost_history/)
    expect(fn).toMatch(/v_source = 'invoice'/)
    expect(fn).toMatch(/skipped_stale/)
    expect(fn).toMatch(/on conflict \(location_id, inventory_product_id\) do nothing/)
    expect(fn).toMatch(/for update/)
    expect(SQL).toMatch(/grant execute on function public\.senda_set_inventory_purchase_cost\(jsonb\)\s+to service_role/)
    expect(SQL).toMatch(/revoke all on function public\.senda_set_inventory_purchase_cost\(jsonb\)\s+from public, anon, authenticated/)
    expect(SQL).toMatch(/inventory_cost_history_member_select/)
    expect(SQL).toMatch(/senda_is_org_active_member\(organization_id\)/)
    const body = withoutComments(fn)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
    expect(body).not.toMatch(/set quantity_on_hand/i)
    expect(body).not.toMatch(/purchase_documents/)
    expect(body).not.toMatch(/register_sale_consumption/)
    expect(body).not.toMatch(/ponderado/)
  })

  it('documenta último costo, 503 pendiente y verify de solo lectura', () => {
    expect(DOC).toMatch(/INVENTORY_COST_RPC_PENDING/)
    expect(DOC).toMatch(/quantity_on_hand/)
    expect(DOC).toMatch(/100000 ml/)
    expect(DOC).toMatch(/último costo/i)
    expect(DOC).toMatch(/no es un promedio ponderado/i)
    expect(DOC).toMatch(/Etapa B/)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/keeps_quantity_on_hand/)
    expect(VERIFY).toMatch(/writes_history/)
    expect(VERIFY).toMatch(/inventory_cost_history/)
    expect(VERIFY).toMatch(/No modifica tablas/)
    const body = withoutComments(VERIFY)
    expect(body).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop)\b/im)
  })
})

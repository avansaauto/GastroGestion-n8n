import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-receive-purchase-cost.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-receive-purchase-cost.sql', import.meta.url),
  'utf8',
)
const PREFLIGHT = readFileSync(
  new URL('../../sql/verify-senda-receive-purchase-cost-preflight.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-receive-purchase-cost.md', import.meta.url),
  'utf8',
)
const COST = readFileSync(
  new URL('../../sql/proposed-senda-set-inventory-purchase-cost.sql', import.meta.url),
  'utf8',
)
const TRACE = readFileSync(
  new URL('../../sql/verify-senda-receive-trace.sql', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

function receiveBody(sql: string) {
  const start = sql.search(/create or replace function public\.senda_receive_purchase_document_line/i)
  if (start < 0) return sql
  const end = sql.indexOf('comment on function public.senda_receive_purchase_document_line', start)
  return end >= 0 ? sql.slice(start, end) : sql.slice(start)
}

describe('proposed-senda-receive-purchase-cost.sql', () => {
  it('no se aplica sola y no recrea el SQL de costo de compra', () => {
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/RECEIVE_COST_ABORT: falta senda_set_inventory_purchase_cost/)
    expect(SQL).not.toMatch(/create table public\.inventory_cost_history/)
    expect(SQL).not.toMatch(/create function public\.senda_set_inventory_purchase_cost/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_set_inventory_purchase_cost/)
    expect(COST).toMatch(/create function public\.senda_set_inventory_purchase_cost\(p jsonb\)/)
  })

  it('reutiliza el RPC de último costo en la misma transacción, después de sumar stock', () => {
    const fn = receiveBody(SQL)
    const body = withoutComments(fn)
    expect(fn).toMatch(/security definer/)
    expect(fn).toMatch(/set search_path = pg_catalog, public/)
    expect(fn).toMatch(/v_actor := public\.senda_require_backend_actor/)
    expect(fn).toMatch(/senda_actor_is_purchase_member\(v_location, v_actor\)/)
    expect(fn).toMatch(/quantity_on_hand = public\.inventory_valuations\.quantity_on_hand \+ excluded\.quantity_on_hand/)
    expect(fn).toMatch(/perform public\.senda_set_inventory_purchase_cost/)
    expect(fn).toMatch(/'source', 'invoice'/)
    expect(fn).toMatch(/'source_ref', v_receipt_id/)
    expect(fn).toMatch(/v_purchase_cost := v_net/)
    expect(fn).toMatch(/'purchase_quantity', v_line\.inventory_physical_quantity/)
    expect(fn).toMatch(/'purchase_cost', v_purchase_cost/)
    expect(fn).not.toMatch(/round\(v_net \* \(p_quantity \/ v_line\.inventory_physical_quantity\)/)
    expect(fn).toMatch(/p_quantity > v_remaining/)
    expect(fn).toMatch(/raise exception 'VALUATION_AMOUNT_REQUIRED'/)
    expect(fn).toMatch(/raise exception 'IDEMPOTENCY_CONFLICT'/)
    expect(fn).toMatch(/raise exception 'PRODUCT_INACTIVE'/)
    expect(body).not.toMatch(/exception when/i)
    expect(body).not.toMatch(/\bhttp\b/i)
    expect(body).not.toMatch(/pending_product_mappings/)
    expect(body).not.toMatch(/sales_product_mappings/)
    expect(body).not.toMatch(/register_sale_consumption/)
    const replayAt = fn.search(/idempotent', true/)
    const costAt = fn.search(/senda_set_inventory_purchase_cost/)
    const stockAt = fn.search(/quantity_on_hand = public\.inventory_valuations\.quantity_on_hand \+/)
    expect(replayAt).toBeGreaterThan(0)
    expect(costAt).toBeGreaterThan(replayAt)
    expect(costAt).toBeGreaterThan(stockAt)
  })

  it('usa las mismas claves jsonb que el RPC de costo instalado', () => {
    const fn = withoutComments(receiveBody(SQL))
    const cost = withoutComments(COST)
    for (const key of [
      'actor_user_id',
      'organization_id',
      'location_id',
      'inventory_product_id',
      'purchase_quantity',
      'purchase_cost',
      'source',
      'source_ref',
      'effective_at',
    ]) {
      expect(fn).toContain(`'${key}'`)
      expect(cost).toContain(`p->>'${key}'`)
    }
    expect(cost).toMatch(/round\(v_cost, 2\)/)
    expect(cost).toMatch(/round\(v_cost \/ v_qty, 8\)/)
    expect(cost).toMatch(/v_source = 'invoice'/)
    expect(cost).toMatch(/v_effective < v_existing_last_at/)
    expect(cost).not.toMatch(/v_effective <= v_existing_last_at/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_set_inventory_purchase_cost/)
  })

  it('documenta 10 kg a $200.000 y conservas de solo lectura', () => {
    expect(DOC).toMatch(/10000/)
    expect(DOC).toMatch(/200000/)
    expect(DOC).toMatch(/\$4\.000/)
    expect(DOC).toMatch(/skipped_stale/)
    expect(PREFLIGHT).toMatch(/SOLO LECTURA/)
    expect(PREFLIGHT).toMatch(/receive_does_not_call_cost_yet/)
    expect(PREFLIGHT).not.toMatch(/create function public\.senda_set_inventory_purchase_cost/)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/receive_calls_cost_rpc/)
    expect(VERIFY).toMatch(/cost_uses_invoiced_qty/)
    expect(VERIFY).toMatch(/no_partial_cost_round/)
    const verifyBody = VERIFY.replace(/--[^\n]*/g, '')
    expect(verifyBody).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop|truncate|call)\b/im)
    expect(SQL).toMatch(/grant execute on function public\.senda_receive_purchase_document_line\(uuid, uuid, numeric, uuid, uuid\)\s+to service_role/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_receive_purchase_document_line\([^)]+\) to authenticated/)
    expect(TRACE).toMatch(/SOLO LECTURA|solo lectura/)
    expect(TRACE).toMatch(/purchase_document_receipts/)
    expect(TRACE).toMatch(/inventory_movements/)
    expect(TRACE).toMatch(/inventory_valuations/)
    const traceBody = TRACE.replace(/--[^\n]*/g, '')
    expect(traceBody).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop|truncate|call)\b/im)
  })
})

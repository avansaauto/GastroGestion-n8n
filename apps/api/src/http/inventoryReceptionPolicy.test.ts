import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/migrate-inventory-reception.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-inventory-reception.sql', import.meta.url),
  'utf8',
)
const MIGRATE = readFileSync(
  new URL('../../sql/migrate-invoice-persistence.sql', import.meta.url),
  'utf8',
)

describe('migración definitiva de recepción', () => {
  it('no se ejecuta sola y no crea datos de prueba', () => {
    expect(SQL).toMatch(/MIGRACIÓN DEFINITIVA/)
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    const withoutComments = SQL.replace(/--[^\n]*/g, '')
    expect(withoutComments).not.toMatch(/pending_product_mappings/)
    expect(withoutComments).not.toMatch(/sales_product_mappings/)
    expect(withoutComments).not.toMatch(/values\s*\(\s*'[0-9a-f-]{36}'/i)
  })

  it('crea eventos parciales por línea y no usa purchase_receipts', () => {
    expect(SQL).toMatch(/create table public\.purchase_document_receipts/)
    expect(SQL).toMatch(/unique \(purchase_document_id, idempotency_key\)/)
    expect(SQL).toMatch(/constraint purchase_document_receipts_qty_chk check \(quantity > 0\)/)
    expect(SQL).not.toMatch(/insert into public\.purchase_receipts/i)
    expect(SQL).not.toMatch(/insert into public\.purchase_items/i)
    expect(SQL).not.toMatch(/alter table public\.purchase_receipts/i)
  })

  it('escribe movimiento purchase y suma existencias sin inventar costos', () => {
    expect(SQL).toMatch(/insert into public\.inventory_movements[\s\S]*?'purchase'/)
    expect(SQL).toMatch(/quantity_on_hand = public\.inventory_valuations\.quantity_on_hand \+ excluded\.quantity_on_hand/)
    expect(SQL).toMatch(/alter column average_unit_cost drop not null/)
    expect(SQL).toMatch(/p_quantity,\s*null,\s*null,/s)
    expect(SQL).not.toMatch(/set average_unit_cost/i)
    expect(SQL).not.toMatch(/average_unit_cost = /)
    expect(SQL).toMatch(/on conflict \(location_id, inventory_product_id\) do nothing/)
    expect(SQL).toMatch(/on conflict \(location_inventory_id\) do update/)
  })

  it('valida actor, membresía, línea mapeada, tope e idempotencia en una RPC DEFINER', () => {
    expect(SQL).toMatch(/create or replace function public\.senda_receive_purchase_document_line/)
    expect(SQL).toMatch(/v_actor := public\.senda_require_backend_actor/)
    expect(SQL).toMatch(/senda_actor_is_purchase_member\(v_location, v_actor\)/)
    expect(SQL).toMatch(/for update/)
    expect(SQL).toMatch(/raise exception 'LINE_NOT_MAPPED'/)
    expect(SQL).toMatch(/raise exception 'RECEIPT_EXCEEDS_INVOICED'/)
    expect(SQL).toMatch(/raise exception 'IDEMPOTENCY_CONFLICT'/)
    expect(SQL).toMatch(/raise exception 'LINE_NOT_INVENTORIABLE'/)
    expect(SQL).not.toMatch(/raise exception 'PRODUCT_INACTIVE'/)
    expect(SQL).toMatch(/grant execute on function public\.senda_receive_purchase_document_line\(uuid, uuid, numeric, uuid, uuid\)\s+to service_role/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_receive_purchase_document_line\([^)]+\) to authenticated/)
    expect(SQL).not.toMatch(/grant insert on table public\.inventory_movements/i)
    expect(SQL).not.toMatch(/grant update on table public\.inventory_valuations/i)
  })

  it('restringe received a service_role y a factura sin pendientes ni unmapped', () => {
    expect(SQL).toMatch(/senda_purchase_document_is_fully_received/)
    expect(SQL).toMatch(/p_eligibility is not distinct from 'eligible'/)
    expect(SQL).toMatch(/p_mapping_status is distinct from 'not_applicable'/)
    expect(SQL).toMatch(/'fiscal', 'service', 'ignored', 'expense', 'logistics'/)
    expect(SQL).toMatch(/'service_consumption', 'charge', 'none'/)
    expect(SQL).toMatch(/mapping_status is distinct from 'mapped'/)
    expect(SQL).toMatch(/coalesce\(l\.inventory_physical_quantity, 0\) <= 0/)
    expect(SQL).toMatch(/is distinct from l\.inventory_physical_quantity/)
    expect(SQL).toMatch(/new\.status = 'received' and old\.status is distinct from 'received'/)
    expect(SQL).toMatch(/auth\.role\(\), ''\) is distinct from 'service_role'/)
    expect(SQL).toMatch(/auth\.role\(\), ''\) = 'service_role'/)
    expect(SQL).not.toMatch(/set_config\('senda.allow_received'/)
    expect(SQL).toMatch(/raise exception 'STATUS_RECEIVED_RESERVED'/)
    expect(SQL).toMatch(/raise exception 'CANCEL_HAS_RECEIPTS'/)
    expect(SQL).toMatch(/raise exception 'LINE_HAS_RECEIPTS'/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_save_purchase_invoice/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_map_purchase_document_line/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_cancel_purchase_invoice/)
  })

  it('conserva las reglas documentales del trigger de facturas', () => {
    expect(SQL).toMatch(/raise exception 'DOCUMENTARY_IMMUTABLE'/)
    expect(SQL).toMatch(/raise exception 'STATUS_INSERT_NOT_ALLOWED'/)
    expect(MIGRATE).toMatch(/raise exception 'STATUS_RECEIVED_RESERVED'/)
    expect(MIGRATE).not.toMatch(/create table public\.purchase_document_receipts/)
  })

  it('deja la verificación en solo lectura', () => {
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    const withoutComments = VERIFY.replace(/--[^\n]*/g, '')
    expect(withoutComments).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop|truncate|call)\b/im)
    expect(VERIFY).toMatch(/senda_receive_purchase_document_line/)
    expect(VERIFY).toMatch(/received→received no revalida la reserva/)
    expect(VERIFY).toMatch(/inventory_physical_quantity, 0\) <= 0/)
  })
})

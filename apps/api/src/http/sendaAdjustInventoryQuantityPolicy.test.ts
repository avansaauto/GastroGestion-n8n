import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-adjust-inventory-quantity.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-adjust-inventory-quantity.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-adjust-inventory-quantity.md', import.meta.url),
  'utf8',
)

describe('proposed-senda-adjust-inventory-quantity.sql', () => {
  it('no se aplica sola y no desactiva el insumo', () => {
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/INVENTORY_ADJUST_RPC_EXISTS/)
    expect(SQL).toMatch(/create table public\.inventory_adjustments/)
    expect(SQL).toMatch(/create function public\.senda_adjust_inventory_quantity\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_adjust_inventory_quantity/)
    expect(SQL).not.toMatch(/set active = false/)
    const start = SQL.search(/create function public\.senda_adjust_inventory_quantity\(p jsonb\)/i)
    const end = SQL.indexOf('comment on function public.senda_adjust_inventory_quantity', start)
    const fn = SQL.slice(start, end >= 0 ? end : undefined)
    expect(fn).not.toMatch(/delete from public\.inventory_products/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_cancel_purchase_invoice/)
  })

  it('exige movimiento firmado, motivo, idempotencia y conserva movement_type', () => {
    expect(SQL).toMatch(/insert into public\.inventory_movements/)
    expect(SQL).toMatch(/v_qty/)
    expect(SQL).not.toMatch(/abs\(v_qty\)/)
    expect(SQL).not.toMatch(/v_abs/)
    expect(SQL).toMatch(/chk_movement_type/)
    expect(SQL).toMatch(/v_has_adjustment/)
    expect(SQL).not.toMatch(
      /drop constraint[\s\S]*check \(movement_type in \('purchase', 'adjustment'\)\)/,
    )
    expect(SQL).toMatch(/REASON_REQUIRED/)
    expect(SQL).toMatch(/ADJUSTMENT_EXCEEDS_ON_HAND/)
    expect(SQL).toMatch(/IDEMPOTENCY_CONFLICT/)
    expect(SQL).toMatch(/senda_actor_is_purchase_member/)
    expect(SQL).toMatch(/coalesce\(ip\.active, false\)/)
    expect(SQL).toMatch(/grant execute on function public\.senda_adjust_inventory_quantity\(jsonb\)\s+to service_role/)
    expect(DOC).toMatch(/-quantity_on_hand/)
    expect(DOC).toMatch(/cantidad firmada/)
    expect(DOC).toMatch(/No se hace `UPDATE inventory_valuations SET quantity_on_hand = 0`/)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/writes_movement_before_balance/)
    expect(VERIFY).toMatch(/stores_signed_quantity/)
    expect(VERIFY).toMatch(/idempotency_and_non_negative/)
    expect(VERIFY).toMatch(/li_insert_preserves_product_active/)
    expect(VERIFY).toMatch(/movement_type_allows_adjustment/)
    expect(VERIFY).toMatch(/movement_type_not_narrowed_to_two/)
  })
})

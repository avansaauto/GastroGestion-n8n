import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-delete-purchase-invoice.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-delete-purchase-invoice.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-delete-purchase-invoice.md', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

describe('proposed-senda-delete-purchase-invoice.sql', () => {
  it('no se aplica sola y no desactiva triggers', () => {
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/drop function if exists public\.senda_delete_purchase_invoice\(jsonb\)/)
    expect(SQL).toMatch(/create function public\.senda_delete_purchase_invoice\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_delete_purchase_invoice/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_receive_purchase_document_line/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_cancel_purchase_invoice/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_confirm_purchase_invoice_intake/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_adjust_inventory_quantity/)
  })

  it('llama senda_adjust_inventory_quantity y no inserta movimientos a mano', () => {
    const start = SQL.search(/create function public\.senda_delete_purchase_invoice\(p jsonb\)/i)
    const end = SQL.indexOf('comment on function public.senda_delete_purchase_invoice', start)
    const body = withoutComments(SQL.slice(start, end >= 0 ? end : undefined))
    expect(body).toMatch(/senda_adjust_inventory_quantity/)
    expect(body).toMatch(/idempotency_key.*receipt_id|receipt_id[\s\S]*idempotency_key/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
    expect(body).toMatch(/REVERSAL_INSUFFICIENT_STOCK/)
    expect(body).toMatch(/deleted_at/)
    expect(body).toMatch(/purchase_invoice_deletion_log/)
    expect(body).toMatch(/missing_inventory/)
    expect(body).toMatch(/REVERSAL_ABORTED/)
    expect(body).toMatch(/REVERSAL_INVENTORY_REF_MISMATCH/)
    expect(body).toMatch(/already_reversed|inventory_adjustments/)
    expect(body).toMatch(/excluded_deleted_invoices|d\.deleted_at is null/)
    expect(body).not.toMatch(/session_replication/)
    expect(body).not.toMatch(/DELETE_HAS_RECEIPTS/)
    expect(body).not.toMatch(/delete from public\.purchase_documents/i)
    expect(body).not.toMatch(/delete from public\.purchase_document_receipts/i)
    expect(body).not.toMatch(/pg_get_constraintdef/)
    expect(body).not.toMatch(/adjust_error/)
    expect(SQL).toMatch(/grant execute on function public\.senda_delete_purchase_invoice\(jsonb\)\s+to service_role/)
    expect(DOC).toMatch(/senda_adjust_inventory_quantity/)
    expect(DOC).toMatch(/REVERSAL_ABORTED|obligatoria/)
  })

  it('verificador: una sola lista y falla si cualquier check es false', () => {
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/do \$verify\$/)
    expect(VERIFY).toMatch(/DELETE_INVOICE_VERIFY_FAILED/)
    expect(VERIFY).toMatch(/ALL_CHECKS_PASSED/)
    expect(VERIFY).toMatch(/rejects_inconsistent_location_inventory_ref/)
    expect(VERIFY).toMatch(/cost_restore_avoids_loop_alias_r/)
    expect(VERIFY).toMatch(/cost_restore_null_when_no_prior/)
    expect(VERIFY).toMatch(/allows_delete_without_receipts/)
    expect(VERIFY).toMatch(/inactive_product_still_reverses_when_li_exists/)
    expect(VERIFY).toMatch(/abort_on_adjust_failure_when_inventory_exists/)
    expect(VERIFY).toMatch(/idempotent_replay_by_receipt/)
    expect(VERIFY).toMatch(/no_session_replication_role/)
    expect(VERIFY).toMatch(/'session_replication' \|\| '_role'/)
    expect(VERIFY).toMatch(/purchase_document_receipts\[\[:space:\]\]\+r/)
    // Sin segundo listado desincronizado (el DO antiguo duplicado).
    expect(VERIFY).not.toMatch(/do \$fail\$/)
    expect(VERIFY.match(/delete_definer/g)?.length).toBe(1)
  })

  it('hotfix ejecutable REPLACE la RPC con alias pr y loop v_rec', () => {
    const hotfix = readFileSync(
      new URL('../../sql/hotfix-senda-delete-purchase-invoice.sql', import.meta.url),
      'utf8',
    )
    expect(hotfix).toMatch(/create or replace function public\.senda_delete_purchase_invoice\(p jsonb\)/)
    expect(hotfix).toMatch(/for v_rec in/)
    expect(hotfix).toMatch(/purchase_document_receipts pr/)
    expect(hotfix).toMatch(/pr\.purchase_document_id/)
    expect(hotfix).toMatch(/average_unit_cost = v_restore_cost/)
    expect(hotfix).not.toMatch(/average_unit_cost\s*=\s*coalesce\s*\(\s*v_restore_cost/)
    expect(hotfix).toMatch(/DELETE_HOTFIX_ABORT/)
    expect(hotfix).toMatch(/grant execute on function public\.senda_delete_purchase_invoice\(jsonb\)\s+to service_role/)
  })
})

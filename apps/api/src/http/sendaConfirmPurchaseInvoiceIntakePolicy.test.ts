import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-confirm-purchase-invoice-intake.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-confirm-purchase-invoice-intake.sql', import.meta.url),
  'utf8',
)
const FUNCTIONAL = readFileSync(
  new URL('../../sql/test-senda-confirm-purchase-invoice-intake.sql', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

describe('proposed-senda-confirm-purchase-invoice-intake.sql', () => {
  it('no se aplica sola y exige preflight de dependencias y category', () => {
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/CONFIRM_INTAKE_RPC_EXISTS/)
    expect(SQL).toMatch(/senda_map_purchase_document_line/)
    expect(SQL).toMatch(/senda_receive_purchase_document_line/)
    expect(SQL).toMatch(/senda_set_inventory_product_active/)
    expect(SQL).toMatch(/inventory_products\.category/)
    expect(SQL).toMatch(/create function public\.senda_confirm_purchase_invoice_intake\(p jsonb\)/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_confirm_purchase_invoice_intake/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_receive_purchase_document_line/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_map_purchase_document_line/)
  })

  it('extiende auditoría conservando acciones base; no lista fija suelta', () => {
    expect(SQL).toMatch(/purchase_document_audit_action_chk incompatible/)
    expect(SQL).toMatch(/regexp_matches\(v_def/)
    expect(SQL).toMatch(/invoice_intake_confirmed/)
    expect(SQL).toMatch(/invoice_line_received/)
    expect(SQL).not.toMatch(
      /alter table public\.purchase_document_audit\s+drop constraint if exists purchase_document_audit_action_chk;\s*alter table public\.purchase_document_audit\s+add constraint purchase_document_audit_action_chk\s+check \(action in \(\s*'invoice_reviewed'/,
    )
  })

  it('revalida conversiones SI/empaque y persiste intentos', () => {
    const start = SQL.search(/create function public\.senda_confirm_purchase_invoice_intake\(p jsonb\)/i)
    const end = SQL.indexOf('comment on function public.senda_confirm_purchase_invoice_intake', start)
    const body = withoutComments(SQL.slice(start, end >= 0 ? end : undefined))
    expect(body).toMatch(/senda_confirm_intake_assert_physical/)
    expect(body).toMatch(/senda_map_purchase_document_line/)
    expect(body).toMatch(/senda_receive_purchase_document_line/)
    expect(body).toMatch(/purchase_document_confirm_attempts/)
    expect(body).toMatch(/PENDING_NOT_ALLOWED/)
    expect(body).toMatch(/CONFIRM_IDEMPOTENCY_CONFLICT/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
    expect(SQL).toMatch(/create function public\.senda_confirm_intake_assert_physical/)
    expect(SQL).toMatch(/EQUIVALENCE_REQUIRED/)
    expect(SQL).toMatch(/revoke all on function public\.senda_confirm_intake_assert_physical/)
  })

  it('protege create sin fallback; verificador y test funcional actualizados', () => {
    const ensureStart = SQL.search(/create function public\.senda_ensure_inventory_product_for_intake\(p jsonb\)/i)
    const ensureEnd = SQL.indexOf('comment on function public.senda_ensure_inventory_product_for_intake', ensureStart)
    const ensureBody = withoutComments(SQL.slice(ensureStart, ensureEnd >= 0 ? ensureEnd : undefined))
    expect(ensureBody).not.toMatch(/undefined_column/)
    expect(SQL).toMatch(/revoke all on function public\.senda_ensure_inventory_product_for_intake\(jsonb\)\s+from public, anon, authenticated, service_role/)
    expect(VERIFY).toMatch(/audit_preserves_actions_plus_intake/)
    expect(VERIFY).toMatch(/conversion_helpers_internal/)
    expect(FUNCTIONAL).toMatch(/ROLLBACK/)
    expect(FUNCTIONAL).toMatch(/CONFIRM_INTAKE_TEST_SKIP/)
    expect(FUNCTIONAL).toMatch(/v_movements_after_replay is distinct from v_movements_after_confirm/)
    expect(FUNCTIONAL).toMatch(/v_stock_after_replay is distinct from v_stock_after_confirm/)
    expect(FUNCTIONAL).toMatch(/v_pin_document_id/)
    expect(FUNCTIONAL).not.toMatch(/v_actor uuid := null/)
  })

  it('serializa create concurrente: advisory lock antes del rechequeo de duplicados', () => {
    const ensureStart = SQL.search(/create function public\.senda_ensure_inventory_product_for_intake\(p jsonb\)/i)
    const ensureEnd = SQL.indexOf('comment on function public.senda_ensure_inventory_product_for_intake', ensureStart)
    const ensureBody = withoutComments(SQL.slice(ensureStart, ensureEnd >= 0 ? ensureEnd : undefined))
    const lockAt = ensureBody.search(/pg_advisory_xact_lock/i)
    const recheckAt = ensureBody.search(/Releer duplicados|into v_existing/i)
    const duplicateAt = ensureBody.search(/DUPLICATE_PRODUCT/)
    expect(lockAt).toBeGreaterThan(-1)
    expect(ensureBody).toMatch(/hashtext\('senda_ensure_inv:'/)
    expect(ensureBody).toMatch(/hashtext\(v_norm\)/)
    expect(recheckAt).toBeGreaterThan(lockAt)
    expect(duplicateAt).toBeGreaterThan(lockAt)
    expect(VERIFY).toMatch(/ensure_concurrent_name_lock/)
    expect(FUNCTIONAL).toMatch(/pg_advisory_xact_lock|CONFIRM_INTAKE_TEST_CONCURRENCY/)
  })
})

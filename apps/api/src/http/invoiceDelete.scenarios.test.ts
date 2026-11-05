import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-delete-purchase-invoice.sql', import.meta.url),
  'utf8',
)
const HOTFIX = readFileSync(
  new URL('../../sql/hotfix-senda-delete-purchase-invoice.sql', import.meta.url),
  'utf8',
)

function functionBody(sql = SQL) {
  const start = sql.search(
    /create(?: or replace)? function public\.senda_delete_purchase_invoice\(p jsonb\)/i,
  )
  const end = sql.indexOf('comment on function public.senda_delete_purchase_invoice', start)
  return sql.slice(start, end >= 0 ? end : undefined).replace(/--[^\n]*/g, '')
}

/**
 * Escenarios contractuales del RPC (no ejecutan SQL).
 * Cubren los casos de aceptación de eliminación con reversión.
 */
describe('escenarios senda_delete_purchase_invoice (lógico + adjust)', () => {
  const body = functionBody()
  const hotfixBody = functionBody(HOTFIX)

  it('factura sin recepción: marca deleted_at sin hard delete ni adjust obligatorio', () => {
    expect(body).toMatch(/set deleted_at = v_now/)
    expect(body).toMatch(/deleted_by = v_actor/)
    expect(body).not.toMatch(/delete from public\.purchase_documents/i)
    expect(body).not.toMatch(/delete from public\.purchase_document_lines/i)
    expect(body).not.toMatch(/delete from public\.purchase_document_receipts/i)
    expect(body).not.toMatch(/DELETE_HAS_RECEIPTS/)
  })

  it('factura recibida con stock: senda_adjust_inventory_quantity y receipt_id como idempotency_key', () => {
    expect(body).toMatch(/senda_adjust_inventory_quantity/)
    expect(body).toMatch(/'idempotency_key',\s*v_rec\.receipt_id/)
    expect(body).toMatch(/'quantity',\s*-v_rec\.quantity/)
    expect(body).not.toMatch(/insert into public\.inventory_movements/i)
  })

  it('stock insuficiente: REVERSAL_INSUFFICIENT_STOCK y no omite la reversión', () => {
    expect(body).toMatch(/REVERSAL_INSUFFICIENT_STOCK/)
    expect(body).toMatch(/v_on_hand < v_rec\.quantity/)
    expect(body).toMatch(/ADJUSTMENT_EXCEEDS_ON_HAND/)
  })

  it('producto eliminado físicamente: missing_inventory y continúa', () => {
    expect(body).toMatch(/product_missing',\s*true/)
    expect(body).toMatch(/skipped',\s*'missing_inventory'/)
  })

  it('sin location_inventory asociado: missing_inventory (no crea LI vía adjust)', () => {
    expect(body).toMatch(/v_li is null/)
    expect(body).toMatch(/missing_inventory/)
    expect(body).not.toMatch(/adjust_error/)
    expect(body).not.toMatch(/PRODUCT_NOT_IN_ORG[\s\S]{0,80}continue/)
  })

  it('cost restore: alias pr + loop v_rec (bug 42703)', () => {
    expect(body).toMatch(/for v_rec in/)
    expect(body).toMatch(/purchase_document_receipts pr/)
    expect(body).toMatch(/pr\.purchase_document_id/)
    expect(body).not.toMatch(/from public\.purchase_document_receipts r\b/)
    expect(hotfixBody).toMatch(/for v_rec in/)
    expect(hotfixBody).toMatch(/purchase_document_receipts pr/)
    expect(hotfixBody).toMatch(/create or replace function public\.senda_delete_purchase_invoice/)
  })

  it('location_inventory_id inconsistente: aborta sin fallback a otro LI', () => {
    expect(body).toMatch(/REVERSAL_INVENTORY_REF_MISMATCH/)
    expect(body).toMatch(/v_li_location is distinct from v_location/)
    expect(body).toMatch(/v_li_product is distinct from v_rec\.inventory_product_id/)
    const refBlockStart = body.indexOf('location_inventory_id is not null')
    const elseLookup = body.indexOf('else', refBlockStart)
    const mismatchRaise = body.indexOf('REVERSAL_INVENTORY_REF_MISMATCH', refBlockStart)
    expect(refBlockStart).toBeGreaterThan(-1)
    expect(mismatchRaise).toBeGreaterThan(refBlockStart)
    expect(mismatchRaise).toBeLessThan(elseLookup === -1 ? body.length : elseLookup + 200)
  })

  it('producto inactivo con inventario: sigue intentando adjust (no skip por active)', () => {
    expect(body).toMatch(/product_inactive/)
    expect(body).toMatch(/coalesce\(v_rec\.product_active, false\) is not true/)
    expect(body).not.toMatch(/if coalesce\(v_rec\.product_active[\s\S]{0,120}continue/)
    expect(body).not.toMatch(/product_active is not true[\s\S]{0,80}continue/)
  })

  it('varias líneas / recibos del mismo insumo: loop por receipt_id ordenado', () => {
    expect(body).toMatch(/order by rec\.created_at, rec\.id/)
    expect(body).toMatch(/for v_rec in/)
    expect(body).toMatch(/idempotency_key = v_rec\.receipt_id/)
  })

  it('eliminación repetida: already_reversed / replay sin ajustes duplicados', () => {
    expect(body).toMatch(/inventory_adjustments/)
    expect(body).toMatch(/idempotency_key = v_rec\.receipt_id/)
    expect(body).toMatch(/already_reversed/)
    expect(body).toMatch(/'replay',\s*true/)
    expect(body).toMatch(/if v_deleted_at is not null/)
  })

  it('restaura costo desde historial válido; NULL si no hay anterior; no borra history', () => {
    expect(body).toMatch(/d\.deleted_at is null/)
    expect(body).toMatch(/d\.id is distinct from v_doc/)
    expect(body).toMatch(/excluded_deleted_invoices/)
    expect(body).toMatch(/inventory_cost_history/)
    expect(body).not.toMatch(/delete from public\.inventory_cost_history/i)
    expect(body).toMatch(/average_unit_cost = v_restore_cost/)
    expect(body).toMatch(/last_purchase_unit_cost = v_restore_cost/)
    expect(body).not.toMatch(/average_unit_cost\s*=\s*coalesce\s*\(\s*v_restore_cost/)
    expect(body).toMatch(/when v_restore_cost is null then 'cleared'/)
    // No usa previous_unit_cost de la fila excluida como restore ciego.
    expect(body).not.toMatch(/v_restore_cost\s*:=\s*h\.previous_unit_cost/)
  })

  it('fallo a mitad: REVERSAL_ABORTED / stock insuficiente abortan antes de deleted_at', () => {
    expect(body).toMatch(/REVERSAL_ABORTED/)
    const adjustPos = body.search(/senda_adjust_inventory_quantity/)
    const deletedPos = body.search(/set deleted_at = v_now/)
    expect(adjustPos).toBeGreaterThan(-1)
    expect(deletedPos).toBeGreaterThan(adjustPos)
    expect(body).not.toMatch(/session_replication/)
  })

  it('auditoría y service_role', () => {
    expect(body).toMatch(/purchase_invoice_deletion_log/)
    expect(SQL).toMatch(/grant execute on function public\.senda_delete_purchase_invoice\(jsonb\)\s+to service_role/)
    expect(SQL).toMatch(/revoke all on function public\.senda_delete_purchase_invoice\(jsonb\)[\s\S]*authenticated/)
    expect(HOTFIX).toMatch(/grant execute on function public\.senda_delete_purchase_invoice\(jsonb\)\s+to service_role/)
  })
})

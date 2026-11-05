import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-sale-consumption-event.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-sale-consumption-event.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-sale-consumption-event.md', import.meta.url),
  'utf8',
)

describe('proposed-senda-sale-consumption-event.sql', () => {
  it('conserva register_sale_consumption y agrega el envoltorio', () => {
    expect(SQL).toMatch(/NO EJECUTAR/)
    expect(SQL).toMatch(/create table public\.sale_consumption_events/)
    expect(SQL).toMatch(/create table public\.sale_consumption_event_lines/)
    expect(SQL).toMatch(/create or replace function public\.senda_register_sale_consumption_event\(p jsonb\)/)
    expect(SQL).toMatch(/from public\.register_sale_consumption\(/)
    expect(SQL).not.toMatch(/create or replace function public\.register_sale_consumption\(/)
    expect(SQL).toMatch(/grant execute on function public\.senda_register_sale_consumption_event\(jsonb\)\s+to service_role/)
    expect(SQL).toMatch(/revoke all on function public\.senda_register_sale_consumption_event\(jsonb\)\s+from public, anon, authenticated/)
  })

  it('persiste rechazos de stock y estados de lote', () => {
    expect(SQL).toMatch(/check \(status in \('complete', 'partial', 'failed', 'duplicate', 'reversed'\)\)/)
    expect(SQL).toMatch(/check \(status in \('registered', 'failed', 'duplicate'\)\)/)
    expect(SQL).toMatch(/exception/)
    expect(SQL).toMatch(/SALE_EVENT_IDEMPOTENCY_CONFLICT/)
    expect(SQL).toMatch(/reintenta SOLO líneas failed|status is distinct from 'failed'/)
    expect(SQL).toMatch(/set search_path = pg_catalog, public/)
    expect(DOC).toMatch(/SALE_EXCEEDS_ON_HAND/)
    expect(DOC).toMatch(/partial/)
    expect(DOC).toMatch(/no inventa.*reverso|No inventa reversos/i)
  })

  it('la verificación solo lee y exige el RPC de venta intacto', () => {
    expect(VERIFY).toMatch(/solo lectura|No modifica datos/)
    expect(VERIFY).toMatch(/rpc_sale_untouched/)
    expect(VERIFY).not.toMatch(/\b(insert|update|delete|drop)\b/i)
  })
})

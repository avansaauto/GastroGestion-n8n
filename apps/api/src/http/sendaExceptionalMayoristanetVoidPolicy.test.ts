import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-exceptional-void-mayoristanet-ef01f3a8.sql', import.meta.url),
  'utf8',
)
const TEST = readFileSync(
  new URL('../../sql/test-senda-exceptional-void-mayoristanet.sql', import.meta.url),
  'utf8',
)
const RUNNER = readFileSync(
  new URL('../scripts/runExceptionalMayoristanetVoid.ts', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

describe('senda_exceptional_void_mayoristanet_ef01f3a8 security closure', () => {
  const start = SQL.search(
    /create or replace function public\.senda_exceptional_void_mayoristanet_ef01f3a8\(p jsonb\)/i,
  )
  const end = SQL.indexOf(
    'comment on function public.senda_exceptional_void_mayoristanet_ef01f3a8',
    start,
  )
  const body = withoutComments(SQL.slice(start, end >= 0 ? end : undefined))

  it('no amplía EXECUTE; solo service_role', () => {
    expect(SQL).toMatch(
      /revoke all on function public\.senda_exceptional_void_mayoristanet_ef01f3a8\(jsonb\)\s+from public, anon, authenticated/,
    )
    expect(SQL).toMatch(
      /grant execute on function public\.senda_exceptional_void_mayoristanet_ef01f3a8\(jsonb\)\s+to service_role/,
    )
    expect(SQL).not.toMatch(/grant execute[\s\S]*to authenticated/)
    expect(SQL).not.toMatch(/grant execute[\s\S]*to anon/)
  })

  it('aborta conflicto de auditoría (no DO NOTHING)', () => {
    expect(body).not.toMatch(/on conflict\s*\(\s*purchase_document_id\s*\)\s*do nothing/i)
    expect(body).toMatch(/EXCEPTIONAL_AUDIT_CONFLICT/)
    expect(body).toMatch(/unique_violation/)
  })

  it('fingerprint exacto de 7 recepciones y 3 movimientos', () => {
    expect(body).toMatch(/EXCEPTIONAL_RECEIPT_FINGERPRINT/)
    expect(body).toMatch(/EXCEPTIONAL_LATER_FINGERPRINT/)
    expect(SQL).toMatch(/76f64826-5ce1-4a91-a59e-0f712afe699f/)
    expect(SQL).toMatch(/579a598f-c3ff-4ffc-b0b3-f33377f6651e/)
    expect(SQL).toMatch(/da65cf9a-21dd-4c8a-8116-fe020daaa86c/)
    expect(SQL).toMatch(/2aef7885-6c71-4fd7-b89b-fc2925376b36/)
  })

  it('dry_run retorna antes de escrituras y revalida bajo locks', () => {
    expect(body).toMatch(/writes',\s*false/)
    expect(body).toMatch(/if v_dry then/)
    expect(body).toMatch(/revalidate_under_locks/)
    const dryIdx = body.indexOf('if v_dry then')
    const writeIdx = body.indexOf("v_phase := 'write'")
    const adjustIdx = body.indexOf('senda_adjust_inventory_quantity')
    expect(dryIdx).toBeGreaterThan(-1)
    expect(writeIdx).toBeGreaterThan(dryIdx)
    expect(adjustIdx).toBeGreaterThan(writeIdx)
  })

  it('suite SQL cubre duplicados, inesperados, replay y rollback', () => {
    expect(TEST).toMatch(/EXCEPTIONAL_RECEIPT_FINGERPRINT/)
    expect(TEST).toMatch(/EXCEPTIONAL_UNEXPECTED_DEPENDENT/)
    expect(TEST).toMatch(/EXCEPTIONAL_LATER_FINGERPRINT/)
    expect(TEST).toMatch(/EXCEPTIONAL_AUDIT_CONFLICT/)
    expect(TEST).toMatch(/replay tras deleted_at/)
    expect(TEST).toMatch(/rollback íntegro/)
    expect(TEST).toMatch(/dry_run no movimientos nuevos/)
  })

  it('runner admin usa solo service_role backend y no imprime secretos', () => {
    expect(RUNNER).toMatch(/getSupabaseAdmin/)
    expect(RUNNER).toMatch(/isSupabaseAdminConfigured/)
    expect(RUNNER).toMatch(/--dry-run/)
    expect(RUNNER).toMatch(/--confirm/)
    expect(RUNNER).toMatch(/MAYORISTANET_VOID_CONFIRM/)
    expect(RUNNER).toMatch(/Nunca expone SUPABASE_SERVICE_ROLE_KEY/)
    expect(RUNNER).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY\)/)
    expect(RUNNER).not.toMatch(/console\.log\(process\.env/)
  })
})

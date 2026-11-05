import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-purchase-document-confirm-intent.sql', import.meta.url),
  'utf8',
)

describe('proposed-senda-purchase-document-confirm-intent.sql', () => {
  it('guarda el intento pendiente sin tocar el RPC ni los intentos exitosos', () => {
    const executable = SQL.replace(/--.*$/gm, '')
    expect(executable).toMatch(/create table public\.purchase_document_confirm_intents/)
    expect(executable).toMatch(/unique \(purchase_document_id\)/)
    expect(executable).toMatch(/unique \(confirm_idempotency_key\)/)
    expect(executable).toMatch(/lines jsonb not null/)
    expect(executable).toMatch(/grant select on table public\.purchase_document_confirm_intents to authenticated/)
    expect(executable).toMatch(/grant insert on table public\.purchase_document_confirm_intents to service_role/)
    expect(executable).not.toMatch(/grant insert on table public\.purchase_document_confirm_intents to authenticated/)
    expect(executable).not.toMatch(/senda_confirm_purchase_invoice_intake/)
    expect(executable).not.toMatch(/purchase_document_confirm_attempts/)
    expect(executable).not.toMatch(/alter table public\.purchase_documents/)
    expect(executable).not.toMatch(/create or replace function public\.senda_save_purchase_invoice\(/)
    expect(executable).toMatch(/create or replace function public\.senda_save_purchase_invoice_with_confirm_intent/)
    const raiseAt = executable.indexOf("raise exception 'CONFIRM_INTENT_REQUIRED'")
    const saveAt = executable.indexOf("public.senda_save_purchase_invoice(p - 'confirm_intent')")
    expect(raiseAt).toBeGreaterThan(-1)
    expect(saveAt).toBeGreaterThan(raiseAt)
    expect(executable).not.toMatch(/exception\s+when/i)
    expect(executable).toMatch(/insert into public\.purchase_document_confirm_intents/)
    expect(executable).toMatch(/raise exception 'CONFIRM_INTENT_LINE_MISMATCH'/)
    expect(executable).toMatch(/revoke update, delete on table public\.purchase_document_confirm_intents from service_role/)
    expect(executable).not.toMatch(/grant update/)
    expect(executable).toMatch(/grant execute on function public\.senda_save_purchase_invoice_with_confirm_intent\(jsonb\)/)
  })
})

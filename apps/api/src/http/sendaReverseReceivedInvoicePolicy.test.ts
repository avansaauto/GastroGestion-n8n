import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-reverse-received-invoice.sql', import.meta.url),
  'utf8',
)
const DOC = readFileSync(
  new URL('../../sql/proposed-senda-reverse-received-invoice.md', import.meta.url),
  'utf8',
)

describe('proposed-senda-reverse-received-invoice', () => {
  it('aborta y no reescribe cancel ni borra auditoría', () => {
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/REVERSE_RECEIVED_NOT_AUTHORIZED/)
    expect(SQL).not.toMatch(/create function public\.senda_reverse/)
    expect(SQL).not.toMatch(/create or replace function public\.senda_cancel_purchase_invoice/)
    expect(SQL).not.toMatch(/delete from public\.purchase_documents/)
    expect(SQL).not.toMatch(/delete from public\.purchase_document_audit/)
    expect(SQL).not.toMatch(/delete from public\.inventory_movements/)
    expect(DOC).toMatch(/NO IMPLEMENTAR/)
    expect(DOC).toMatch(/CANCEL_HAS_RECEIPTS/)
    expect(DOC).toMatch(/REVERSAL_WOULD_GO_NEGATIVE/)
    expect(DOC).toMatch(/last_purchase_unit_cost/)
  })
})

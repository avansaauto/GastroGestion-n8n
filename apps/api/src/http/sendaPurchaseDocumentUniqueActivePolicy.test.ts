import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveInvoiceSaveIdempotency } from './invoiceSaveStrategy.js'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-purchase-document-unique-active.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-purchase-document-unique-active.sql', import.meta.url),
  'utf8',
)
const DELETE_SQL = readFileSync(
  new URL('../../sql/proposed-senda-delete-purchase-invoice.sql', import.meta.url),
  'utf8',
)
const SAVE_TS = readFileSync(new URL('./invoiceSave.ts', import.meta.url), 'utf8')
const QUERY_TS = readFileSync(new URL('./invoiceQuery.ts', import.meta.url), 'utf8')

const active = {
  id: 'doc-active',
  organizationId: 'org-1',
  fileSha256: 'ab'.repeat(32),
  issuerTaxIdNormalized: '30707296832',
  voucherType: 'A',
  pointOfSale: '0012',
  voucherNumber: '00610241',
  status: 'reviewed',
}

const incoming = {
  organizationId: 'org-1',
  fileSha256: active.fileSha256,
  issuerTaxIdNormalized: active.issuerTaxIdNormalized,
  voucherType: active.voucherType,
  pointOfSale: active.pointOfSale,
  voucherNumber: active.voucherNumber,
}

describe('unicidad de factura activa', () => {
  it('recrea solo los dos índices y conserva cancelled más deleted_at', () => {
    const executable = SQL.replace(/--[^\n]*/g, '')
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(executable).toMatch(/drop index public\.purchase_documents_file_sha256_uniq;/)
    expect(executable).toMatch(/drop index public\.purchase_documents_voucher_uniq;/)
    expect(executable).toMatch(
      /create unique index purchase_documents_file_sha256_uniq[\s\S]*organization_id, file_sha256[\s\S]*status is distinct from 'cancelled'[\s\S]*deleted_at is null/,
    )
    expect(executable).toMatch(
      /create unique index purchase_documents_voucher_uniq[\s\S]*organization_id[\s\S]*issuer_tax_id_normalized[\s\S]*coalesce\(voucher_type, ''\)[\s\S]*coalesce\(point_of_sale, ''\)[\s\S]*voucher_number[\s\S]*status is distinct from 'cancelled'[\s\S]*deleted_at is null/,
    )
    expect(executable).not.toMatch(/create or replace function/i)
    expect(executable).not.toMatch(/senda_delete_purchase_invoice/)
    expect(executable).not.toMatch(/senda_receive_purchase_document_line/)
    expect(executable).not.toMatch(/senda_confirm_purchase_invoice_intake/)
    expect(executable).not.toMatch(/delete from public\.purchase_documents/i)
    expect(executable).not.toMatch(/status\s*=\s*'cancelled'/)
    expect(VERIFY).toMatch(/deleted_at is null/)
    expect(VERIFY).toMatch(/cancelled/)
    expect(VERIFY).not.toMatch(/\b(insert|update|delete)\b/i)
  })

  it('la detección de duplicados ya excluye eliminados y cancelled', () => {
    expect(SAVE_TS).toMatch(/\.is\('deleted_at', null\)/)
    expect(QUERY_TS).toMatch(/\.neq\('status', 'cancelled'\)/)
    expect(QUERY_TS).toMatch(/documents\.is\('deleted_at', null\)/)
  })

  it('rechaza un comprobante activo duplicado y deja pasar el eliminado', () => {
    expect(resolveInvoiceSaveIdempotency([active], incoming).action).toBe('return_existing')
    expect(resolveInvoiceSaveIdempotency([active], {
      ...incoming,
      fileSha256: 'cd'.repeat(32),
    }).action).toBe('reject_duplicate_voucher')
    // listOrgDocuments no entrega filas con deleted_at. Sin esa fila, se puede volver a cargar.
    expect(resolveInvoiceSaveIdempotency([], incoming).action).toBe('insert')
    expect(resolveInvoiceSaveIdempotency([{ ...active, status: 'cancelled' }], incoming).action).toBe('insert')
  })

  it('aísla otra organización', () => {
    expect(resolveInvoiceSaveIdempotency([active], {
      ...incoming,
      organizationId: 'org-2',
    }).action).toBe('insert')
  })

  it('la eliminación repetida sigue siendo lógica e idempotente, sin pasar a cancelled', () => {
    const start = DELETE_SQL.search(/create function public\.senda_delete_purchase_invoice\(p jsonb\)/i)
    const end = DELETE_SQL.indexOf('comment on function public.senda_delete_purchase_invoice', start)
    const body = DELETE_SQL.slice(start, end >= 0 ? end : undefined).replace(/--[^\n]*/g, '')
    expect(body).toMatch(/if v_deleted_at is not null/)
    expect(body).toMatch(/'replay', true/)
    expect(body).toMatch(/set deleted_at = v_now/)
    expect(body).toMatch(/deleted_by = v_actor/)
    expect(body).not.toMatch(/status\s*=\s*'cancelled'/i)
    expect(body).not.toMatch(/delete from public\.purchase_documents/i)
    expect(body).not.toMatch(/delete from public\.purchase_invoice_deletion_log/i)
    expect(body).not.toMatch(/storage\.objects/i)
  })
})

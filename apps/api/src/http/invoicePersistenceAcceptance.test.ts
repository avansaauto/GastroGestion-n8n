import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './fileHash.js'
import {
  issueInvoiceIntegrityToken,
  InvoiceIntegrityError,
} from './invoiceIntegrity.js'
import { assertInvoiceSaveRequest } from './invoiceSaveGuard.js'
import {
  INVOICE_SAVE_STRATEGY,
  invoiceStorageObjectPath,
  resolveInvoiceSaveIdempotency,
} from './invoiceSaveStrategy.js'
import { analyzeExtractedInvoice } from '../modules/invoice-intelligence/analyze.js'

const SQL = readFileSync(
  new URL('../../sql/migrate-invoice-persistence.sql', import.meta.url),
  'utf8',
)
const VERIFY_SQL = readFileSync(
  new URL('../../sql/verify-invoice-persistence.sql', import.meta.url),
  'utf8',
)

const commercial = JSON.parse(
  readFileSync(
    new URL('../modules/invoice-intelligence/fixtures/commercial-cases.json', import.meta.url),
    'utf8',
  ),
) as Record<string, Record<string, unknown>>

const services = JSON.parse(
  readFileSync(
    new URL('../modules/invoice-intelligence/fixtures/service-cases.json', import.meta.url),
    'utf8',
  ),
) as Record<string, Record<string, unknown>>

const invoices = JSON.parse(
  readFileSync(
    new URL('../modules/invoice-intelligence/fixtures/invoice-cases.json', import.meta.url),
    'utf8',
  ),
) as Record<string, Record<string, unknown>>

const SECRET = 'test-integrity-secret-not-for-production'
const PDF = Buffer.from('%PDF-1.4\nfixture')
const OTHER_PDF = Buffer.from('%PDF-1.4\nother')
const NOW = new Date('2026-10-14T14:00:00.000Z')

describe('contrato SQL de persistencia (Paso 293–294)', () => {
  it('no altera inventario, movimientos, purchase_items ni receipts', () => {
    expect(SQL).not.toMatch(/alter table public\.inventory_/i)
    expect(SQL).not.toMatch(/alter table public\.purchase_items/i)
    expect(SQL).not.toMatch(/alter table public\.purchase_receipts/i)
    expect(SQL).not.toMatch(/insert into public\.inventory_/i)
    expect(SQL).not.toMatch(/insert into public\.purchase_items/i)
    expect(SQL).not.toMatch(/insert into public\.purchase_receipts/i)
  })

  it('usa membresía DEFINER con user_id explícito, no current_user', () => {
    expect(SQL).toMatch(/create or replace function public\.senda_actor_is_purchase_member/)
    expect(SQL).toMatch(/senda_actor_is_purchase_member\(p_location_id uuid, p_user_id uuid\)/)
    expect(SQL).toMatch(/m\.user_id = p_user_id/)
    expect(SQL).not.toMatch(/m\.user_id = current_user/)
    const actorFn = SQL.slice(SQL.indexOf('senda_actor_is_purchase_member(p_location_id'))
    expect(actorFn.slice(0, 400)).toMatch(/security definer/)
    const memberFn = SQL.slice(SQL.indexOf('senda_is_purchase_member(p_location_id uuid)'))
    expect(memberFn.slice(0, 400)).toMatch(/security definer/)
    expect(SQL).toMatch(/v_actor := public\.senda_require_backend_actor/)
    expect(SQL).not.toMatch(/v_actor := auth\.uid\(\)/)
    expect(SQL).toMatch(/senda_actor_is_purchase_member\(v_location_id, v_actor\)/)
    expect(SQL).toMatch(/senda_actor_is_purchase_member\(v_location, v_actor\)/)
  })

  it('impide EXECUTE de escritura a authenticated; solo service_role + actor del backend', () => {
    expect(SQL).toMatch(/grant execute on function public\.senda_save_purchase_invoice\(jsonb\) to service_role/)
    expect(SQL).toMatch(/grant execute on function public\.senda_cancel_purchase_invoice\(uuid, uuid\) to service_role/)
    expect(SQL).toMatch(
      /grant execute on function public\.senda_map_purchase_document_line\(uuid, uuid, numeric, uuid\) to service_role/,
    )
    expect(SQL).not.toMatch(/grant execute on function public\.senda_save_purchase_invoice\(jsonb\) to authenticated/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_cancel_purchase_invoice\([^)]+\) to authenticated/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_map_purchase_document_line\([^)]+\) to authenticated/)
    expect(SQL).toMatch(/revoke all on function public\.senda_save_purchase_invoice\(jsonb\) from public, anon, authenticated/)
    expect(SQL).toMatch(/auth\.role\(\), ''\) is distinct from 'service_role'/)
    expect(SQL).toMatch(/raise exception 'BACKEND_ROLE_REQUIRED'/)
    expect(SQL).toMatch(/raise exception 'ACTOR_REQUIRED'/)
    expect(SQL).toMatch(/p->>'actor_user_id'/)
    expect(SQL).toMatch(/senda_cancel_purchase_invoice\(p_id uuid, p_actor_user_id uuid\)/)
    expect(SQL).toMatch(/p_actor_user_id uuid/)
    expect(SQL).toMatch(/revoke all on function public\.senda_require_backend_actor\(uuid\) from public, anon, authenticated, service_role/)
    expect(SQL).toMatch(/created_by\s*\) values/)
  })

  it('exige producto para cantidad física > 0', () => {
    expect(SQL).toMatch(/purchase_document_lines_qty_requires_product_chk/)
    expect(SQL).toMatch(/inventory_product_id is not null or inventory_physical_quantity = 0/)
    expect(SQL).toMatch(/when p_inventory_product_id is null then 0/)
  })

  it('bloquea anulación y mapeo con FOR UPDATE sobre la cabecera', () => {
    const cancelFn = SQL.slice(
      SQL.indexOf('create or replace function public.senda_cancel_purchase_invoice'),
      SQL.indexOf('create or replace function public.senda_map_purchase_document_line'),
    )
    const mapFn = SQL.slice(
      SQL.indexOf('create or replace function public.senda_map_purchase_document_line'),
    )
    expect(cancelFn).toMatch(/for update/)
    expect(mapFn).toMatch(/from public\.purchase_documents d[\s\S]*for update/)
    expect(mapFn).toMatch(/from public\.purchase_document_lines l[\s\S]*for update/)
  })

  it('no registra audit_payload del cliente', () => {
    expect(SQL).not.toMatch(/audit_payload/)
    expect(SQL).toMatch(/jsonb_build_object\(\s*'actor_user_id', v_actor/)
    expect(SQL).toMatch(/'invoice_reviewed'/)
    expect(SQL).toMatch(/'invoice_cancelled'/)
    expect(SQL).toMatch(/'invoice_line_mapped'/)
  })

  it('confirma reviewed en la misma función que inserta draft y líneas (rollback atómico)', () => {
    const saveFn = SQL.slice(
      SQL.indexOf('create or replace function public.senda_save_purchase_invoice'),
      SQL.indexOf('create or replace function public.senda_cancel_purchase_invoice'),
    )
    expect(saveFn).toMatch(/'draft'/)
    expect(saveFn).toMatch(/insert into public\.purchase_document_lines/)
    expect(saveFn).toMatch(/set status = 'reviewed'/)
    expect(saveFn).toMatch(/insert into public\.purchase_document_audit/)
    expect(saveFn).toMatch(/SAVE_NOT_ALLOWED_NO_INVENTORY/)
  })

  it('deja la verificación posterior en solo lectura', () => {
    expect(SQL).toMatch(/MIGRACIÓN DEFINITIVA/)
    const withoutComments = VERIFY_SQL.replace(/--[^\n]*/g, '')
    expect(withoutComments).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop|truncate|call)\b/im)
    expect(VERIFY_SQL).toMatch(/SOLO LECTURA/)
    expect(VERIFY_SQL).toMatch(/has_function_privilege/)
    expect(VERIFY_SQL).toMatch(/authenticated sin EXECUTE de save/)
    expect(VERIFY_SQL).toMatch(/authenticated sin EXECUTE de cancel/)
    expect(VERIFY_SQL).toMatch(/authenticated sin EXECUTE de map/)
    expect(VERIFY_SQL).toMatch(/Save llama a senda_require_backend_actor/)
    expect(VERIFY_SQL).toMatch(/require_backend_actor exige service_role y actor no nulo/)
    expect(VERIFY_SQL).not.toMatch(
      /senda_save_purchase_invoice\(jsonb\)'\:\:regprocedure\)\s+like '%BACKEND_ROLE_REQUIRED%'/,
    )
    expect(VERIFY_SQL).toMatch(/purchase_document_lines_qty_requires_product_chk/)
    expect(VERIFY_SQL).toMatch(/inventory_physical_quantity\\s\*=\\s\*\\/)
    expect(VERIFY_SQL).toMatch(/~\*/)
    expect(VERIFY_SQL).not.toMatch(/inventory_physical_quantity = 0%'/)
  })
})

describe('aceptación: guardar y rechazar', () => {
  it('permite guardar mercadería PILSEN confirmada (elegible ≥ 1, sin stock)', () => {
    const result = analyzeExtractedInvoice(commercial.pilsenFullBonus, {}, {
      commercialDecisions: [{
        adjustmentSourceIndex: 3,
        targetSourceIndex: 4,
        decision: 'confirm',
        type: 'bonus',
      }],
    })
    const bonus = result.interpretation.lines.find((line) =>
      result.interpretation.relations[0]?.adjustmentLineIds.includes(line.lineId),
    )

    expect(result.inventorySummary.eligibleLines).toBeGreaterThanOrEqual(1)
    expect(bonus?.physical).toMatchObject({ movement: 'none', proposedQuantity: 0 })
    expect(result.document.lines.some((line) => (line.amount ?? 0) < 0)).toBe(true)
    expect(INVOICE_SAVE_STRATEGY.steps).toContain('never_write_purchase_items_or_inventory')
    expect(INVOICE_SAVE_STRATEGY.steps).toContain('rpc_senda_save_purchase_invoice')
  })

  it('rechaza documentos solo de servicios (MetroGAS)', () => {
    const result = analyzeExtractedInvoice(services.metrogasReference)
    expect(result.inventorySummary.eligibleLines).toBe(0)
    expect(result.document.classification).toBe('service')
    expect(SQL).toMatch(/SAVE_NOT_ALLOWED_NO_INVENTORY/)
  })

  it('guarda mercadería sin vincular a productos', () => {
    const result = analyzeExtractedInvoice(invoices.foodInvoice)
    expect(result.inventorySummary.eligibleLines).toBeGreaterThanOrEqual(1)
    expect(SQL).toMatch(/then 'unmapped' else 'not_applicable' end,\s*\n\s*null,/)
    expect(SQL).toMatch(/when v_eligibility = 'eligible' then 'unmapped'/)
  })

  it('guarda descuentos y bonificaciones sin cantidades físicas negativas', () => {
    const result = analyzeExtractedInvoice(commercial.pilsenFullBonus)
    const negatives = result.document.lines.filter((line) => (line.amount ?? 0) < 0)
    expect(negatives.length).toBeGreaterThan(0)
    expect(negatives.every((line) => (line.inventoryPhysicalQuantity ?? 0) >= 0)).toBe(true)
    expect(SQL).toMatch(/inventory_physical_quantity >= 0/)
    expect(SQL).toMatch(/purchase_document_lines_negative_not_stock_chk/)
  })
})

describe('aceptación: duplicados, org, HMAC, anulación', () => {
  const org1 = {
    id: 'doc-1',
    organizationId: 'org-1',
    fileSha256: sha256Hex(PDF),
    issuerTaxIdNormalized: '30123456781',
    voucherType: 'A',
    pointOfSale: '0001',
    voucherNumber: '00000001',
    status: 'reviewed',
  }

  it('rechaza duplicado por hash y por identidad fiscal', () => {
    expect(resolveInvoiceSaveIdempotency([org1], {
      organizationId: 'org-1',
      fileSha256: sha256Hex(PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    }).action).toBe('return_existing')

    expect(resolveInvoiceSaveIdempotency([org1], {
      organizationId: 'org-1',
      fileSha256: sha256Hex(OTHER_PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    }).action).toBe('reject_duplicate_voucher')
  })

  it('impide acceso cruzado entre organizaciones', () => {
    expect(resolveInvoiceSaveIdempotency([org1], {
      organizationId: 'org-2',
      fileSha256: sha256Hex(PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    }).action).toBe('insert')
    expect(SQL).toMatch(/m\.organization_id = l\.organization_id/)
    expect(SQL).toMatch(/PRODUCT_ORG_MISMATCH/)
    expect(SQL).toMatch(/NOT_A_MEMBER/)
  })

  it('rechaza modificar el análisis original cubierto por HMAC', () => {
    const snapshot = {
      document: { lines: [{ id: 'line-1', amount: 10 }] },
      interpretation: { relations: [], consistency: 'consistent' },
      validation: { status: 'ready' },
      inventory: { eligibleLines: 1, shouldOfferFutureReceipt: true },
      metadata: {
        provider: 'fake-ai',
        model: 'fixture',
        promptVersion: 'senda-invoice-v2-service',
        processingTimeMs: 1,
        fileSha256: sha256Hex(PDF),
      },
    }
    const issued = issueInvoiceIntegrityToken({
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot,
      secret: SECRET,
      now: NOW,
    })
    expect(() => assertInvoiceSaveRequest({
      userId: 'user-1',
      fileBytes: PDF,
      snapshot: {
        ...snapshot,
        document: { lines: [{ id: 'line-1', amount: 99 }] },
      },
      integrityToken: issued.token,
      commercialDecisions: [],
      organizationId: 'org-1',
      extension: 'pdf',
      secret: SECRET,
      now: NOW,
    })).toThrow(InvoiceIntegrityError)
    expect(SQL).toMatch(/ORIGINAL_ANALYSIS_IMMUTABLE/)
    expect(invoiceStorageObjectPath('org-1', sha256Hex(PDF), 'pdf')).toBe(
      `org-1/invoices/${sha256Hex(PDF)}.pdf`,
    )
  })

  it('un comprobante eliminado no ocupa la identidad: la lista activa permite cargarlo de nuevo', () => {
    expect(resolveInvoiceSaveIdempotency([], {
      organizationId: 'org-1',
      fileSha256: sha256Hex(PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    }).action).toBe('insert')
  })

  it('anula sin reactivar: cancelled sale de únicos y es terminal', () => {
    expect(resolveInvoiceSaveIdempotency([{ ...org1, status: 'cancelled' }], {
      organizationId: 'org-1',
      fileSha256: sha256Hex(OTHER_PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    }).action).toBe('insert')
    expect(SQL).toMatch(/CANCELLED_TERMINAL/)
    expect(SQL).toMatch(/CANCEL_REQUIRES_REVIEWED/)
    expect(SQL).not.toMatch(/old\.status = 'cancelled' and new\.status = 'reviewed'/)
  })
})

import { describe, expect, it } from 'vitest'
import { CommercialDecisionError } from './invoiceCommercialDecisions.js'
import { sha256Hex } from './fileHash.js'
import {
  issueInvoiceIntegrityToken,
  InvoiceIntegrityError,
  type InvoiceIntegritySnapshot,
} from './invoiceIntegrity.js'
import { assertInvoiceSaveRequest } from './invoiceSaveGuard.js'
import {
  describeInvoiceSaveRecovery,
  INVOICE_SAVE_STRATEGY,
  invoiceStorageObjectPath,
  resolveInvoiceSaveIdempotency,
} from './invoiceSaveStrategy.js'

const SECRET = 'test-integrity-secret-not-for-production'
const PDF = Buffer.from('%PDF-1.4\nfixture')
const OTHER_PDF = Buffer.from('%PDF-1.4\nother')
const NOW = new Date('2026-10-14T14:00:00.000Z')

function snapshot(overrides: Partial<InvoiceIntegritySnapshot> = {}): InvoiceIntegritySnapshot {
  return {
    document: {
      supplier: { name: 'Alimentos Demo SA', taxId: '30-12345678-1' },
      amounts: { total: 1210 },
      lines: [
        { id: 'line-pilsen', amount: 82500, unitPrice: 1650, quantity: 50 },
        { id: 'line-bonus', amount: -82500, unitPrice: -82500, quantity: 1 },
      ],
    },
    interpretation: {
      relations: [{
        id: 'relation-line-bonus',
        type: 'bonus',
        targetLineId: 'line-pilsen',
        adjustmentLineIds: ['line-bonus'],
        proposedPhysicalQuantity: 50,
        unit: 'L',
        bonusAmount: 82500,
        grossAmount: 82500,
        netAcquisitionAmount: 0,
      }],
      consistency: 'consistent',
    },
    validation: { status: 'ready' },
    inventory: { eligibleLines: 1, shouldOfferFutureReceipt: true },
    metadata: {
      provider: 'fake-ai',
      model: 'fixture',
      promptVersion: 'senda-invoice-v2-service',
      processingTimeMs: 12,
      fileSha256: sha256Hex(PDF),
    },
    ...overrides,
  }
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    relationId: 'relation-line-bonus',
    decision: 'confirm' as const,
    type: 'bonus' as const,
    targetLineId: 'line-pilsen',
    adjustmentLineIds: ['line-bonus'],
    proposedPhysicalQuantity: 50,
    unit: 'L',
    bonusAmount: 82500,
    grossAmount: 82500,
    netAcquisitionAmount: 0,
    originalAdjustmentAmounts: [
      { lineId: 'line-bonus', amount: -82500, unitPrice: -82500, quantity: 1 },
    ],
    ...overrides,
  }
}

function signed(data = snapshot(), userId = 'user-1', file = PDF) {
  return issueInvoiceIntegrityToken({
    userId,
    fileSha256: sha256Hex(file),
    snapshot: data,
    secret: SECRET,
    now: NOW,
  })
}

describe('guardia de integridad previa al guardado', () => {
  it('acepta un token válido y calcula el path content-addressed', () => {
    const data = snapshot()
    const issued = signed(data)
    const result = assertInvoiceSaveRequest({
      userId: 'user-1',
      fileBytes: PDF,
      snapshot: { ...data, metadata: { ...data.metadata, integrityToken: issued.token } },
      integrityToken: issued.token,
      commercialDecisions: [decision()],
      organizationId: 'org-1',
      extension: 'pdf',
      secret: SECRET,
      now: new Date('2026-10-14T14:30:00.000Z'),
    })
    expect(result.fileSha256).toBe(sha256Hex(PDF))
    expect(result.claims.sub).toBe('user-1')
    expect(result.storagePath).toBe(invoiceStorageObjectPath('org-1', sha256Hex(PDF), 'pdf'))
    expect(issued.token).not.toContain(SECRET)
  })

  it('rechaza un token modificado', () => {
    const data = snapshot()
    const issued = signed(data)
    expect(() => assertInvoiceSaveRequest({
      userId: 'user-1',
      fileBytes: PDF,
      snapshot: data,
      integrityToken: `${issued.token.slice(0, -4)}aaaa`,
      commercialDecisions: [decision()],
      organizationId: 'org-1',
      extension: 'pdf',
      secret: SECRET,
      now: NOW,
    })).toThrow(InvoiceIntegrityError)
  })

  it('rechaza un archivo diferente aunque el cliente copie el hash', () => {
    const data = snapshot()
    const issued = signed(data)
    expect(() => assertInvoiceSaveRequest({
      userId: 'user-1',
      fileBytes: OTHER_PDF,
      snapshot: {
        ...data,
        metadata: { ...data.metadata, fileSha256: sha256Hex(PDF) },
      },
      integrityToken: issued.token,
      commercialDecisions: [decision()],
      organizationId: 'org-1',
      extension: 'pdf',
      secret: SECRET,
      now: NOW,
    })).toThrow(/archivo no coincide/)
  })

  it('rechaza un snapshot con importes alterados', () => {
    const data = snapshot()
    const issued = signed(data)
    expect(() => assertInvoiceSaveRequest({
      userId: 'user-1',
      fileBytes: PDF,
      snapshot: snapshot({
        document: {
          supplier: { name: 'Alimentos Demo SA', taxId: '30-12345678-1' },
          amounts: { total: 1 },
          lines: [
            { id: 'line-pilsen', amount: 1, unitPrice: 1650, quantity: 50 },
            { id: 'line-bonus', amount: -82500, unitPrice: -82500, quantity: 1 },
          ],
        },
      }),
      integrityToken: issued.token,
      commercialDecisions: [decision()],
      organizationId: 'org-1',
      extension: 'pdf',
      secret: SECRET,
      now: NOW,
    })).toThrow(/modificado/)
  })

  it('rechaza un usuario diferente', () => {
    const data = snapshot()
    const issued = signed(data)
    expect(() => assertInvoiceSaveRequest({
      userId: 'user-2',
      fileBytes: PDF,
      snapshot: data,
      integrityToken: issued.token,
      commercialDecisions: [decision()],
      organizationId: 'org-1',
      extension: 'pdf',
      secret: SECRET,
      now: NOW,
    })).toThrow(/otro usuario/)
  })

  it('rechaza un token expirado', () => {
    const data = snapshot()
    const issued = issueInvoiceIntegrityToken({
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
      ttlSeconds: 60,
      now: NOW,
    })
    expect(() => assertInvoiceSaveRequest({
      userId: 'user-1',
      fileBytes: PDF,
      snapshot: data,
      integrityToken: issued.token,
      commercialDecisions: [decision()],
      organizationId: 'org-1',
      extension: 'pdf',
      secret: SECRET,
      now: new Date('2026-10-14T14:05:00.000Z'),
    })).toThrow(/expiró/)
  })

  it('rechaza decisiones comerciales manipuladas aunque el token sea válido', () => {
    const data = snapshot()
    const issued = signed(data)
    expect(() => assertInvoiceSaveRequest({
      userId: 'user-1',
      fileBytes: PDF,
      snapshot: data,
      integrityToken: issued.token,
      commercialDecisions: [decision({ bonusAmount: 1 })],
      organizationId: 'org-1',
      extension: 'pdf',
      secret: SECRET,
      now: NOW,
    })).toThrow(CommercialDecisionError)
  })
})

describe('duplicados y reintentos', () => {
  const existing = [{
    id: 'doc-1',
    organizationId: 'org-1',
    fileSha256: sha256Hex(PDF),
    issuerTaxIdNormalized: '30123456781',
    voucherType: 'A',
    pointOfSale: '0001',
    voucherNumber: '00000001',
    status: 'reviewed',
  }]

  it('trata el mismo hash como reintento idempotente', () => {
    expect(resolveInvoiceSaveIdempotency(existing, {
      organizationId: 'org-1',
      fileSha256: sha256Hex(PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    })).toEqual({ action: 'return_existing', id: 'doc-1', reason: 'file_hash' })
    expect(describeInvoiceSaveRecovery('duplicate_hash')).toMatch(/idempotente/)
  })

  it('rechaza otro archivo con el mismo comprobante', () => {
    expect(resolveInvoiceSaveIdempotency(existing, {
      organizationId: 'org-1',
      fileSha256: sha256Hex(OTHER_PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    })).toEqual({ action: 'reject_duplicate_voucher', id: 'doc-1' })
  })

  it('sigue tratando received como documento activo para duplicados', () => {
    expect(resolveInvoiceSaveIdempotency([{
      ...existing[0],
      status: 'received',
    }], {
      organizationId: 'org-1',
      fileSha256: sha256Hex(OTHER_PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    })).toEqual({ action: 'reject_duplicate_voucher', id: 'doc-1' })
  })

  it('permite reutilizar identidad fiscal de un comprobante cancelled', () => {
    expect(resolveInvoiceSaveIdempotency([{
      ...existing[0],
      status: 'cancelled',
    }], {
      organizationId: 'org-1',
      fileSha256: sha256Hex(OTHER_PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000001',
    })).toEqual({ action: 'insert' })
  })

  it('permite insertar un comprobante nuevo', () => {
    expect(resolveInvoiceSaveIdempotency(existing, {
      organizationId: 'org-1',
      fileSha256: sha256Hex(OTHER_PDF),
      issuerTaxIdNormalized: '30123456781',
      voucherType: 'A',
      pointOfSale: '0001',
      voucherNumber: '00000099',
    })).toEqual({ action: 'insert' })
  })

  it('no usa move de Storage ni objetos temporales', () => {
    expect(INVOICE_SAVE_STRATEGY.steps).toContain('upload_private_content_addressed_object')
    expect(INVOICE_SAVE_STRATEGY.steps).toContain('verify_hmac_integrity_token')
    expect(INVOICE_SAVE_STRATEGY.steps).not.toContain('move_or_commit_final_path')
    expect(INVOICE_SAVE_STRATEGY.steps).not.toContain('upload_private_temp_object')
    expect(INVOICE_SAVE_STRATEGY.steps).toContain('rpc_senda_save_purchase_invoice')
    expect(INVOICE_SAVE_STRATEGY.steps.indexOf('verify_hmac_integrity_token')).toBeLessThan(
      INVOICE_SAVE_STRATEGY.steps.indexOf('rpc_senda_save_purchase_invoice'),
    )
    expect(INVOICE_SAVE_STRATEGY.steps.indexOf('recalculate_fiscal_and_documentary')).toBeLessThan(
      INVOICE_SAVE_STRATEGY.steps.indexOf('rpc_senda_save_purchase_invoice'),
    )
    expect(INVOICE_SAVE_STRATEGY.steps.indexOf('bind_actor_from_getUser')).toBeLessThan(
      INVOICE_SAVE_STRATEGY.steps.indexOf('rpc_senda_save_purchase_invoice'),
    )
    expect(INVOICE_SAVE_STRATEGY.steps).not.toContain('insert_document_lines_analysis_audit')
    expect(INVOICE_SAVE_STRATEGY.steps).toContain('never_write_purchase_items_or_inventory')
    expect(describeInvoiceSaveRecovery('insert_failed')).toMatch(/Dejar el objeto/)
    expect(describeInvoiceSaveRecovery('orphan_cleanup_failed')).toMatch(/No revertir/)
  })
})

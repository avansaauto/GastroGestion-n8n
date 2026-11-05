import { describe, expect, it } from 'vitest'
import {
  assertCommercialDecisions,
  CommercialDecisionError,
  type InvoiceCommercialDecisionPayload,
} from './invoiceCommercialDecisions.js'
import { describeInvoiceSaveRecovery, INVOICE_SAVE_STRATEGY } from './invoiceSaveStrategy.js'
import { sha256Hex } from './fileHash.js'

const original = {
  relations: [{
    id: 'relation-line-bonus',
    type: 'bonus' as const,
    targetLineId: 'line-pilsen',
    adjustmentLineIds: ['line-bonus'],
    proposedPhysicalQuantity: 50,
    unit: 'L',
    bonusAmount: 82500,
    grossAmount: 82500,
    netAcquisitionAmount: 0,
  }],
  lines: [
    { id: 'line-pilsen', amount: 82500, unitPrice: 1650, quantity: 50 },
    { id: 'line-bonus', amount: -82500, unitPrice: -82500, quantity: 1 },
  ],
}

function payload(
  overrides: Partial<InvoiceCommercialDecisionPayload> = {},
): InvoiceCommercialDecisionPayload {
  return {
    relationId: 'relation-line-bonus',
    decision: 'confirm',
    type: 'bonus',
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

describe('contrato de decisiones comerciales', () => {
  it('acepta una confirmación que reproduce el análisis original', () => {
    expect(() => assertCommercialDecisions(original, [payload()])).not.toThrow()
  })

  it('rechaza un importe de bonificación alterado', () => {
    expect(() => assertCommercialDecisions(original, [payload({ bonusAmount: 1 })])).toThrow(
      CommercialDecisionError,
    )
    try {
      assertCommercialDecisions(original, [payload({ bonusAmount: 1 })])
    } catch (error) {
      expect(error).toMatchObject({ code: 'DECISION_TAMPERED' })
    }
  })

  it('rechaza cambiar las líneas involucradas o inventar una relación', () => {
    expect(() => assertCommercialDecisions(original, [payload({
      adjustmentLineIds: ['line-pilsen'],
    })])).toThrow(/no coincide/)
    expect(() => assertCommercialDecisions(original, [payload({
      relationId: 'relation-inventada',
    })])).toThrow(/no existe/)
  })

  it('rechaza reescribir el importe original negativo de la línea de ajuste', () => {
    expect(() => assertCommercialDecisions(original, [payload({
      originalAdjustmentAmounts: [
        { lineId: 'line-bonus', amount: 82500, unitPrice: -82500, quantity: 1 },
      ],
    })])).toThrow(/importes originales/)
  })
})

describe('hash y plan de guardado', () => {
  it('hasha los bytes reales', () => {
    expect(sha256Hex(Buffer.from('%PDF-1.4\nfixture'))).toMatch(/^[a-f0-9]{64}$/)
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('b')))
  })

  it('separa Storage de PostgreSQL ante fallos', () => {
    expect(INVOICE_SAVE_STRATEGY.steps).toContain('hash_received_bytes')
    expect(INVOICE_SAVE_STRATEGY.steps).toContain('upload_private_content_addressed_object')
    expect(INVOICE_SAVE_STRATEGY.steps).toContain('rpc_senda_save_purchase_invoice')
    expect(describeInvoiceSaveRecovery('insert_failed')).toMatch(/Dejar el objeto/)
    expect(describeInvoiceSaveRecovery('hash_mismatch')).toMatch(/No subir/)
  })
})

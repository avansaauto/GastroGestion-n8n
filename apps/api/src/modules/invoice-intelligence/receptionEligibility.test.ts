import { describe, expect, it } from 'vitest'
import { analyzeExtractedInvoice } from './analyze.js'
import {
  evaluateReceptionEligibility,
  UNRESOLVED_ELIGIBILITY_CONTEXT,
} from './receptionEligibility.js'

function invoice(overrides: Record<string, unknown> = {}, lineOverrides: Record<string, unknown> = {}) {
  return {
    supplier_name: 'MAYORISTANET.COM S.A.',
    supplier_tax_id: '30-71482322-7',
    document_type: 'A',
    document_number: '0012-00000001',
    issue_date: '2026-07-15',
    currency: 'ARS',
    subtotal: 100,
    discounts: 0,
    tax: 21,
    other_taxes: 0,
    total: 121,
    taxes_included: false,
    main_category: 'gastronomic_merchandise',
    doubtful_fields: [],
    warnings: [],
    lines: [{
      description_original: 'Queso Mozzarella P/Fetear La Paulina Barra x 3,5 Kg',
      name: 'Queso Mozzarella P/Fetear La Paulina Barra x 3,5 Kg',
      quantity: 1,
      unit: 'barra',
      package_count: 1,
      content_per_unit: 3.5,
      content_unit: 'kg',
      unit_price: 100,
      amount: 100,
      tax_rate: 21,
      discount: 0,
      is_summary: false,
      ...lineOverrides,
    }],
    ...overrides,
  }
}

function evaluate(extracted: unknown) {
  return evaluateReceptionEligibility(analyzeExtractedInvoice(extracted))
}

describe('evaluateReceptionEligibility', () => {
  it('marca validación preliminar satisfactoria sin autorizar la recepción', () => {
    const eligibility = evaluate(invoice())

    expect(eligibility.documentDecision).toBe('preliminary_ok')
    expect(eligibility.definitive).toBe('undetermined')
    expect(eligibility.autoApprovable).toBe(false)
    expect(eligibility.reasons).toEqual([])
    expect(eligibility.unresolvedContext).toEqual(UNRESOLVED_ELIGIBILITY_CONTEXT)
    expect(eligibility.unresolvedContext).toEqual([
      'organization',
      'location',
      'exact_product_links',
      'duplicate_detection',
      'reception_policy',
    ])
  })

  it('bloquea un total fiscal que no cierra', () => {
    const eligibility = evaluate(invoice({ total: 200 }))

    expect(eligibility.documentDecision).toBe('blocked')
    expect(eligibility.autoApprovable).toBe(false)
    expect(eligibility.definitive).toBe('undetermined')
    expect(eligibility.reasons.some((item) => item.code === 'DOCUMENT_TOTAL_MISMATCH')).toBe(true)
  })

  it('bloquea un precio ambiguo entre unidad comercial y peso', () => {
    const eligibility = evaluate(invoice({}, {
      description_original: 'Queso Mozzarella Doña Aurora Plancha x 8,8 kg Aprox',
      name: 'Queso Mozzarella Doña Aurora Plancha x 8,8 kg Aprox',
      quantity: 2,
      unit: 'plancha',
      package_count: 2,
      content_per_unit: 8.8,
      content_unit: 'kg',
      unit_price: 10,
      amount: 100,
    }))

    expect(eligibility.documentDecision).toBe('blocked')
    expect(eligibility.reasons.some((item) =>
      item.code === 'PRICE_BASIS_UNRESOLVED' || item.code === 'LINE_PRICE_BASIS_REQUIRES_REVIEW',
    )).toBe(true)
  })

  it('bloquea una línea de stock sin cantidad', () => {
    const eligibility = evaluate(invoice({}, {
      quantity: null,
      package_count: null,
    }))

    expect(eligibility.documentDecision).toBe('blocked')
    expect(eligibility.reasons.some((item) =>
      item.code === 'LINE_FIELD_MISSING' || item.code === 'PHYSICAL_QUANTITY_UNRESOLVED',
    )).toBe(true)
  })

  it('bloquea una unidad comercial sin cantidad física resuelta', () => {
    const eligibility = evaluate(invoice({}, {
      description_original: 'Harina 000',
      name: 'Harina 000',
      quantity: 2,
      unit: 'u',
      package_count: null,
      content_per_unit: null,
      content_unit: null,
      unit_price: 50,
      amount: 100,
    }))

    expect(eligibility.documentDecision).toBe('blocked')
    expect(eligibility.reasons.some((item) => item.code === 'PHYSICAL_QUANTITY_UNRESOLVED')).toBe(true)
    expect(eligibility.unresolvedContext).toContain('exact_product_links')
    expect(eligibility.unresolvedContext).toContain('organization')
  })

  it('trata una advertencia bloqueante como bloqueo y no consulta vínculos', () => {
    const analyzed = analyzeExtractedInvoice(invoice())
    const eligibility = evaluateReceptionEligibility({
      ...analyzed,
      validation: {
        ...analyzed.validation,
        warnings: [
          ...analyzed.validation.warnings,
          {
            code: 'BLOCKING_WARNING',
            severity: 'warning',
            message: 'Advertencia que impide recibir.',
            blocksReview: false,
            blocksReception: true,
          },
        ],
      },
    })

    expect(eligibility.documentDecision).toBe('blocked')
    expect(eligibility.reasons.some((item) => item.code === 'BLOCKING_WARNING')).toBe(true)
    expect(eligibility.autoApprovable).toBe(false)
    expect(eligibility.definitive).toBe('undetermined')
  })
})

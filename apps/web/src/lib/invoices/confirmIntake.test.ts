import { describe, expect, it } from 'vitest'
import { buildConfirmIntakeLines, confirmIntakeBlockReason, matchExistingIngredient } from './confirmIntake'
import { emptyReviewMappingDraft, proposeCreateMappingDraft } from './reviewMapping'
import type { InvoiceAnalysisLine } from './types'

const PRODUCT = { id: 'p1', name: 'Cerveza', baseUnit: 'ml' }

function liquid(overrides: Partial<InvoiceAnalysisLine> = {}): InvoiceAnalysisLine {
  return {
    id: 'line-1',
    sourceIndex: 0,
    originalDescription: 'Cerveza',
    name: 'Cerveza',
    supplierSku: null,
    quantity: 2,
    unit: 'L',
    unitPrice: 10,
    amount: 20,
    classification: 'stock',
    inventoryEligibility: 'eligible',
    quantityKind: 'inventory',
    inventoryPhysicalQuantity: 2,
    missingFields: [],
    ambiguities: [],
    ...overrides,
  }
}

describe('confirmIntake helpers', () => {
  it('bloquea confirmación sin factor de empaque', () => {
    const line = liquid({ unit: 'caja' })
    const reason = confirmIntakeBlockReason(
      [line],
      { 'line-1': '1' },
      {
        'line-1': {
          ...emptyReviewMappingDraft(),
          action: 'link_existing',
          inventoryProductId: PRODUCT.id,
        },
      },
      [PRODUCT],
    )
    expect(reason).toMatch(/factor de conversión/)
  })

  it('arma create, pending y recepción parcial en unidad base', () => {
    const lines = buildConfirmIntakeLines(
      [liquid(), liquid({ id: 'line-2', name: 'Pendiente' })],
      { 'line-1': '1', 'line-2': '2' },
      {
        'line-1': {
          ...emptyReviewMappingDraft(),
          action: 'create',
          createIntent: {
            name: 'Pilsen',
            baseUnit: 'ml',
            category: null,
            minimumStock: null,
          },
        },
        'line-2': emptyReviewMappingDraft(),
      },
      [PRODUCT],
      () => 'key-1',
    )
    expect(lines).toEqual([
      expect.objectContaining({
        purchaseDocumentLineId: 'line-1',
        action: 'create',
        receiveQuantity: 1000,
        conversionFactor: 1000,
        receiveIdempotencyKey: 'key-1',
        create: expect.objectContaining({ name: 'Pilsen', baseUnit: 'ml' }),
      }),
      expect.objectContaining({
        purchaseDocumentLineId: 'line-2',
        action: 'pending',
      }),
    ])
  })

  it('create con barra usa física analizada (no uni→g)', () => {
    const line = liquid({
      id: 'line-barra',
      name: 'Queso Mozzarella P/Fetear La Paulina Barra x 3,5 Kg',
      quantity: 1,
      unit: 'barra',
      inventoryPhysicalQuantity: 3500,
      amount: 26287.08,
    })
    const lines = buildConfirmIntakeLines(
      [line],
      { 'line-barra': '1' },
      {
        'line-barra': {
          ...emptyReviewMappingDraft(),
          action: 'create',
          conversionFactor: 3500,
          createIntent: {
            name: line.name,
            baseUnit: 'g',
            category: null,
            minimumStock: null,
          },
        },
      },
      [],
      () => 'key-barra',
    )
    expect(lines[0]).toMatchObject({
      action: 'create',
      conversionFactor: 3500,
      receiveQuantity: 3500,
    })
    expect(confirmIntakeBlockReason(
      [line],
      { 'line-barra': '1' },
      {
        'line-barra': {
          ...emptyReviewMappingDraft(),
          action: 'create',
          conversionFactor: 3500,
          createIntent: {
            name: line.name,
            baseUnit: 'g',
            category: null,
            minimumStock: null,
          },
        },
      },
      [],
    )).toBeNull()
  })
})

describe('MAYORISTANET 0012-00610241 — confirmación', () => {
  function stock(overrides: Partial<InvoiceAnalysisLine>): InvoiceAnalysisLine {
    return liquid({
      unitPrice: 10,
      amount: 10,
      ...overrides,
    })
  }

  const paulina = stock({
    id: 'paulina',
    name: 'Queso Mozzarella P/Fetear La Paulina Barra',
    originalDescription: 'Queso Mozzarella P/Fetear La Paulina Barra',
    quantity: 2,
    unit: 'barra',
    contentUnit: 'kg',
    inventoryPhysicalQuantity: 7000,
  })
  const aurora = stock({
    id: 'aurora',
    name: 'Queso Mozzarella Doña Aurora Plancha',
    originalDescription: 'Queso Mozzarella Doña Aurora Plancha',
    quantity: 1,
    unit: 'plancha',
    contentUnit: 'kg',
    inventoryPhysicalQuantity: 8880,
  })
  const azucar = stock({
    id: 'azucar',
    name: 'Azucar Blanca Ledesma Pack',
    quantity: 1,
    unit: 'pack',
    contentUnit: 'kg',
    inventoryPhysicalQuantity: 10000,
  })
  const leche = stock({
    id: 'leche',
    name: 'Leche Entera Larga Vida Tregar Pack',
    quantity: 1,
    unit: 'pack',
    contentUnit: 'l',
    inventoryPhysicalQuantity: 12000,
  })
  const pan = stock({
    id: 'pan',
    name: 'Pan Rallado Exclusivo Bolsa',
    quantity: 2,
    unit: 'bolsa',
    contentUnit: 'kg',
    inventoryPhysicalQuantity: 10000,
  })
  const pimienta = stock({
    id: 'pimienta',
    name: 'Pimienta Negra Molida Marfeli Bolsa',
    quantity: 1,
    unit: 'bolsa',
    contentUnit: 'kg',
    inventoryPhysicalQuantity: 1000,
  })
  const lines = [paulina, aurora, azucar, leche, pan, pimienta]

  function drafts() {
    return Object.fromEntries(lines.map((line) => {
      const draft = proposeCreateMappingDraft(line)
      return [line.id, draft]
    }))
  }

  it('crea en la unidad física y deja Doña Aurora vinculable sin recepción', () => {
    expect(proposeCreateMappingDraft(pan).createIntent?.baseUnit).toBe('g')
    expect(proposeCreateMappingDraft(leche).createIntent?.baseUnit).toBe('ml')
    expect(proposeCreateMappingDraft(pimienta).createIntent?.baseUnit).toBe('g')

    const payload = buildConfirmIntakeLines(
      lines,
      Object.fromEntries(lines.map((line) => [line.id, String(line.quantity)])),
      drafts(),
      [],
      () => 'recv-key',
      new Set(['aurora']),
    )
    const byId = Object.fromEntries(payload.map((line) => [line.purchaseDocumentLineId, line]))
    expect(byId.paulina).toMatchObject({ action: 'create', conversionFactor: 3500, receiveQuantity: 7000 })
    expect(byId.aurora).toMatchObject({
      action: 'create',
      conversionFactor: 8880,
      receiveQuantity: null,
      receiveIdempotencyKey: null,
    })
    expect(byId.azucar).toMatchObject({ conversionFactor: 10000, receiveQuantity: 10000, create: { baseUnit: 'g' } })
    expect(byId.leche).toMatchObject({ conversionFactor: 12000, receiveQuantity: 12000, create: { baseUnit: 'ml' } })
    expect(byId.pan).toMatchObject({ conversionFactor: 5000, receiveQuantity: 10000, create: { baseUnit: 'g' } })
    expect(byId.pan.create?.baseUnit).not.toBe('unit')
    expect(byId.pimienta).toMatchObject({ conversionFactor: 1000, receiveQuantity: 1000, create: { baseUnit: 'g' } })
  })

  it('reutiliza un insumo activo de la misma organización y rechaza coincidencias ambiguas', () => {
    const existing = {
      id: 'prod-pan',
      name: 'Pan Rallado Exclusivo Bolsa',
      baseUnit: 'g',
      organizationId: 'org-1',
      active: true,
    }
    const payload = buildConfirmIntakeLines(
      [pan],
      { pan: '2' },
      { pan: proposeCreateMappingDraft(pan) },
      [existing],
      () => 'recv-key',
    )
    expect(payload[0]).toMatchObject({
      action: 'link_existing',
      inventoryProductId: 'prod-pan',
      receiveQuantity: 10000,
    })
    expect(matchExistingIngredient(pan.name, 'g', [
      existing,
      { ...existing, id: 'other-org', organizationId: 'org-2' },
    ], 'org-1').status).toBe('reuse')
    expect(matchExistingIngredient(pan.name, 'g', [
      existing,
      { ...existing, id: 'dup', name: 'pan rallado exclusivo bolsa' },
    ]).status).toBe('ambiguous')
    expect(matchExistingIngredient(pan.name, 'g', [
      { ...existing, baseUnit: 'unit' },
    ]).status).toBe('unit_mismatch')
    expect(confirmIntakeBlockReason(
      [pan],
      { pan: '2' },
      { pan: proposeCreateMappingDraft(pan) },
      [existing, { ...existing, id: 'dup', name: 'Pan rallado exclusivo bolsa' }],
    )).toMatch(/más de un insumo/)
  })

  it('no confirma una línea sin contenido físico ni una conversión incompatible', () => {
    const bare = stock({
      id: 'bare',
      name: 'Mercadería suelta',
      quantity: 3,
      unit: null,
      inventoryPhysicalQuantity: 3,
    })
    expect(confirmIntakeBlockReason(
      [bare],
      { bare: '3' },
      { bare: proposeCreateMappingDraft(bare) },
      [],
    )).toMatch(/factor de conversión|unidades incompatibles/)

    const incompatible = stock({ id: 'mix', unit: 'kg', inventoryPhysicalQuantity: 1000, quantity: 1 })
    expect(confirmIntakeBlockReason(
      [incompatible],
      { mix: '1' },
      {
        mix: {
          ...emptyReviewMappingDraft(),
          action: 'link_existing',
          inventoryProductId: PRODUCT.id,
        },
      },
      [{ ...PRODUCT, baseUnit: 'ml' }],
    )).toMatch(/unidades incompatibles/)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { buildConfirmIntakeLines, confirmIntakeBlockReason } from './confirmIntake'
import { normalizeInvoiceConcept, type ConfirmedMappingMemory } from './invoiceMemory'
import { hydrateReviewMappingDrafts } from './reviewMapping'
import { saveInvoiceWithInventory } from './saveInvoiceWithInventory'
import type { InventoryProductOption, InvoiceAnalysisLine } from './types'

const ORG = 'org-1'

function stock(overrides: Partial<InvoiceAnalysisLine> = {}): InvoiceAnalysisLine {
  return {
    id: 'line-1',
    sourceIndex: 0,
    originalDescription: 'Azúcar',
    name: 'Azúcar',
    supplierSku: null,
    quantity: 1,
    unit: 'pack',
    unitPrice: 10,
    amount: 10,
    classification: 'stock',
    inventoryEligibility: 'eligible',
    quantityKind: 'inventory',
    inventoryPhysicalQuantity: 10000,
    contentUnit: 'g',
    missingFields: [],
    ambiguities: [],
    ...overrides,
  }
}

function product(overrides: Partial<InventoryProductOption> = {}): InventoryProductOption {
  return {
    id: 'prod-azucar',
    name: 'Azúcar',
    baseUnit: 'g',
    organizationId: ORG,
    active: true,
    ...overrides,
  }
}

function memory(description: string, overrides: Partial<ConfirmedMappingMemory> = {}): ConfirmedMappingMemory {
  return {
    descriptionNormalized: normalizeInvoiceConcept(description),
    inventoryProductId: 'prod-azucar',
    inventoryProduct: { id: 'prod-azucar', name: 'Azúcar', baseUnit: 'g' },
    conversionFactor: 10000,
    ...overrides,
  }
}

function ready(line: InvoiceAnalysisLine, products: InventoryProductOption[] = [], memories: ConfirmedMappingMemory[] = []) {
  const hydrated = hydrateReviewMappingDrafts([line], memories, {}, products, ORG)
  return {
    hydrated,
    reason: confirmIntakeBlockReason(
      [line],
      { [line.id]: String(line.quantity) },
      hydrated.drafts,
      products,
      { suggestions: hydrated.suggestions, organizationId: ORG },
    ),
  }
}

describe('guardado único de factura e inventario', () => {
  it('prepara insumos nuevos en la primera factura', () => {
    const line = stock()
    const { hydrated, reason } = ready(line)
    expect(reason).toBeNull()
    expect(hydrated.drafts[line.id]?.action).toBe('create')
    const payload = buildConfirmIntakeLines(
      [line],
      { [line.id]: '1' },
      hydrated.drafts,
      [],
      () => 'recv-1',
    )
    expect(payload[0]).toMatchObject({
      action: 'create',
      receiveQuantity: 10000,
      conversionFactor: 10000,
    })
  })

  it('reutiliza el insumo ya vinculado del mismo proveedor', () => {
    const line = stock()
    const { hydrated, reason } = ready(line, [product()], [memory('Azúcar')])
    expect(reason).toBeNull()
    expect(hydrated.drafts[line.id]).toMatchObject({
      action: 'link_existing',
      inventoryProductId: 'prod-azucar',
    })
    const payload = buildConfirmIntakeLines(
      [line],
      { [line.id]: '1' },
      hydrated.drafts,
      [product()],
      () => 'recv-2',
    )
    expect(payload[0]?.action).toBe('link_existing')
    expect(payload[0]?.action).not.toBe('create')
  })

  it('acepta unidad comercial vacía cuando la cantidad física ya está calculada', () => {
    const line = stock({
      id: 'paulina',
      name: 'La Paulina',
      originalDescription: 'La Paulina',
      unit: null,
      quantity: 2,
      inventoryPhysicalQuantity: 7000,
      contentUnit: 'g',
    })
    const { hydrated, reason } = ready(line)
    expect(reason).toBeNull()
    const payload = buildConfirmIntakeLines(
      [line],
      { paulina: '2' },
      hydrated.drafts,
      [],
      () => 'recv-3',
    )
    expect(payload[0]).toMatchObject({
      action: 'create',
      conversionFactor: 3500,
      receiveQuantity: 7000,
    })
  })

  it('pide corrección antes de guardar un peso variable sin interpretación suficiente', () => {
    const line = stock({
      id: 'aurora',
      name: 'Doña Aurora',
      originalDescription: 'Queso Doña Aurora',
      unit: null,
      quantity: 1,
      inventoryPhysicalQuantity: 8880,
      contentUnit: 'g',
    })
    const hydrated = hydrateReviewMappingDrafts([line], [], {}, [], ORG)
    const reason = confirmIntakeBlockReason(
      [line],
      { aurora: '1' },
      hydrated.drafts,
      [],
      { commercialReviewLineIds: new Set(['aurora']), organizationId: ORG },
    )
    expect(reason).toMatch(/interpretación comercial/)
    expect(reason).toMatch(/antes de guardar/)
  })

  it('deja pasar un peso variable cuando la cantidad física ya está confirmada', () => {
    const line = stock({
      id: 'fiambre',
      name: 'Jamón',
      originalDescription: 'Jamón cocido',
      unit: 'kg',
      quantity: 1.25,
      inventoryPhysicalQuantity: 1250,
      contentUnit: 'g',
    })
    const { reason } = ready(line)
    expect(reason).toBeNull()
  })

  it('bloquea una conversión incompatible', () => {
    const line = stock({ unit: 'kg', inventoryPhysicalQuantity: 1000, contentUnit: 'g' })
    const reason = confirmIntakeBlockReason(
      [line],
      { [line.id]: '1' },
      {
        [line.id]: {
          inventoryProductId: 'prod-ml',
          approximateAccepted: false,
          conversionFactor: null,
          action: 'link_existing',
          createIntent: null,
        },
      },
      [product({ id: 'prod-ml', name: 'Leche', baseUnit: 'ml' })],
      { organizationId: ORG },
    )
    expect(reason).toMatch(/incompatibles/)
  })

  it('no vincula por un nombre parecido y pide elegir ante una coincidencia ambigua', () => {
    const line = stock({ name: 'Harina 0000', originalDescription: 'Harina 0000' })
    const similar = memory('Harina 000', {
      inventoryProductId: 'prod-harina',
      inventoryProduct: { id: 'prod-harina', name: 'Harina 000', baseUnit: 'g' },
    })
    const approximate = ready(line, [], [similar])
    expect(approximate.hydrated.suggestions[line.id]?.kind).toBe('approximate')
    expect(approximate.hydrated.drafts[line.id]?.action).toBe('pending')
    expect(approximate.reason).toMatch(/no es una coincidencia segura/)

    const ambiguous = ready(line, [
      product({ id: 'a', name: 'Harina 0000' }),
      product({ id: 'b', name: 'harina 0000' }),
    ])
    expect(ambiguous.hydrated.drafts[line.id]?.action).toBe('pending')
    expect(ambiguous.reason).toMatch(/más de un insumo/)
  })

  it('reintenta el inventario sin volver a guardar el comprobante', async () => {
    const saveDraft = vi.fn(async () => ({ id: 'doc-1', idempotent: false }))
    const confirm = vi.fn(async () => {
      throw new Error('stock no disponible')
    })
    await expect(saveInvoiceWithInventory({
      savedDocument: null,
      saveDraft,
      confirm,
    })).rejects.toThrow(/stock no disponible/)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(1)

    const retryConfirm = vi.fn(async () => undefined)
    const retry = await saveInvoiceWithInventory({
      savedDocument: { id: 'doc-1', idempotent: false },
      saveDraft,
      confirm: retryConfirm,
    })
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(retryConfirm).toHaveBeenCalledWith({ id: 'doc-1', idempotent: false })
    expect(retry.phase).toBe('confirmed')
  })

  it('vuelve a cargar una factura eliminada como comprobante nuevo y no repite uno ya activo', async () => {
    const confirm = vi.fn(async () => undefined)
    const reloaded = await saveInvoiceWithInventory({
      savedDocument: null,
      saveDraft: async () => ({ id: 'doc-nuevo', idempotent: false }),
      confirm,
    })
    expect(reloaded).toEqual({ saved: { id: 'doc-nuevo', idempotent: false }, phase: 'confirmed' })
    expect(confirm).toHaveBeenCalledTimes(1)

    const skipped = vi.fn(async () => undefined)
    const active = await saveInvoiceWithInventory({
      savedDocument: null,
      saveDraft: async () => ({ id: 'doc-activo', idempotent: true }),
      confirm: skipped,
    })
    expect(active.phase).toBe('already_registered')
    expect(skipped).not.toHaveBeenCalled()

    const resume = vi.fn(async () => undefined)
    const interrupted = await saveInvoiceWithInventory({
      savedDocument: null,
      saveDraft: async () => ({ id: 'doc-activo', idempotent: true, confirmIntentStored: true }),
      confirm: resume,
    })
    expect(interrupted.phase).toBe('confirmed')
    expect(resume).toHaveBeenCalledWith({ id: 'doc-activo', idempotent: true, confirmIntentStored: true })
  })

  it('prepara el alta de los seis insumos nuevos sin una decisión por línea', () => {
    const lines = [
      stock({ id: 'paulina', name: 'Queso Mozzarella para Fetear La Paulina', originalDescription: 'Queso Mozzarella para Fetear La Paulina', quantity: 2, unit: 'barra', inventoryPhysicalQuantity: 7000, contentUnit: 'kg', unitPrice: 13143.54, amount: 26287.08 }),
      stock({ id: 'aurora', name: 'Queso Mozzarella Doña Aurora Plancha', originalDescription: 'Queso Mozzarella Doña Aurora Plancha', quantity: 1, unit: 'plancha', inventoryPhysicalQuantity: 8880, contentUnit: 'kg', unitPrice: 8213.95, amount: 72972.75 }),
      stock({ id: 'azucar', name: 'Azucar Blanca Ledesma', originalDescription: 'Azucar Blanca Ledesma', quantity: 1, unit: 'pack', inventoryPhysicalQuantity: 10000, contentUnit: 'kg', unitPrice: 12159.77, amount: 12159.77 }),
      stock({ id: 'leche', name: 'Leche Entera Larga Vida Trega', originalDescription: 'Leche Entera Larga Vida Trega', quantity: 1, unit: 'pack', inventoryPhysicalQuantity: 12000, contentUnit: 'l', unitPrice: 16337.16, amount: 16337.16 }),
      stock({ id: 'pan', name: 'Pan Rallado Exclusivo', originalDescription: 'Pan Rallado Exclusivo', quantity: 2, unit: 'bolsa', inventoryPhysicalQuantity: 10000, contentUnit: 'kg', unitPrice: 2500, amount: 5000 }),
      stock({ id: 'pimienta', name: 'Pimienta Negra Molida', originalDescription: 'Pimienta Negra Molida', quantity: 1, unit: 'bolsa', inventoryPhysicalQuantity: 1000, contentUnit: 'kg', unitPrice: 4100, amount: 4100 }),
    ]
    const hydrated = hydrateReviewMappingDrafts(lines, [], {}, [], ORG)
    expect(lines.every((line) => hydrated.drafts[line.id]?.action === 'create')).toBe(true)
    expect(lines.every((line) => hydrated.drafts[line.id]?.createIntent?.name === line.name)).toBe(true)
    const reason = confirmIntakeBlockReason(
      lines,
      Object.fromEntries(lines.map((line) => [line.id, String(line.quantity)])),
      hydrated.drafts,
      [],
      { suggestions: hydrated.suggestions, organizationId: ORG },
    )
    expect(reason).toBeNull()
    const keys = lines.map((_, index) => `recv-${index + 1}`)
    let cursor = 0
    const build = () => {
      cursor = 0
      return buildConfirmIntakeLines(
        lines,
        Object.fromEntries(lines.map((line) => [line.id, String(line.quantity)])),
        hydrated.drafts,
        [],
        () => keys[cursor++] ?? 'recv-extra',
      )
    }
    const first = build()
    const second = build()
    expect(first.map((line) => line.action)).toEqual(['create', 'create', 'create', 'create', 'create', 'create'])
    expect(first.map((line) => line.receiveQuantity)).toEqual([7000, 8880, 10000, 12000, 10000, 1000])
    expect(second).toEqual(first)
  })

  it('reutiliza un vínculo confirmado y deja ambigua una coincidencia doble', () => {
    const linked = stock({ id: 'azucar', name: 'Azucar Blanca Ledesma', originalDescription: 'Azucar Blanca Ledesma' })
    const confirmed = ready(linked, [product({ name: 'Azucar Blanca Ledesma' })], [memory('Azucar Blanca Ledesma')])
    expect(confirmed.hydrated.drafts[linked.id]?.action).toBe('link_existing')
    expect(confirmed.reason).toBeNull()

    const ambiguous = ready(linked, [
      product({ id: 'a', name: 'Azucar Blanca Ledesma' }),
      product({ id: 'b', name: 'azucar blanca ledesma' }),
    ])
    expect(ambiguous.hydrated.drafts[linked.id]?.action).toBe('pending')
    expect(ambiguous.hydrated.drafts[linked.id]?.createIntent).toBeNull()
    expect(ambiguous.reason).toMatch(/más de un insumo/)
  })

  it('bloquea el guardado si la interpretación comercial de la línea no cierra', () => {
    const line = stock({
      id: 'aurora',
      name: 'Queso Mozzarella Doña Aurora Plancha',
      originalDescription: 'Queso Mozzarella Doña Aurora Plancha',
      quantity: 1,
      unit: 'plancha',
      inventoryPhysicalQuantity: 8880,
      unitPrice: 8213.95,
      amount: 65000,
    })
    const hydrated = hydrateReviewMappingDrafts([line], [], {}, [], ORG)
    expect(hydrated.drafts[line.id]?.action).toBe('create')
    const reason = confirmIntakeBlockReason(
      [line],
      { aurora: '1' },
      hydrated.drafts,
      [],
      { commercialReviewLineIds: new Set(['aurora']), organizationId: ORG },
    )
    expect(reason).toMatch(/antes de guardar/)
  })
})

import { describe, expect, it } from 'vitest'
import {
  intakeAttemptFingerprint,
  recoverSavedIntake,
  recoverStoredCommercialUnit,
  withStableIntakeKeys,
} from './savedIntakeRecovery'
import type {
  InventoryProductOption,
  InvoiceAnalysisApiResult,
  InvoiceAnalysisLine,
  InvoiceStoredLine,
} from './types'

const ORG = 'a01b3bf7-6af2-4078-9931-e70f55b4626e'
const PAULINA = '3a16835d-ec6b-427f-82d3-db8a434c9499'

const ids = {
  paulina: '83e668cb-479a-4dc8-bcdb-db152dce375c',
  aurora: '22c728e4-109d-4433-8635-ddde3ee72cbf',
  azucar: 'af365ebc-bc92-403f-a68f-6c0d2470cde4',
  leche: '2882cfea-a315-42cd-a3da-e9e981a4a808',
  pan: '6c49340b-9999-4488-8871-577be955a559',
  pimienta: '0a90c736-fef1-4aba-a443-ae6292055d5e',
}

const sources = {
  paulina: 'line-sob5kx-1',
  aurora: 'line-17udio7-1',
  azucar: 'line-gm4ga0-1',
  leche: 'line-lo3irm-1',
  pan: 'line-1o41r6h-1',
  pimienta: 'line-1o9xkao-1',
}

function analysisLine(overrides: Partial<InvoiceAnalysisLine> & { id: string }): InvoiceAnalysisLine {
  return {
    sourceIndex: 0,
    originalDescription: overrides.name ?? overrides.id,
    name: overrides.name ?? overrides.id,
    supplierSku: null,
    quantity: 1,
    unit: null,
    unitPrice: null,
    amount: 1,
    classification: 'stock',
    inventoryEligibility: 'eligible',
    quantityKind: 'inventory',
    inventoryPhysicalQuantity: 0,
    missingFields: [],
    ambiguities: [],
    ...overrides,
  }
}

function stored(input: {
  id: string
  sourceLineId: string
  description: string
  quantity: number
  unit: string | null
  receivedQuantity?: number
}): InvoiceStoredLine {
  return {
    id: input.id,
    sourceLineId: input.sourceLineId,
    sourceIndex: 0,
    original: {
      description: input.description,
      quantity: input.quantity,
      unit: input.unit,
      unitPrice: null,
      amount: null,
    },
    reviewed: {
      description: input.description,
      quantity: input.quantity,
      unit: input.unit,
      unitPrice: null,
      amount: null,
    },
    classification: 'stock',
    inventoryEligibility: 'eligible',
    mappingStatus: 'unmapped',
    quantityKind: 'inventory',
    inventoryPhysicalQuantity: 0,
    inventoryProductId: null,
    inventoryProduct: null,
    receivedQuantity: input.receivedQuantity ?? 0,
  }
}

function snapshot(
  lines: InvoiceAnalysisLine[],
  statuses: Array<[string, 'confirmed' | 'requires_review']>,
): InvoiceAnalysisApiResult {
  return {
    document: { lines },
    interpretation: {
      lines: statuses.map(([lineId, status]) => ({ lineId, operation: 'inbound', status })),
    },
  } as InvoiceAnalysisApiResult
}

const originalLines: InvoiceAnalysisLine[] = [
  analysisLine({
    id: sources.paulina,
    name: 'Queso Mozzarella P/Fetea r La Paulina Barra',
    originalDescription: 'Queso Mozzarella P/Fetea r La Paulina Barra x 3,5 Kg',
    quantity: 2,
    contentPerUnit: 3.5,
    contentUnit: 'kg',
    inventoryPhysicalQuantity: 7000,
  }),
  analysisLine({
    id: sources.aurora,
    name: 'Queso Mozzarella Doña Aurora Plancha',
    originalDescription: 'Queso Mozzarella Doña Aurora Plancha x 8,8 kg Aproxs',
    quantity: 1,
    contentPerUnit: 8.8,
    contentUnit: 'kg',
    billedWeight: 8.88,
    billedWeightUnit: 'kg',
    inventoryPhysicalQuantity: 8880,
  }),
  analysisLine({
    id: sources.azucar,
    name: 'Azucar Blanca Ledesma Pack',
    originalDescription: 'Azucar Blanca Ledesma Pack (10 x 1 Kg)',
    quantity: 1,
    unit: 'pack',
    contentPerUnit: 1,
    contentUnit: 'kg',
    inventoryPhysicalQuantity: 10000,
  }),
  analysisLine({
    id: sources.leche,
    name: 'Leche Entera Larga Vida Tregar Pack',
    originalDescription: 'Leche Entera Larga Vida Tregar Pack (12 x 1 Lt)',
    quantity: 1,
    unit: 'pack',
    contentPerUnit: 1,
    contentUnit: 'lt',
    inventoryPhysicalQuantity: 12000,
  }),
  analysisLine({
    id: sources.pan,
    name: 'Pan Rallado Exclusivo Bolsa',
    originalDescription: 'Pan Rallado Exclusivo Bolsa x 5 Kg',
    quantity: 2,
    contentPerUnit: 5,
    contentUnit: 'kg',
    inventoryPhysicalQuantity: 10000,
  }),
  analysisLine({
    id: sources.pimienta,
    name: 'Pimienta Negra Molida Marfeli Bolsa',
    originalDescription: 'Pimienta Negra Molida Marfeli Bolsa x 1Kg',
    quantity: 1,
    contentPerUnit: 1,
    contentUnit: 'kg',
    inventoryPhysicalQuantity: 1000,
  }),
]

const statuses: Array<[string, 'confirmed' | 'requires_review']> = [
  [sources.paulina, 'confirmed'],
  [sources.aurora, 'requires_review'],
  [sources.azucar, 'confirmed'],
  [sources.leche, 'confirmed'],
  [sources.pan, 'confirmed'],
  [sources.pimienta, 'confirmed'],
]

const reviewedLines = originalLines.map((line) => (
  line.id === sources.aurora
    ? { ...line, billedWeight: null, inventoryPhysicalQuantity: 8800 }
    : line
))

const storedLines = [
  stored({
    id: ids.paulina,
    sourceLineId: sources.paulina,
    description: 'Queso Mozzarella P/Fetea r La Paulina Barra',
    quantity: 2,
    unit: null,
  }),
  stored({
    id: ids.aurora,
    sourceLineId: sources.aurora,
    description: 'Queso Mozzarella Doña Aurora Plancha',
    quantity: 1,
    unit: null,
  }),
  stored({
    id: ids.azucar,
    sourceLineId: sources.azucar,
    description: 'Azucar Blanca Ledesma Pack',
    quantity: 1,
    unit: 'pack',
  }),
  stored({
    id: ids.leche,
    sourceLineId: sources.leche,
    description: 'Leche Entera Larga Vida Tregar Pack',
    quantity: 1,
    unit: 'pack',
  }),
  stored({
    id: ids.pan,
    sourceLineId: sources.pan,
    description: 'Pan Rallado Exclusivo Bolsa',
    quantity: 2,
    unit: null,
  }),
  stored({
    id: ids.pimienta,
    sourceLineId: sources.pimienta,
    description: 'Pimienta Negra Molida Marfeli Bolsa',
    quantity: 1,
    unit: null,
  }),
]

const paulinaProduct: InventoryProductOption = {
  id: PAULINA,
  name: 'Queso Mozzarella P/Fetea r La Paulina Barra',
  baseUnit: 'g',
  organizationId: ORG,
  active: true,
}

describe('recuperación de una factura guardada', () => {
  const recovered = recoverSavedIntake({
    organizationId: ORG,
    lines: storedLines,
    originalAnalysis: snapshot(originalLines, statuses),
    reviewedAnalysis: snapshot(reviewedLines, statuses),
    products: [
      paulinaProduct,
      {
        ...paulinaProduct,
        id: '99999999-9999-4999-8999-999999999999',
        organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    ],
  })

  it('recupera presentación, factor y unidad base de las seis líneas', () => {
    expect(recoverStoredCommercialUnit('Queso La Paulina Barra x 3,5 Kg', null)).toBe('barra')
    expect(recoverStoredCommercialUnit('Barra y bolsa', null)).toBeNull()
    expect(recovered.lines).toHaveLength(6)
    expect(recovered.previews.map((line) => line.message)).toEqual([
      'Vincular insumo existente · 3500 g/barra · recibir 7000 g.',
      'Crear y vincular en g · 8880 g/plancha · sin recepción hasta resolver la revisión comercial.',
      'Crear y vincular en g · 10000 g/pack · recibir 10000 g.',
      'Crear y vincular en ml · 12000 ml/pack · recibir 12000 ml.',
      'Crear y vincular en g · 5000 g/bolsa · recibir 10000 g.',
      'Crear y vincular en g · 1000 g/bolsa · recibir 1000 g.',
    ])
  })

  it('reutiliza La Paulina y crea los otros cinco sin duplicar', () => {
    const [paulina, aurora, azucar, leche, pan, pimienta] = recovered.lines
    expect(paulina).toMatchObject({
      purchaseDocumentLineId: ids.paulina,
      action: 'link_existing',
      inventoryProductId: PAULINA,
      conversionFactor: 3500,
      receiveQuantity: 7000,
    })
    expect(paulina.create).toBeUndefined()
    expect(aurora).toMatchObject({
      action: 'create',
      conversionFactor: 8880,
      receiveQuantity: null,
      create: { name: 'Queso Mozzarella Doña Aurora Plancha', baseUnit: 'g' },
    })
    expect(azucar).toMatchObject({
      action: 'create',
      conversionFactor: 10000,
      receiveQuantity: 10000,
      create: { baseUnit: 'g' },
    })
    expect(leche).toMatchObject({
      action: 'create',
      conversionFactor: 12000,
      receiveQuantity: 12000,
      create: { baseUnit: 'ml' },
    })
    expect(pan).toMatchObject({
      action: 'create',
      conversionFactor: 5000,
      receiveQuantity: 10000,
      create: { baseUnit: 'g' },
    })
    expect(pimienta).toMatchObject({
      action: 'create',
      conversionFactor: 1000,
      receiveQuantity: 1000,
      create: { baseUnit: 'g' },
    })
    expect(recovered.lines.filter((line) => line.inventoryProductId === PAULINA)).toHaveLength(1)
  })

  it('deja pendiente una línea sin evidencia original y no la arma desde el nombre', () => {
    const looseId = '12121212-1212-4121-8121-121212121212'
    const result = recoverSavedIntake({
      organizationId: ORG,
      lines: [
        stored({
          id: looseId,
          sourceLineId: 'line-loose',
          description: 'Pan Rallado Exclusivo Bolsa x 5 Kg',
          quantity: 2,
          unit: null,
        }),
      ],
      originalAnalysis: snapshot([
        analysisLine({
          id: 'line-loose',
          name: 'Pan Rallado Exclusivo Bolsa x 5 Kg',
          originalDescription: 'Pan Rallado Exclusivo Bolsa x 5 Kg',
          quantity: 2,
          inventoryPhysicalQuantity: 2,
        }),
      ], [['line-loose', 'confirmed']]),
      reviewedAnalysis: null,
      products: [],
    })
    expect(result.lines).toEqual([{ purchaseDocumentLineId: looseId, action: 'pending' }])
    expect(result.actionableCount).toBe(0)
    expect(result.previews[0]?.message).toMatch(/pendiente/i)
  })

  it('no vuelve a recibir una línea que ya tiene stock', () => {
    const result = recoverSavedIntake({
      organizationId: ORG,
      lines: [{
        ...storedLines[0]!,
        mappingStatus: 'mapped',
        inventoryProductId: PAULINA,
        receivedQuantity: 7000,
      }],
      originalAnalysis: snapshot(originalLines, statuses),
      reviewedAnalysis: snapshot(reviewedLines, statuses),
      products: [paulinaProduct],
    })
    expect(result.lines[0]).toMatchObject({
      action: 'link_existing',
      inventoryProductId: PAULINA,
      receiveQuantity: null,
    })
  })

  it('repite la misma clave de idempotencia mientras el intento no cambia', () => {
    let n = 0
    const randomUUID = () => `00000000-0000-4000-8000-00000000000${n++}`
    const first = withStableIntakeKeys(recovered.lines, { confirmKey: null, receiveKeys: {} }, randomUUID)
    const second = withStableIntakeKeys(
      recovered.lines,
      { confirmKey: first.confirmKey, receiveKeys: first.receiveKeys },
      randomUUID,
    )
    expect(second.confirmKey).toBe(first.confirmKey)
    expect(second.lines.map((line) => line.receiveIdempotencyKey)).toEqual(
      first.lines.map((line) => line.receiveIdempotencyKey),
    )
    expect(first.lines[1]?.receiveIdempotencyKey).toBeNull()
    expect(intakeAttemptFingerprint(recovered.lines)).toBe(intakeAttemptFingerprint(recovered.lines))
    const changed = recovered.lines.map((line, index) => (
      index === 0 ? { ...line, conversionFactor: 1 } : line
    ))
    expect(intakeAttemptFingerprint(changed)).not.toBe(intakeAttemptFingerprint(recovered.lines))
  })
})

import { describe, expect, it } from 'vitest'
import { buildConfirmIntakeLines } from './confirmIntake'
import {
  factorFromPresentationAnswer,
  formatComprehensibleQuantity,
  parsePresentationAnswer,
  physicalResultLabel,
  presentationQuestion,
} from './presentation'
import type { InvoiceAnalysisLine } from './types'

function line(patch: Partial<InvoiceAnalysisLine> = {}): InvoiceAnalysisLine {
  return {
    id: 'line-1',
    sourceIndex: 0,
    originalDescription: 'Producto',
    name: 'Producto',
    supplierSku: null,
    quantity: 2,
    unit: 'barra',
    unitPrice: 10,
    amount: 20,
    classification: 'stock',
    inventoryEligibility: 'eligible',
    quantityKind: 'inventory',
    inventoryPhysicalQuantity: 7000,
    missingFields: [],
    ambiguities: [],
    ...patch,
  }
}

describe('presentación física', () => {
  it('muestra kg, g, L, ml y unidades según la magnitud', () => {
    expect(formatComprehensibleQuantity(7000, 'g')).toBe('7 kg')
    expect(formatComprehensibleQuantity(250, 'g')).toBe('250 g')
    expect(formatComprehensibleQuantity(8880, 'g')).toBe('8,88 kg')
    expect(formatComprehensibleQuantity(12000, 'ml')).toBe('12 L')
    expect(formatComprehensibleQuantity(500, 'ml')).toBe('500 ml')
    expect(formatComprehensibleQuantity(3, 'unit')).toBe('3 unidades')
    expect(formatComprehensibleQuantity(1, 'unit')).toBe('1 unidad')
  })

  it('pregunta el contenido de la presentación cuando falta la equivalencia', () => {
    expect(presentationQuestion('barra', 'g')).toBe('¿Cuántos kg trae cada barra?')
    expect(presentationQuestion('botella', 'ml')).toBe('¿Cuántos litros contiene cada botella?')
    expect(presentationQuestion('caja', 'unit')).toBe('¿Cuántas unidades trae cada caja?')
    expect(presentationQuestion('u', 'g')).toBe('¿Cuántos kg trae cada unidad?')
  })

  it('calcula el factor interno sin exponerlo en el resultado', () => {
    expect(parsePresentationAnswer('3,5')).toBe(3.5)
    expect(parsePresentationAnswer('0')).toBeNull()
    expect(parsePresentationAnswer('-1')).toBeNull()
    expect(parsePresentationAnswer('')).toBeNull()
    expect(factorFromPresentationAnswer(3.5, 'g')).toBe(3500)
    expect(factorFromPresentationAnswer(1.5, 'ml')).toBe(1500)
    expect(factorFromPresentationAnswer(12, 'unit')).toBe(12)
    expect(factorFromPresentationAnswer(0, 'g')).toBeNull()
    const label = physicalResultLabel(7000, 'g', 52574.17)
    expect(label).toContain('7 kg')
    expect(label).not.toContain('3500')
    expect(label).not.toContain('Factor')
  })

  it('conserva el payload de inventario y no cambia la idempotencia del plan', () => {
    const paulina = line({
      id: 'line-paulina',
      name: 'La Paulina',
      originalDescription: 'La Paulina',
      quantity: 2,
      unit: 'barra',
      inventoryPhysicalQuantity: 7000,
    })
    const drafts = {
      'line-paulina': {
        inventoryProductId: 'create:line-paulina',
        approximateAccepted: false,
        conversionFactor: factorFromPresentationAnswer(3.5, 'g'),
        action: 'create' as const,
        createIntent: { name: 'La Paulina', baseUnit: 'g' as const },
      },
    }
    const first = buildConfirmIntakeLines([paulina], { 'line-paulina': '2' }, drafts, [], () => 'recv-1')
    const second = buildConfirmIntakeLines([paulina], { 'line-paulina': '2' }, drafts, [], () => 'recv-1')
    expect(second).toEqual(first)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      purchaseDocumentLineId: 'line-paulina',
      action: 'create',
      conversionFactor: 3500,
      receiveQuantity: 7000,
      receiveIdempotencyKey: 'recv-1',
      create: { name: 'La Paulina', baseUnit: 'g' },
    })
    expect(JSON.stringify(first)).not.toMatch(/¿Cuántos|Factor de conversión/)
  })
})

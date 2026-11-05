import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeExtractedInvoice, createInvoiceReader } from './analyze.js'
import { InvoiceAiResponseError, parseGeminiJson } from './geminiJson.js'
import type { InvoiceAiProvider } from './types.js'

type FixtureCases = Record<string, Record<string, unknown>>

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/invoice-cases.json', import.meta.url), 'utf8'),
) as FixtureCases

describe('núcleo inteligente de facturas', () => {
  it('clasifica Metrogas anonimizado como servicio sin líneas de inventario', () => {
    const result = analyzeExtractedInvoice(fixtures.publicService)

    expect(result.document.classification).toBe('service')
    expect(result.document.lines.every((line) => line.inventoryEligibility === 'ineligible')).toBe(true)
    expect(result.inventorySummary.shouldOfferFutureReceipt).toBe(false)
  })

  it('reconoce una factura de alimentos con producto inventariable', () => {
    const result = analyzeExtractedInvoice(fixtures.foodInvoice)

    expect(result.document.classification).toBe('gastronomic_merchandise')
    expect(result.document.lines[0].classification).toBe('stock')
    expect(result.document.lines[0].inventoryEligibility).toBe('eligible')
    expect(result.inventorySummary.shouldOfferFutureReceipt).toBe(true)
  })

  it('clasifica independientemente mercadería, flete e IVA en una factura mixta', () => {
    const result = analyzeExtractedInvoice(fixtures.mixedInvoice)

    expect(result.document.classification).toBe('mixed')
    expect(result.document.lines.map((line) => line.classification)).toEqual([
      'stock',
      'logistics',
      'fiscal',
    ])
    expect(result.inventorySummary.eligibleLines).toBe(1)
  })

  it('marca como inválida una factura con cantidad por precio inconsistente', () => {
    const result = analyzeExtractedInvoice(fixtures.inconsistentAmounts)

    expect(result.validation.status).toBe('invalid')
    expect(result.validation.errors.some((error) => error.code === 'LINE_AMOUNT_MISMATCH')).toBe(true)
    expect(result.validation.mathematicallyConsistent).toBe(false)
  })

  it('no inventa unidades por pack cuando el contenido es desconocido', () => {
    const result = analyzeExtractedInvoice(fixtures.unknownPack)
    const line = result.document.lines[0]

    expect(line.unitsPerPackage).toBeNull()
    expect(line.detectedUnits).toBeNull()
    expect(line.classification).toBe('stock')
    expect(line.inventoryEligibility).toBe('pending_review')
    expect(result.validation.blocksReception).toBe(true)
  })

  it('mantiene un documento ambiguo pendiente de revisión', () => {
    const result = analyzeExtractedInvoice(fixtures.ambiguousDocument)

    expect(result.document.classification).toBe('ambiguous')
    expect(result.document.lines[0].classification).toBe('pending_review')
    expect(result.validation.status).toBe('requires_review')
  })

  it('no convierte el rubro otro en mercadería', () => {
    const result = analyzeExtractedInvoice(fixtures.unknownCategory)

    expect(result.document.classification).toBe('ambiguous')
    expect(result.document.lines[0].inventoryEligibility).toBe('pending_review')
    expect(result.inventorySummary.eligibleLines).toBe(0)
  })

  it('excluye una línea de subtotal del inventario y de la suma comercial', () => {
    const result = analyzeExtractedInvoice(fixtures.subtotalLine)

    expect(result.document.lines[1].classification).toBe('fiscal')
    expect(result.document.lines[1].inventoryEligibility).toBe('ineligible')
    expect(result.validation.differences.linesVsSubtotal).toBe(0)
    expect(result.inventorySummary.eligibleLines).toBe(1)
  })

  it('requiere revisión ante contradicción entre documento de servicio y línea física', () => {
    const result = analyzeExtractedInvoice(fixtures.contradictoryClassification)

    expect(result.document.classification).toBe('ambiguous')
    expect(result.document.lines[0].classification).toBe('pending_review')
    expect(
      result.validation.pendingConfirmations.some(
        (pending) => pending.code === 'DOCUMENT_LINE_CONTRADICTION',
      ),
    ).toBe(true)
    expect(result.inventorySummary.shouldOfferFutureReceipt).toBe(false)
  })

  it('rechaza JSON de Gemini inválido o incompleto sin repararlo silenciosamente', () => {
    const invalid = readFileSync(
      new URL('./fixtures/invalid-gemini.txt', import.meta.url),
      'utf8',
    )

    expect(() => parseGeminiJson(invalid)).toThrowError(InvoiceAiResponseError)
    try {
      parseGeminiJson(invalid)
    } catch (error) {
      expect(error).toMatchObject({ code: 'INCOMPLETE_RESPONSE' })
    }
  })

  it('permite inyectar un proveedor simulado sin red y conserva metadatos técnicos', async () => {
    const provider: InvoiceAiProvider = {
      extract: async () => ({
        extracted: fixtures.foodInvoice,
        provider: 'fake-ai',
        model: 'fixture-model',
        usage: { promptTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    }

    const result = await createInvoiceReader(provider).analyze({
      base64: 'Zml4dHVyZQ==',
      mimeType: 'application/pdf',
    })

    expect(result.metadata).toMatchObject({
      provider: 'fake-ai',
      model: 'fixture-model',
      usage: { totalTokens: 150 },
    })
  })
})

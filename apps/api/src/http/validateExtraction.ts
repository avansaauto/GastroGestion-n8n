import { analyzeExtractedInvoice } from '../modules/invoice-intelligence/analyze.js'
import { evaluateReceptionEligibility } from '../modules/invoice-intelligence/receptionEligibility.js'
import type {
  InvoiceAnalysisResult,
  NormalizedInvoiceLine,
} from '../modules/invoice-intelligence/types.js'

export class ExtractionPayloadError extends Error {
  readonly status = 422
  readonly code = 'INVALID_EXTRACTION'

  constructor(message: string) {
    super(message)
    this.name = 'ExtractionPayloadError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Compuerta mínima antes del pipeline. No inventa campos ni completa importes. */
export function assertExtractionPayload(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ExtractionPayloadError('La extracción debe ser un objeto JSON.')
  }
  const lines = value.lines ?? value.items
  if (!Array.isArray(lines)) {
    throw new ExtractionPayloadError('La extracción debe incluir lines o items como array.')
  }
}

function publicLine(line: NormalizedInvoiceLine) {
  const { raw: _raw, ...rest } = line
  return rest
}

/**
 * Analiza un JSON ya extraído. No llama a Gemini, no firma tokens de guardado
 * y no toca documentos, insumos ni stock.
 */
export function validateExtractedInvoice(extracted: unknown) {
  assertExtractionPayload(extracted)
  const result = analyzeExtractedInvoice(extracted, {
    provider: 'external',
    model: 'n8n',
  })
  return toValidateExtractionResult(result)
}

export function toValidateExtractionResult(result: InvoiceAnalysisResult) {
  return {
    document: {
      supplier: result.document.supplier,
      header: result.document.document,
      amounts: result.document.amounts,
      classification: result.document.classification,
      mainCategory: result.document.mainCategory,
      service: result.document.service,
      reviewStatus: result.document.reviewStatus,
      lines: result.document.lines.map(publicLine),
    },
    interpretation: {
      version: result.interpretation.version,
      lines: result.interpretation.lines,
      relations: result.interpretation.relations,
      consistency: result.interpretation.consistency,
      blocksReception: result.interpretation.blocksReception,
      unresolvedLineIds: result.interpretation.unresolvedLineIds,
    },
    validation: result.validation,
    eligibility: evaluateReceptionEligibility(result),
    inventory: result.inventorySummary,
    metadata: {
      provider: result.metadata.provider,
      model: result.metadata.model,
      promptVersion: result.metadata.promptVersion,
      processingTimeMs: result.metadata.processingTimeMs,
    },
  }
}

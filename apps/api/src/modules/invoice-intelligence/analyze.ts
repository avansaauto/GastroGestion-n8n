import { interpretCommercialInvoice } from './commercialInterpretation.js'
import { normalizeExtractedInvoice } from './normalize.js'
import { INVOICE_PROMPT_VERSION } from './types.js'
import type {
  AiUsage,
  InvoiceAiProvider,
  InvoiceAnalysisResult,
  InvoiceAnalysisOptions,
  InvoiceDocumentInput,
} from './types.js'
import { validateInvoice } from './validate.js'

export type AnalysisSourceMetadata = {
  provider?: string
  model?: string
  usage?: AiUsage
  processingTimeMs?: number
}

export function applyInterpretationEligibility(
  document: InvoiceAnalysisResult['document'],
  interpretation: InvoiceAnalysisResult['interpretation'],
) {
  const interpretationByLine = new Map(
    interpretation.lines.map((line) => [line.lineId, line]),
  )
  for (const line of document.lines) {
    const interpreted = interpretationByLine.get(line.id)
    if (!interpreted) continue
    if (interpreted.physical.movement === 'pending_review') {
      line.inventoryEligibility = 'pending_review'
    } else if (interpreted.physical.movement === 'none') {
      line.inventoryEligibility = 'ineligible'
    } else if (
      interpreted.physical.movement === 'inbound'
      && line.classification === 'stock'
      && (line.amount ?? 0) >= 0
    ) {
      line.inventoryEligibility = 'eligible'
    }
  }
}

export function analyzeExtractedInvoice(
  extracted: unknown,
  metadata: AnalysisSourceMetadata = {},
  options: InvoiceAnalysisOptions = {},
): InvoiceAnalysisResult {
  const startedAt = performance.now()
  const document = normalizeExtractedInvoice(extracted)
  const interpretation = interpretCommercialInvoice(document, options)
  applyInterpretationEligibility(document, interpretation)
  const validation = validateInvoice(document, interpretation)
  document.reviewStatus = validation.status

  const eligibleLines = document.lines.filter(
    (line) => line.inventoryEligibility === 'eligible',
  ).length
  const pendingLines = document.lines.filter(
    (line) => line.inventoryEligibility === 'pending_review',
  ).length

  return {
    document,
    interpretation,
    validation,
    metadata: {
      provider: metadata.provider ?? 'simulated',
      model: metadata.model ?? 'fixture',
      promptVersion: INVOICE_PROMPT_VERSION,
      processingTimeMs:
        metadata.processingTimeMs ?? Math.max(0, Math.round(performance.now() - startedAt)),
      ...(metadata.usage ? { usage: metadata.usage } : {}),
    },
    inventorySummary: {
      eligibleLines,
      pendingLines,
      receptionBlocked: validation.blocksReception,
      shouldOfferFutureReceipt: eligibleLines > 0 && !validation.blocksReception,
    },
  }
}

export function createInvoiceReader(provider: InvoiceAiProvider) {
  return {
    async analyze(
      input: InvoiceDocumentInput,
      options: InvoiceAnalysisOptions = {},
    ): Promise<InvoiceAnalysisResult> {
      const startedAt = performance.now()
      const extraction = await provider.extract(input)
      return analyzeExtractedInvoice(
        extraction.extracted,
        {
          provider: extraction.provider,
          model: extraction.model,
          usage: extraction.usage,
          processingTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
        },
        options,
      )
    },
  }
}

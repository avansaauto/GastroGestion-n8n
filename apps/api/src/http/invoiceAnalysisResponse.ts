import type { InvoiceAnalysisResult, NormalizedInvoiceLine } from '../modules/invoice-intelligence/index.js'

function publicLine(line: NormalizedInvoiceLine) {
  const { raw: _raw, ...rest } = line
  return rest
}

export function toInvoiceAnalysisApiResult(
  result: InvoiceAnalysisResult,
  options: {
    fileSha256: string
    integrity?: { token: string; snapshotSha256: string; expiresAt: string }
  },
) {
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
    inventory: result.inventorySummary,
    metadata: {
      provider: result.metadata.provider,
      model: result.metadata.model,
      promptVersion: result.metadata.promptVersion,
      processingTimeMs: result.metadata.processingTimeMs,
      fileSha256: options.fileSha256,
      ...(options.integrity
        ? {
            snapshotSha256: options.integrity.snapshotSha256,
            integrityToken: options.integrity.token,
            integrityExpiresAt: options.integrity.expiresAt,
          }
        : {}),
    },
  }
}

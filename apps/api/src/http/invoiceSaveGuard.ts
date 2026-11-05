import { sha256Hex } from './fileHash.js'
import {
  assertCommercialDecisions,
  type InvoiceCommercialDecisionPayload,
  type OriginalAnalysisLine,
  type OriginalCommercialRelation,
} from './invoiceCommercialDecisions.js'
import {
  verifyInvoiceIntegrity,
  type InvoiceIntegrityClaims,
  type InvoiceIntegritySnapshot,
} from './invoiceIntegrity.js'
import { invoiceStorageObjectPath } from './invoiceSaveStrategy.js'

export type InvoiceSaveGuardInput = {
  userId: string
  fileBytes: Buffer
  snapshot: InvoiceIntegritySnapshot
  integrityToken: string | null | undefined
  commercialDecisions: InvoiceCommercialDecisionPayload[]
  organizationId: string
  extension: string
  secret: string
  now?: Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function originalFromSnapshot(snapshot: InvoiceIntegritySnapshot): {
  relations: OriginalCommercialRelation[]
  lines: OriginalAnalysisLine[]
} {
  const document = isRecord(snapshot.document) ? snapshot.document : {}
  const interpretation = isRecord(snapshot.interpretation) ? snapshot.interpretation : {}
  const rawLines = Array.isArray(document.lines) ? document.lines : []
  const rawRelations = Array.isArray(interpretation.relations) ? interpretation.relations : []

  const lines: OriginalAnalysisLine[] = rawLines.flatMap((line) => {
    if (!isRecord(line) || typeof line.id !== 'string') return []
    return [{
      id: line.id,
      amount: asNumber(line.amount),
      unitPrice: asNumber(line.unitPrice),
      quantity: asNumber(line.quantity),
    }]
  })

  const relations: OriginalCommercialRelation[] = rawRelations.flatMap((relation) => {
    if (
      !isRecord(relation)
      || typeof relation.id !== 'string'
      || (relation.type !== 'bonus' && relation.type !== 'discount')
    ) {
      return []
    }
    return [{
      id: relation.id,
      type: relation.type,
      targetLineId: typeof relation.targetLineId === 'string' ? relation.targetLineId : null,
      adjustmentLineIds: Array.isArray(relation.adjustmentLineIds)
        ? relation.adjustmentLineIds.filter((id): id is string => typeof id === 'string')
        : [],
      proposedPhysicalQuantity: asNumber(relation.proposedPhysicalQuantity),
      unit: typeof relation.unit === 'string' ? relation.unit : null,
      bonusAmount: asNumber(relation.bonusAmount) ?? 0,
      grossAmount: asNumber(relation.grossAmount),
      netAcquisitionAmount: asNumber(relation.netAcquisitionAmount),
    }]
  })

  return { relations, lines }
}

export function assertInvoiceSaveRequest(input: InvoiceSaveGuardInput): {
  fileSha256: string
  claims: InvoiceIntegrityClaims
  storagePath: string
} {
  const fileSha256 = sha256Hex(input.fileBytes)
  const claims = verifyInvoiceIntegrity({
    token: input.integrityToken,
    userId: input.userId,
    fileSha256,
    snapshot: input.snapshot,
    secret: input.secret,
    now: input.now,
  })
  assertCommercialDecisions(originalFromSnapshot(input.snapshot), input.commercialDecisions)
  return {
    fileSha256,
    claims,
    storagePath: invoiceStorageObjectPath(input.organizationId, fileSha256, input.extension),
  }
}

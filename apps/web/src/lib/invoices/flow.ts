import { validateInvoiceFile } from './file'
import {
  duplicateBlocksAnalyze,
  duplicateBlocksSave,
  DUPLICATE_LOOKUP_FAILED_MESSAGE,
  DUPLICATE_SAVE_BLOCKED_REASON,
  initialDuplicateState,
  type DuplicateLookupOutcome,
  type InvoiceDuplicateState,
} from './invoiceDuplicate'
import {
  applyCommercialReview,
  commercialRelationSaveBlockReason,
  mergeReviewReceivedDrafts,
  unresolvedCommercialRelations,
} from './commercialReview'
import { needsFiscalAcceptance } from './review'
import type { ConfirmedMappingMemory } from './invoiceMemory'
import {
  emptyReviewMappingDraft,
  hydrateReviewMappingDrafts,
  proposeCreateMappingDraft,
  type ReviewMappingCreateIntent,
  type ReviewMappingDrafts,
  type ReviewMappingSuggestions,
} from './reviewMapping'
import { canEditReviewReceived, initialReviewReceivedDrafts, type ReviewReceivedDrafts } from './reviewReceived'
import { reviewIntakeBlockReason, type IntakeLineResult } from './reviewIntake'
import type { InvoiceApiError } from './api'
import type {
  InventoryProductOption,
  InvoiceAnalysisApiResult,
  InvoiceDuplicateMatch,
  InvoiceSaveApiResult,
  InvoiceSaveCorrections,
  LocalRelationDecision,
  SelectedInvoiceFile,
} from './types'

export type InvoiceFlowStatus = 'idle' | 'analyzing' | 'review' | 'failed'
export type InvoiceSaveStatus = 'idle' | 'saving' | 'saved' | 'failed'

export type InvoiceFlowState = {
  file: SelectedInvoiceFile | null
  fileError: string | null
  status: InvoiceFlowStatus
  result: InvoiceAnalysisApiResult | null
  originalSnapshot: InvoiceAnalysisApiResult | null
  corrections: InvoiceSaveCorrections
  requestError: Pick<InvoiceApiError, 'message' | 'status' | 'code'> | null
  localDecisions: Record<string, LocalRelationDecision>
  receivedDrafts: ReviewReceivedDrafts
  mappingDrafts: ReviewMappingDrafts
  mappingSuggestions: ReviewMappingSuggestions
  saveStatus: InvoiceSaveStatus
  saveError: Pick<InvoiceApiError, 'message' | 'status' | 'code'> | null
  savedDocument: InvoiceSaveApiResult | null
  intakePhase: string | null
  intakeLines: IntakeLineResult[]
  acceptFiscalInconsistency: boolean
  duplicate: InvoiceDuplicateState
}

export const initialInvoiceFlow: InvoiceFlowState = {
  file: null,
  fileError: null,
  status: 'idle',
  result: null,
  originalSnapshot: null,
  corrections: {},
  requestError: null,
  localDecisions: {},
  receivedDrafts: {},
  mappingDrafts: {},
  mappingSuggestions: {},
  saveStatus: 'idle',
  saveError: null,
  savedDocument: null,
  intakePhase: null,
  intakeLines: [],
  acceptFiscalInconsistency: false,
  duplicate: { ...initialDuplicateState },
}

export function freezeAnalysisSnapshot(result: InvoiceAnalysisApiResult): InvoiceAnalysisApiResult {
  return JSON.parse(JSON.stringify(result)) as InvoiceAnalysisApiResult
}

export function canAnalyze(state: InvoiceFlowState) {
  return Boolean(state.file)
    && !state.fileError
    && state.status !== 'analyzing'
    && state.saveStatus !== 'saving'
    && !duplicateBlocksAnalyze(state.duplicate)
}

export function shouldShowSaveAction(state: InvoiceFlowState) {
  if (!state.result || state.status !== 'review') return false
  return (state.result.inventory.eligibleLines ?? 0) >= 1
    || state.result.interpretation.relations.length > 0
}

export function canSaveInvoice(state: InvoiceFlowState, locationId: string) {
  if (!shouldShowSaveAction(state)) return false
  if (state.saveStatus === 'saving' || state.saveStatus === 'saved') return false
  if (duplicateBlocksSave(state.duplicate)) return false
  if (!state.file || !state.originalSnapshot) return false
  if (!state.originalSnapshot.metadata.integrityToken) return false
  if (!locationId.trim()) return false
  if (!state.result) return false
  if (unresolvedCommercialRelations(state.result.interpretation.relations).length > 0) return false
  if (state.result.inventory.eligibleLines < 1) return false
  if (needsFiscalAcceptance(state.result) && !state.acceptFiscalInconsistency) return false
  if (reviewIntakeBlockReason(state.result.document.lines, state.receivedDrafts)) return false
  return true
}

export function saveBlockedReason(
  state: InvoiceFlowState,
  locationId: string,
  previewMode: boolean,
): string | null {
  if (!shouldShowSaveAction(state)) return null
  if (state.duplicate.status === 'matched') return DUPLICATE_SAVE_BLOCKED_REASON
  if (previewMode) return 'Iniciá sesión para guardar la factura.'
  if (!locationId.trim()) return 'Seleccioná un local para guardar.'
  if (!state.originalSnapshot?.metadata.integrityToken) {
    return 'El análisis no tiene firma de integridad. Volvé a analizar el comprobante.'
  }
  if (state.result) {
    const commercial = commercialRelationSaveBlockReason(
      state.result.interpretation.relations,
      state.result.document.lines,
    )
    if (commercial) return commercial
  }
  if (state.result && needsFiscalAcceptance(state.result) && !state.acceptFiscalInconsistency) {
    return 'Confirmá la diferencia fiscal para guardar.'
  }
  if (state.result) {
    return reviewIntakeBlockReason(state.result.document.lines, state.receivedDrafts)
  }
  return null
}

export function selectInvoiceFile(
  state: InvoiceFlowState,
  file: File,
): InvoiceFlowState {
  const validation = validateInvoiceFile(file)
  if (!validation.ok) {
    return {
      ...initialInvoiceFlow,
      fileError: validation.message,
    }
  }
  return {
    ...initialInvoiceFlow,
    file: {
      file,
      name: file.name,
      type: validation.selected.type,
      size: file.size,
    },
  }
}

export function clearInvoiceFile(): InvoiceFlowState {
  return { ...initialInvoiceFlow }
}

export function beginDuplicateCheck(
  state: InvoiceFlowState,
  contextKey: string,
): InvoiceFlowState {
  return {
    ...state,
    duplicate: {
      status: 'checking',
      match: null,
      warning: null,
      source: null,
      contextKey,
    },
  }
}

export function applyDuplicateLookup(
  state: InvoiceFlowState,
  input: {
    contextKey: string
    match: InvoiceDuplicateMatch | null
    source: 'hash' | 'fiscal'
  },
): InvoiceFlowState {
  if (state.duplicate.contextKey !== input.contextKey) return state
  if (input.match) {
    if (input.match.disposition === 'deleted') {
      return {
        ...state,
        duplicate: {
          status: 'noted',
          match: input.match,
          warning: null,
          source: input.source,
          contextKey: input.contextKey,
        },
      }
    }
    return {
      ...state,
      duplicate: {
        status: 'matched',
        match: input.match,
        warning: null,
        source: input.source,
        contextKey: input.contextKey,
      },
    }
  }
  return {
    ...state,
    duplicate: {
      status: 'clear',
      match: null,
      warning: null,
      source: input.source,
      contextKey: input.contextKey,
    },
  }
}

export function failDuplicateLookup(
  state: InvoiceFlowState,
  contextKey: string,
): InvoiceFlowState {
  if (state.duplicate.contextKey !== contextKey) return state
  return {
    ...state,
    duplicate: {
      status: 'failed',
      match: null,
      warning: DUPLICATE_LOOKUP_FAILED_MESSAGE,
      source: null,
      contextKey,
    },
  }
}

export function clearDuplicateCheck(state: InvoiceFlowState): InvoiceFlowState {
  return {
    ...state,
    duplicate: { ...initialDuplicateState },
  }
}

export function abandonAnalyze(state: InvoiceFlowState): InvoiceFlowState {
  if (state.status !== 'analyzing') return state
  return {
    ...state,
    status: 'idle',
    requestError: null,
    result: null,
    originalSnapshot: null,
    corrections: {},
    localDecisions: {},
    receivedDrafts: {},
    mappingDrafts: {},
    mappingSuggestions: {},
    saveStatus: 'idle',
    saveError: null,
    savedDocument: null,
    intakePhase: null,
    intakeLines: [],
    acceptFiscalInconsistency: false,
  }
}

export function prepareDuplicateContext(
  state: InvoiceFlowState,
  contextKey: string,
): InvoiceFlowState {
  return beginDuplicateCheck(abandonAnalyze(state), contextKey)
}

export function applyDuplicateOutcome(
  state: InvoiceFlowState,
  contextKey: string,
  outcome: DuplicateLookupOutcome | { kind: 'skipped' },
  source: 'hash' | 'fiscal',
): InvoiceFlowState {
  if (outcome.kind === 'stale' || outcome.kind === 'skipped') return state
  if (outcome.kind === 'failed') return failDuplicateLookup(state, contextKey)
  if (outcome.kind === 'matched') {
    return applyDuplicateLookup(state, { contextKey, match: outcome.match, source })
  }
  return applyDuplicateLookup(state, { contextKey, match: null, source })
}

export function beginAnalyze(state: InvoiceFlowState): InvoiceFlowState | null {
  if (!canAnalyze(state) || !state.file) return null
  return {
    ...state,
    status: 'analyzing',
    requestError: null,
    result: null,
    originalSnapshot: null,
    corrections: {},
    localDecisions: {},
    receivedDrafts: {},
    mappingDrafts: {},
    mappingSuggestions: {},
    saveStatus: 'idle',
    saveError: null,
    savedDocument: null,
    intakePhase: null,
    intakeLines: [],
    acceptFiscalInconsistency: false,
  }
}

export function succeedAnalyze(
  state: InvoiceFlowState,
  result: InvoiceAnalysisApiResult,
): InvoiceFlowState {
  return {
    ...state,
    status: 'review',
    result,
    originalSnapshot: freezeAnalysisSnapshot(result),
    receivedDrafts: initialReviewReceivedDrafts(result.document.lines),
    mappingDrafts: {},
    mappingSuggestions: {},
    requestError: null,
    saveStatus: 'idle',
    saveError: null,
    savedDocument: null,
    intakePhase: null,
    intakeLines: [],
    acceptFiscalInconsistency: false,
  }
}

export function failAnalyze(
  state: InvoiceFlowState,
  error: Pick<InvoiceApiError, 'message' | 'status' | 'code'>,
): InvoiceFlowState {
  return {
    ...state,
    status: 'failed',
    result: null,
    originalSnapshot: null,
    requestError: error,
    receivedDrafts: {},
    mappingDrafts: {},
    mappingSuggestions: {},
    saveStatus: 'idle',
    saveError: null,
    savedDocument: null,
    intakePhase: null,
    intakeLines: [],
  }
}

export function setLocalDecision(
  state: InvoiceFlowState,
  relationId: string,
  decision: LocalRelationDecision,
): InvoiceFlowState {
  if (state.saveStatus === 'saving' || state.saveStatus === 'saved') return state
  const localDecisions = {
    ...state.localDecisions,
    [relationId]: decision,
  }
  const source = state.originalSnapshot ?? state.result
  if (!source) return { ...state, localDecisions }
  const result = applyCommercialReview(source, localDecisions)
  return {
    ...state,
    localDecisions,
    result,
    receivedDrafts: mergeReviewReceivedDrafts(state.receivedDrafts, result.document.lines),
  }
}

export function setReviewReceivedDisplay(
  state: InvoiceFlowState,
  sourceLineId: string,
  displayValue: string,
): InvoiceFlowState {
  if (state.saveStatus === 'saving' || state.saveStatus === 'saved') return state
  const line = state.result?.document.lines.find((item) => item.id === sourceLineId)
  if (!line || !canEditReviewReceived(line)) return state
  return {
    ...state,
    receivedDrafts: {
      ...state.receivedDrafts,
      [sourceLineId]: displayValue,
    },
  }
}

export function hydrateReviewMapping(
  state: InvoiceFlowState,
  memories: ConfirmedMappingMemory[],
  products: InventoryProductOption[] = [],
  organizationId?: string | null,
  replaceExisting = false,
): InvoiceFlowState {
  if (!state.result) return state
  const next = hydrateReviewMappingDrafts(
    state.result.document.lines,
    memories,
    replaceExisting ? {} : state.mappingDrafts,
    products,
    organizationId,
  )
  return {
    ...state,
    mappingDrafts: next.drafts,
    mappingSuggestions: next.suggestions,
  }
}

export function resetReviewMapping(state: InvoiceFlowState): InvoiceFlowState {
  return {
    ...state,
    mappingDrafts: {},
    mappingSuggestions: {},
  }
}

export function setReviewMappingProduct(
  state: InvoiceFlowState,
  sourceLineId: string,
  inventoryProductId: string,
  conversionFactor?: number | null,
): InvoiceFlowState {
  if (state.saveStatus === 'saving' || state.saveStatus === 'saved') return state
  const line = state.result?.document.lines.find((item) => item.id === sourceLineId)
  if (!line || !canEditReviewReceived(line)) return state
  const previous = state.mappingDrafts[sourceLineId] ?? emptyReviewMappingDraft()
  if (!inventoryProductId.trim()) {
    // Volver a la propuesta de alta (no deja la línea “vacía” sin opción).
    return {
      ...state,
      mappingDrafts: {
        ...state.mappingDrafts,
        [sourceLineId]: proposeCreateMappingDraft(line),
      },
    }
  }
  return {
    ...state,
    mappingDrafts: {
      ...state.mappingDrafts,
      [sourceLineId]: {
        ...previous,
        inventoryProductId,
        action: 'link_existing',
        createIntent: null,
        conversionFactor: conversionFactor === undefined
          ? (inventoryProductId === previous.inventoryProductId ? previous.conversionFactor : null)
          : conversionFactor,
      },
    },
  }
}

export function setReviewMappingCreateIntent(
  state: InvoiceFlowState,
  sourceLineId: string,
  intent: ReviewMappingCreateIntent,
): InvoiceFlowState {
  if (state.saveStatus === 'saving' || state.saveStatus === 'saved') return state
  const line = state.result?.document.lines.find((item) => item.id === sourceLineId)
  if (!line || !canEditReviewReceived(line)) return state
  const previous = state.mappingDrafts[sourceLineId] ?? emptyReviewMappingDraft()
  const reactivateId = intent.reactivateProductId?.trim() || null
  return {
    ...state,
    mappingDrafts: {
      ...state.mappingDrafts,
      [sourceLineId]: {
        ...previous,
        inventoryProductId: reactivateId ?? '',
        action: reactivateId ? 'reactivate' : 'create',
        createIntent: intent,
        conversionFactor: previous.conversionFactor,
        approximateAccepted: false,
      },
    },
  }
}

export function setReviewMappingConversionFactor(
  state: InvoiceFlowState,
  sourceLineId: string,
  conversionFactor: number | null,
): InvoiceFlowState {
  if (state.saveStatus === 'saving' || state.saveStatus === 'saved') return state
  const line = state.result?.document.lines.find((item) => item.id === sourceLineId)
  if (!line || !canEditReviewReceived(line)) return state
  const previous = state.mappingDrafts[sourceLineId] ?? emptyReviewMappingDraft()
  return {
    ...state,
    mappingDrafts: {
      ...state.mappingDrafts,
      [sourceLineId]: {
        ...previous,
        conversionFactor,
      },
    },
  }
}

export function acceptReviewMappingSuggestion(
  state: InvoiceFlowState,
  sourceLineId: string,
): InvoiceFlowState {
  if (state.saveStatus === 'saving' || state.saveStatus === 'saved') return state
  const suggestion = state.mappingSuggestions[sourceLineId]
  if (!suggestion) return state
  return {
    ...state,
    mappingDrafts: {
      ...state.mappingDrafts,
      [sourceLineId]: {
        inventoryProductId: suggestion.inventoryProductId,
        approximateAccepted: true,
        conversionFactor: suggestion.conversionFactor ?? null,
        action: 'link_existing',
        createIntent: null,
      },
    },
  }
}

export function setAcceptFiscalInconsistency(
  state: InvoiceFlowState,
  value: boolean,
): InvoiceFlowState {
  if (state.saveStatus === 'saving' || state.saveStatus === 'saved') return state
  return {
    ...state,
    acceptFiscalInconsistency: value,
  }
}

export function beginSave(state: InvoiceFlowState, locationId: string): InvoiceFlowState | null {
  if (!canSaveInvoice(state, locationId)) return null
  return {
    ...state,
    saveStatus: 'saving',
    saveError: null,
    intakePhase: 'Guardando factura…',
    intakeLines: [],
  }
}

export function failSave(
  state: InvoiceFlowState,
  error: Pick<InvoiceApiError, 'message' | 'status' | 'code'>,
): InvoiceFlowState {
  return {
    ...state,
    saveStatus: 'failed',
    saveError: error,
    intakePhase: null,
  }
}

export function captureSavedDocument(
  state: InvoiceFlowState,
  savedDocument: InvoiceSaveApiResult,
): InvoiceFlowState {
  return {
    ...state,
    savedDocument,
    saveError: null,
  }
}

export function setIntakePhase(state: InvoiceFlowState, message: string | null): InvoiceFlowState {
  return {
    ...state,
    intakePhase: message,
  }
}

export function canRetryIntake(state: InvoiceFlowState) {
  return Boolean(
    state.savedDocument
    && !state.savedDocument.idempotent
    && state.saveStatus !== 'saving'
    && state.intakeLines.some((line) => line.retryable),
  )
}

export function beginIntakeRetry(state: InvoiceFlowState): InvoiceFlowState | null {
  if (!canRetryIntake(state)) return null
  return {
    ...state,
    saveStatus: 'saving',
    saveError: null,
    intakePhase: 'Reintentando operaciones pendientes…',
  }
}

export function finishIntake(
  state: InvoiceFlowState,
  intakeLines: IntakeLineResult[],
  savedDocument: InvoiceSaveApiResult,
): InvoiceFlowState {
  return {
    ...state,
    saveStatus: 'saved',
    saveError: null,
    savedDocument,
    intakePhase: null,
    intakeLines,
  }
}

export function succeedSave(
  state: InvoiceFlowState,
  savedDocument: InvoiceSaveApiResult,
): InvoiceFlowState {
  return finishIntake(state, state.intakeLines, savedDocument)
}

/** Guarda el comprobante sin confirmar recepción ni bloquear la revisión. */
export function succeedDraftSave(
  state: InvoiceFlowState,
  savedDocument: InvoiceSaveApiResult,
): InvoiceFlowState {
  return {
    ...state,
    saveStatus: 'idle',
    saveError: null,
    savedDocument,
    intakePhase: null,
    intakeLines: [],
  }
}

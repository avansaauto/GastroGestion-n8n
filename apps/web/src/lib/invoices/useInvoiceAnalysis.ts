import { useCallback, useEffect, useRef, useState } from 'react'
import {
  analyzeInvoiceJob,
  completeInvoiceSave,
  confirmPurchaseInvoiceIntake,
  getInvoice,
  InvoiceApiError,
  lookupInvoiceDuplicate,
  saveInvoice,
  type ConfirmIntakeApiResult,
} from './api'
import { sha256HexOfFile } from './fileHash'
import { ANALYSIS_IN_PROGRESS_MESSAGE } from './invoiceDuplicate'
import {
  beginAnalyze,
  beginSave,
  canAnalyze as flowCanAnalyze,
  canRetryIntake,
  canSaveInvoice as flowCanSaveInvoice,
  captureSavedDocument,
  clearInvoiceFile,
  failAnalyze,
  failSave,
  finishIntake,
  initialInvoiceFlow,
  saveBlockedReason as flowSaveBlockedReason,
  selectInvoiceFile,
  setAcceptFiscalInconsistency,
  setIntakePhase,
  setLocalDecision,
  setReviewReceivedDisplay,
  setReviewMappingProduct,
  setReviewMappingConversionFactor,
  setReviewMappingCreateIntent,
  acceptReviewMappingSuggestion,
  hydrateReviewMapping,
  resetReviewMapping,
  succeedAnalyze,
  succeedDraftSave,
  applyDuplicateOutcome,
  clearDuplicateCheck,
  prepareDuplicateContext,
  beginDuplicateCheck,
  type InvoiceFlowState,
} from './flow'
import {
  analyzeWithDuplicateGuard,
  duplicateContextKey,
  hashAndLookupDuplicate,
  invoiceFileKey,
  lookupFiscalDuplicate,
} from './invoiceDuplicate'
import type { ConfirmedMappingMemory } from './invoiceMemory'
import {
  buildConfirmIntakeLines,
  confirmIntakeBlockReason,
  type ConfirmIntakeGuard,
  type ConfirmIntakeLinePayload,
} from './confirmIntake'
import { saveInvoiceWithInventory } from './saveInvoiceWithInventory'
import { storedLineForAnalysis } from './mapping'
import type { ReviewMappingCreateIntent } from './reviewMapping'
import { toCommercialDecisionPayload } from './review'
import type { InventoryProductOption, InvoiceAnalysisLine, InvoiceStoredLine, LocalRelationDecision } from './types'
import type { IntakeLineResult } from './reviewIntake'

function intakeLinesFromConfirm(
  outcome: ConfirmIntakeApiResult,
  analysisLines: InvoiceAnalysisLine[],
  storedLines: InvoiceStoredLine[],
): IntakeLineResult[] {
  return outcome.lines.map((line) => {
    const analysis = analysisLines.find((item) => {
      const stored = storedLineForAnalysis({ id: item.id }, storedLines)
      return stored?.id === line.purchaseDocumentLineId
    })
    const label = analysis?.name || analysis?.originalDescription || line.purchaseDocumentLineId
    if (line.action === 'pending') {
      return {
        sourceLineId: analysis?.id ?? line.purchaseDocumentLineId,
        label,
        status: 'pending_mapping' as const,
        message: 'Sin insumo confirmado. No se actualizó el stock.',
        retryable: true,
      }
    }
    if (line.receive && typeof line.receive.remaining_quantity === 'number' && line.receive.remaining_quantity > 0) {
      return {
        sourceLineId: analysis?.id ?? line.purchaseDocumentLineId,
        label,
        status: 'partial' as const,
        message: 'Quedó mercadería sin ingresar. Reintentá sin crear otra factura.',
        retryable: true,
        remainingQuantity: Number(line.receive.remaining_quantity),
      }
    }
    if (line.receive) {
      return {
        sourceLineId: analysis?.id ?? line.purchaseDocumentLineId,
        label,
        status: 'received' as const,
        message: outcome.idempotent
          ? 'Recepción ya registrada. No se duplicó el movimiento.'
          : 'Recepción confirmada.',
        retryable: false,
      }
    }
    return {
      sourceLineId: analysis?.id ?? line.purchaseDocumentLineId,
      label,
      status: 'mapped' as const,
      message: 'Insumo vinculado, sin ingreso de stock.',
      retryable: true,
    }
  })
}

function intakeGuard(state: InvoiceFlowState, organizationId?: string | null): ConfirmIntakeGuard {
  return {
    commercialReviewLineIds: new Set(
      (state.result?.interpretation.lines ?? [])
        .filter((line) => line.status === 'requires_review')
        .map((line) => line.lineId),
    ),
    suggestions: state.mappingSuggestions,
    organizationId,
  }
}

export function useInvoiceAnalysis(locationId = '', previewMode = false) {
  const [state, setState] = useState<InvoiceFlowState>(initialInvoiceFlow)
  const stateRef = useRef(state)
  const analyzeInFlight = useRef(false)
  const analyzeAbortRef = useRef<AbortController | null>(null)
  const saveInFlight = useRef(false)
  const confirmKeyRef = useRef<string | null>(null)
  const confirmPlanRef = useRef<{
    confirmIdempotencyKey: string
    lines: ConfirmIntakeLinePayload[]
  } | null>(null)
  const lookupGeneration = useRef(0)
  const analyzeGeneration = useRef(0)
  stateRef.current = state

  const bumpContext = useCallback(() => {
    lookupGeneration.current += 1
    analyzeGeneration.current += 1
    analyzeAbortRef.current?.abort()
    analyzeInFlight.current = false
    saveInFlight.current = false
    confirmKeyRef.current = null
    confirmPlanRef.current = null
  }, [])

  useEffect(() => () => {
    analyzeGeneration.current += 1
    analyzeAbortRef.current?.abort()
    analyzeInFlight.current = false
  }, [])

  const selectFile = useCallback((file: File) => {
    bumpContext()
    setState((current) => {
      const next = selectInvoiceFile(current, file)
      stateRef.current = next
      return next
    })
  }, [bumpContext])

  const clearFile = useCallback(() => {
    bumpContext()
    setState(clearInvoiceFile())
  }, [bumpContext])

  const fileToken = state.file ? invoiceFileKey(state.file.file) : ''

  useEffect(() => {
    bumpContext()
    const file = stateRef.current.file?.file
    if (previewMode || !file || !locationId.trim()) {
      setState((current) => clearDuplicateCheck(current))
      return
    }
    const generation = lookupGeneration.current
    const contextKey = duplicateContextKey(locationId, invoiceFileKey(file))
    setState((current) => prepareDuplicateContext(current, contextKey))
    void hashAndLookupDuplicate({
      file,
      locationId,
      isCurrent: () => lookupGeneration.current === generation,
      hashFile: sha256HexOfFile,
      lookup: lookupInvoiceDuplicate,
    }).then(async (outcome) => {
      if (lookupGeneration.current !== generation) return
      const existingResult = stateRef.current.result
      setState((current) => {
        const hashed = applyDuplicateOutcome(current, contextKey, outcome, 'hash')
        if (outcome.kind === 'clear' && existingResult) {
          return beginDuplicateCheck(hashed, contextKey)
        }
        return hashed
      })
      if (outcome.kind !== 'clear' || !existingResult) return
      const fiscal = await lookupFiscalDuplicate({
        locationId,
        result: existingResult,
        isCurrent: () => lookupGeneration.current === generation,
        lookup: lookupInvoiceDuplicate,
      })
      if (lookupGeneration.current !== generation) return
      setState((current) => applyDuplicateOutcome(current, contextKey, fiscal, 'fiscal'))
    })
  }, [bumpContext, fileToken, locationId, previewMode])

  const analyze = useCallback(async () => {
    if (analyzeInFlight.current || saveInFlight.current) return
    if (!locationId.trim()) return
    const started = beginAnalyze(stateRef.current)
    if (!started?.file) return
    const generation = analyzeGeneration.current
    const lookupGen = lookupGeneration.current
    const contextKey = duplicateContextKey(locationId, invoiceFileKey(started.file.file))
    const controller = new AbortController()
    analyzeAbortRef.current = controller
    analyzeInFlight.current = true
    stateRef.current = started
    setState(started)
    try {
      const outcome = await analyzeWithDuplicateGuard({
        locationId,
        isCurrent: () => (
          analyzeGeneration.current === generation
          && lookupGeneration.current === lookupGen
          && !controller.signal.aborted
        ),
        analyze: () => analyzeInvoiceJob(started.file!.file, locationId, {
          signal: controller.signal,
          onJob: (job) => {
            if (!job.reused) return
            setState((current) => (
              current.status === 'analyzing'
                ? { ...current, intakePhase: ANALYSIS_IN_PROGRESS_MESSAGE }
                : current
            ))
          },
        }),
        lookupFiscal: lookupInvoiceDuplicate,
      })
      if (outcome.kind === 'stale') return
      setState((current) => {
        if (analyzeGeneration.current !== generation) return current
        if (current.file?.file !== started.file?.file) return current
        const reviewed = succeedAnalyze(current, outcome.result)
        return applyDuplicateOutcome(reviewed, contextKey, outcome.duplicate, 'fiscal')
      })
    } catch (error) {
      if (
        analyzeGeneration.current !== generation
        || controller.signal.aborted
        || (error instanceof InvoiceApiError && error.code === 'ANALYSIS_CANCELLED')
      ) return
      const mapped = error instanceof InvoiceApiError
        ? error
        : new InvoiceApiError('No se pudo analizar la factura.', 0, 'ANALYSIS_FAILED')
      setState((current) => {
        if (current.file?.file !== started.file?.file) return current
        return failAnalyze(current, mapped)
      })
    } finally {
      if (analyzeAbortRef.current === controller) analyzeAbortRef.current = null
      if (analyzeGeneration.current === generation) {
        analyzeInFlight.current = false
      }
    }
  }, [locationId])

  const decide = useCallback((relationId: string, decision: LocalRelationDecision) => {
    setState((current) => setLocalDecision(current, relationId, decision))
  }, [])

  const setAcceptFiscal = useCallback((value: boolean) => {
    setState((current) => setAcceptFiscalInconsistency(current, value))
  }, [])

  const setReceivedDisplay = useCallback((sourceLineId: string, displayValue: string) => {
    setState((current) => setReviewReceivedDisplay(current, sourceLineId, displayValue))
  }, [])

  const setMappingProduct = useCallback((sourceLineId: string, inventoryProductId: string) => {
    setState((current) => setReviewMappingProduct(current, sourceLineId, inventoryProductId))
  }, [])

  const setMappingConversionFactor = useCallback((sourceLineId: string, conversionFactor: number | null) => {
    setState((current) => setReviewMappingConversionFactor(current, sourceLineId, conversionFactor))
  }, [])

  const setMappingCreateIntent = useCallback((sourceLineId: string, intent: ReviewMappingCreateIntent) => {
    setState((current) => setReviewMappingCreateIntent(current, sourceLineId, intent))
  }, [])

  const acceptMappingSuggestion = useCallback((sourceLineId: string) => {
    setState((current) => acceptReviewMappingSuggestion(current, sourceLineId))
  }, [])

  const applyMappingMemories = useCallback((
    memories: ConfirmedMappingMemory[],
    products: InventoryProductOption[] = [],
    organizationId?: string | null,
    replaceExisting = false,
  ) => {
    setState((current) => hydrateReviewMapping(
      current,
      memories,
      products,
      organizationId,
      replaceExisting,
    ))
  }, [])

  const clearMappingDrafts = useCallback(() => {
    setState((current) => resetReviewMapping(current))
  }, [])

  const stageConfirmPlan = useCallback((products: InventoryProductOption[]) => {
    if (confirmPlanRef.current) return confirmPlanRef.current
    const current = stateRef.current
    const analysisLines = current.result?.document.lines ?? []
    const blockReceptionLineIds = new Set(
      (current.result?.interpretation.lines ?? [])
        .filter((line) => line.status === 'requires_review')
        .map((line) => line.lineId),
    )
    const lines = buildConfirmIntakeLines(
      analysisLines,
      current.receivedDrafts,
      current.mappingDrafts,
      products,
      () => crypto.randomUUID(),
      blockReceptionLineIds,
    )
    const plan = {
      confirmIdempotencyKey: crypto.randomUUID(),
      lines,
    }
    confirmPlanRef.current = plan
    confirmKeyRef.current = plan.confirmIdempotencyKey
    return plan
  }, [])

  const persistDraft = useCallback(async (
    saveLocationId: string,
    confirmPlan?: { confirmIdempotencyKey: string; lines: ConfirmIntakeLinePayload[] } | null,
  ) => {
    if (stateRef.current.savedDocument) return stateRef.current.savedDocument
    const started = beginSave(stateRef.current, saveLocationId)
    if (!started?.file || !started.originalSnapshot) return null
    const integrityToken = started.originalSnapshot.metadata.integrityToken
    if (!integrityToken) return null
    stateRef.current = started
    setState(started)
    setState((latest) => setIntakePhase(latest, 'Guardando comprobante…'))
    const saved = await saveInvoice({
      file: started.file!.file,
      locationId: saveLocationId,
      integrityToken,
      originalSnapshot: started.originalSnapshot!,
      corrections: started.corrections,
      commercialDecisions: toCommercialDecisionPayload(
        started.originalSnapshot!,
        started.localDecisions,
      ),
      acceptFiscalInconsistency: started.acceptFiscalInconsistency,
      confirmIntent: confirmPlan
        ? {
          confirmIdempotencyKey: confirmPlan.confirmIdempotencyKey,
          lines: confirmPlan.lines.map((line) => ({
            sourceLineId: line.purchaseDocumentLineId,
            action: line.action,
            inventoryProductId: line.inventoryProductId ?? null,
            create: line.create ?? null,
            conversionFactor: line.conversionFactor ?? null,
            receiveQuantity: line.receiveQuantity ?? null,
            receiveIdempotencyKey: line.receiveIdempotencyKey ?? null,
          })),
        }
        : null,
    })
    const next = succeedDraftSave(captureSavedDocument(stateRef.current, saved), saved)
    stateRef.current = next
    setState(next)
    return saved
  }, [])

  const runConfirmIntake = useCallback(async (
    saveLocationId: string,
    organizationId: string,
    products: InventoryProductOption[] = [],
  ) => {
    const current = stateRef.current
    if (!current.savedDocument) return
    if (current.savedDocument.idempotent && !current.savedDocument.confirmIntentStored) return
    if (!current.savedDocument.confirmIntentStored) {
      const blocked = confirmIntakeBlockReason(
        current.result?.document.lines ?? [],
        current.receivedDrafts,
        current.mappingDrafts,
        products,
        intakeGuard(current, organizationId),
      )
      if (blocked) {
        setState((latest) => failSave(latest, {
          message: blocked,
          status: 422,
          code: 'CONFIRM_BLOCKED',
        }))
        return
      }
    }
    setState((latest) => ({
      ...latest,
      saveStatus: 'saving',
      saveError: null,
      intakePhase: 'Confirmando recepción…',
    }))
    const detail = await getInvoice(current.savedDocument.id)
    if (current.savedDocument.confirmIntentStored) {
      const outcome = await completeInvoiceSave(current.savedDocument.id, {
        organizationId,
        locationId: saveLocationId,
      })
      const analysisLines = current.result?.document.lines ?? []
      const intakeLines = intakeLinesFromConfirm(outcome, analysisLines, detail.lines)
      confirmKeyRef.current = null
      setState((latest) => finishIntake(latest, intakeLines, latest.savedDocument!))
      return
    }
    const analysisLines = current.result?.document.lines ?? []
    const blockReceptionLineIds = new Set(
      (current.result?.interpretation.lines ?? [])
        .filter((line) => line.status === 'requires_review')
        .map((line) => line.lineId),
    )
    const built = confirmPlanRef.current?.lines ?? buildConfirmIntakeLines(
      analysisLines,
      current.receivedDrafts,
      current.mappingDrafts,
      products,
      () => crypto.randomUUID(),
      blockReceptionLineIds,
    )
    const lines = built.map((line) => {
      const stored = storedLineForAnalysis({ id: line.purchaseDocumentLineId }, detail.lines)
      if (!stored) {
        throw new InvoiceApiError(
          'No hay una línea guardada asociada para confirmar.',
          422,
          'LINES_MISMATCH',
        )
      }
      return { ...line, purchaseDocumentLineId: stored.id }
    })
    const confirmKey = confirmPlanRef.current?.confirmIdempotencyKey
      ?? (canRetryIntake(current) && confirmKeyRef.current
        ? confirmKeyRef.current
        : crypto.randomUUID())
    confirmKeyRef.current = confirmKey
    const outcome = await confirmPurchaseInvoiceIntake(current.savedDocument.id, {
      organizationId,
      locationId: saveLocationId,
      confirmIdempotencyKey: confirmKey,
      lines,
    })
    confirmKeyRef.current = null
    const intakeLines = intakeLinesFromConfirm(outcome, analysisLines, detail.lines)
    setState((latest) => finishIntake(latest, intakeLines, latest.savedDocument!))
  }, [])

  /** Solo conserva el comprobante, sin confirmar recepción ni mover stock. */
  const saveDraft = useCallback(async (saveLocationId: string) => {
    if (saveInFlight.current || analyzeInFlight.current) return
    if (stateRef.current.savedDocument) return
    saveInFlight.current = true
    try {
      await persistDraft(saveLocationId)
    } catch (error) {
      const mapped = error instanceof InvoiceApiError
        ? error
        : new InvoiceApiError('No se pudo guardar la factura.', 0, 'SAVE_FAILED')
      setState((latest) => failSave(latest, mapped))
    } finally {
      saveInFlight.current = false
    }
  }, [persistDraft])

  const confirmIntake = useCallback(async (
    saveLocationId: string,
    organizationId: string,
    products: InventoryProductOption[] = [],
  ) => {
    if (saveInFlight.current || analyzeInFlight.current) return
    saveInFlight.current = true
    try {
      await runConfirmIntake(saveLocationId, organizationId, products)
    } catch (error) {
      const mapped = error instanceof InvoiceApiError
        ? error
        : new InvoiceApiError('No se pudo confirmar la recepción.', 0, 'CONFIRM_FAILED')
      const uncertain = mapped.status === 0 || mapped.status >= 500
      setState((latest) => ({
        ...failSave(latest, mapped),
        intakeLines: uncertain
          ? [{
              sourceLineId: 'confirm',
              label: 'Confirmación',
              status: 'receive_uncertain' as const,
              message: `${mapped.message} Conservamos la clave de idempotencia para reintentar sin duplicar stock.`,
              retryable: true,
            }]
          : latest.intakeLines,
      }))
    } finally {
      saveInFlight.current = false
    }
  }, [runConfirmIntake])

  /**
   * Flujo principal: valida → guarda comprobante junto con el intento → confirma.
   * El intento se arma una sola vez. Si la página se cierra después del alta,
   * Completar guardado repite ese mismo payload.
   */
  const saveAndReceive = useCallback(async (
    saveLocationId: string,
    organizationId: string,
    products: InventoryProductOption[] = [],
  ) => {
    if (saveInFlight.current || analyzeInFlight.current) return
    const blocked = confirmIntakeBlockReason(
      stateRef.current.result?.document.lines ?? [],
      stateRef.current.receivedDrafts,
      stateRef.current.mappingDrafts,
      products,
      intakeGuard(stateRef.current, organizationId),
    )
    if (blocked) {
      setState((latest) => failSave(latest, {
        message: blocked,
        status: 422,
        code: 'CONFIRM_BLOCKED',
      }))
      return
    }
    saveInFlight.current = true
    try {
      const plan = stageConfirmPlan(products)
      const outcome = await saveInvoiceWithInventory({
        savedDocument: stateRef.current.savedDocument,
        saveDraft: async () => {
          const saved = await persistDraft(saveLocationId, plan)
          if (!saved) {
            throw new InvoiceApiError('No se pudo guardar la factura.', 0, 'SAVE_FAILED')
          }
          return saved
        },
        confirm: async () => {
          await runConfirmIntake(saveLocationId, organizationId, products)
        },
      })
      if (outcome.phase === 'already_registered') {
        setState((latest) => finishIntake(latest, [], outcome.saved))
      }
    } catch (error) {
      const mapped = error instanceof InvoiceApiError
        ? error
        : new InvoiceApiError('No se pudo guardar o confirmar la recepción.', 0, 'SAVE_FAILED')
      const uncertain = mapped.status === 0 || mapped.status >= 500
      setState((latest) => ({
        ...failSave(latest, mapped),
        intakeLines: uncertain && latest.savedDocument
          ? [{
              sourceLineId: 'confirm',
              label: 'Confirmación',
              status: 'receive_uncertain' as const,
              message: `${mapped.message} El comprobante quedó guardado y el inventario no se actualizó. Reintentá sin crear otra factura.`,
              retryable: true,
            }]
          : latest.intakeLines,
      }))
    } finally {
      saveInFlight.current = false
    }
  }, [persistDraft, runConfirmIntake, stageConfirmPlan])

  return {
    state,
    canAnalyze: flowCanAnalyze(state)
      && Boolean(locationId.trim())
      && !previewMode
      && state.duplicate.status !== 'idle',
    canSave: (saveLocationId: string) => flowCanSaveInvoice(state, saveLocationId) && !state.savedDocument,
    canConfirm: Boolean(state.savedDocument && !state.savedDocument.idempotent && state.saveStatus !== 'saving'),
    canRetry: canRetryIntake(state),
    saveBlockedReason: (saveLocationId: string, isPreview: boolean) => (
      flowSaveBlockedReason(state, saveLocationId, isPreview)
    ),
    confirmBlockedReason: (
      products: InventoryProductOption[] = [],
      organizationId?: string | null,
    ) => (
      confirmIntakeBlockReason(
        state.result?.document.lines ?? [],
        state.receivedDrafts,
        state.mappingDrafts,
        products,
        intakeGuard(state, organizationId),
      )
    ),
    selectFile,
    clearFile,
    analyze,
    decide,
    setAcceptFiscal,
    setReceivedDisplay,
    setMappingProduct,
    setMappingConversionFactor,
    setMappingCreateIntent,
    acceptMappingSuggestion,
    applyMappingMemories,
    clearMappingDrafts,
    saveDraft,
    saveAndReceive,
    confirmIntake,
  }
}

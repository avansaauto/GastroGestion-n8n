import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useRegisterWorkspaceGuard } from '@/lib/WorkspaceGuardProvider'
import { InvoiceApiError, listCatalogMappingMemories, listCatalogProducts } from '@/lib/invoices/api'
import { shouldShowInvoiceReview } from '@/lib/invoices/invoiceDuplicate'
import { invoiceIntakeStage } from '@/lib/invoices/intakeStage'
import { useInvoiceAnalysis } from '@/lib/invoices/useInvoiceAnalysis'
import type { ConfirmedMappingMemory } from '@/lib/invoices/invoiceMemory'
import { locationName, organizationName } from '@/lib/operations'
import { useAuth } from '@/lib/auth'
import {
  invoiceHasActiveOperation,
  invoiceWorkspaceGuard,
} from '@/lib/workspaceGuard'
import { InvoiceDropzone } from './InvoiceDropzone'
import { InvoiceDuplicateNotice } from './InvoiceDuplicateNotice'
import { InvoiceMappingCreateModal } from './InvoiceMappingCreateModal'
import { InvoiceReview } from './InvoiceReview'
import type { InvoiceProductCatalog } from './InvoiceMappingPicker'

export function shouldRedirectAfterInvoiceSave(input: {
  saveStatus: string
  canRetry: boolean
  savedId?: string | null
}) {
  return input.saveStatus === 'saved' && Boolean(input.savedId) && !input.canRetry
}

export function InvoiceNewPage() {
  const navigate = useNavigate()
  const { previewMode } = useAuth()
  const {
    organization,
    organizationId,
    location,
    locations,
    locationId,
    loading,
    error,
  } = useAuthorizedScopeContext()
  const [pinnedLocationId, setPinnedLocationId] = useState(locationId)
  const {
    state,
    canAnalyze,
    canSave,
    canConfirm,
    canRetry,
    saveBlockedReason,
    confirmBlockedReason,
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
    saveAndReceive,
  } = useInvoiceAnalysis(pinnedLocationId, previewMode)
  const redirectedRef = useRef<string | null>(null)
  const [catalog, setCatalog] = useState<InvoiceProductCatalog>({
    products: [],
    loading: false,
    error: '',
  })
  const [createLineId, setCreateLineId] = useState<string | null>(null)
  const createLine = createLineId
    ? state.result?.document.lines.find((line) => line.id === createLineId) ?? null
    : null
  const mappingMemoriesRef = useRef<ConfirmedMappingMemory[]>([])
  const discardInvoice = useCallback(() => {
    clearFile()
  }, [clearFile])
  useRegisterWorkspaceGuard(
    'invoice-new',
    invoiceWorkspaceGuard({
      hasFile: Boolean(state.file),
      status: state.status,
      saveStatus: state.saveStatus,
    }),
    discardInvoice,
  )
  const analyzing = state.status === 'analyzing'
  const saving = state.saveStatus === 'saving'
  const busy = analyzing || saving
  const activeOperation = invoiceHasActiveOperation({
    hasFile: Boolean(state.file),
    status: state.status,
    saveStatus: state.saveStatus,
  })
  if (!activeOperation && pinnedLocationId !== locationId) {
    setPinnedLocationId(locationId)
  }
  const operationLocationId = pinnedLocationId || locationId
  const destination = locations.find((item) => item.id === operationLocationId) ?? location
  const catalogKey = [
    operationLocationId,
    organizationId,
    state.originalSnapshot?.metadata.integrityToken ?? '',
    state.originalSnapshot?.metadata.fileSha256 ?? '',
  ].join(':')

  useEffect(() => {
    const locationReady = locations.some((item) => item.id === operationLocationId)
    if (previewMode || !operationLocationId || !locationReady || !state.originalSnapshot) {
      mappingMemoriesRef.current = []
      setCatalog({ products: [], loading: false, error: '' })
      clearMappingDrafts()
      return
    }
    let cancelled = false
    // Alta diferida antes de que vuelva el catálogo: un producto nuevo queda
    // en create sin clic. El catálogo, si llega, puede pasar esa línea a
    // link_existing o dejarla pendiente si la coincidencia es ambigua.
    applyMappingMemories([], [], organizationId, true)
    setCatalog({ products: [], loading: true, error: '' })
    Promise.all([
      listCatalogProducts(operationLocationId),
      listCatalogMappingMemories(operationLocationId, state.originalSnapshot.document.supplier.taxId),
    ]).then(([products, memories]) => {
      if (cancelled) return
      mappingMemoriesRef.current = memories
      setCatalog({ products, loading: false, error: '' })
      applyMappingMemories(memories, products, organizationId)
    }).catch((reason: Error) => {
      if (cancelled) return
      mappingMemoriesRef.current = []
      setCatalog({
        products: [],
        loading: false,
        error: reason instanceof InvoiceApiError ? reason.message : 'No se pudieron consultar los insumos.',
      })
    })
    return () => {
      cancelled = true
    }
  }, [
    applyMappingMemories,
    catalogKey,
    clearMappingDrafts,
    locations,
    operationLocationId,
    organizationId,
    previewMode,
    state.originalSnapshot,
  ])

  useEffect(() => {
    if (!state.result || catalog.loading) return
    applyMappingMemories(mappingMemoriesRef.current, catalog.products, organizationId)
  }, [
    applyMappingMemories,
    catalog.loading,
    catalog.products,
    organizationId,
    state.localDecisions,
    state.result,
  ])

  useEffect(() => {
    const savedId = state.savedDocument?.id ?? null
    const inventoryComplete = state.saveStatus === 'saved'
      && state.intakeLines.length > 0
      && state.intakeLines.every((line) => line.status === 'received')
      && !canRetry
    if (!shouldRedirectAfterInvoiceSave({
      saveStatus: inventoryComplete ? 'saved' : 'idle',
      canRetry: false,
      savedId: inventoryComplete ? savedId : null,
    })) return
    if (!savedId || redirectedRef.current === savedId) return
    redirectedRef.current = savedId
    navigate('/facturas', { replace: true, state: { invoiceRegistered: true } })
  }, [canRetry, navigate, state.intakeLines, state.saveStatus, state.savedDocument?.id])

  return (
    <div className="space-y-6">
      <div>
        <Link className="inline-flex items-center gap-1 text-sm font-semibold text-senda-muted hover:text-senda-ink" to="/facturas">
          <ArrowLeft size={16} /> Facturas
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="m-0 text-xl font-extrabold tracking-tight sm:text-2xl">Nueva factura</h2>
            <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-senda-muted">
              GastroGest lee el comprobante. Al guardar se vinculan los insumos y se actualiza el inventario.
            </p>
            {previewMode ? (
              <p className="mb-0 mt-2 text-xs text-senda-muted">
                En vista previa no se asigna un local real. Configurá Supabase e iniciá sesión.
              </p>
            ) : destination && organization ? (
              <p className="mb-0 mt-2 text-xs text-senda-muted">
                Destino: {locationName(destination)} · {organizationName(organization)}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {error && (
        <p className="mb-0 text-sm text-red-700">{error}</p>
      )}
      {!previewMode && !loading && !locationId && (
        <p className="mb-0 text-sm text-senda-muted">No hay un local activo para guardar la factura.</p>
      )}

      {(() => {
        const reviewVisible = Boolean(state.result && shouldShowInvoiceReview(state.result, state.duplicate))
        const stage = invoiceIntakeStage({
          hasFile: Boolean(state.file),
          analyzing,
          hasReview: reviewVisible,
        })
        const askBeforeReplace = () => {
          if (!state.result) return true
          const saved = Boolean(state.savedDocument)
          return window.confirm(
            saved
              ? '¿Cargar otra factura? Esta pantalla se reinicia. La factura ya guardada sigue en el listado.'
              : '¿Cambiar el archivo? Vas a perder la revisión que todavía no guardaste.',
          )
        }
        const replaceFile = (file: File) => {
          if (!askBeforeReplace()) return
          selectFile(file)
        }
        const removeFile = () => {
          if (!askBeforeReplace()) return
          clearFile()
        }

        const documentPanel = (
          <Card className="p-4 sm:p-5">
            <InvoiceDropzone
              disabled={busy}
              error={state.fileError}
              file={state.file}
              onClear={removeFile}
              onSelect={replaceFile}
            />

            {stage !== 'review' ? <InvoiceDuplicateNotice duplicate={state.duplicate} /> : null}

            {stage === 'analyzing' && state.file && (
              <div className="mt-5 flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-4">
                <Loader2 className="mt-0.5 shrink-0 animate-spin text-senda-navy" size={20} />
                <div>
                  <p className="m-0 text-sm font-semibold">Estamos leyendo tu factura</p>
                  <p className="mb-0 mt-1 text-sm leading-6 text-senda-muted">
                    {state.intakePhase
                      || `Análisis en curso de ${state.file.name}. Puede tardar más de un minuto. No cierres esta pantalla.`}
                  </p>
                </div>
              </div>
            )}

            {state.requestError && stage !== 'review' && (
              <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {state.requestError.message}
              </div>
            )}

            {stage === 'selected' && (
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Button
                  className="w-full sm:w-auto"
                  disabled={!canAnalyze || previewMode || busy}
                  onClick={() => void analyze()}
                >
                  Analizar factura
                </Button>
                {state.status === 'failed' && (
                  <Button className="w-full sm:w-auto" disabled={busy || !canAnalyze} variant="secondary" onClick={() => void analyze()}>
                    Reintentar
                  </Button>
                )}
              </div>
            )}
            {previewMode && stage !== 'review' && (
              <p className="mb-0 mt-3 text-xs text-senda-muted">
                En vista previa no se envía el archivo. Configurá Supabase e iniciá sesión para un análisis real.
              </p>
            )}
          </Card>
        )

        if (stage !== 'review') return documentPanel

        return (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]">
            <div className="lg:sticky lg:top-3">{documentPanel}</div>
            <InvoiceReview
              localDecisions={state.localDecisions}
              mappingCatalog={catalog}
              mappingDrafts={state.mappingDrafts}
              mappingSuggestions={state.mappingSuggestions}
              receivedDrafts={state.receivedDrafts}
              result={state.result!}
              onAcceptMappingSuggestion={acceptMappingSuggestion}
              onCreateMappingProduct={organizationId && !previewMode ? setCreateLineId : undefined}
              onDecide={decide}
              onMappingConversionFactorChange={setMappingConversionFactor}
              onMappingProductChange={setMappingProduct}
              onReceivedChange={setReceivedDisplay}
              save={{
                canSave: canSave(operationLocationId) && !previewMode,
                canConfirm: canConfirm && !previewMode && Boolean(organizationId),
                canRetry: canRetry && !previewMode && Boolean(organizationId),
                saving,
                saved: state.savedDocument,
                error: state.saveError,
                blockedReason: saveBlockedReason(operationLocationId, previewMode),
                confirmBlockedReason: confirmBlockedReason(catalog.products, organizationId),
                progressMessage: state.intakePhase,
                intakeLines: state.intakeLines,
                acceptFiscalInconsistency: state.acceptFiscalInconsistency,
                onAcceptFiscal: setAcceptFiscal,
                onSave: () => {
                  if (!organizationId) return
                  void saveAndReceive(operationLocationId, organizationId, catalog.products)
                },
                onCancel: () => {
                  if (state.savedDocument) {
                    navigate('/facturas')
                    return
                  }
                  if (state.file && !window.confirm('¿Cancelar sin guardar la factura?')) return
                  clearFile()
                },
              }}
            />
          </div>
        )
      })()}

      {organizationId && createLine && (
        <InvoiceMappingCreateModal
          commercialDescription={createLine.name || createLine.originalDescription || ''}
          contentUnit={createLine.contentUnit}
          invoiceUnit={createLine.unit}
          open={Boolean(createLineId)}
          organizationId={organizationId}
          onClose={() => setCreateLineId(null)}
          onPrepared={(intent) => {
            if (createLineId) setMappingCreateIntent(createLineId, intent)
            setCreateLineId(null)
          }}
        />
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useRegisterWorkspaceGuard } from '@/lib/WorkspaceGuardProvider'
import { InvoiceApiError, listCatalogMappingMemories, listCatalogProducts } from '@/lib/invoices/api'
import { shouldShowInvoiceReview } from '@/lib/invoices/invoiceDuplicate'
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
            <h2 className="m-0 text-2xl font-extrabold tracking-tight">Nueva factura</h2>
            <p className="mb-0 mt-2 text-sm text-senda-muted">
              SENDA lee el comprobante. Al guardar se vinculan los insumos y se actualiza el inventario.
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

      <Card className="p-5">
        <InvoiceDropzone
          disabled={busy}
          error={state.fileError}
          file={state.file}
          onClear={clearFile}
          onSelect={selectFile}
        />

        <InvoiceDuplicateNotice duplicate={state.duplicate} />

        {analyzing && state.file && (
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-senda-border bg-senda-subtle px-4 py-4">
            <Loader2 className="mt-0.5 animate-spin text-senda-navy" size={20} />
            <div>
              <p className="m-0 text-sm font-semibold">SENDA está analizando el documento</p>
              <p className="mb-0 mt-1 text-sm text-senda-muted">
                {state.intakePhase
                  || `Archivo: ${state.file.name}. Puede tardar más de un minuto. No cierres esta pantalla.`}
              </p>
            </div>
          </div>
        )}

        {state.requestError && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.requestError.message}
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            disabled={!canAnalyze || previewMode || busy}
            onClick={() => void analyze()}
          >
            {analyzing ? 'Analizando…' : 'Analizar factura'}
          </Button>
          {state.status === 'failed' && (
            <Button disabled={busy || !canAnalyze} variant="secondary" onClick={() => void analyze()}>
              Reintentar
            </Button>
          )}
        </div>
        {previewMode && (
          <p className="mb-0 mt-3 text-xs text-senda-muted">
            En vista previa no se envía el archivo. Configurá Supabase e iniciá sesión para un análisis real.
          </p>
        )}
      </Card>

      {state.result && shouldShowInvoiceReview(state.result, state.duplicate) && (
        <InvoiceReview
          localDecisions={state.localDecisions}
          mappingCatalog={catalog}
          mappingDrafts={state.mappingDrafts}
          mappingSuggestions={state.mappingSuggestions}
          receivedDrafts={state.receivedDrafts}
          result={state.result}
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
      )}

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

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { Modal } from '@/components/ui/Modal'
import type { Location } from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import { useRegisterWorkspaceGuard } from '@/lib/WorkspaceGuardProvider'
import { getInvoice, InvoiceApiError, listPendingReceptions } from '@/lib/invoices/api'
import {
  applyPendingReceptionsPage,
  pendingLineFromInvoiceDetail,
  pendingLineToStoredLine,
  reconcilePendingAfterReceive,
} from '@/lib/invoices/pendingReceptions'
import { formatDisplayQuantity } from '@/lib/invoices/receptionUnits'
import type { AttemptStore } from '@/lib/invoices/receiveAttempt'
import type { ReceiveLineFn } from '@/lib/invoices/receiveSubmit'
import { formatIssueDate, formatQuantity } from '@/lib/invoices/review'
import type { InvoiceReceiveResult, PendingReceptionLine } from '@/lib/invoices/types'
import { locationName } from '@/lib/operations'
import { pendingReceptionsWorkspaceGuard } from '@/lib/workspaceGuard'
import { InvoiceReceiveForm } from './InvoiceReceiveSection'

function quantityLabel(quantity: number, baseUnit: string | null) {
  return formatDisplayQuantity(quantity, baseUnit, formatQuantity)
}

function destinationLabel(
  row: PendingReceptionLine,
  locations: Location[],
  fallback = '',
) {
  const match = locations.find((location) => location.id === row.locationId)
  return match ? locationName(match) : fallback || row.locationId
}

function pendingReceptionColumns({
  locations,
  fallbackLocationLabel,
  sending,
  onReceive,
}: {
  locations: Location[]
  fallbackLocationLabel: string
  sending: boolean
  onReceive: (row: PendingReceptionLine) => void
}): Column<PendingReceptionLine>[] {
  return [
    {
      key: 'supplier',
      label: 'Proveedor',
      render: (row) => <span className="font-semibold">{row.supplierName || '—'}</span>,
    },
    {
      key: 'ingredient',
      label: 'Insumo',
      render: (row) => row.ingredientName || '—',
    },
    {
      key: 'number',
      label: 'Número de factura',
      render: (row) => row.documentNumber || '—',
    },
    {
      key: 'date',
      label: 'Fecha',
      render: (row) => formatIssueDate(row.documentDate),
    },
    {
      key: 'invoiced',
      label: 'Cantidad facturada',
      render: (row) => quantityLabel(row.invoicedQuantity, row.baseUnit),
    },
    {
      key: 'received',
      label: 'Cantidad recibida acumulada',
      render: (row) => quantityLabel(row.receivedQuantity, row.baseUnit),
    },
    {
      key: 'pending',
      label: 'Cantidad pendiente',
      render: (row) => quantityLabel(row.remainingQuantity, row.baseUnit),
    },
    {
      key: 'location',
      label: 'Local',
      render: (row) => destinationLabel(row, locations, fallbackLocationLabel) || '—',
    },
    {
      key: 'action',
      label: '',
      render: (row) => (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="min-h-8 px-3 text-xs"
            disabled={sending}
            type="button"
            onClick={() => onReceive(row)}
          >
            Recibir
          </Button>
          <Link className="text-sm font-semibold text-senda-navy hover:underline" to={`/facturas/${row.invoiceId}`}>
            Ver factura
          </Link>
        </div>
      ),
    },
  ]
}

export function InvoicePendingReceivePanel({
  row,
  destinationLabel: locationLabel,
  sending = false,
  refreshing = false,
  receiveLine,
  store,
  onReceived,
  onSending,
  onRefresh,
}: {
  row: PendingReceptionLine
  destinationLabel: string
  sending?: boolean
  refreshing?: boolean
  receiveLine?: ReceiveLineFn
  store?: AttemptStore
  onReceived: (result: InvoiceReceiveResult) => void
  onSending?: (active: boolean) => void
  onRefresh: () => void
}) {
  const stored = pendingLineToStoredLine(row)
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Proveedor</dt>
          <dd className="m-0 font-semibold">{row.supplierName || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Factura</dt>
          <dd className="m-0 font-semibold">{row.documentNumber || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Insumo</dt>
          <dd className="m-0 font-semibold">{row.ingredientName}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Local de destino</dt>
          <dd className="m-0 font-semibold">{locationLabel || row.locationId}</dd>
        </div>
      </dl>
      <p className="mb-0 text-xs text-senda-muted">
        El stock se registra en el local de la factura. El local del encabezado no cambia el destino de una factura ya guardada.
      </p>
      <InvoiceReceiveForm
        key={`${row.lineId}:${row.remainingQuantity}:${row.receivedQuantity}`}
        invoiceId={row.invoiceId}
        line={stored}
        receiveLine={receiveLine}
        sending={sending}
        store={store}
        onReceived={onReceived}
        onSending={onSending}
      />
      <Button disabled={sending || refreshing} type="button" variant="secondary" onClick={onRefresh}>
        {refreshing ? 'Actualizando…' : 'Actualizar cantidades'}
      </Button>
    </div>
  )
}

export function InvoicePendingReceptionsView({
  previewMode = false,
  locations,
  locationId,
  selectedLocationLabel,
  items,
  loading,
  loadingMore,
  error,
  nextCursor,
  receivingRow = null,
  sending = false,
  refreshing = false,
  receiveLine,
  store,
  onRetry,
  onLoadMore,
  onReceive,
  onCloseReceive,
  onReceived,
  onRefreshQuantities,
  onSending,
}: {
  previewMode?: boolean
  locations: Location[]
  locationId: string
  selectedLocationLabel: string
  items: PendingReceptionLine[]
  loading: boolean
  loadingMore: boolean
  error: string
  nextCursor: string | null
  receivingRow?: PendingReceptionLine | null
  sending?: boolean
  refreshing?: boolean
  receiveLine?: ReceiveLineFn
  store?: AttemptStore
  onRetry: () => void
  onLoadMore: () => void
  onReceive?: (row: PendingReceptionLine) => void
  onCloseReceive?: () => void
  onReceived?: (result: InvoiceReceiveResult) => void
  onRefreshQuantities?: () => void
  onSending?: (active: boolean) => void
}) {
  const hasMore = Boolean(nextCursor)
  const columns = pendingReceptionColumns({
    locations,
    fallbackLocationLabel: selectedLocationLabel,
    sending,
    onReceive: onReceive ?? (() => undefined),
  })
  const visibleItems = items.filter((row) => Boolean(row.ingredientId && row.ingredientName.trim()))

  return (
    <div className="space-y-6">
      <div>
        <Link className="inline-flex items-center gap-1 text-sm font-semibold text-senda-muted hover:text-senda-ink" to="/facturas">
          <ArrowLeft size={16} /> Facturas
        </Link>
        <div className="mt-3">
          <h2 className="m-0 text-2xl font-extrabold tracking-tight">Recepciones pendientes</h2>
          <p className="mb-0 mt-2 text-sm text-senda-muted">
            Mercadería facturada con cantidad pendiente de recibir. La recepción entra al local de la factura, no a otro local de la interfaz.
          </p>
        </div>
      </div>

      {previewMode ? (
        <p className="mb-0 text-xs text-senda-muted">
          En vista previa no se consultan recepciones pendientes. Configurá Supabase e iniciá sesión.
        </p>
      ) : locationId ? (
        <p className="mb-0 text-xs text-senda-muted">
          {`Consultando pendientes de ${selectedLocationLabel}.`}
        </p>
      ) : (
        <p className="mb-0 text-xs text-senda-muted">No hay un local activo.</p>
      )}

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <span className="inline-flex items-center gap-2">
            <AlertCircle size={18} /> {error}
          </span>
          <Button onClick={onRetry} type="button" variant="secondary">Reintentar</Button>
        </div>
      )}

      {previewMode ? (
        <Card className="grid min-h-64 place-items-center px-5 text-center text-sm text-senda-muted">
          En vista previa no se consultan recepciones pendientes. Configurá Supabase e iniciá sesión.
        </Card>
      ) : !locationId && !loading ? (
        <Card className="grid min-h-64 place-items-center px-5 text-center text-sm text-senda-muted">
          No hay un local activo para consultar recepciones pendientes.
        </Card>
      ) : loading ? (
        <Card className="flex min-h-64 items-center justify-center gap-2 text-sm text-senda-muted">
          <Loader2 className="animate-spin" size={19} /> Cargando recepciones pendientes…
        </Card>
      ) : !error && visibleItems.length === 0 ? (
        <Card className="grid min-h-64 place-items-center px-5 text-center text-sm text-senda-muted">
          No hay mercadería pendiente de recibir en este local.
        </Card>
      ) : visibleItems.length > 0 ? (
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <DataTable columns={columns} rowKey={(row) => row.lineId} rows={visibleItems} />
          </Card>
          {hasMore && (
            <div className="flex justify-center">
              <Button disabled={loadingMore} onClick={onLoadMore} type="button" variant="secondary">
                {loadingMore ? 'Cargando…' : 'Cargar más'}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <Modal
        open={Boolean(receivingRow)}
        title="Recibir mercadería"
        onClose={onCloseReceive ?? (() => undefined)}
      >
        {receivingRow && (
          <InvoicePendingReceivePanel
            destinationLabel={destinationLabel(receivingRow, locations, selectedLocationLabel)}
            receiveLine={receiveLine}
            refreshing={refreshing}
            row={receivingRow}
            sending={sending}
            store={store}
            onReceived={onReceived ?? (() => undefined)}
            onRefresh={onRefreshQuantities ?? (() => undefined)}
            onSending={onSending}
          />
        )}
      </Modal>
    </div>
  )
}

export function InvoicePendingReceptionsPage() {
  const { previewMode } = useAuth()
  const {
    location,
    locations,
    locationId,
    loading: scopeLoading,
    error: scopeError,
  } = useAuthorizedScopeContext()
  const [items, setItems] = useState<PendingReceptionLine[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)
  const [receivingRow, setReceivingRow] = useState<PendingReceptionLine | null>(null)
  const [sending, setSending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const requestGen = useRef(0)
  const selectedLocationLabel = location ? locationName(location) : ''
  const discardReception = useCallback(() => {
    setReceivingRow(null)
  }, [])
  useRegisterWorkspaceGuard(
    'pending-receptions',
    pendingReceptionsWorkspaceGuard({
      sending,
      receivingOpen: Boolean(receivingRow),
    }),
    discardReception,
  )

  useEffect(() => {
    setReceivingRow(null)
    setSending(false)
    if (previewMode || !locationId) {
      requestGen.current += 1
      setItems([])
      setNextCursor(null)
      setLoading(false)
      setLoadingMore(false)
      setError('')
      return
    }
    const gen = ++requestGen.current
    setItems([])
    setNextCursor(null)
    setLoading(true)
    setLoadingMore(false)
    setError('')
    listPendingReceptions(locationId)
      .then((page) => {
        if (gen !== requestGen.current) return
        setItems(applyPendingReceptionsPage([], page.items, 'replace'))
        setNextCursor(page.nextCursor)
      })
      .catch((reason: Error) => {
        if (gen !== requestGen.current) return
        setItems([])
        setNextCursor(null)
        setError(reason instanceof InvoiceApiError ? reason.message : reason.message)
      })
      .finally(() => {
        if (gen !== requestGen.current) return
        setLoading(false)
      })
  }, [locationId, previewMode, retryKey])

  function loadMore() {
    const location = locationId
    const cursor = nextCursor
    const gen = requestGen.current
    if (!location || !cursor || loading || loadingMore) return
    setLoadingMore(true)
    setError('')
    listPendingReceptions(location, { cursor })
      .then((page) => {
        if (gen !== requestGen.current) return
        setItems((current) => applyPendingReceptionsPage(current, page.items, 'append'))
        setNextCursor(page.nextCursor)
      })
      .catch((reason: Error) => {
        if (gen !== requestGen.current) return
        setError(reason instanceof InvoiceApiError ? reason.message : reason.message)
      })
      .finally(() => {
        if (gen !== requestGen.current) return
        setLoadingMore(false)
      })
  }

  async function handleReceived(result: InvoiceReceiveResult) {
    const gen = requestGen.current
    setItems((current) => reconcilePendingAfterReceive(current, result))
    setReceivingRow(null)
    setSending(false)
    try {
      const detail = await getInvoice(result.purchaseDocumentId)
      if (gen !== requestGen.current) return
      setItems((current) => reconcilePendingAfterReceive(current, result, detail))
    } catch {
      // Conservamos las cantidades que devolvió el POST de recepción.
    }
  }

  async function refreshQuantities() {
    if (!receivingRow || sending) return
    const gen = requestGen.current
    setRefreshing(true)
    try {
      const detail = await getInvoice(receivingRow.invoiceId)
      if (gen !== requestGen.current) return
      const next = pendingLineFromInvoiceDetail(receivingRow, detail)
      setItems((current) => current.flatMap((row) => {
        if (row.lineId !== receivingRow.lineId) return [row]
        return next ? [next] : []
      }))
      setReceivingRow(next)
    } catch (reason: unknown) {
      if (gen !== requestGen.current) return
      setError(reason instanceof InvoiceApiError ? reason.message : 'No se pudieron actualizar las cantidades.')
    } finally {
      if (gen !== requestGen.current) return
      setRefreshing(false)
    }
  }

  return (
    <InvoicePendingReceptionsView
      error={error || scopeError}
      items={items}
      loading={!previewMode && (loading || scopeLoading)}
      loadingMore={loadingMore}
      locationId={locationId}
      locations={locations}
      nextCursor={nextCursor}
      previewMode={previewMode}
      receivingRow={receivingRow}
      refreshing={refreshing}
      selectedLocationLabel={selectedLocationLabel}
      sending={sending}
      onCloseReceive={() => {
        if (!sending) setReceivingRow(null)
      }}
      onLoadMore={loadMore}
      onReceive={(row) => {
        if (sending) return
        setError('')
        setReceivingRow(row)
      }}
      onReceived={(result) => {
        void handleReceived(result)
      }}
      onRefreshQuantities={() => {
        void refreshQuantities()
      }}
      onRetry={() => setRetryKey((value) => value + 1)}
      onSending={setSending}
    />
  )
}

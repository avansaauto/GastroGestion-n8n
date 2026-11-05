import { AlertCircle, FileText, Loader2, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import { InvoiceApiError, deleteInvoice, listInvoices } from '@/lib/invoices/api'
import {
  INVOICE_BULK_DELETE_LABEL,
  INVOICE_DELETE_CONFIRM_MANY,
  INVOICE_SELECT_ALL_VISIBLE_HINT,
  classifyInvoiceForDelete,
  invoiceCanDelete,
  invoiceDeleteBlockReason,
  invoiceDeleteSelectionLabel,
  pruneInvoiceSelection,
  selectVisibleInvoices,
  toggleInvoiceSelection,
  visibleInvoiceSelectionState,
  type InvoiceDeleteClassification,
} from '@/lib/invoices/invoiceDeleteState'
import {
  INVOICE_LIST_FILTERS,
  invoicesForScope,
  visibleInvoiceList,
  type InvoiceListFilter,
} from '@/lib/invoices/invoiceListFilter'
import { locationName } from '@/lib/operations'
import { INVOICE_STATUS_LABEL, invoiceStatusTone } from '@/lib/invoices/invoiceReceiveState'
import { formatIssueDate, formatMoney } from '@/lib/invoices/review'
import type { InvoiceListItem } from '@/lib/invoices/types'
import { cn } from '@/lib/utils'

export type InvoiceDeleteOutcome = {
  id: string
  label: string
  result: 'deleted' | 'blocked' | 'failed'
  reason?: string
}

export type InvoiceDeleteDialogState = {
  items: InvoiceListItem[]
  classifications: InvoiceDeleteClassification[]
  submitting: boolean
  error: string
  outcomes: InvoiceDeleteOutcome[] | null
}

export function InvoiceListView({
  invoices,
  filter,
  search,
  onFilter,
  onSearch,
  selectedIds = [],
  onToggle,
  onToggleAll,
  onRequestDelete,
  onRequestBulkDelete,
}: {
  invoices: InvoiceListItem[]
  filter: InvoiceListFilter
  search: string
  onFilter: (filter: InvoiceListFilter) => void
  onSearch: (value: string) => void
  selectedIds?: string[]
  onToggle?: (invoiceId: string) => void
  onToggleAll?: (checked: boolean) => void
  onRequestDelete?: (item: InvoiceListItem) => void
  onRequestBulkDelete?: () => void
}) {
  const { counts, rows } = useMemo(
    () => visibleInvoiceList(invoices, search, filter),
    [invoices, search, filter],
  )
  const visibleIds = rows.map((row) => row.id)
  const selectionState = visibleInvoiceSelectionState(selectedIds, visibleIds)
  const selectedSet = new Set(selectedIds)
  const selectedVisibleCount = visibleIds.filter((id) => selectedSet.has(id)).length

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
          Buscar
          <span className="relative block">
            <Search className="absolute left-3 top-3 text-slate-400" size={17} />
            <Input
              className="pl-9"
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Proveedor o número…"
              value={search}
            />
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          {INVOICE_LIST_FILTERS.map((option) => (
            <button
              className={cn(
                'inline-flex min-h-9 items-center rounded-full px-3 text-sm font-semibold transition',
                filter === option.id
                  ? 'bg-senda-navy text-white'
                  : 'border border-senda-border bg-white text-senda-ink hover:bg-senda-subtle',
              )}
              key={option.id}
              onClick={() => onFilter(option.id)}
              type="button"
            >
              {`${option.label} (${counts[option.id]})`}
            </button>
          ))}
        </div>
      </Card>

      {rows.length === 0 ? (
        <Card className="overflow-hidden">
          <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
            <span className="rounded-2xl bg-senda-subtle p-4 text-senda-muted">
              <FileText size={28} />
            </span>
            <h3 className="mb-0 mt-4 text-lg font-bold">
              {search || filter !== 'all' ? 'Sin resultados' : 'Todavía no hay facturas'}
            </h3>
            <p className="mb-0 mt-2 max-w-md text-sm leading-6 text-senda-muted">
              {search || filter !== 'all'
                ? 'Probá otro filtro o limpiá la búsqueda para ver el listado completo.'
                : 'Cargá el primer comprobante para empezar a actualizar stock y costos del local.'}
            </p>
            {!search && filter === 'all' ? (
              <Link className="mt-5" to="/facturas/nueva">
                <Button>Nueva factura</Button>
              </Link>
            ) : null}
          </div>
        </Card>
      ) : (
        <>
          {selectedVisibleCount > 0 ? (
            <div className="flex flex-col gap-3 rounded-xl border border-senda-border bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="mb-0 text-sm font-semibold">{invoiceDeleteSelectionLabel(selectedVisibleCount)}</p>
                <p className="mb-0 mt-1 text-xs text-senda-muted">{INVOICE_SELECT_ALL_VISIBLE_HINT}</p>
              </div>
              <Button onClick={onRequestBulkDelete} type="button" variant="secondary">
                {INVOICE_BULK_DELETE_LABEL}
              </Button>
            </div>
          ) : null}
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-senda-border bg-senda-subtle/70 text-xs uppercase tracking-wide text-senda-muted">
                    <th className="w-12 px-5 py-3">
                      <input
                        aria-checked={selectionState === 'some' ? 'mixed' : selectionState === 'all'}
                        aria-label="Seleccionar todas las facturas visibles"
                        checked={selectionState === 'all'}
                        onChange={(event) => onToggleAll?.(event.target.checked)}
                        type="checkbox"
                      />
                    </th>
                    <th className="px-5 py-3 font-semibold">Proveedor</th>
                    <th className="px-5 py-3 font-semibold">Fecha</th>
                    <th className="px-5 py-3 font-semibold">Comprobante</th>
                    <th className="px-5 py-3 font-semibold">Importe</th>
                    <th className="px-5 py-3 font-semibold">Estado</th>
                    <th className="px-5 py-3 font-semibold">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const blocked = invoiceDeleteBlockReason(row)
                    return (
                      <tr className="border-b border-senda-border last:border-0" key={row.id}>
                        <td className="px-5 py-4">
                          <input
                            aria-label={`Seleccionar ${row.supplierName || row.documentNumber || 'factura'}`}
                            checked={selectedSet.has(row.id)}
                            onChange={() => onToggle?.(row.id)}
                            type="checkbox"
                          />
                        </td>
                        <td className="px-5 py-4 font-semibold">{row.supplierName || '—'}</td>
                        <td className="px-5 py-4">{formatIssueDate(row.documentDate)}</td>
                        <td className="px-5 py-4">{row.documentNumber || '—'}</td>
                        <td className="px-5 py-4">{formatMoney(row.total, row.currency)}</td>
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-1.5">
                            <Badge tone={invoiceStatusTone(row.status)}>
                              {INVOICE_STATUS_LABEL[row.status] ?? row.status}
                            </Badge>
                            {row.pendingConfiguration && <Badge tone="warning">Pendiente de configuración</Badge>}
                            {row.pendingReceive && <Badge tone="warning">Pendiente de recibir</Badge>}
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2">
                            <Link
                              className="text-sm font-semibold text-senda-navy hover:underline"
                              to={`/facturas/${row.id}`}
                            >
                              Ver detalle
                            </Link>
                            <button
                              aria-label={`Eliminar ${row.supplierName || row.documentNumber || 'factura'}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-senda-navy hover:bg-senda-subtle disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={Boolean(blocked)}
                              onClick={() => onRequestDelete?.(row)}
                              title={blocked ?? 'Eliminar factura'}
                              type="button"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

export function InvoiceDeleteConfirm({
  dialog,
  onClose,
  onConfirm,
}: {
  dialog: InvoiceDeleteDialogState | null
  onClose: () => void
  onConfirm: () => void
}) {
  if (!dialog) return null
  const eligible = dialog.classifications.filter((row) => row.canDelete)
  const blocked = dialog.classifications.filter((row) => !row.canDelete)
  const done = dialog.outcomes != null
  const deleted = dialog.outcomes?.filter((row) => row.result === 'deleted') ?? []
  const failed = dialog.outcomes?.filter((row) => row.result !== 'deleted') ?? []
  const title = dialog.items.length === 1 ? 'Eliminar factura' : 'Eliminar facturas'

  return (
    <Modal open title={title} onClose={onClose}>
      <div className="space-y-4 text-sm">
        {!done && (
          <p className="mb-0 whitespace-pre-line">
            {eligible.length > 0
              ? INVOICE_DELETE_CONFIRM_MANY(eligible.length)
              : 'Ninguna de las facturas seleccionadas se puede eliminar.'}
          </p>
        )}
        <p className="mb-0 text-xs text-senda-muted">{INVOICE_SELECT_ALL_VISIBLE_HINT}</p>
        {!done && eligible.length > 0 && (
          <ul className="mb-0 list-disc space-y-1 pl-5">
            {eligible.map((row) => (
              <li key={row.id}>{row.label}</li>
            ))}
          </ul>
        )}
        {!done && blocked.length > 0 && (
          <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-orange-800">
            <p className="m-0 font-semibold">No se eliminan</p>
            <ul className="mb-0 mt-2 list-disc space-y-1 pl-5">
              {blocked.map((row) => (
                <li key={row.id}>{row.label}: {row.reason}</li>
              ))}
            </ul>
          </div>
        )}
        {done && (
          <>
            <p className="m-0 font-semibold">
              {`${deleted.length} eliminada${deleted.length === 1 ? '' : 's'}, ${failed.length} sin cambios.`}
            </p>
            {deleted.length > 0 && (
              <ul className="mb-0 list-disc space-y-1 pl-5">
                {deleted.map((row) => (
                  <li key={row.id}>{row.label}</li>
                ))}
              </ul>
            )}
            {failed.length > 0 && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
                <ul className="mb-0 list-disc space-y-1 pl-5">
                  {failed.map((row) => (
                    <li key={row.id}>{row.label}: {row.reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {dialog.error && (
          <p className="mb-0 text-red-700">{dialog.error}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {done ? (
            <Button onClick={onClose}>Cerrar</Button>
          ) : (
            <>
              <Button disabled={dialog.submitting} onClick={onClose} variant="secondary">Cancelar</Button>
              <Button disabled={dialog.submitting || eligible.length === 0} onClick={onConfirm}>
                {dialog.submitting ? 'Eliminando…' : 'Eliminar'}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

export const INVOICE_REGISTERED_BANNER = 'Factura guardada y stock actualizado.'

export function invoiceRegisteredFromState(state: unknown) {
  return Boolean(
    state
    && typeof state === 'object'
    && (state as { invoiceRegistered?: unknown }).invoiceRegistered === true,
  )
}

export function InvoicesPage() {
  const route = useLocation()
  const registered = invoiceRegisteredFromState(route.state)
  const { previewMode } = useAuth()
  const { location, locationId } = useAuthorizedScopeContext()
  const [load, setLoad] = useState<{ locationId: string; invoices: InvoiceListItem[]; error: string }>({
    locationId: '',
    invoices: [],
    error: '',
  })
  const [filter, setFilter] = useState<InvoiceListFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [deleteDialog, setDeleteDialog] = useState<InvoiceDeleteDialogState | null>(null)
  const requestRef = useRef(0)
  const invoices = invoicesForScope(load.locationId, locationId, load.invoices)
  const error = load.locationId === locationId ? load.error : ''
  const loading = !previewMode && Boolean(locationId) && load.locationId !== locationId
  const visible = useMemo(
    () => visibleInvoiceList(invoices, search, filter).rows,
    [invoices, search, filter],
  )

  useEffect(() => {
    setSelectedIds([])
    setDeleteDialog(null)
  }, [locationId])

  useEffect(() => {
    setSelectedIds((current) => pruneInvoiceSelection(current, visible.map((row) => row.id)))
  }, [visible])

  useEffect(() => {
    if (previewMode || !locationId) {
      requestRef.current += 1
      setLoad({ locationId: locationId || '', invoices: [], error: '' })
      return
    }
    const requestId = ++requestRef.current
    const requestedLocationId = locationId
    listInvoices(requestedLocationId)
      .then((next) => {
        if (requestId !== requestRef.current) return
        setLoad({ locationId: requestedLocationId, invoices: next, error: '' })
      })
      .catch((reason: Error) => {
        if (requestId !== requestRef.current) return
        setLoad({
          locationId: requestedLocationId,
          invoices: [],
          error: reason instanceof InvoiceApiError ? reason.message : reason.message,
        })
      })
  }, [locationId, previewMode])

  function openDelete(items: InvoiceListItem[]) {
    if (items.length === 0) return
    setDeleteDialog({
      items,
      classifications: items.map(classifyInvoiceForDelete),
      submitting: false,
      error: '',
      outcomes: null,
    })
  }

  const invoiceKpis = useMemo(() => {
    const total = invoices.reduce((sum, row) => sum + (Number.isFinite(row.total) ? Number(row.total) : 0), 0)
    const suppliers = new Set(
      invoices.map((row) => row.supplierName?.trim()).filter((name): name is string => Boolean(name)),
    )
    return {
      count: invoices.length,
      total,
      suppliers: suppliers.size,
      currency: invoices[0]?.currency ?? 'ARS',
    }
  }, [invoices])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="m-0 text-2xl font-extrabold tracking-tight">Facturas</h2>
          <p className="mb-0 mt-2 text-sm text-senda-muted">
            Comprobantes del local: carga, seguimiento y recepción a inventario.
            Podés eliminar facturas; si ya ingresaron stock, se revierte ese ingreso al eliminarlas.
          </p>
          {!previewMode && location && (
            <p className="mb-0 mt-2 text-xs text-senda-muted">
              Facturas de {locationName(location)}.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/facturas/nueva">
            <Button className="min-h-11 px-5 shadow-sm">Nueva factura</Button>
          </Link>
        </div>
      </div>

      {!previewMode && !loading && invoices.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="p-4">
            <p className="m-0 text-xs font-semibold uppercase tracking-wide text-senda-muted">Comprobantes</p>
            <p className="mb-0 mt-2 text-2xl font-extrabold">{invoiceKpis.count}</p>
          </Card>
          <Card className="p-4">
            <p className="m-0 text-xs font-semibold uppercase tracking-wide text-senda-muted">Total listado</p>
            <p className="mb-0 mt-2 text-2xl font-extrabold">
              {formatMoney(invoiceKpis.total, invoiceKpis.currency)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="m-0 text-xs font-semibold uppercase tracking-wide text-senda-muted">Proveedores</p>
            <p className="mb-0 mt-2 text-2xl font-extrabold">{invoiceKpis.suppliers}</p>
          </Card>
        </div>
      ) : null}

      {registered && (
        <p className="mb-0 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
          {INVOICE_REGISTERED_BANNER}
        </p>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {loading ? (
        <Card className="flex min-h-[360px] items-center justify-center gap-2 text-sm text-senda-muted">
          <Loader2 className="animate-spin" size={19} /> Cargando facturas…
        </Card>
      ) : invoices.length === 0 ? (
        <Card className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center">
          <span className="rounded-2xl bg-senda-subtle p-4 text-senda-muted">
            <FileText size={30} />
          </span>
          <h3 className="mb-0 mt-5 text-lg font-bold">Todavía no hay facturas registradas</h3>
          <p className="mb-0 mt-2 max-w-md text-sm leading-6 text-senda-muted">
            Cuando guardes un comprobante, va a aparecer acá con proveedor, fecha, número e importe.
          </p>
          <Link className="mt-5" to="/facturas/nueva">
            <Button>Nueva factura</Button>
          </Link>
        </Card>
      ) : (
        <InvoiceListView
          filter={filter}
          invoices={invoices}
          search={search}
          selectedIds={selectedIds}
          onFilter={setFilter}
          onSearch={setSearch}
          onToggle={(invoiceId) => setSelectedIds((current) => toggleInvoiceSelection(current, invoiceId))}
          onToggleAll={(checked) => setSelectedIds(selectVisibleInvoices(visible.map((row) => row.id), checked))}
          onRequestDelete={(item) => openDelete([item])}
          onRequestBulkDelete={() => {
            openDelete(visible.filter((row) => selectedIds.includes(row.id)))
          }}
        />
      )}
      <InvoiceDeleteConfirm
        dialog={deleteDialog}
        onClose={() => {
          if (deleteDialog?.submitting) return
          setDeleteDialog(null)
        }}
        onConfirm={() => {
          if (!deleteDialog || deleteDialog.submitting) return
          const eligible = deleteDialog.items.filter((item) => invoiceCanDelete(item))
          if (eligible.length === 0) return
          setDeleteDialog({ ...deleteDialog, submitting: true, error: '' })
          const outcomes: InvoiceDeleteOutcome[] = []
          for (const row of deleteDialog.classifications.filter((item) => !item.canDelete)) {
            outcomes.push({
              id: row.id,
              label: row.label,
              result: 'blocked',
              reason: row.reason ?? undefined,
            })
          }
          void (async () => {
            for (const item of eligible) {
              const label = item.supplierName || item.documentNumber || item.id
              try {
                await deleteInvoice(item.id)
                outcomes.push({
                  id: item.id,
                  label,
                  result: 'deleted',
                })
              } catch (reason: unknown) {
                outcomes.push({
                  id: item.id,
                  label,
                  result: 'failed',
                  reason: reason instanceof InvoiceApiError ? reason.message : 'No se pudo eliminar la factura.',
                })
              }
            }
            const deletedIds = new Set(
              outcomes.filter((row) => row.result === 'deleted').map((row) => row.id),
            )
            setLoad((current) => ({
              ...current,
              invoices: current.invoices.filter((row) => !deletedIds.has(row.id)),
            }))
            setSelectedIds((current) => current.filter((id) => !deletedIds.has(id)))
            setDeleteDialog((current) => (
              current
                ? { ...current, submitting: false, outcomes }
                : current
            ))
          })()
        }}
      />
    </div>
  )
}

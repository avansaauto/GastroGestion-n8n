import { AlertCircle, ArrowLeft, FileText, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import {
  completeInvoiceSave,
  deleteInvoice,
  getConfirmRecovery,
  getInvoice,
  getInvoiceFile,
  InvoiceApiError,
} from '@/lib/invoices/api'
import { shouldOfferCompleteSave, type ConfirmRecoveryStatus } from '@/lib/invoices/confirmRecovery'
import {
  INVOICE_DELETE_CONFIRM,
  invoiceCanDelete,
  invoiceDeleteBlockReason,
} from '@/lib/invoices/invoiceDeleteState'
import { applyInvoiceReceiveResult, INVOICE_STATUS_LABEL, invoiceStatusTone } from '@/lib/invoices/invoiceReceiveState'
import { localDecisionsFromPayload } from '@/lib/invoices/review'
import type {
  InvoiceDetail,
  InvoiceFileAccess,
  InvoiceMapResult,
  InvoiceReceiveResult,
} from '@/lib/invoices/types'
import { InvoiceReview } from './InvoiceReview'

function OriginalDocumentCard({
  file,
  onRefresh,
  refreshing,
}: {
  file: InvoiceFileAccess | null
  onRefresh: () => void
  refreshing: boolean
}) {
  if (!file) {
    return (
      <Card className="p-5">
        <h3 className="m-0 text-base font-bold">Documento original</h3>
        <p className="mb-0 mt-2 text-sm text-senda-muted">
          No hay un enlace disponible para el archivo original.
        </p>
      </Card>
    )
  }

  const isPdf = file.contentType === 'application/pdf'
  const isImage = Boolean(file.contentType?.startsWith('image/'))

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="m-0 text-base font-bold">Documento original</h3>
          <p className="mb-0 mt-2 text-sm text-senda-muted">
            Enlace firmado de corta duración. El archivo no es público.
          </p>
        </div>
        <Button disabled={refreshing} variant="secondary" onClick={onRefresh}>
          {refreshing ? 'Renovando…' : 'Renovar enlace'}
        </Button>
      </div>
      {isPdf ? (
        <iframe
          className="h-[480px] w-full rounded-xl border border-senda-border bg-white"
          src={file.url}
          title="Documento original"
        />
      ) : isImage ? (
        <img
          alt="Documento original"
          className="max-h-[480px] w-full rounded-xl border border-senda-border object-contain"
          src={file.url}
        />
      ) : (
        <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-senda-muted">
          <FileText size={18} /> Vista previa no disponible para este tipo de archivo.
        </div>
      )}
      <a
        className="inline-flex text-sm font-semibold text-senda-navy hover:underline"
        href={file.url}
        rel="noreferrer"
        target="_blank"
      >
        Abrir original
      </a>
    </Card>
  )
}

export function InvoiceDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<InvoiceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [recovery, setRecovery] = useState<ConfirmRecoveryStatus | null>(null)
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState('')

  useEffect(() => {
    if (!id) {
      setError('El identificador de la factura no es válido.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    getInvoice(id)
      .then(setDetail)
      .catch((reason: Error) => {
        setDetail(null)
        setError(reason instanceof InvoiceApiError ? reason.message : reason.message)
      })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    if (!detail?.id || !detail.organizationId || !detail.locationId) return
    let cancelled = false
    getConfirmRecovery(detail.id, detail.organizationId, detail.locationId)
      .then((result) => {
        if (!cancelled) setRecovery(result.status)
      })
      .catch(() => {
        if (!cancelled) setRecovery('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [detail?.id, detail?.organizationId, detail?.locationId])

  const decisions = useMemo(
    () => localDecisionsFromPayload(detail?.commercialDecisions),
    [detail],
  )

  async function refreshFile() {
    if (!id) return
    setRefreshing(true)
    try {
      const file = await getInvoiceFile(id)
      setDetail((current) => (current ? { ...current, file } : current))
    } catch (reason) {
      setError(reason instanceof InvoiceApiError ? reason.message : 'No se pudo renovar el enlace.')
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center gap-2 text-sm text-senda-muted">
        <Loader2 className="animate-spin" size={19} /> Cargando factura…
      </div>
    )
  }

  if (error || !detail || !detail.reviewedAnalysis) {
    return (
      <div className="space-y-6">
        <Link className="inline-flex items-center gap-1 text-sm font-semibold text-senda-muted hover:text-senda-ink" to="/facturas">
          <ArrowLeft size={16} /> Facturas
        </Link>
        <Card className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
          <AlertCircle className="text-senda-muted" size={28} />
          <h3 className="mb-0 mt-4 text-lg font-bold">No se pudo mostrar la factura</h3>
          <p className="mb-0 mt-2 max-w-md text-sm text-senda-muted">
            {error || 'No se encontró la factura.'}
          </p>
        </Card>
      </div>
    )
  }

  const listItemLike = {
    status: detail.status,
    hasReceipts: detail.lines.some((line) => (line.receivedQuantity ?? 0) > 0),
  }
  const canDelete = invoiceCanDelete(listItemLike)
  const deleteBlocked = invoiceDeleteBlockReason(listItemLike)

  return (
    <div className="space-y-6">
      <div>
        <Link className="inline-flex items-center gap-1 text-sm font-semibold text-senda-muted hover:text-senda-ink" to="/facturas">
          <ArrowLeft size={16} /> Facturas
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="m-0 text-2xl font-extrabold tracking-tight">
              {detail.supplierName || 'Factura'}
            </h2>
            <p className="mb-0 mt-2 text-sm text-senda-muted">
              {detail.documentNumber || 'Sin número'}
            </p>
            {completeError && (
              <p className="mb-0 mt-2 text-sm text-red-700">{completeError}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={invoiceStatusTone(detail.status)}>
              {INVOICE_STATUS_LABEL[detail.status] ?? detail.status}
            </Badge>
            {shouldOfferCompleteSave(recovery) && (
              <Button
                disabled={completing}
                onClick={() => {
                  if (!detail) return
                  setCompleting(true)
                  setCompleteError('')
                  void completeInvoiceSave(detail.id, {
                    organizationId: detail.organizationId,
                    locationId: detail.locationId,
                  })
                    .then(() => getInvoice(detail.id))
                    .then((next) => {
                      setDetail(next)
                      setRecovery('completed')
                    })
                    .catch((reason: unknown) => {
                      setCompleteError(
                        reason instanceof InvoiceApiError
                          ? reason.message
                          : 'No se pudo completar el guardado.',
                      )
                    })
                    .finally(() => setCompleting(false))
                }}
              >
                {completing ? 'Completando…' : 'Completar guardado'}
              </Button>
            )}
            <Button
              disabled={!canDelete || deleting}
              title={deleteBlocked ?? 'Eliminar factura'}
              variant="secondary"
              onClick={() => {
                setDeleteError('')
                setDeleteOpen(true)
              }}
            >
              Eliminar factura
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={deleteOpen}
        title="Eliminar factura"
        onClose={() => {
          if (deleting) return
          setDeleteOpen(false)
        }}
      >
        <div className="space-y-4 text-sm">
          <p className="mb-0 whitespace-pre-line">{INVOICE_DELETE_CONFIRM}</p>
          {deleteError && <p className="mb-0 text-red-700">{deleteError}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={deleting}
              variant="secondary"
              onClick={() => setDeleteOpen(false)}
            >
              Cancelar
            </Button>
            <Button
              disabled={deleting}
              onClick={() => {
                setDeleting(true)
                setDeleteError('')
                void deleteInvoice(detail.id)
                  .then(() => {
                    navigate('/facturas', { replace: true })
                  })
                  .catch((reason: unknown) => {
                    setDeleteError(
                      reason instanceof InvoiceApiError
                        ? reason.message
                        : 'No se pudo eliminar la factura.',
                    )
                    setDeleting(false)
                  })
              }}
            >
              {deleting ? 'Eliminando…' : 'Eliminar'}
            </Button>
          </div>
        </div>
      </Modal>

      <OriginalDocumentCard
        file={detail.file}
        refreshing={refreshing}
        onRefresh={() => void refreshFile()}
      />

      <InvoiceReview
        documentStatus={INVOICE_STATUS_LABEL[detail.status] ?? detail.status}
        lineOperations={{
          invoiceId: detail.id,
          lines: detail.lines,
          status: detail.status,
          organizationId: detail.organizationId,
          locationId: detail.locationId,
          onMapped: (result: InvoiceMapResult) => {
            setDetail((current) => {
              if (!current) return current
              return {
                ...current,
                unmappedLineCount: result.unmappedLineCount,
                lines: current.lines.map((line) => (
                  line.id === result.id
                    ? {
                      ...line,
                      mappingStatus: result.mappingStatus,
                      inventoryProductId: result.inventoryProductId,
                      inventoryPhysicalQuantity: result.inventoryPhysicalQuantity,
                      inventoryProduct: {
                        id: result.inventoryProduct.id,
                        name: result.inventoryProduct.name,
                        baseUnit: result.inventoryProduct.baseUnit,
                      },
                      mappingSuggestion: null,
                      invoicedQuantity: result.inventoryPhysicalQuantity,
                      receivedQuantity: line.receivedQuantity ?? 0,
                      remainingQuantity: result.inventoryPhysicalQuantity - (line.receivedQuantity ?? 0),
                      configurationStatus: null,
                    }
                    : line
                )),
              }
            })
          },
          onReceived: (result: InvoiceReceiveResult) => {
            setDetail((current) => current ? applyInvoiceReceiveResult(current, result) : current)
          },
        }}
        localDecisions={decisions}
        mode="saved"
        originalResult={detail.originalAnalysis}
        readOnly={detail.status === 'received'}
        result={detail.reviewedAnalysis}
      />
    </div>
  )
}

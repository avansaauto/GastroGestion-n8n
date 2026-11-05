import { useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { receiveInvoiceLine } from '@/lib/invoices/api'
import { lineDescription } from '@/lib/invoices/mapping'
import {
  createMemoryAttemptStore,
  defaultAttemptStore,
  readReceiveAttempt,
  type AttemptStore,
} from '@/lib/invoices/receiveAttempt'
import {
  receiveVisualState,
  submitReceiveLine,
  type ReceiveLineFn,
} from '@/lib/invoices/receiveSubmit'
import {
  formatDisplayQuantity,
  formatInventoryUnit,
  physicalToDisplay,
} from '@/lib/invoices/receptionUnits'
import { formatQuantity } from '@/lib/invoices/review'
import type { InvoiceReceiveResult, InvoiceStoredLine } from '@/lib/invoices/types'

export function InvoiceReceiveForm({
  invoiceId,
  line,
  receiveLine = receiveInvoiceLine,
  store,
  sending = false,
  onSending,
  onReceived,
}: {
  invoiceId: string
  line: InvoiceStoredLine
  receiveLine?: ReceiveLineFn
  store?: AttemptStore
  sending?: boolean
  onSending?: (active: boolean) => void
  onReceived: (result: InvoiceReceiveResult) => void
}) {
  const fallbackStore = useRef<AttemptStore | null>(null)
  if (!fallbackStore.current) {
    fallbackStore.current = typeof sessionStorage === 'undefined'
      ? createMemoryAttemptStore()
      : defaultAttemptStore()
  }
  const attemptStore = store ?? fallbackStore.current
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const unit = line.inventoryProduct?.baseUnit ?? null
  const invoiced = line.invoicedQuantity ?? line.inventoryPhysicalQuantity
  const received = line.receivedQuantity ?? 0
  const remaining = line.remainingQuantity
  const displayRemaining = remaining == null ? null : physicalToDisplay(remaining, unit)
  const [input, setInput] = useState(
    displayRemaining != null && displayRemaining > 0 ? String(displayRemaining) : '',
  )
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [quantityWarning, setQuantityWarning] = useState('')
  const state = receiveVisualState(line)
  const pendingAttempt = readReceiveAttempt(invoiceId, line.id, attemptStore)
  const displayUnit = formatInventoryUnit(unit)
  const canReceive = state !== 'pending_configuration' && remaining != null && remaining > 0
  const inProgress = busy || sending

  async function submit(forceNew = false) {
    if (busyRef.current || sending || !canReceive || remaining == null) return
    busyRef.current = true
    setBusy(true)
    onSending?.(true)
    try {
      const outcome = await submitReceiveLine({
        invoiceId,
        lineId: line.id,
        remaining,
        unit,
        displayValue: input,
        forceNew,
        sending: false,
        store: attemptStore,
        receiveLine,
        onBeforeRequest: () => {
          setQuantityWarning('')
          setError('')
          setConflict(false)
          setUncertain(false)
        },
      })
      if (outcome.kind === 'ignored') return
      if (outcome.kind === 'validation') {
        setError(outcome.message)
        setQuantityWarning('')
        return
      }
      if (outcome.kind === 'pending_different_quantity') {
        setQuantityWarning(outcome.message)
        setError('')
        return
      }
      if (outcome.kind === 'success') {
        onReceived(outcome.result)
        return
      }
      if (outcome.kind === 'conflict') {
        setConflict(true)
        setError(outcome.message)
        return
      }
      if (outcome.kind === 'uncertain') {
        setUncertain(true)
        setError(outcome.message)
        return
      }
      setError(outcome.message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo registrar la recepción.')
    } finally {
      busyRef.current = false
      setBusy(false)
      onSending?.(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="m-0 text-sm font-semibold">
          {line.inventoryProduct?.name || lineDescription(line)}
        </p>
        <p className="mb-0 mt-1 text-xs text-senda-muted">{lineDescription(line)}</p>
      </div>

      {state === 'pending_configuration' ? (
        <p className="mb-0 text-sm text-senda-muted">
          Pendiente de configuración. Primero vinculá esta línea a un insumo. No se puede recibir mercadería todavía.
        </p>
      ) : (
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Facturada</dt>
            <dd className="m-0 font-semibold">{formatDisplayQuantity(invoiced, unit, formatQuantity)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Recibida</dt>
            <dd className="m-0 font-semibold">{formatDisplayQuantity(received, unit, formatQuantity)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Pendiente</dt>
            <dd className="m-0 font-semibold">{formatDisplayQuantity(remaining, unit, formatQuantity)}</dd>
          </div>
        </dl>
      )}

      {pendingAttempt?.status === 'pending' && !conflict && (
        <p className="mb-0 text-sm text-senda-muted">
          Hay un intento sin confirmar. Si el envío falló, reintentá de forma segura con la misma clave.
        </p>
      )}
      {quantityWarning && <p className="mb-0 text-sm text-orange-800">{quantityWarning}</p>}
      {error && <p className="mb-0 text-sm text-red-700">{error}</p>}
      {uncertain && (
        <p className="mb-0 text-sm text-senda-muted">
          El resultado no está confirmado. Reintentá para no duplicar la recepción.
        </p>
      )}

      {canReceive && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[180px] space-y-1.5 text-xs font-semibold text-senda-muted">
            Cantidad a recibir ({displayUnit})
            <Input
              disabled={inProgress}
              inputMode="decimal"
              type="text"
              value={input}
              onChange={(event) => {
                setInput(event.target.value)
                setQuantityWarning('')
              }}
            />
          </label>
          <Button disabled={inProgress} onClick={() => void submit(false)}>
            {inProgress ? 'Enviando…' : uncertain ? 'Reintentar recepción' : 'Confirmar recepción'}
          </Button>
          {(conflict || quantityWarning) && (
            <Button disabled={inProgress} variant="secondary" onClick={() => void submit(true)}>
              Nueva recepción
            </Button>
          )}
        </div>
      )}

      {!canReceive && state === 'complete' && (
        <p className="mb-0 text-sm text-senda-muted">
          Esta línea ya está recibida. No se registran nuevas entradas.
        </p>
      )}
    </div>
  )
}

import { InvoiceApiError } from './api'
import {
  clearReceiveAttempt,
  markReceiveAttemptResolved,
  prepareReceiveAttempt,
  type AttemptStore,
  type ReceiveAttemptRecord,
} from './receiveAttempt'
import {
  displayToPhysical,
  formatInventoryUnit,
  parseDisplayQuantity,
  physicalToDisplay,
} from './receptionUnits'
import { formatQuantity } from './review'
import type { InvoiceReceiveResult, InvoiceStoredLine } from './types'

export type ReceiveLineFn = (
  invoiceId: string,
  lineId: string,
  input: { quantity: number; idempotencyKey: string },
) => Promise<InvoiceReceiveResult>

export type ReceiveVisualState = 'pending_configuration' | 'none' | 'partial' | 'complete'

export type ReceiveSubmitOutcome =
  | { kind: 'ignored' }
  | { kind: 'validation'; message: string }
  | { kind: 'pending_different_quantity'; attempt: ReceiveAttemptRecord; message: string }
  | { kind: 'success'; result: InvoiceReceiveResult }
  | { kind: 'conflict'; message: string }
  | { kind: 'uncertain'; message: string; attempt: ReceiveAttemptRecord }
  | { kind: 'error'; message: string }

const inFlight = new Set<string>()

function operationLock(invoiceId: string, lineId: string, idempotencyKey: string) {
  return `${invoiceId}:${lineId}:${idempotencyKey}`
}

export function receiveVisualState(line: InvoiceStoredLine): ReceiveVisualState {
  if (line.configurationStatus === 'pending_configuration' || line.mappingStatus !== 'mapped') {
    return 'pending_configuration'
  }
  const received = line.receivedQuantity ?? 0
  const remaining = line.remainingQuantity
  if (remaining != null && remaining <= 0 && received > 0) return 'complete'
  if (received > 0 && remaining != null && remaining > 0) return 'partial'
  return 'none'
}

export function receiveStateLabel(state: ReceiveVisualState) {
  if (state === 'pending_configuration') return 'Pendiente de configuración'
  if (state === 'complete') return 'Recibido'
  if (state === 'partial') return 'Recibido parcial'
  return 'Sin recibir'
}

export async function submitReceiveLine(input: {
  invoiceId: string
  lineId: string
  remaining: number
  unit: string | null
  displayValue: string
  forceNew?: boolean
  sending?: boolean
  store: AttemptStore
  receiveLine: ReceiveLineFn
  createKey?: () => string
  onBeforeRequest?: () => void
}): Promise<ReceiveSubmitOutcome> {
  if (input.sending) return { kind: 'ignored' }

  const parsed = parseDisplayQuantity(input.displayValue)
  if (parsed == null || parsed <= 0) {
    return { kind: 'validation', message: 'Indicá una cantidad mayor a cero.' }
  }
  const physical = displayToPhysical(parsed, input.unit)
  if (physical > input.remaining) {
    return { kind: 'validation', message: 'La cantidad supera lo pendiente de esta línea.' }
  }
  if (input.forceNew) {
    clearReceiveAttempt(input.invoiceId, input.lineId, input.store)
  }
  const prepared = prepareReceiveAttempt({
    invoiceId: input.invoiceId,
    lineId: input.lineId,
    quantity: physical,
    store: input.store,
    createKey: input.createKey,
  })
  if (!prepared.ok) {
    const displayUnit = formatInventoryUnit(input.unit)
    return {
      kind: 'pending_different_quantity',
      attempt: prepared.attempt,
      message: `Hay un intento anterior de ${formatQuantity(physicalToDisplay(prepared.attempt.quantity, input.unit))} ${displayUnit} sin confirmar. Reintentá esa cantidad o iniciá una recepción nueva.`,
    }
  }

  const lock = operationLock(input.invoiceId, input.lineId, prepared.attempt.idempotencyKey)
  if (inFlight.has(lock)) return { kind: 'ignored' }
  inFlight.add(lock)
  input.onBeforeRequest?.()

  try {
    const result = await input.receiveLine(input.invoiceId, input.lineId, {
      quantity: physical,
      idempotencyKey: prepared.attempt.idempotencyKey,
    })
    markReceiveAttemptResolved(input.invoiceId, input.lineId, input.store)
    return { kind: 'success', result }
  } catch (reason) {
    if (reason instanceof InvoiceApiError && reason.code === 'IDEMPOTENCY_CONFLICT') {
      return { kind: 'conflict', message: reason.message }
    }
    if (reason instanceof InvoiceApiError && (reason.status === 0 || reason.status >= 500)) {
      return { kind: 'uncertain', message: reason.message, attempt: prepared.attempt }
    }
    return {
      kind: 'error',
      message: reason instanceof InvoiceApiError ? reason.message : 'No se pudo registrar la recepción.',
    }
  } finally {
    inFlight.delete(lock)
  }
}

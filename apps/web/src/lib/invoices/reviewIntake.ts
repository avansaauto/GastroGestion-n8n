import { InvoiceApiError } from './api'
import { storedLineForAnalysis, conversionMessage, previewPhysicalQuantity } from './mapping'
import {
  defaultAttemptStore,
  markReceiveAttemptResolved,
  prepareReceiveAttempt,
  type AttemptStore,
} from './receiveAttempt'
import {
  formatDisplayQuantity,
  formatInventoryUnit,
  physicalToDisplay,
} from './receptionUnits'
import {
  emptyReviewMappingDraft,
  reviewMappingConversion,
  type ReviewMappingDrafts,
} from './reviewMapping'
import {
  canEditReviewReceived,
  reviewReceivedView,
  type ReviewReceivedDrafts,
} from './reviewReceived'
import { formatQuantity } from './review'
import type {
  InvoiceAnalysisLine,
  InvoiceDetail,
  InvoiceMapResult,
  InvoiceReceiveResult,
  InventoryProductOption,
  InvoiceSaveApiResult,
  InvoiceStoredLine,
} from './types'

export function formatPendingInventoryQuantity(
  remainingPhysical: number,
  baseUnit: string | null | undefined,
) {
  const display = physicalToDisplay(remainingPhysical, baseUnit)
  if (display == null) {
    return `${formatQuantity(remainingPhysical)} ${formatInventoryUnit(baseUnit)}`
  }
  return formatDisplayQuantity(remainingPhysical, baseUnit, formatQuantity)
}

export type PlannedIntakeAction = 'pending_mapping' | 'conversion_invalid' | 'map_only' | 'map_and_receive'

export type PlannedIntakeLine = {
  sourceLineId: string
  label: string
  action: PlannedIntakeAction
  inventoryProductId: string
  conversionFactor: number | null
  conversionCode?: 'INCOMPATIBLE_UNITS' | 'EQUIVALENCE_REQUIRED'
  receivedCommercial: number
  physicalReceive: number | null
}

export type IntakeLineStatus =
  | 'pending_mapping'
  | 'conversion_invalid'
  | 'mapped'
  | 'received'
  | 'partial'
  | 'association_failed'
  | 'map_failed'
  | 'receive_failed'
  | 'receive_uncertain'
  | 'load_failed'

export type IntakeLineResult = {
  sourceLineId: string
  label: string
  status: IntakeLineStatus
  message: string
  retryable: boolean
  storedLineId?: string
  remainingQuantity?: number | null
  physicalQuantity?: number | null
}

export type IntakeSummaryKind = 'complete' | 'partial' | 'pending_mapping' | 'errors' | 'already_registered'

export type IntakeSummary = {
  kind: IntakeSummaryKind
  title: string
  body: string
}

export type IntakeProgress = {
  phase: 'saving' | 'loading' | 'mapping' | 'receiving' | 'retrying'
  message: string
  sourceLineId?: string
}

export type ReviewIntakePorts = {
  getInvoice: (id: string) => Promise<InvoiceDetail>
  mapInvoiceLine: (
    invoiceId: string,
    lineId: string,
    input: { inventoryProductId: string; conversionFactor?: number },
  ) => Promise<InvoiceMapResult>
  receiveInvoiceLine: (
    invoiceId: string,
    lineId: string,
    input: { quantity: number; idempotencyKey: string },
  ) => Promise<InvoiceReceiveResult>
  store?: AttemptStore
  createKey?: () => string
  onProgress?: (progress: IntakeProgress) => void
}

function lineLabel(line: InvoiceAnalysisLine) {
  return line.name || line.originalDescription || line.id
}

export function reviewIntakeBlockReason(
  lines: InvoiceAnalysisLine[],
  receivedDrafts: ReviewReceivedDrafts,
): string | null {
  for (const line of lines) {
    if (!canEditReviewReceived(line)) continue
    const view = reviewReceivedView(line, receivedDrafts[line.id])
    if (view?.error) {
      return `${lineLabel(line)}: ${view.error}`
    }
  }
  return null
}

export function planReviewIntake(
  lines: InvoiceAnalysisLine[],
  receivedDrafts: ReviewReceivedDrafts,
  mappingDrafts: ReviewMappingDrafts,
  products: InventoryProductOption[],
): PlannedIntakeLine[] {
  const catalog = new Map(products.map((product) => [product.id, product]))
  const planned: PlannedIntakeLine[] = []
  for (const line of lines) {
    if (!canEditReviewReceived(line)) continue
    const view = reviewReceivedView(line, receivedDrafts[line.id])
    const received = view?.received ?? 0
    const draft = mappingDrafts[line.id] ?? emptyReviewMappingDraft()
    const productId = draft.inventoryProductId.trim()
    const product = productId ? catalog.get(productId) ?? null : null
    if (!productId) {
      planned.push({
        sourceLineId: line.id,
        label: lineLabel(line),
        action: 'pending_mapping',
        inventoryProductId: '',
        conversionFactor: null,
        receivedCommercial: received,
        physicalReceive: null,
      })
      continue
    }
    const { conversion } = reviewMappingConversion(line, product, draft.conversionFactor)
    if (!conversion || !conversion.ok) {
      planned.push({
        sourceLineId: line.id,
        label: lineLabel(line),
        action: 'conversion_invalid',
        inventoryProductId: productId,
        conversionFactor: draft.conversionFactor,
        conversionCode: conversion && !conversion.ok
          ? conversion.code
          : 'INCOMPATIBLE_UNITS',
        receivedCommercial: received,
        physicalReceive: null,
      })
      continue
    }
    const physicalReceive = received > 0
      ? previewPhysicalQuantity(received, conversion.factor)
      : null
    planned.push({
      sourceLineId: line.id,
      label: lineLabel(line),
      action: physicalReceive != null ? 'map_and_receive' : 'map_only',
      inventoryProductId: productId,
      conversionFactor: draft.conversionFactor,
      receivedCommercial: received,
      physicalReceive,
    })
  }
  return planned
}

export function intakeLineRetryable(result: IntakeLineResult) {
  return result.retryable
}

export const ALREADY_REGISTERED_MESSAGE =
  'Esta factura ya estaba registrada en SENDA. No se modificó el inventario durante este intento.'

export function alreadyRegisteredSummary(): IntakeSummary {
  return {
    kind: 'already_registered',
    title: 'Factura ya registrada',
    body: ALREADY_REGISTERED_MESSAGE,
  }
}

export function intakeOutcomeSummary(input: {
  saved?: InvoiceSaveApiResult | null
  intakeLines?: IntakeLineResult[]
}): IntakeSummary | null {
  if (input.saved?.idempotent) return alreadyRegisteredSummary()
  if (input.intakeLines?.length) return summarizeIntake(input.intakeLines)
  return null
}

export function summarizeIntake(lines: IntakeLineResult[]): IntakeSummary {
  if (lines.some((line) => line.retryable)) {
    return {
      kind: 'errors',
      title: 'Operación incompleta',
      body: 'El comprobante puede estar guardado, pero el inventario no quedó actualizado. Reintentá sin crear otra factura ni duplicar movimientos.',
    }
  }
  if (lines.some((line) => line.status === 'pending_mapping' || line.status === 'conversion_invalid')) {
    return {
      kind: 'pending_mapping',
      title: 'Operación incompleta',
      body: 'Hay líneas pendientes de vinculación. No se actualizó el stock y no se creó otra factura.',
    }
  }
  if (lines.some((line) => line.status === 'partial')) {
    return {
      kind: 'partial',
      title: 'Operación incompleta',
      body: 'Quedó mercadería sin ingresar al inventario. Reintentá sin crear otra factura.',
    }
  }
  if (lines.length > 0 && lines.every((line) => line.status === 'mapped')) {
    return {
      kind: 'pending_mapping',
      title: 'Operación incompleta',
      body: 'Los insumos quedaron vinculados, sin ingreso de stock. No se creó otra factura.',
    }
  }
  return {
    kind: 'complete',
    title: 'Factura guardada y stock actualizado.',
    body: 'El comprobante quedó registrado y las cantidades confirmadas ingresaron al inventario.',
  }
}

function skippedResult(plan: PlannedIntakeLine): IntakeLineResult {
  if (plan.action === 'pending_mapping') {
    return {
      sourceLineId: plan.sourceLineId,
      label: plan.label,
      status: 'pending_mapping',
      message: 'Sin insumo. Quedó pendiente de vinculación. No se movió stock.',
      retryable: false,
    }
  }
  return {
    sourceLineId: plan.sourceLineId,
    label: plan.label,
    status: 'conversion_invalid',
    message: plan.conversionCode
      ? conversionMessage(plan.conversionCode)
      : 'No se puede convertir esa unidad de la factura a la unidad del inventario.',
    retryable: false,
  }
}

function remainingAfterMap(mapped: InvoiceMapResult, stored?: InvoiceStoredLine) {
  const received = stored?.receivedQuantity ?? 0
  return Number((mapped.inventoryPhysicalQuantity - received).toFixed(6))
}

function remainingOf(stored: InvoiceStoredLine) {
  if (stored.remainingQuantity != null) return stored.remainingQuantity
  const invoiced = stored.invoicedQuantity ?? stored.inventoryPhysicalQuantity
  const received = stored.receivedQuantity ?? 0
  return Number((invoiced - received).toFixed(6))
}

function isTerminal(result: IntakeLineResult | undefined) {
  if (!result) return false
  return !result.retryable
}

async function receivePlannedQuantity(input: {
  invoiceId: string
  storedLineId: string
  quantity: number
  remaining: number
  baseUnit?: string | null
  ports: ReviewIntakePorts
}): Promise<Pick<IntakeLineResult, 'status' | 'message' | 'retryable' | 'remainingQuantity' | 'physicalQuantity'>> {
  if (input.remaining <= 0) {
    return {
      status: 'received',
      message: 'Ya estaba recibida. No se duplicó el movimiento.',
      retryable: false,
      remainingQuantity: 0,
      physicalQuantity: input.quantity,
    }
  }
  const quantity = Math.min(input.quantity, input.remaining)
  const store = input.ports.store ?? defaultAttemptStore()
  const prepared = prepareReceiveAttempt({
    invoiceId: input.invoiceId,
    lineId: input.storedLineId,
    quantity,
    store,
    createKey: input.ports.createKey,
  })
  if (!prepared.ok) {
    return {
      status: 'receive_failed',
      message: 'Hay un intento anterior de recepción sin confirmar. Reintentá la misma cantidad.',
      retryable: true,
    }
  }
  try {
    const result = await input.ports.receiveInvoiceLine(input.invoiceId, input.storedLineId, {
      quantity,
      idempotencyKey: prepared.attempt.idempotencyKey,
    })
    markReceiveAttemptResolved(input.invoiceId, input.storedLineId, store)
    const remaining = result.remainingQuantity
    return {
      status: remaining > 0 ? 'partial' : 'received',
      message: remaining > 0
        ? `Recepción parcial registrada. Quedan ${formatPendingInventoryQuantity(remaining, input.baseUnit)} pendientes.`
        : result.idempotent
          ? 'Recepción confirmada. No se duplicó el movimiento.'
          : 'Recepción completa registrada.',
      retryable: false,
      remainingQuantity: remaining,
      physicalQuantity: result.quantity,
    }
  } catch (reason) {
    if (reason instanceof InvoiceApiError && reason.code === 'IDEMPOTENCY_CONFLICT') {
      return {
        status: 'receive_failed',
        message: reason.message,
        retryable: false,
      }
    }
    if (reason instanceof InvoiceApiError && (reason.status === 0 || reason.status >= 500)) {
      return {
        status: 'receive_uncertain',
        message: `${reason.message} Conservamos la clave de idempotencia para reintentar sin duplicar stock.`,
        retryable: true,
      }
    }
    return {
      status: 'receive_failed',
      message: reason instanceof InvoiceApiError ? reason.message : 'No se pudo registrar la recepción.',
      retryable: true,
    }
  }
}

async function mapAndMaybeReceive(input: {
  invoiceId: string
  plan: PlannedIntakeLine
  stored: InvoiceStoredLine
  ports: ReviewIntakePorts
}): Promise<IntakeLineResult> {
  const { plan, stored, ports, invoiceId } = input
  let remaining = remainingOf(stored)
  let invoicedPhysical = stored.invoicedQuantity ?? stored.inventoryPhysicalQuantity
  let baseUnit = stored.inventoryProduct?.baseUnit ?? null

  if (stored.mappingStatus !== 'mapped' || stored.inventoryProductId !== plan.inventoryProductId) {
    ports.onProgress?.({
      phase: 'mapping',
      message: `Vinculando ${plan.label}…`,
      sourceLineId: plan.sourceLineId,
    })
    try {
      const mapped = await ports.mapInvoiceLine(invoiceId, stored.id, {
        inventoryProductId: plan.inventoryProductId,
        ...(plan.conversionFactor != null ? { conversionFactor: plan.conversionFactor } : {}),
      })
      invoicedPhysical = mapped.inventoryPhysicalQuantity
      remaining = remainingAfterMap(mapped, stored)
      baseUnit = mapped.inventoryProduct.baseUnit
    } catch (reason) {
      if (
        reason instanceof InvoiceApiError
        && reason.code === 'LINE_HAS_RECEIPTS'
        && stored.mappingStatus === 'mapped'
      ) {
        remaining = remainingOf(stored)
      } else {
        return {
          sourceLineId: plan.sourceLineId,
          label: plan.label,
          status: 'map_failed',
          message: reason instanceof InvoiceApiError ? reason.message : 'No se pudo vincular el insumo.',
          retryable: true,
          storedLineId: stored.id,
        }
      }
    }
  }

  if (plan.action === 'map_only' || plan.physicalReceive == null || plan.physicalReceive <= 0) {
    return {
      sourceLineId: plan.sourceLineId,
      label: plan.label,
      status: 'mapped',
      message: 'Insumo vinculado. Cantidad recibida 0: no se registró recepción.',
      retryable: false,
      storedLineId: stored.id,
      remainingQuantity: remaining,
      physicalQuantity: invoicedPhysical,
    }
  }

  ports.onProgress?.({
    phase: 'receiving',
    message: `Recibiendo ${plan.label}…`,
    sourceLineId: plan.sourceLineId,
  })
  const received = await receivePlannedQuantity({
    invoiceId,
    storedLineId: stored.id,
    quantity: plan.physicalReceive,
    remaining,
    baseUnit,
    ports,
  })
  return {
    sourceLineId: plan.sourceLineId,
    label: plan.label,
    storedLineId: stored.id,
    ...received,
  }
}

export async function applyPlannedIntake(input: {
  invoiceId: string
  planned: PlannedIntakeLine[]
  previous?: IntakeLineResult[]
  ports: ReviewIntakePorts
}): Promise<{ detail: InvoiceDetail | null; lines: IntakeLineResult[] }> {
  const previousById = new Map((input.previous ?? []).map((line) => [line.sourceLineId, line]))
  const needsDocument = input.planned.some((plan) => (
    !isTerminal(previousById.get(plan.sourceLineId))
    && (plan.action === 'map_only' || plan.action === 'map_and_receive')
  ))
  if (!needsDocument) {
    return {
      detail: null,
      lines: input.planned.map((plan) => {
        const previous = previousById.get(plan.sourceLineId)
        if (isTerminal(previous)) return previous!
        return skippedResult(plan)
      }),
    }
  }

  input.ports.onProgress?.({ phase: 'loading', message: 'Consultando líneas guardadas…' })
  let detail: InvoiceDetail
  try {
    detail = await input.ports.getInvoice(input.invoiceId)
  } catch (reason) {
    const message = reason instanceof InvoiceApiError
      ? reason.message
      : 'No se pudieron consultar las líneas guardadas.'
    return {
      detail: null,
      lines: input.planned.map((plan) => {
        const previous = previousById.get(plan.sourceLineId)
        if (isTerminal(previous)) return previous!
        return {
          sourceLineId: plan.sourceLineId,
          label: plan.label,
          status: 'load_failed' as const,
          message,
          retryable: true,
        }
      }),
    }
  }

  const lines: IntakeLineResult[] = []
  for (const plan of input.planned) {
    const previous = previousById.get(plan.sourceLineId)
    if (isTerminal(previous)) {
      lines.push(previous!)
      continue
    }
    if (plan.action === 'pending_mapping' || plan.action === 'conversion_invalid') {
      lines.push(skippedResult(plan))
      continue
    }
    const stored = storedLineForAnalysis({ id: plan.sourceLineId }, detail.lines)
    if (!stored) {
      lines.push({
        sourceLineId: plan.sourceLineId,
        label: plan.label,
        status: 'association_failed',
        message: 'No hay una línea guardada asociada. No se puede vincular ni recibir.',
        retryable: true,
      })
      continue
    }
    lines.push(await mapAndMaybeReceive({
      invoiceId: input.invoiceId,
      plan,
      stored,
      ports: input.ports,
    }))
    if (lines.at(-1)?.storedLineId) {
      const latest = lines.at(-1)!
      detail = {
        ...detail,
        lines: detail.lines.map((line) => (
          line.id === latest.storedLineId && latest.status === 'mapped'
            ? { ...line, mappingStatus: 'mapped', inventoryProductId: plan.inventoryProductId }
            : line.id === latest.storedLineId && (latest.status === 'received' || latest.status === 'partial')
              ? {
                ...line,
                mappingStatus: 'mapped',
                inventoryProductId: plan.inventoryProductId,
                remainingQuantity: latest.remainingQuantity ?? line.remainingQuantity,
              }
              : line
        )),
      }
    }
  }
  return { detail, lines }
}

export function intakeHasRetryable(lines: IntakeLineResult[]) {
  return lines.some((line) => line.retryable)
}

export type SaveThenIntakeInput = {
  savedDocument?: InvoiceSaveApiResult | null
  saveInvoice: () => Promise<InvoiceSaveApiResult>
  onSaved?: (saved: InvoiceSaveApiResult) => void
  planned: PlannedIntakeLine[]
  previous?: IntakeLineResult[]
  ports: ReviewIntakePorts
}

export async function saveThenApplyIntake(input: SaveThenIntakeInput): Promise<{
  saved: InvoiceSaveApiResult
  detail: InvoiceDetail | null
  lines: IntakeLineResult[]
  summary: IntakeSummary
}> {
  let saved = input.savedDocument ?? null
  if (!saved) {
    input.ports.onProgress?.({ phase: 'saving', message: 'Guardando factura…' })
    saved = await input.saveInvoice()
    input.onSaved?.(saved)
  } else {
    input.ports.onProgress?.({ phase: 'retrying', message: 'Reintentando operaciones pendientes…' })
  }
  if (saved.idempotent) {
    return {
      saved,
      detail: null,
      lines: [],
      summary: alreadyRegisteredSummary(),
    }
  }
  const applied = await applyPlannedIntake({
    invoiceId: saved.id,
    planned: input.planned,
    previous: input.previous,
    ports: input.ports,
  })
  return {
    saved,
    detail: applied.detail,
    lines: applied.lines,
    summary: summarizeIntake(applied.lines),
  }
}

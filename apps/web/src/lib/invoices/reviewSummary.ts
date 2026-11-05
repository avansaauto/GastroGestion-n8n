import { LINE_CLASSIFICATION_LABEL, partitionReviewLines } from './review'
import type { ReviewMappingDraft, ReviewMappingDrafts } from './reviewMapping'
import { canEditReviewReceived, reviewReceivedView, type ReviewReceivedDrafts } from './reviewReceived'
import type { InvoiceAnalysisApiResult, InvoiceAnalysisLine } from './types'

export type ReviewLineVisual = {
  kind: 'eligible' | 'commercial_pending' | 'adjustment' | 'unmapped' | 'other'
  label: string
  tone: 'neutral' | 'warning' | 'success'
}

export type ReviewInventoryStat = {
  key: 'merchandise' | 'partial' | 'unmapped' | 'commercial'
  label: string
  count: number
}

export type ReviewInventorySummary = {
  title: string
  body: string
  showReception: false
  stats: ReviewInventoryStat[]
}

export type ReviewInventoryOptions = {
  mappingDrafts?: ReviewMappingDrafts
  receivedDrafts?: ReviewReceivedDrafts
  mappingAvailable?: boolean
  /** Factura ya guardada: no anunciar una recepción futura. */
  settled?: boolean
}

export function reviewLineVisual(
  line: InvoiceAnalysisLine,
  options: {
    mappingAvailable?: boolean
    mappingDraft?: ReviewMappingDraft
  } = {},
): ReviewLineVisual {
  if ((line.amount ?? 0) < 0 || (line.unitPrice ?? 0) < 0) {
    return { kind: 'adjustment', label: 'Ajuste (sin stock)', tone: 'neutral' }
  }
  if (line.inventoryEligibility === 'pending_review') {
    return { kind: 'commercial_pending', label: 'Revisión comercial', tone: 'warning' }
  }
  if (line.inventoryEligibility === 'eligible') {
    const mapped = Boolean(options.mappingDraft?.inventoryProductId)
    if (options.mappingAvailable && !mapped) {
      return { kind: 'unmapped', label: 'Sin insumo', tone: 'warning' }
    }
    return { kind: 'eligible', label: 'Habilitada', tone: 'success' }
  }
  return {
    kind: 'other',
    label: LINE_CLASSIFICATION_LABEL[line.classification] ?? line.classification,
    tone: 'neutral',
  }
}

export function reviewInventoryCounts(
  result: InvoiceAnalysisApiResult,
  options: ReviewInventoryOptions = {},
) {
  const { concepts } = partitionReviewLines(
    result.document.lines,
    result.interpretation.relations,
  )
  let partial = 0
  let unmapped = 0
  let commercial = 0
  let eligible = 0
  for (const line of concepts) {
    if (line.inventoryEligibility === 'pending_review') commercial += 1
    if (line.inventoryEligibility !== 'eligible') continue
    eligible += 1
    if (options.mappingAvailable && !options.mappingDrafts?.[line.id]?.inventoryProductId) {
      unmapped += 1
    }
    if (!canEditReviewReceived(line)) continue
    const view = reviewReceivedView(line, options.receivedDrafts?.[line.id])
    if (view?.showRemaining) partial += 1
  }
  return {
    merchandise: concepts.length,
    eligible,
    partial,
    unmapped,
    commercial,
  }
}

export function reviewInventorySummary(
  result: InvoiceAnalysisApiResult,
  options: ReviewInventoryOptions = {},
): ReviewInventorySummary {
  const counts = reviewInventoryCounts(result, options)
  const stats: ReviewInventoryStat[] = []
  if (counts.merchandise > 0) {
    stats.push({ key: 'merchandise', label: 'Mercadería', count: counts.merchandise })
  }
  if (counts.partial > 0) {
    stats.push({ key: 'partial', label: 'Recepción parcial', count: counts.partial })
  }
  if (counts.unmapped > 0) {
    stats.push({ key: 'unmapped', label: 'Sin insumo', count: counts.unmapped })
  }
  if (counts.commercial > 0) {
    stats.push({ key: 'commercial', label: 'Revisión comercial', count: counts.commercial })
  }

  const showReception = false as const

  if (result.document.classification === 'service') {
    return {
      title: 'Sin recepción de mercadería',
      body: 'Documento de servicios: no hay productos para stock ni recepción.',
      showReception,
      stats: [],
    }
  }

  if (counts.merchandise === 0) {
    return {
      title: 'Sin mercadería para recibir',
      body: 'Este comprobante solo tiene ajustes o conceptos no inventariables. No hay mercadería para registrar en inventario.',
      showReception,
      stats,
    }
  }

  if (options.settled) {
    const parts: string[] = []
    if (counts.commercial > 0) {
      parts.push(
        counts.commercial === 1
          ? 'Hay una bonificación o descuento pendiente.'
          : `Hay ${counts.commercial} líneas con revisión comercial pendiente.`,
      )
    }
    if (counts.unmapped > 0) {
      parts.push(
        counts.unmapped === 1
          ? '1 línea requiere vinculación a un insumo.'
          : `${counts.unmapped} líneas requieren vinculación a un insumo.`,
      )
    }
    if (counts.partial > 0) {
      parts.push(
        counts.partial === 1
          ? 'Hay una recepción parcial.'
          : `Hay ${counts.partial} recepciones parciales.`,
      )
    }
    if (parts.length === 0) {
      return { title: '', body: '', showReception, stats: [] }
    }
    return {
      title: 'Pendientes de inventario',
      body: parts.join(' '),
      showReception,
      stats: stats.filter((stat) => stat.key !== 'merchandise'),
    }
  }

  if (counts.commercial > 0 && counts.eligible === 0) {
    return {
      title: 'Revisión comercial pendiente',
      body: counts.commercial === 1
        ? 'Hay una bonificación o descuento pendiente. Confirmala o rechazala para habilitar la recepción.'
        : `Hay ${counts.commercial} líneas con revisión comercial pendiente. Confirmá o rechazá cada una para habilitar la recepción.`,
      showReception,
      stats,
    }
  }

  const parts: string[] = []
  if (counts.eligible > 0) {
    parts.push('SENDA registrará lo efectivamente recibido al guardar.')
  }
  if (counts.commercial > 0) {
    parts.push(
      counts.commercial === 1
        ? 'Hay una línea que requiere confirmar o rechazar una bonificación antes de recibirla.'
        : `Hay ${counts.commercial} líneas que requieren confirmar o rechazar una bonificación antes de recibirlas.`,
    )
  }
  if (counts.unmapped > 0) {
    parts.push(
      counts.unmapped === 1
        ? '1 línea requiere vinculación a un insumo.'
        : `${counts.unmapped} líneas requieren vinculación a un insumo.`,
    )
  }
  if (parts.length === 0) {
    return {
      title: 'Sin mercadería para recibir',
      body: 'No hay líneas habilitadas para inventario en este comprobante.',
      showReception,
      stats,
    }
  }
  return {
    title: 'Recepción al guardar',
    body: parts.join(' '),
    showReception,
    stats,
  }
}

export function inventoryCopy(
  result: InvoiceAnalysisApiResult,
  options?: ReviewInventoryOptions,
) {
  const summary = reviewInventorySummary(result, options)
  return {
    title: summary.title,
    body: summary.body,
    showReception: summary.showReception,
  }
}

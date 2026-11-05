import type {
  InvoiceDetail,
  InvoiceReceiveResult,
  InvoiceStoredLine,
  PendingReceptionLine,
} from './types'

export function pendingReceptionsPath(
  locationId: string,
  options: { cursor?: string | null; limit?: number } = {},
) {
  const params = new URLSearchParams({ locationId })
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.limit != null) params.set('limit', String(options.limit))
  return `/api/invoices/pending-receptions?${params.toString()}`
}

export function mergePendingReceptions(
  current: PendingReceptionLine[],
  incoming: PendingReceptionLine[],
): PendingReceptionLine[] {
  const seen = new Set(current.map((row) => row.lineId))
  const next = [...current]
  for (const row of incoming) {
    if (seen.has(row.lineId)) continue
    seen.add(row.lineId)
    next.push(row)
  }
  return next
}

export function applyPendingReceptionsPage(
  current: PendingReceptionLine[],
  incoming: PendingReceptionLine[],
  mode: 'replace' | 'append',
) {
  return mergePendingReceptions(mode === 'replace' ? [] : current, incoming)
}

export function pendingLineToStoredLine(row: PendingReceptionLine): InvoiceStoredLine {
  return {
    id: row.lineId,
    sourceLineId: row.lineId,
    sourceIndex: null,
    original: {
      description: row.ingredientName,
      quantity: null,
      unit: row.baseUnit,
      unitPrice: null,
      amount: null,
    },
    reviewed: {
      description: row.ingredientName,
      quantity: null,
      unit: row.baseUnit,
      unitPrice: null,
      amount: null,
    },
    classification: 'stock',
    inventoryEligibility: 'eligible',
    mappingStatus: 'mapped',
    quantityKind: 'inventory',
    inventoryPhysicalQuantity: row.invoicedQuantity,
    inventoryProductId: row.ingredientId,
    inventoryProduct: {
      id: row.ingredientId,
      name: row.ingredientName,
      baseUnit: row.baseUnit,
    },
    invoicedQuantity: row.invoicedQuantity,
    receivedQuantity: row.receivedQuantity,
    remainingQuantity: row.remainingQuantity,
  }
}

export function applyPendingReceptionResult(
  items: PendingReceptionLine[],
  result: InvoiceReceiveResult,
): PendingReceptionLine[] {
  return items.flatMap((row) => {
    if (row.lineId !== result.purchaseDocumentLineId) return [row]
    if (result.remainingQuantity <= 0) return []
    return [{
      ...row,
      invoicedQuantity: result.invoicedQuantity,
      receivedQuantity: result.receivedQuantity,
      remainingQuantity: result.remainingQuantity,
    }]
  })
}

export function applyPendingReceptionServerLine(
  items: PendingReceptionLine[],
  lineId: string,
  server: PendingReceptionLine | null,
): PendingReceptionLine[] {
  return items.flatMap((row) => {
    if (row.lineId !== lineId) return [row]
    if (!server || server.remainingQuantity <= 0) return []
    return [server]
  })
}

export function pendingLineFromInvoiceDetail(
  current: PendingReceptionLine,
  detail: Pick<InvoiceDetail, 'locationId' | 'lines'>,
): PendingReceptionLine | null {
  const stored = detail.lines.find((line) => line.id === current.lineId)
  if (!stored) return null
  const remaining = stored.remainingQuantity ?? 0
  if (remaining <= 0) return null
  return {
    ...current,
    locationId: detail.locationId || current.locationId,
    invoicedQuantity: stored.invoicedQuantity ?? stored.inventoryPhysicalQuantity,
    receivedQuantity: stored.receivedQuantity ?? 0,
    remainingQuantity: remaining,
  }
}

export function reconcilePendingAfterReceive(
  items: PendingReceptionLine[],
  result: InvoiceReceiveResult,
  detail?: Pick<InvoiceDetail, 'locationId' | 'lines'> | null,
): PendingReceptionLine[] {
  const fromReceive = applyPendingReceptionResult(items, result)
  if (!detail) return fromReceive
  const current = fromReceive.find((row) => row.lineId === result.purchaseDocumentLineId)
    ?? items.find((row) => row.lineId === result.purchaseDocumentLineId)
  if (!current) return fromReceive
  return applyPendingReceptionServerLine(
    fromReceive,
    result.purchaseDocumentLineId,
    pendingLineFromInvoiceDetail(current, detail),
  )
}

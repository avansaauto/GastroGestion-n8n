import { InvoiceSaveError } from './invoiceSaveError.js'
import type { InvoiceLineClassification } from '../modules/invoice-intelligence/types.js'

const LINE_CLASSIFICATIONS = new Set<InvoiceLineClassification>([
  'stock',
  'service',
  'expense',
  'logistics',
  'fiscal',
  'pending_review',
  'ignored',
])

export type InvoiceHeaderSnapshot = {
  type: string | null
  number: string | null
  issueDate: string | null
  dueDate: string | null
  currency: string
  currencyNeedsConfirmation: boolean
  clientNumber: string | null
  meterNumber: string | null
  paymentCode: string | null
  printNumber: string | null
}

export type InvoiceDocumentSnapshot = {
  supplier: { name: string | null; taxId: string | null }
  header: InvoiceHeaderSnapshot
  amounts: {
    subtotal: number | null
    discounts: number
    taxes: number
    otherTaxes: number
    total: number | null
    taxesIncluded: boolean
  }
  classification: string
  mainCategory: string
  service: unknown
  reviewStatus: string
  lines: Array<Record<string, unknown> & { id: string }>
}

export type InvoiceSaveCorrections = {
  supplier?: { name?: string; taxId?: string }
  header?: {
    type?: string
    number?: string
    issueDate?: string
    currency?: string
  }
  lines?: Array<{
    id: string
    name?: string
    quantity?: number | null
    unit?: string | null
    unitPrice?: number | null
    amount?: number | null
    classification?: InvoiceLineClassification
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

export function parseInvoiceCorrections(value: unknown): InvoiceSaveCorrections {
  if (value == null || value === '') return {}
  if (!isRecord(value)) {
    throw new InvoiceSaveError('Las correcciones no son válidas.', 'INVALID_CORRECTIONS', 422)
  }
  const forbidden = [
    'inventoryPhysicalQuantity',
    'inventory_physical_quantity',
    'inventory_product_id',
    'inventoryProductId',
  ]
  if (forbidden.some((key) => key in value)) {
    throw new InvoiceSaveError(
      'El mapeo de inventario no se envía en el guardado.',
      'INVALID_CORRECTIONS',
      422,
    )
  }

  const corrections: InvoiceSaveCorrections = {}
  if (isRecord(value.supplier)) {
    corrections.supplier = {
      ...(asString(value.supplier.name) !== undefined ? { name: asString(value.supplier.name) } : {}),
      ...(asString(value.supplier.taxId) !== undefined ? { taxId: asString(value.supplier.taxId) } : {}),
    }
  }
  if (isRecord(value.header)) {
    corrections.header = {
      ...(asString(value.header.type) !== undefined ? { type: asString(value.header.type) } : {}),
      ...(asString(value.header.number) !== undefined ? { number: asString(value.header.number) } : {}),
      ...(asString(value.header.issueDate) !== undefined ? { issueDate: asString(value.header.issueDate) } : {}),
      ...(asString(value.header.currency) !== undefined ? { currency: asString(value.header.currency) } : {}),
    }
  }
  if (value.lines != null) {
    if (!Array.isArray(value.lines)) {
      throw new InvoiceSaveError('Las correcciones de líneas no son válidas.', 'INVALID_CORRECTIONS', 422)
    }
    corrections.lines = value.lines.map((line) => {
      if (!isRecord(line) || typeof line.id !== 'string') {
        throw new InvoiceSaveError('Cada corrección de línea necesita un id existente.', 'INVALID_CORRECTIONS', 422)
      }
      if (forbidden.some((key) => key in line)) {
        throw new InvoiceSaveError(
          'El mapeo de inventario no se envía en el guardado.',
          'INVALID_CORRECTIONS',
          422,
        )
      }
      const classification = asString(line.classification)
      if (classification && !LINE_CLASSIFICATIONS.has(classification as InvoiceLineClassification)) {
        throw new InvoiceSaveError('La clasificación de línea no es válida.', 'INVALID_CORRECTIONS', 422)
      }
      return {
        id: line.id,
        ...(asString(line.name) !== undefined ? { name: asString(line.name) } : {}),
        ...(asNumber(line.quantity) !== undefined ? { quantity: asNumber(line.quantity) } : {}),
        ...(asString(line.unit) !== undefined || line.unit === null ? { unit: asString(line.unit) ?? null } : {}),
        ...(asNumber(line.unitPrice) !== undefined ? { unitPrice: asNumber(line.unitPrice) } : {}),
        ...(asNumber(line.amount) !== undefined ? { amount: asNumber(line.amount) } : {}),
        ...(classification ? { classification: classification as InvoiceLineClassification } : {}),
      }
    })
  }
  return corrections
}

export function applyInvoiceCorrections(
  original: InvoiceDocumentSnapshot,
  corrections: InvoiceSaveCorrections,
): InvoiceDocumentSnapshot {
  const next = structuredClone(original)
  if (corrections.supplier?.name !== undefined) next.supplier.name = corrections.supplier.name
  if (corrections.supplier?.taxId !== undefined) next.supplier.taxId = corrections.supplier.taxId

  if (corrections.header?.type !== undefined) next.header.type = corrections.header.type
  if (corrections.header?.number !== undefined) next.header.number = corrections.header.number
  if (corrections.header?.issueDate !== undefined) next.header.issueDate = corrections.header.issueDate
  if (corrections.header?.currency !== undefined) {
    if (!next.header.currencyNeedsConfirmation && next.header.currency) {
      throw new InvoiceSaveError(
        'La moneda extraída no admite corrección en este paso.',
        'INVALID_CORRECTIONS',
        422,
      )
    }
    next.header.currency = corrections.header.currency
  }

  if (corrections.lines?.length) {
    const byId = new Map(next.lines.map((line) => [line.id, line]))
    for (const patch of corrections.lines) {
      const line = byId.get(patch.id)
      if (!line) {
        throw new InvoiceSaveError(
          'No se pueden inventar líneas en las correcciones.',
          'INVALID_CORRECTIONS',
          422,
        )
      }
      if (patch.name !== undefined) line.name = patch.name
      if (patch.quantity !== undefined) line.quantity = patch.quantity
      if (patch.unit !== undefined) line.unit = patch.unit
      if (patch.unitPrice !== undefined) line.unitPrice = patch.unitPrice
      if (patch.amount !== undefined) line.amount = patch.amount
      if (patch.classification !== undefined) line.classification = patch.classification
    }
  }
  return next
}

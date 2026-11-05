import { InvoiceSaveError } from './invoiceSaveError.js'

/**
 * Valores de `purchase_documents.document_type` confirmados por el esquema del
 * proyecto. El CHECK `purchase_documents_type_check` pertenece a la tabla
 * original y no está definido en `migrate-invoice-persistence.sql`.
 *
 * Evidencia:
 * - OpenAPI / inspect: default `invoice`.
 * - RPC: `coalesce(p->>'document_type', 'invoice')`.
 * - 23514: `FACTURA` no está permitido.
 *
 * No se agregan `credit_note` / `debit_note` hasta que el CHECK los liste.
 */
export const PURCHASE_DOCUMENT_TYPE_ALLOWED = ['invoice'] as const

export type PurchaseDocumentType = (typeof PURCHASE_DOCUMENT_TYPE_ALLOWED)[number]

const ALLOWED = new Set<string>(PURCHASE_DOCUMENT_TYPE_ALLOWED)

type DocumentTypeCandidate = 'invoice' | 'credit_note' | 'debit_note'

function canonicalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function candidateFromLabel(canonical: string): DocumentTypeCandidate | null {
  if (!canonical) return null
  if (canonical === 'invoice') return 'invoice'
  if (canonical === 'credit note' || canonical === 'credit_note') return 'credit_note'
  if (canonical === 'debit note' || canonical === 'debit_note') return 'debit_note'
  if (
    canonical === 'nc'
    || canonical.startsWith('nc ')
    || /\bnota\b.*\bcredit/.test(canonical)
  ) {
    return 'credit_note'
  }
  if (
    canonical === 'nd'
    || canonical.startsWith('nd ')
    || /\bnota\b.*\bdebit/.test(canonical)
  ) {
    return 'debit_note'
  }
  if (
    canonical === 'factura'
    || canonical.startsWith('factura ')
    || /^f[abcem]$/.test(canonical)
  ) {
    return 'invoice'
  }
  return null
}

export function normalizePurchaseDocumentType(raw: string | null | undefined): PurchaseDocumentType {
  const canonical = canonicalize(raw ?? '')
  if (!canonical) {
    throw new InvoiceSaveError(
      'Falta el tipo de comprobante.',
      'DOCUMENT_TYPE_REQUIRED',
      422,
    )
  }
  const candidate = candidateFromLabel(canonical)
  if (!candidate) {
    throw new InvoiceSaveError(
      'El tipo de comprobante no está permitido para guardar.',
      'INVALID_DOCUMENT_TYPE',
      422,
    )
  }
  if (!ALLOWED.has(candidate)) {
    throw new InvoiceSaveError(
      'El tipo de comprobante no está permitido para guardar.',
      'INVALID_DOCUMENT_TYPE',
      422,
    )
  }
  return candidate as PurchaseDocumentType
}

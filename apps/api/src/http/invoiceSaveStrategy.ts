import { isCompleteVoucherIdentity } from './invoiceVoucher.js'

/**
 * Estrategia de guardado. POST /api/invoices usa estos pasos.
 *
 * Storage y PostgreSQL no son una transacción. Un rename de objeto no se trata
 * como commit atómico junto al INSERT.
 *
 * Path definitivo (content-addressed), sin temporales ni move:
 *   {organization_id}/invoices/{fileSha256}.{ext}
 *
 * El hash se recalcula de los bytes recibidos en el save. El token HMAC cubre
 * usuario, hash del archivo y hash canónico del snapshot original.
 *
 * Replay / duplicados:
 * - El token puede reutilizarse hasta exp para reintentar el mismo guardado.
 * - La unicidad (org, file_sha256) donde status <> cancelled hace el reintento
 *   idempotente: se devuelve el documento existente, no se borra el objeto.
 * - La unicidad (org, CUIT, tipo, PV, número) donde status <> cancelled rechaza
 *   otro archivo con el mismo comprobante (409). Dos PDF distintos no son dos
 *   facturas si la identidad fiscal coincide.
 * - Estados del CHECK real: draft | reviewed | received | cancelled.
 *   El RPC inserta draft, escribe lineas y confirma reviewed en una sola
 *   transaccion. received es recepcion futura. cancelled anula.
 * - PostgreSQL no verifica HMAC. El backend lo hace antes del RPC.
 * - El RPC lo invoca getSupabaseAdmin() (service_role). authenticated no EXECUTE.
 * - actor_user_id = request.user.id de getUser. No se copia del body.
 * - No hay store de nonce/jti en este paso.
 */

export const INVOICE_SAVE_STRATEGY = {
  hashAlgorithm: 'sha256',
  hashSource: 'received_bytes',
  storageBucket: 'invoice-documents',
  pathPattern: '{organization_id}/invoices/{fileSha256}.{ext}',
  orphanAfterHours: 24,
  steps: [
    'authorize_location_via_rls',
    'verify_hmac_integrity_token',
    'assert_commercial_decisions',
    'recalculate_fiscal_and_documentary',
    'hash_received_bytes',
    'reject_if_voucher_or_hash_duplicate',
    'upload_private_content_addressed_object',
    'bind_actor_from_getUser',
    'rpc_senda_save_purchase_invoice',
    'on_unique_violation_return_existing',
    'schedule_orphan_cleanup',
    'never_write_purchase_items_or_inventory',
  ],
} as const

export type InvoiceSaveRecoveryError =
  | 'hash_mismatch'
  | 'duplicate_hash'
  | 'duplicate_voucher'
  | 'insert_failed'
  | 'upload_failed'
  | 'orphan_cleanup_failed'

export function invoiceStorageObjectPath(
  organizationId: string,
  fileSha256: string,
  extension: string,
) {
  const ext = extension.replace(/^\./, '').toLowerCase()
  return `${organizationId}/invoices/${fileSha256}.${ext}`
}

export type ExistingPurchaseDocumentIndex = {
  id: string
  organizationId: string
  fileSha256: string | null
  issuerTaxIdNormalized: string | null
  voucherType: string | null
  pointOfSale: string | null
  voucherNumber: string | null
  status: string
}

export type IncomingVoucherKey = {
  organizationId: string
  fileSha256: string
  issuerTaxIdNormalized: string | null
  voucherType: string | null
  pointOfSale: string | null
  voucherNumber: string | null
}

function isActiveDocument(status: string) {
  return status !== 'cancelled'
}

function fiscalIdentity(row: {
  issuerTaxIdNormalized: string | null
  voucherType: string | null
  pointOfSale: string | null
  voucherNumber: string | null
}) {
  return {
    issuerTaxIdNormalized: row.issuerTaxIdNormalized,
    voucherType: row.voucherType,
    pointOfSale: row.pointOfSale,
    voucherNumber: row.voucherNumber,
  }
}

function sameVoucher(existing: ExistingPurchaseDocumentIndex, incoming: IncomingVoucherKey) {
  const left = fiscalIdentity(existing)
  const right = fiscalIdentity(incoming)
  if (!isCompleteVoucherIdentity(left) || !isCompleteVoucherIdentity(right)) return false
  return (
    left.issuerTaxIdNormalized === right.issuerTaxIdNormalized
    && left.voucherType === right.voucherType
    && left.pointOfSale === right.pointOfSale
    && left.voucherNumber === right.voucherNumber
  )
}

export function resolveInvoiceSaveIdempotency(
  existing: ExistingPurchaseDocumentIndex[],
  incoming: IncomingVoucherKey,
):
  | { action: 'insert' }
  | { action: 'return_existing'; id: string; reason: 'file_hash' }
  | { action: 'reject_duplicate_voucher'; id: string } {
  const inOrg = existing.filter(
    (row) => row.organizationId === incoming.organizationId && isActiveDocument(row.status),
  )
  const byHash = inOrg.find((row) => row.fileSha256 === incoming.fileSha256)
  const byVoucher = inOrg.find((row) => sameVoucher(row, incoming))

  if (byHash && byVoucher && byHash.id !== byVoucher.id) {
    return { action: 'reject_duplicate_voucher', id: byVoucher.id }
  }
  if (byHash) {
    return { action: 'return_existing', id: byHash.id, reason: 'file_hash' }
  }
  if (byVoucher) {
    return { action: 'reject_duplicate_voucher', id: byVoucher.id }
  }
  return { action: 'insert' }
}

export function describeInvoiceSaveRecovery(error: InvoiceSaveRecoveryError) {
  switch (error) {
    case 'hash_mismatch':
      return 'Rechazar 409 HASH_MISMATCH. No subir archivo. No insertar filas. El PDF no es el analizado.'
    case 'duplicate_hash':
      return 'Responder 200/409 idempotente con el id existente. No borrar el objeto content-addressed: pertenece al documento ya guardado.'
    case 'duplicate_voucher':
      return 'Responder 409 DUPLICATE_DOCUMENT. Otro archivo ya usa ese comprobante. No insertar. No borrar el objeto ajeno.'
    case 'upload_failed':
      return 'No insertar en PostgreSQL. El usuario puede reintentar el save; el path definitivo se vuelve a escribir con los mismos bytes.'
    case 'insert_failed':
      return 'Dejar el objeto content-addressed. No confirmar el save. El reintento reescribe el mismo path e intenta el INSERT de nuevo. Un job borra huérfanos > 24 h sin fila.'
    case 'orphan_cleanup_failed':
      return 'Registrar el error y reintentar el job. No revertir documentos ya insertados. No tratar Storage como rollback de SQL.'
    default:
      return 'No confirmar el guardado.'
  }
}

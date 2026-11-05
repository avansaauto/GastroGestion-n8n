import { isCompleteVoucherIdentity, parseVoucherIdentity, type CompleteVoucherIdentity } from './invoiceVoucher'
import type { InvoiceAnalysisApiResult, InvoiceDuplicateMatch } from './types'

export const DUPLICATE_CHECKING_MESSAGE = 'Comprobando factura…'
export const DUPLICATE_REGISTERED_TITLE = 'Factura ya registrada'
export const DUPLICATE_LOOKUP_FAILED_MESSAGE = 'No se pudo comprobar si esta factura ya existe'
export const DUPLICATE_OPEN_LABEL = 'Abrir factura registrada'
export const DUPLICATE_SAVE_BLOCKED_REASON = 'Esta factura ya está registrada.'

export type InvoiceDuplicateStatus = 'idle' | 'checking' | 'matched' | 'noted' | 'clear' | 'failed'

export const DELETED_PRIOR_TITLE = 'La factura anterior fue eliminada'
export const DELETED_PRIOR_BODY = 'Podés registrarla de nuevo. No se recupera la eliminada ni se duplica un comprobante activo.'

export const ANALYSIS_IN_PROGRESS_MESSAGE = 'Hay un análisis en curso de este archivo. SENDA continúa con esa lectura.'
export type InvoiceDuplicateSource = 'hash' | 'fiscal' | null

export type InvoiceDuplicateState = {
  status: InvoiceDuplicateStatus
  match: InvoiceDuplicateMatch | null
  warning: string | null
  source: InvoiceDuplicateSource
  contextKey: string | null
}

export const initialDuplicateState: InvoiceDuplicateState = {
  status: 'idle',
  match: null,
  warning: null,
  source: null,
  contextKey: null,
}

export type DuplicateLookupQuery =
  | { locationId: string; fileSha256: string }
  | {
    locationId: string
    issuerTaxId: string
    voucherType: string
    pointOfSale: string
    voucherNumber: string
  }

export type DuplicateLookupOutcome =
  | { kind: 'stale' }
  | { kind: 'matched'; match: InvoiceDuplicateMatch }
  | { kind: 'clear' }
  | { kind: 'failed' }

export function invoiceFileKey(file: { name: string; size: number; lastModified: number }) {
  return `${file.name}:${file.size}:${file.lastModified}`
}

export function duplicateContextKey(locationId: string, fileKey: string) {
  return `${locationId.trim()}::${fileKey}`
}

export function buildDuplicateLookupPath(query: DuplicateLookupQuery) {
  const params = new URLSearchParams()
  params.set('locationId', query.locationId)
  if ('fileSha256' in query) {
    params.set('fileSha256', query.fileSha256)
  } else {
    params.set('issuerTaxId', query.issuerTaxId)
    params.set('voucherType', query.voucherType)
    params.set('pointOfSale', query.pointOfSale)
    params.set('voucherNumber', query.voucherNumber)
  }
  return `/api/invoices/duplicates?${params.toString()}`
}

export function fiscalIdentityFromAnalysis(result: InvoiceAnalysisApiResult) {
  return parseVoucherIdentity({
    taxId: result.document.supplier.taxId,
    documentNumber: result.document.header.number,
    documentType: result.document.header.type,
  })
}

export function fiscalLookupQuery(
  locationId: string,
  identity: CompleteVoucherIdentity,
): DuplicateLookupQuery {
  return {
    locationId,
    issuerTaxId: identity.issuerTaxIdNormalized,
    voucherType: identity.voucherType,
    pointOfSale: identity.pointOfSale,
    voucherNumber: identity.voucherNumber,
  }
}

export function duplicateBlocksAnalyze(state: { status: InvoiceDuplicateStatus }) {
  return state.status === 'checking' || state.status === 'matched'
}

export function duplicateBlocksSave(state: { status: InvoiceDuplicateStatus }) {
  return state.status === 'checking' || state.status === 'matched'
}

export function shouldShowInvoiceReview(
  result: InvoiceAnalysisApiResult | null,
  duplicate: InvoiceDuplicateState,
) {
  return Boolean(result) && duplicate.status !== 'matched' && duplicate.status !== 'checking'
}

async function runDuplicateLookup(
  lookup: () => Promise<InvoiceDuplicateMatch | null>,
  isCurrent: () => boolean,
): Promise<DuplicateLookupOutcome> {
  if (!isCurrent()) return { kind: 'stale' }
  try {
    const match = await lookup()
    if (!isCurrent()) return { kind: 'stale' }
    return match ? { kind: 'matched', match } : { kind: 'clear' }
  } catch {
    if (!isCurrent()) return { kind: 'stale' }
    return { kind: 'failed' }
  }
}

export async function lookupHashDuplicate(input: {
  locationId: string
  fileSha256: string
  isCurrent: () => boolean
  lookup: (query: DuplicateLookupQuery) => Promise<InvoiceDuplicateMatch | null>
}): Promise<DuplicateLookupOutcome> {
  return runDuplicateLookup(
    () => input.lookup({
      locationId: input.locationId,
      fileSha256: input.fileSha256,
    }),
    input.isCurrent,
  )
}

export async function hashAndLookupDuplicate(input: {
  file: Blob
  locationId: string
  isCurrent: () => boolean
  hashFile: (file: Blob) => Promise<string>
  lookup: (query: DuplicateLookupQuery) => Promise<InvoiceDuplicateMatch | null>
}): Promise<DuplicateLookupOutcome> {
  if (!isCurrentReady(input.locationId, input.isCurrent)) return { kind: 'stale' }
  try {
    const fileSha256 = await input.hashFile(input.file)
    if (!input.isCurrent()) return { kind: 'stale' }
    return lookupHashDuplicate({
      locationId: input.locationId,
      fileSha256,
      isCurrent: input.isCurrent,
      lookup: input.lookup,
    })
  } catch {
    if (!input.isCurrent()) return { kind: 'stale' }
    return { kind: 'failed' }
  }
}

function isCurrentReady(locationId: string, isCurrent: () => boolean) {
  return Boolean(locationId.trim()) && isCurrent()
}

export async function lookupFiscalDuplicate(input: {
  locationId: string
  result: InvoiceAnalysisApiResult
  isCurrent: () => boolean
  lookup: (query: DuplicateLookupQuery) => Promise<InvoiceDuplicateMatch | null>
}): Promise<DuplicateLookupOutcome | { kind: 'skipped' }> {
  const identity = fiscalIdentityFromAnalysis(input.result)
  if (!isCompleteVoucherIdentity(identity)) return { kind: 'skipped' }
  return runDuplicateLookup(
    () => input.lookup(fiscalLookupQuery(input.locationId, identity)),
    input.isCurrent,
  )
}

export async function analyzeWithDuplicateGuard(input: {
  isCurrent: () => boolean
  analyze: () => Promise<InvoiceAnalysisApiResult>
  lookupFiscal: (query: DuplicateLookupQuery) => Promise<InvoiceDuplicateMatch | null>
  locationId: string
}): Promise<
  | { kind: 'stale' }
  | {
    kind: 'analyzed'
    result: InvoiceAnalysisApiResult
    duplicate: DuplicateLookupOutcome | { kind: 'skipped' }
  }
> {
  if (!input.isCurrent()) return { kind: 'stale' }
  const result = await input.analyze()
  if (!input.isCurrent()) return { kind: 'stale' }
  const duplicate = await lookupFiscalDuplicate({
    locationId: input.locationId,
    result,
    isCurrent: input.isCurrent,
    lookup: input.lookupFiscal,
  })
  if (duplicate.kind === 'stale' || !input.isCurrent()) return { kind: 'stale' }
  return { kind: 'analyzed', result, duplicate }
}

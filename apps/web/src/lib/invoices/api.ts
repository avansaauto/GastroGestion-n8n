import { supabase } from '@/lib/supabase'
import { INVOICE_ANALYZE_TIMEOUT_MS, INVOICE_RECEIVE_TIMEOUT_MS, INVOICE_SAVE_TIMEOUT_MS } from './constants'
import { buildDuplicateLookupPath, type DuplicateLookupQuery } from './invoiceDuplicate'
import type { ConfirmedMappingMemory } from './invoiceMemory'
import { invoicesListPath } from './invoiceListFilter'
import { pendingReceptionsPath } from './pendingReceptions'
import type {
  InvoiceAnalysisApiResult,
  InvoiceCommercialDecisionPayload,
  InvoiceDetail,
  InvoiceDuplicateMatch,
  InvoiceFileAccess,
  InvoiceListItem,
  InvoiceMapResult,
  InvoiceReceiveResult,
  InvoiceCancelResult,
  InvoiceDeleteResult,
  InventoryProductOption,
  InvoiceSaveApiResult,
  InvoiceSaveCorrections,
  PendingReceptionLine,
  PendingReceptionPage,
} from './types'

export class InvoiceApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'InvoiceApiError'
  }
}

const API_URL = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '')

const ERROR_BY_STATUS: Record<number, { code: string; message: string }> = {
  401: { code: 'UNAUTHENTICATED', message: 'La sesión expiró o no es válida.' },
  403: { code: 'FORBIDDEN', message: 'No tenés autorización para analizar facturas.' },
  413: { code: 'FILE_TOO_LARGE', message: 'El archivo supera el máximo permitido de 10 MB.' },
  422: { code: 'UNSUPPORTED_DOCUMENT', message: 'El documento no es compatible.' },
  429: { code: 'RATE_LIMITED', message: 'Se alcanzó el límite de análisis. Probá más tarde.' },
  502: { code: 'PROVIDER_REJECTED', message: 'No se pudo completar la lectura del documento.' },
  503: { code: 'PROVIDER_UNAVAILABLE', message: 'El análisis de facturas no está disponible.' },
  504: { code: 'PROVIDER_TIMEOUT', message: 'El análisis superó el tiempo de espera.' },
}

export function mapInvoiceHttpError(status: number, payload: { error?: string; code?: string }) {
  if (status === 401 || status === 403 || status === 429 || status === 504) {
    const mapped = ERROR_BY_STATUS[status]
    return new InvoiceApiError(mapped.message, status, payload.code || mapped.code)
  }
  if (status === 502) {
    return new InvoiceApiError(
      ERROR_BY_STATUS[502].message,
      status,
      payload.code || ERROR_BY_STATUS[502].code,
    )
  }
  const mapped = ERROR_BY_STATUS[status]
  if (mapped) {
    return new InvoiceApiError(payload.error || mapped.message, status, payload.code || mapped.code)
  }
  return new InvoiceApiError(
    payload.error || 'No se pudo analizar la factura.',
    status,
    payload.code || 'ANALYSIS_FAILED',
  )
}

function isAbortError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String(error.name) : ''
  return name === 'AbortError' || name === 'TimeoutError'
}

async function resolveAccessToken(explicit?: string) {
  if (explicit) return explicit
  if (!supabase) {
    throw new InvoiceApiError('Supabase todavía no está configurado.', 0, 'NOT_CONFIGURED')
  }
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session?.access_token) {
    throw new InvoiceApiError('La sesión no está disponible.', 401, 'UNAUTHENTICATED')
  }
  return data.session.access_token
}

export async function analyzeInvoice(
  file: File,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; accessToken?: string } = {},
): Promise<InvoiceAnalysisApiResult> {
  const accessToken = await resolveAccessToken(options.accessToken)

  const timeoutMs = options.timeoutMs ?? INVOICE_ANALYZE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const body = new FormData()
  body.append('file', file, file.name)

  try {
    const response = await (options.fetchImpl ?? fetch)(`${API_URL}/api/invoices/analyze`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body,
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({})) as {
      data?: InvoiceAnalysisApiResult
      error?: string
      code?: string
    }
    if (!response.ok) throw mapInvoiceHttpError(response.status, payload)
    if (!payload.data) {
      throw new InvoiceApiError('La respuesta del análisis está incompleta.', 502, 'PROVIDER_INVALID_RESPONSE')
    }
    return payload.data
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    if (isAbortError(error)) {
      throw new InvoiceApiError(
        'El análisis superó el tiempo de espera.',
        504,
        'PROVIDER_TIMEOUT',
      )
    }
    throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
  } finally {
    clearTimeout(timer)
  }
}

export const INVOICE_ANALYSIS_POLL_INTERVAL_MS = 2_000

const ANALYSIS_JOB_FAILURE_MESSAGE: Record<string, string> = {
  INVALID_EXTRACTION: 'La extracción no tiene una estructura utilizable.',
  ANALYSIS_FAILED: 'No se pudo analizar la factura.',
  DISPATCH_REJECTED: 'No se pudo enviar el documento a analizar.',
}

export async function analyzeInvoiceJob(
  file: File,
  locationId: string,
  options: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    pollIntervalMs?: number
    accessToken?: string
    signal?: AbortSignal
    onJob?: (job: { jobId: string; status: string; reused?: boolean }) => void
  } = {},
): Promise<InvoiceAnalysisApiResult> {
  const location = locationId.trim()
  if (!location) {
    throw new InvoiceApiError('Indicá el local.', 400, 'LOCATION_REQUIRED')
  }
  const timeoutMs = options.timeoutMs ?? INVOICE_ANALYZE_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? INVOICE_ANALYSIS_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  const signal = options.signal
  const fetchImpl = options.fetchImpl ?? fetch

  const stopError = () => {
    if (signal?.aborted) {
      return new InvoiceApiError('El análisis se canceló.', 0, 'ANALYSIS_CANCELLED')
    }
    if (Date.now() >= deadline) {
      return new InvoiceApiError('El análisis superó el tiempo de espera.', 504, 'PROVIDER_TIMEOUT')
    }
    return null
  }

  const assertRunning = () => {
    const stopped = stopError()
    if (stopped) throw stopped
  }

  const requestJob = async (url: string, init: RequestInit) => {
    assertRunning()
    const accessToken = await resolveAccessToken(options.accessToken)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()))
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => ({})) as {
        data?: { jobId?: string; status?: string; result?: unknown; failureCode?: string; reused?: boolean }
        error?: string
        code?: string
      }
      if (!response.ok) throw mapInvoiceHttpError(response.status, payload)
      const data = payload.data
      const jobId = data?.jobId
      const status = data?.status
      if (!data || !jobId || !status) {
        throw new InvoiceApiError('La respuesta del análisis está incompleta.', 502, 'PROVIDER_INVALID_RESPONSE')
      }
      return {
        jobId,
        status,
        result: data.result,
        failureCode: data.failureCode,
        reused: data.reused,
      }
    } catch (error) {
      if (error instanceof InvoiceApiError) throw error
      const stopped = stopError()
      if (stopped) throw stopped
      if (isAbortError(error)) {
        throw new InvoiceApiError('El análisis superó el tiempo de espera.', 504, 'PROVIDER_TIMEOUT')
      }
      throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const body = new FormData()
  body.append('file', file, file.name)
  body.append('locationId', location)
  let job = await requestJob(`${API_URL}/api/invoices/analysis-jobs`, { method: 'POST', body })
  options.onJob?.(job)

  while (job.status === 'queued' || job.status === 'processing') {
    await waitForAnalysisPoll(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), signal)
    assertRunning()
    job = await requestJob(`${API_URL}/api/invoices/analysis-jobs/${job.jobId}`, { method: 'GET' })
  }

  if (job.status === 'failed') {
    const code = job.failureCode || 'ANALYSIS_FAILED'
    throw new InvoiceApiError(
      ANALYSIS_JOB_FAILURE_MESSAGE[code] || 'No se pudo analizar la factura.',
      422,
      code,
    )
  }
  if (job.status === 'ready') {
    const result = asAnalysis(job.result)
    if (!result) {
      throw new InvoiceApiError('La respuesta del análisis está incompleta.', 502, 'PROVIDER_INVALID_RESPONSE')
    }
    return result
  }
  throw new InvoiceApiError('No se pudo analizar la factura.', 500, 'ANALYSIS_FAILED')
}

function waitForAnalysisPoll(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InvoiceApiError('El análisis se canceló.', 0, 'ANALYSIS_CANCELLED'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new InvoiceApiError('El análisis se canceló.', 0, 'ANALYSIS_CANCELLED'))
    }
    signal?.addEventListener('abort', onAbort)
  })
}

const SAVE_ERROR_BY_CODE: Record<string, string> = {
  UNAUTHENTICATED: 'La sesión expiró o no es válida.',
  DUPLICATE_DOCUMENT: 'Este comprobante ya está registrado.',
  INVOICE_STORAGE_NOT_CONFIGURED: 'El almacenamiento de facturas no está configurado.',
  SAVE_NOT_ALLOWED_NO_INVENTORY: 'Este documento no tiene productos de inventario para guardar.',
  FISCAL_INCONSISTENCY_REQUIRES_ACCEPTANCE: 'La diferencia fiscal requiere confirmación explícita.',
  COMMERCIAL_RELATION_UNRESOLVED: 'Confirmá o rechazá las bonificaciones pendientes antes de guardar.',
  TOKEN_EXPIRED: 'El análisis expiró. Volvé a analizar el comprobante.',
  TOKEN_MISSING: 'Falta la firma de integridad. Volvé a analizar el comprobante.',
  TOKEN_INVALID: 'La firma de integridad no es válida. Volvé a analizar el comprobante.',
  FILE_MISMATCH: 'El archivo no coincide con el analizado. Volvé a analizarlo.',
  SNAPSHOT_MISMATCH: 'El resultado del análisis no coincide con la firma. Volvé a analizar el comprobante.',
  SECRET_MISSING: 'Falta la clave de integridad para persistir.',
  SERVICE_ROLE_MISSING: 'Falta la clave de servicio para persistir.',
  UPLOAD_FAILED: 'No se pudo guardar el archivo original.',
  FORBIDDEN: 'No tenés autorización para guardar facturas en este local.',
  LOCATION_REQUIRED: 'Indicá el local.',
}

export function mapInvoiceSaveHttpError(status: number, payload: { error?: string; code?: string }) {
  if (status === 401) {
    return new InvoiceApiError(
      SAVE_ERROR_BY_CODE.UNAUTHENTICATED,
      401,
      payload.code || 'UNAUTHENTICATED',
    )
  }
  const code = payload.code || ''
  if (code === 'COMMERCIAL_RELATION_UNRESOLVED') {
    return new InvoiceApiError(
      payload.error || SAVE_ERROR_BY_CODE.COMMERCIAL_RELATION_UNRESOLVED,
      status,
      code,
    )
  }
  if (code && SAVE_ERROR_BY_CODE[code]) {
    return new InvoiceApiError(SAVE_ERROR_BY_CODE[code], status, code)
  }
  if (status === 409) {
    return new InvoiceApiError(
      payload.error || SAVE_ERROR_BY_CODE.DUPLICATE_DOCUMENT,
      status,
      payload.code || 'DUPLICATE_DOCUMENT',
    )
  }
  if (status === 503 && /storage|bucket/i.test(payload.error || '')) {
    return new InvoiceApiError(
      SAVE_ERROR_BY_CODE.INVOICE_STORAGE_NOT_CONFIGURED,
      503,
      payload.code || 'INVOICE_STORAGE_NOT_CONFIGURED',
    )
  }
  return new InvoiceApiError(
    payload.error || 'No se pudo guardar la factura.',
    status,
    payload.code || 'SAVE_FAILED',
  )
}

export function buildInvoiceSaveFormData(input: {
  file: File
  locationId: string
  integrityToken: string
  originalSnapshot: InvoiceAnalysisApiResult
  corrections?: InvoiceSaveCorrections
  commercialDecisions: InvoiceCommercialDecisionPayload[]
  acceptFiscalInconsistency?: boolean
  confirmIntent?: {
    confirmIdempotencyKey: string
    lines: Array<{
      sourceLineId: string
      action: string
      inventoryProductId?: string | null
      create?: {
        name: string
        baseUnit: string
        category?: string | null
        minimumStock?: number | null
      } | null
      conversionFactor?: number | null
      receiveQuantity?: number | null
      receiveIdempotencyKey?: string | null
    }>
  } | null
}) {
  const body = new FormData()
  body.append('file', input.file, input.file.name)
  body.append('locationId', input.locationId)
  body.append('integrityToken', input.integrityToken)
  body.append('originalSnapshot', JSON.stringify(input.originalSnapshot))
  body.append('corrections', JSON.stringify(input.corrections ?? {}))
  body.append('commercialDecisions', JSON.stringify(input.commercialDecisions))
  if (input.acceptFiscalInconsistency) {
    body.append('acceptFiscalInconsistency', 'true')
  }
  if (input.confirmIntent) {
    body.append('confirmIntent', JSON.stringify(input.confirmIntent))
  }
  return body
}

export async function saveInvoice(
  input: {
    file: File
    locationId: string
    integrityToken: string
    originalSnapshot: InvoiceAnalysisApiResult
    corrections?: InvoiceSaveCorrections
    commercialDecisions: InvoiceCommercialDecisionPayload[]
    acceptFiscalInconsistency?: boolean
    confirmIntent?: {
      confirmIdempotencyKey: string
      lines: Array<{
        sourceLineId: string
        action: string
        inventoryProductId?: string | null
        create?: {
          name: string
          baseUnit: string
          category?: string | null
          minimumStock?: number | null
        } | null
        conversionFactor?: number | null
        receiveQuantity?: number | null
        receiveIdempotencyKey?: string | null
      }>
    } | null
  },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; accessToken?: string } = {},
): Promise<InvoiceSaveApiResult> {
  const accessToken = await resolveAccessToken(options.accessToken)
  const timeoutMs = options.timeoutMs ?? INVOICE_SAVE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const body = buildInvoiceSaveFormData(input)

  try {
    const response = await (options.fetchImpl ?? fetch)(`${API_URL}/api/invoices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body,
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({})) as {
      data?: InvoiceSaveApiResult
      error?: string
      code?: string
    }
    if (!response.ok) throw mapInvoiceSaveHttpError(response.status, payload)
    if (!payload.data?.id) {
      throw new InvoiceApiError('La respuesta del guardado está incompleta.', 502, 'SAVE_INVALID_RESPONSE')
    }
    return payload.data
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    if (isAbortError(error)) {
      throw new InvoiceApiError(
        'El guardado superó el tiempo de espera. Buscá el comprobante en Facturas; si ya está, abrilo desde el detalle. No se registró recepción automática.',
        504,
        'SAVE_TIMEOUT',
      )
    }
    throw new InvoiceApiError(
      'No se pudo conectar con el servidor. Buscá el comprobante en Facturas; si ya está, abrilo desde el detalle. No se registró recepción automática.',
      0,
      'NETWORK',
    )
  } finally {
    clearTimeout(timer)
  }
}

const QUERY_ERROR_BY_CODE: Record<string, string> = {
  UNAUTHENTICATED: 'La sesión expiró o no es válida.',
  FORBIDDEN: 'No tenés autorización para consultar facturas.',
  NOT_FOUND: 'No se encontró la factura.',
  DOCUMENT_ID_INVALID: 'El identificador de la factura no es válido.',
  SIGNED_URL_FAILED: 'No se pudo generar el enlace al documento original.',
  SERVICE_ROLE_MISSING: 'No se pudo generar el enlace al documento original.',
  LINE_NOT_FOUND: 'La línea no pertenece a esta factura.',
  LINE_NOT_INVENTORIABLE: 'Esta línea no representa mercadería inventariable.',
  PRODUCT_NOT_FOUND: 'El producto no existe o no está disponible.',
  PRODUCT_OUT_OF_SCOPE: 'El producto no pertenece a la organización de la factura.',
  PRODUCT_INACTIVE: 'El producto no está activo.',
  INVALID_QUANTITY: 'La cantidad de la línea no permite una equivalencia física.',
  INVALID_CONVERSION: 'El factor de conversión no coincide con la conversión conocida entre esas unidades.',
  CONVERSION_REQUIRED: 'Esta presentación no tiene una equivalencia configurada en el insumo. Configurala en Inventario antes de vincular.',
  EQUIVALENCE_REQUIRED: 'Indicá cuántas unidades base del inventario equivalen a 1 unidad de la factura (caja, pack, pieza…).',
  INCOMPATIBLE_UNITS: 'No se puede convertir esa unidad de la factura a la unidad del inventario.',
  LINE_HAS_RECEIPTS: 'No se puede cambiar el insumo de una línea ya recibida.',
  MAP_REQUIRES_REVIEWED: 'Solo se pueden vincular facturas revisadas.',
  MAP_FAILED: 'No se pudo vincular el producto.',
  LOCATION_ID_INVALID: 'El identificador del local no es válido.',
  CURSOR_INVALID: 'El cursor de paginación no es válido.',
  LIMIT_INVALID: 'El límite de página no es válido.',
}

const CANCEL_ERROR_BY_CODE: Record<string, string> = {
  UNAUTHENTICATED: 'La sesión expiró o no es válida.',
  FORBIDDEN: 'No tenés autorización para anular esta factura.',
  NOT_FOUND: 'No se encontró la factura.',
  DOCUMENT_ID_INVALID: 'El identificador de la factura no es válido.',
  CANCEL_REQUIRES_REVIEWED: 'Solo se pueden anular facturas revisadas que todavía no recibieron mercadería.',
  CANCEL_HAS_RECEIPTS: 'Esta factura ya tiene recepciones de stock. Anularla dejaría movimientos de inventario sin compensar. No se anula ni se borra.',
  INVOICE_RECEIVED_REVERSAL_UNAVAILABLE: 'Esta factura ya fue recibida. Anularla requeriría revertir stock y costos; esa operación todavía no está habilitada. No se oculta ni se borra.',
  SERVICE_ROLE_MISSING: 'Falta la clave de servicio para anular facturas.',
  CANCEL_FAILED: 'No se pudo anular la factura.',
}

const DELETE_ERROR_BY_CODE: Record<string, string> = {
  UNAUTHENTICATED: 'La sesión expiró o no es válida.',
  FORBIDDEN: 'No tenés autorización para eliminar esta factura.',
  NOT_FOUND: 'No se encontró la factura.',
  DOCUMENT_ID_INVALID: 'El identificador de la factura no es válido.',
  REVERSAL_INSUFFICIENT_STOCK: 'No hay stock suficiente para revertir los ingresos de esta factura.',
  DELETE_RPC_PENDING: 'La eliminación de facturas todavía no está habilitada en la base de datos.',
  SERVICE_ROLE_MISSING: 'Falta la clave de servicio para eliminar facturas.',
  LOOKUP_FAILED: 'No se pudieron consultar las facturas.',
  DELETE_FAILED: 'No se pudo eliminar la factura por un error de base de datos.',
}

const RECEIVE_ERROR_BY_CODE: Record<string, string> = {
  UNAUTHENTICATED: 'La sesión expiró o no es válida.',
  FORBIDDEN: 'No tenés autorización para recibir mercadería de esta factura.',
  NOT_FOUND: 'No se encontró la factura.',
  LINE_NOT_FOUND: 'La línea no pertenece a esta factura.',
  LINE_NOT_INVENTORIABLE: 'Esta línea no representa mercadería inventariable.',
  LINE_NOT_MAPPED: 'La línea no está vinculada a un insumo.',
  RECEIVE_REQUIRES_REVIEWED: 'Solo se puede recibir mercadería de facturas revisadas.',
  RECEIPT_EXCEEDS_INVOICED: 'La cantidad supera lo pendiente de esta línea.',
  INVALID_QUANTITY: 'Indicá una cantidad física mayor a cero.',
  UNVALUED_STOCK: 'Hay stock sin costo promedio. Cargá el costo inicial de ese insumo en Inventario antes de recibir esta compra. No se modificó el inventario.',
  VALUATION_AMOUNT_REQUIRED: 'Esta línea no tiene importe. Revisá el neto antes de recibir mercadería.',
  INVALID_PURCHASE_COST: 'El importe de la línea no es válido para valuar el stock.',
  PRODUCT_INACTIVE: 'El producto está desactivado. Reactivalo en Inventario antes de recibir stock.',
  IDEMPOTENCY_KEY_REQUIRED: 'Falta la clave de idempotencia.',
  IDEMPOTENCY_CONFLICT: 'Esa confirmación ya se usó con otros datos.',
  SERVICE_ROLE_MISSING: 'Falta la clave de servicio para recibir mercadería.',
  RECEIVE_FAILED: 'No se pudo registrar la recepción.',
}

export function mapInvoiceCancelHttpError(status: number, payload: { error?: string; code?: string }) {
  if (status === 401) {
    return new InvoiceApiError(CANCEL_ERROR_BY_CODE.UNAUTHENTICATED, 401, payload.code || 'UNAUTHENTICATED')
  }
  const code = payload.code || ''
  if (code && CANCEL_ERROR_BY_CODE[code]) {
    return new InvoiceApiError(CANCEL_ERROR_BY_CODE[code], status, code)
  }
  return new InvoiceApiError(
    payload.error || CANCEL_ERROR_BY_CODE.CANCEL_FAILED,
    status,
    payload.code || 'CANCEL_FAILED',
  )
}

export function mapInvoiceDeleteHttpError(status: number, payload: { error?: string; code?: string }) {
  if (status === 401) {
    return new InvoiceApiError(DELETE_ERROR_BY_CODE.UNAUTHENTICATED, 401, payload.code || 'UNAUTHENTICATED')
  }
  const code = payload.code || ''
  // Preferir el mensaje específico del servidor (p. ej. producto y cantidades faltantes).
  if (code === 'REVERSAL_INSUFFICIENT_STOCK' && payload.error?.trim()) {
    return new InvoiceApiError(payload.error.trim(), status, code)
  }
  if (code && DELETE_ERROR_BY_CODE[code]) {
    return new InvoiceApiError(DELETE_ERROR_BY_CODE[code], status, code)
  }
  return new InvoiceApiError(
    payload.error || DELETE_ERROR_BY_CODE.DELETE_FAILED,
    status,
    payload.code || 'DELETE_FAILED',
  )
}

export function mapInvoiceReceiveHttpError(status: number, payload: { error?: string; code?: string }) {
  if (status === 401) {
    return new InvoiceApiError(RECEIVE_ERROR_BY_CODE.UNAUTHENTICATED, 401, payload.code || 'UNAUTHENTICATED')
  }
  const code = payload.code || ''
  if (code && RECEIVE_ERROR_BY_CODE[code]) {
    return new InvoiceApiError(RECEIVE_ERROR_BY_CODE[code], status, code)
  }
  if (status === 409) {
    return new InvoiceApiError(
      RECEIVE_ERROR_BY_CODE.IDEMPOTENCY_CONFLICT,
      409,
      payload.code || 'IDEMPOTENCY_CONFLICT',
    )
  }
  if (status === 422) {
    return new InvoiceApiError(
      payload.error || RECEIVE_ERROR_BY_CODE.INVALID_QUANTITY,
      422,
      payload.code || 'INVALID_QUANTITY',
    )
  }
  return new InvoiceApiError(
    payload.error || RECEIVE_ERROR_BY_CODE.RECEIVE_FAILED,
    status,
    payload.code || 'RECEIVE_FAILED',
  )
}

export function mapInvoiceQueryHttpError(status: number, payload: { error?: string; code?: string }) {
  if (status === 401) {
    return new InvoiceApiError(QUERY_ERROR_BY_CODE.UNAUTHENTICATED, 401, payload.code || 'UNAUTHENTICATED')
  }
  const code = payload.code || ''
  if (code && QUERY_ERROR_BY_CODE[code]) {
    return new InvoiceApiError(QUERY_ERROR_BY_CODE[code], status, code)
  }
  if (status === 404) {
    return new InvoiceApiError(QUERY_ERROR_BY_CODE.NOT_FOUND, 404, payload.code || 'NOT_FOUND')
  }
  return new InvoiceApiError(
    payload.error || 'No se pudieron consultar las facturas.',
    status,
    payload.code || 'LOOKUP_FAILED',
  )
}

function asAnalysis(value: unknown): InvoiceAnalysisApiResult | null {
  if (!value || typeof value !== 'object') return null
  const record = value as InvoiceAnalysisApiResult
  if (!record.document || !record.validation || !record.inventory) return null
  return record
}

function asDetail(value: InvoiceDetail): InvoiceDetail {
  return {
    ...value,
    originalAnalysis: asAnalysis(value.originalAnalysis),
    reviewedAnalysis: asAnalysis(value.reviewedAnalysis),
    commercialDecisions: Array.isArray(value.commercialDecisions) ? value.commercialDecisions : [],
    lines: Array.isArray(value.lines) ? value.lines : [],
  }
}

async function invoiceGet<T>(
  path: string,
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
): Promise<T> {
  const accessToken = await resolveAccessToken(options.accessToken)
  try {
    const response = await (options.fetchImpl ?? fetch)(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const payload = await response.json().catch(() => ({})) as {
      data?: T
      error?: string
      code?: string
    }
    if (!response.ok) throw mapInvoiceQueryHttpError(response.status, payload)
    if (payload.data === undefined) {
      throw new InvoiceApiError('La respuesta de la consulta está incompleta.', 502, 'LOOKUP_FAILED')
    }
    return payload.data
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
  }
}

export async function listInvoices(
  locationId: string,
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
) {
  const trimmed = locationId.trim()
  if (!trimmed) {
    throw new InvoiceApiError('El identificador del local no es válido.', 400, 'LOCATION_ID_INVALID')
  }
  return invoiceGet<InvoiceListItem[]>(invoicesListPath(trimmed), options)
}

export async function listPendingReceptions(
  locationId: string,
  options: {
    cursor?: string | null
    limit?: number
    fetchImpl?: typeof fetch
    accessToken?: string
  } = {},
): Promise<PendingReceptionPage> {
  const trimmed = locationId.trim()
  if (!trimmed) {
    throw new InvoiceApiError('El identificador del local no es válido.', 400, 'LOCATION_ID_INVALID')
  }
  const accessToken = await resolveAccessToken(options.accessToken)
  try {
    const response = await (options.fetchImpl ?? fetch)(`${API_URL}${pendingReceptionsPath(trimmed, options)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const payload = await response.json().catch(() => ({})) as {
      data?: PendingReceptionLine[]
      nextCursor?: string | null
      error?: string
      code?: string
    }
    if (!response.ok) throw mapInvoiceQueryHttpError(response.status, payload)
    if (!Array.isArray(payload.data)) {
      throw new InvoiceApiError('La respuesta de la consulta está incompleta.', 502, 'LOOKUP_FAILED')
    }
    return {
      items: payload.data,
      nextCursor: typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null,
    }
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
  }
}

export function lookupInvoiceDuplicate(
  query: DuplicateLookupQuery,
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
) {
  return invoiceGet<InvoiceDuplicateMatch | null>(buildDuplicateLookupPath(query), options)
}

export async function getInvoice(
  id: string,
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
) {
  const data = await invoiceGet<InvoiceDetail>(`/api/invoices/${encodeURIComponent(id)}`, options)
  return asDetail(data)
}

export function getInvoiceFile(
  id: string,
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
) {
  return invoiceGet<InvoiceFileAccess>(`/api/invoices/${encodeURIComponent(id)}/file`, options)
}

export function listCatalogProducts(
  locationId: string,
  options: { q?: string; fetchImpl?: typeof fetch; accessToken?: string } = {},
) {
  const params = new URLSearchParams({ locationId })
  if (options.q?.trim()) params.set('q', options.q.trim())
  return invoiceGet<InventoryProductOption[]>(
    `/api/invoices/catalog/products?${params.toString()}`,
    options,
  )
}

export function listCatalogMappingMemories(
  locationId: string,
  issuerTaxId?: string | null,
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
) {
  const params = new URLSearchParams({ locationId })
  if (issuerTaxId?.trim()) params.set('issuerTaxId', issuerTaxId.trim())
  return invoiceGet<ConfirmedMappingMemory[]>(
    `/api/invoices/catalog/mapping-memories?${params.toString()}`,
    options,
  )
}

export function listInvoiceProducts(
  invoiceId: string,
  options: { q?: string; fetchImpl?: typeof fetch; accessToken?: string } = {},
) {
  const query = options.q?.trim() ? `?q=${encodeURIComponent(options.q.trim())}` : ''
  return invoiceGet<InventoryProductOption[]>(
    `/api/invoices/${encodeURIComponent(invoiceId)}/products${query}`,
    options,
  )
}

export async function mapInvoiceLine(
  invoiceId: string,
  lineId: string,
  input: { inventoryProductId: string; conversionFactor?: number },
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
): Promise<InvoiceMapResult> {
  const accessToken = await resolveAccessToken(options.accessToken)
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${API_URL}/api/invoices/${encodeURIComponent(invoiceId)}/lines/${encodeURIComponent(lineId)}/map`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inventoryProductId: input.inventoryProductId,
          ...(typeof input.conversionFactor === 'number' ? { conversionFactor: input.conversionFactor } : {}),
        }),
      },
    )
    const payload = await response.json().catch(() => ({})) as {
      data?: InvoiceMapResult
      error?: string
      code?: string
    }
    if (!response.ok) throw mapInvoiceQueryHttpError(response.status, payload)
    if (!payload.data?.id) {
      throw new InvoiceApiError('La respuesta de la vinculación está incompleta.', 502, 'MAP_FAILED')
    }
    return payload.data
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
  }
}

export type ConfirmIntakeApiLine = {
  purchaseDocumentLineId: string
  action: 'link_existing' | 'create' | 'reactivate' | 'pending'
  inventoryProductId?: string | null
  create?: {
    name: string
    baseUnit: string
    category?: string | null
    minimumStock?: number | null
  } | null
  conversionFactor?: number | null
  receiveQuantity?: number | null
  receiveIdempotencyKey?: string | null
}

export type ConfirmIntakeApiResult = {
  purchaseDocumentId: string
  documentStatus: string
  idempotent: boolean
  unmappedLineCount: number
  lines: Array<{
    purchaseDocumentLineId: string
    action: string
    inventoryProductId: string | null
    created: boolean
    reactivated: boolean
    mapped: boolean
    inventoryPhysicalQuantity: number | null
    receive: Record<string, unknown> | null
  }>
}

export async function confirmPurchaseInvoiceIntake(
  invoiceId: string,
  input: {
    organizationId: string
    locationId: string
    confirmIdempotencyKey: string
    lines: ConfirmIntakeApiLine[]
  },
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
): Promise<ConfirmIntakeApiResult> {
  const accessToken = await resolveAccessToken(options.accessToken)
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${API_URL}/api/invoices/${encodeURIComponent(invoiceId)}/confirm-intake`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      },
    )
    const payload = await response.json().catch(() => ({})) as {
      data?: ConfirmIntakeApiResult
      error?: string
      code?: string
    }
    if (!response.ok) {
      throw new InvoiceApiError(
        payload.error || 'No se pudo confirmar la recepción.',
        response.status,
        payload.code || 'CONFIRM_FAILED',
      )
    }
    if (!payload.data?.purchaseDocumentId) {
      throw new InvoiceApiError('La respuesta de confirmación está incompleta.', 502, 'CONFIRM_FAILED')
    }
    return payload.data
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
  }
}

export async function getConfirmRecovery(
  invoiceId: string,
  organizationId: string,
  locationId: string,
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
) {
  const params = new URLSearchParams({ organizationId, locationId })
  return invoiceGet<{ status: 'completed' | 'recoverable' | 'unavailable'; confirmIdempotencyKey: string | null }>(
    `/api/invoices/${encodeURIComponent(invoiceId)}/confirm-recovery?${params.toString()}`,
    options,
  )
}

export async function completeInvoiceSave(
  invoiceId: string,
  input: { organizationId: string; locationId: string },
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
) {
  const accessToken = await resolveAccessToken(options.accessToken)
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${API_URL}/api/invoices/${encodeURIComponent(invoiceId)}/complete-save`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      },
    )
    const payload = await response.json().catch(() => ({})) as {
      data?: ConfirmIntakeApiResult
      error?: string
      code?: string
    }
    if (!response.ok) {
      throw new InvoiceApiError(
        payload.error || 'No se pudo completar el guardado.',
        response.status,
        payload.code || 'CONFIRM_FAILED',
      )
    }
    if (!payload.data?.purchaseDocumentId) {
      throw new InvoiceApiError('La respuesta de confirmación está incompleta.', 502, 'CONFIRM_FAILED')
    }
    return payload.data
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
  }
}

export async function receiveInvoiceLine(
  invoiceId: string,
  lineId: string,
  input: { quantity: number; idempotencyKey: string },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; accessToken?: string } = {},
): Promise<InvoiceReceiveResult> {
  const accessToken = await resolveAccessToken(options.accessToken)
  const timeoutMs = options.timeoutMs ?? INVOICE_RECEIVE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${API_URL}/api/invoices/${encodeURIComponent(invoiceId)}/lines/${encodeURIComponent(lineId)}/receive`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quantity: input.quantity,
          idempotencyKey: input.idempotencyKey,
        }),
        signal: controller.signal,
      },
    )
    const payload = await response.json().catch(() => ({})) as {
      data?: InvoiceReceiveResult
      error?: string
      code?: string
    }
    if (!response.ok) throw mapInvoiceReceiveHttpError(response.status, payload)
    if (!payload.data?.id) {
      throw new InvoiceApiError('La respuesta de la recepción está incompleta.', 502, 'RECEIVE_FAILED')
    }
    return payload.data
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    if (isAbortError(error)) {
      throw new InvoiceApiError(
        'La recepción superó el tiempo de espera.',
        504,
        'RECEIVE_TIMEOUT',
      )
    }
    throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
  } finally {
    clearTimeout(timer)
  }
}

export async function cancelInvoice(
  invoiceId: string,
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
): Promise<InvoiceCancelResult> {
  const accessToken = await resolveAccessToken(options.accessToken)
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${API_URL}/api/invoices/${encodeURIComponent(invoiceId)}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    )
    const payload = await response.json().catch(() => ({})) as {
      data?: InvoiceCancelResult
      error?: string
      code?: string
    }
    if (!response.ok) throw mapInvoiceCancelHttpError(response.status, payload)
    if (!payload.data?.id || payload.data.status !== 'cancelled') {
      throw new InvoiceApiError('La respuesta de la anulación está incompleta.', 502, 'CANCEL_FAILED')
    }
    return payload.data
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
  }
}

export async function deleteInvoice(
  invoiceId: string,
  options: { fetchImpl?: typeof fetch; accessToken?: string } = {},
): Promise<InvoiceDeleteResult> {
  const accessToken = await resolveAccessToken(options.accessToken)
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${API_URL}/api/invoices/${encodeURIComponent(invoiceId)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    )
    const payload = await response.json().catch(() => ({})) as {
      data?: InvoiceDeleteResult
      error?: string
      code?: string
    }
    if (!response.ok) throw mapInvoiceDeleteHttpError(response.status, payload)
    if (!payload.data?.id || payload.data.deleted !== true) {
      throw new InvoiceApiError('La respuesta de la eliminación está incompleta.', 502, 'DELETE_FAILED')
    }
    return payload.data
  } catch (error) {
    if (error instanceof InvoiceApiError) throw error
    throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
  }
}

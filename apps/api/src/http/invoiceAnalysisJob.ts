import type { SupabaseClient } from '@supabase/supabase-js'
import { sha256Hex } from './fileHash.js'
import {
  issueInvoiceIntegrityToken,
  type InvoiceIntegritySigner,
} from './invoiceIntegrity.js'
import { toInvoiceAnalysisApiResult } from './invoiceAnalysisResponse.js'
import {
  type InvoiceAnalysisJobRecord,
  type InvoiceAnalysisJobStatus,
  type InvoiceAnalysisJobStore,
} from './invoiceAnalysisJobStore.js'
import { analyzeExtractedInvoice } from '../modules/invoice-intelligence/analyze.js'
import { inspectInvoiceBuffer } from '../modules/invoice-intelligence/localInvoiceTool.js'
import {
  ExtractionPayloadError,
  assertExtractionPayload,
} from './validateExtraction.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class InvoiceAnalysisJobError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNAUTHENTICATED'
      | 'LOCATION_REQUIRED'
      | 'INVALID_LOCATION'
      | 'LOCATION_LOOKUP_FAILED'
      | 'FORBIDDEN'
      | 'FILE_REQUIRED'
      | 'JOB_NOT_FOUND'
      | 'JOB_STORE_FAILED'
      | 'JOB_BUSY'
      | 'CALLBACK_TOKEN_MISSING'
      | 'CALLBACK_TOKEN_INVALID'
      | 'CALLBACK_TOKEN_EXPIRED'
      | 'CLIENT_DESTINATION'
      | 'RESULT_CONFLICT'
      | 'INVALID_EXTRACTION'
      | 'ANALYSIS_FAILED',
    public readonly status: number,
  ) {
    super(message)
    this.name = 'InvoiceAnalysisJobError'
  }
}

export type InvoiceAnalysisJobPublic = {
  jobId: string
  status: InvoiceAnalysisJobStatus
  locationId: string
  organizationId: string
  result?: unknown
  failureCode?: string
}

const FORBIDDEN_CALLBACK_KEYS = new Set([
  'organizationid',
  'organization_id',
  'locationid',
  'location_id',
  'actoruserid',
  'actor_user_id',
  'actorintegrationid',
  'actor_integration_id',
  'userid',
  'user_id',
])

export async function loadAuthorizedInvoiceLocation(client: SupabaseClient, locationId: string) {
  if (!UUID_RE.test(locationId)) {
    throw new InvoiceAnalysisJobError('Indicá un local válido.', 'INVALID_LOCATION', 400)
  }
  const { data, error } = await client
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) {
    throw new InvoiceAnalysisJobError('No se pudo verificar el local.', 'LOCATION_LOOKUP_FAILED', 500)
  }
  const id = typeof data?.id === 'string' ? data.id : ''
  const organizationId = typeof data?.organization_id === 'string' ? data.organization_id : ''
  if (!UUID_RE.test(id) || id.toLowerCase() !== locationId.toLowerCase() || !UUID_RE.test(organizationId)) {
    throw new InvoiceAnalysisJobError(
      'El local no existe o no pertenece a tu organización.',
      'FORBIDDEN',
      403,
    )
  }
  return { id: id.toLowerCase(), organizationId: organizationId.toLowerCase() }
}

export async function createInvoiceAnalysisJob(input: {
  userId: string | undefined
  userClient: SupabaseClient
  locationId: string
  file: { buffer: Buffer; originalname?: string; mimetype?: string } | undefined
  maxFileBytes: number
  store: InvoiceAnalysisJobStore
}): Promise<{ job: InvoiceAnalysisJobRecord; callbackToken: string | null }> {
  if (!input.userId) {
    throw new InvoiceAnalysisJobError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  if (!input.locationId.trim()) {
    throw new InvoiceAnalysisJobError('Indicá el local.', 'LOCATION_REQUIRED', 400)
  }
  const location = await loadAuthorizedInvoiceLocation(input.userClient, input.locationId.trim())
  if (!input.file?.buffer?.length) {
    throw new InvoiceAnalysisJobError(
      'Adjuntá un único PDF o imagen en el campo file.',
      'FILE_REQUIRED',
      400,
    )
  }
  const inspected = inspectInvoiceBuffer(input.file.buffer, {
    filename: input.file.originalname,
    declaredMimeType: input.file.mimetype,
    maxBytes: input.maxFileBytes,
  })
  try {
    return await input.store.enqueue({
      userId: input.userId,
      organizationId: location.organizationId,
      locationId: location.id,
      fileSha256: sha256Hex(input.file.buffer),
      byteSize: input.file.buffer.length,
      mediaType: inspected.mimeType,
      bytes: input.file.buffer,
    })
  } catch (error) {
    if (error instanceof InvoiceAnalysisJobError) throw error
    throw new InvoiceAnalysisJobError(
      'No se pudo guardar el trabajo de análisis.',
      'JOB_STORE_FAILED',
      500,
    )
  }
}

export async function readInvoiceAnalysisJob(input: {
  userId: string | undefined
  userClient: SupabaseClient
  jobId: string
  store: InvoiceAnalysisJobStore
}): Promise<InvoiceAnalysisJobPublic> {
  if (!input.userId) {
    throw new InvoiceAnalysisJobError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  let record: InvoiceAnalysisJobRecord | null
  try {
    record = await input.store.getForUser(input.jobId, input.userId)
  } catch {
    throw new InvoiceAnalysisJobError(
      'No se pudo consultar el trabajo de análisis.',
      'JOB_STORE_FAILED',
      500,
    )
  }
  if (!record) {
    throw new InvoiceAnalysisJobError('Trabajo no encontrado.', 'JOB_NOT_FOUND', 404)
  }
  const location = await loadAuthorizedInvoiceLocation(input.userClient, record.locationId)
  if (location.organizationId !== record.organizationId || location.id !== record.locationId) {
    throw new InvoiceAnalysisJobError('No autorizado.', 'FORBIDDEN', 403)
  }
  const visible: InvoiceAnalysisJobPublic = {
    jobId: record.id,
    status: record.status,
    locationId: record.locationId,
    organizationId: record.organizationId,
  }
  if (record.status === 'ready') {
    const result = await input.store.readResult(record.id)
    if (!isRecord(result)) {
      throw new InvoiceAnalysisJobError(
        'No se pudo consultar el trabajo de análisis.',
        'JOB_STORE_FAILED',
        500,
      )
    }
    visible.result = result
  } else if (record.status === 'failed' && record.failureCode) {
    visible.failureCode = record.failureCode
  }
  return visible
}

export async function submitInvoiceAnalysisResult(input: {
  jobId: string
  authorizationHeader: string | undefined
  body: unknown
  store: InvoiceAnalysisJobStore
  integrity: InvoiceIntegritySigner | null
}) {
  const token = callbackTokenFromHeader(input.authorizationHeader)
  if (containsForbiddenCallbackKey(input.body)) {
    throw new InvoiceAnalysisJobError(
      'La devolución no puede indicar organización, sucursal ni actor.',
      'CLIENT_DESTINATION',
      400,
    )
  }
  const extractionSha256 = sha256Hex(Buffer.from(canonicalJson(input.body), 'utf8'))
  let outcome
  try {
    outcome = await input.store.finish({
      jobId: input.jobId,
      token,
      extractionSha256,
      produce: async (job) => {
        try {
          assertExtractionPayload(input.body)
          const analysis = analyzeExtractedInvoice(input.body, {
            provider: 'external',
            model: 'n8n',
          })
          const unsigned = toInvoiceAnalysisApiResult(analysis, { fileSha256: job.fileSha256 })
          if (!input.integrity?.secret) return { result: unsigned }
          const signed = issueInvoiceIntegrityToken({
            userId: job.userId,
            fileSha256: job.fileSha256,
            snapshot: unsigned,
            secret: input.integrity.secret,
            ttlSeconds: input.integrity.ttlSeconds,
            now: input.integrity.now?.(),
          })
          return {
            result: toInvoiceAnalysisApiResult(analysis, {
              fileSha256: job.fileSha256,
              integrity: {
                token: signed.token,
                snapshotSha256: signed.snapshotSha256,
                expiresAt: signed.expiresAt,
              },
            }),
          }
        } catch (error) {
          if (error instanceof ExtractionPayloadError || error instanceof TypeError) {
            return { failureCode: 'INVALID_EXTRACTION' as const }
          }
          return { failureCode: 'ANALYSIS_FAILED' as const }
        }
      },
    })
  } catch (error) {
    if (error instanceof InvoiceAnalysisJobError) throw error
    if (error instanceof Error && error.message === 'JOB_LOCK_TIMEOUT') {
      throw new InvoiceAnalysisJobError('El trabajo está siendo actualizado.', 'JOB_BUSY', 503)
    }
    throw new InvoiceAnalysisJobError(
      'No se pudo guardar el resultado del análisis.',
      'JOB_STORE_FAILED',
      500,
    )
  }

  if (outcome.kind === 'not_found') {
    throw new InvoiceAnalysisJobError('Trabajo no encontrado.', 'JOB_NOT_FOUND', 404)
  }
  if (outcome.kind === 'invalid_token') {
    throw new InvoiceAnalysisJobError('Credencial inválida.', 'CALLBACK_TOKEN_INVALID', 401)
  }
  if (outcome.kind === 'expired') {
    throw new InvoiceAnalysisJobError('La credencial del trabajo venció.', 'CALLBACK_TOKEN_EXPIRED', 401)
  }
  if (outcome.kind === 'conflict') {
    throw new InvoiceAnalysisJobError(
      'El trabajo ya tiene otro resultado.',
      'RESULT_CONFLICT',
      409,
    )
  }
  if (outcome.job.status === 'failed') {
    const code = outcome.job.failureCode === 'INVALID_EXTRACTION' ? 'INVALID_EXTRACTION' : 'ANALYSIS_FAILED'
    throw new InvoiceAnalysisJobError(
      code === 'INVALID_EXTRACTION'
        ? 'La extracción no tiene una estructura utilizable.'
        : 'No se pudo procesar la extracción.',
      code,
      422,
    )
  }
  return {
    jobId: outcome.job.id,
    status: outcome.job.status,
  }
}

function callbackTokenFromHeader(header: string | undefined) {
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(header) : null
  if (!match) {
    throw new InvoiceAnalysisJobError('Credencial inválida.', 'CALLBACK_TOKEN_MISSING', 401)
  }
  return match[1]
}

function containsForbiddenCallbackKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenCallbackKey)
  if (!isRecord(value)) return false
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CALLBACK_KEYS.has(key.toLowerCase())) return true
    if (containsForbiddenCallbackKey(nested)) return true
  }
  return false
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const body = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')
  return `{${body}}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

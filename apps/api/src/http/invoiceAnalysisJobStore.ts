import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from './fileHash.js'

/**
 * Persistencia local de un solo proceso.
 * El directorio sobrevive a un reinicio de la API. No se comparte entre máquinas.
 * Dos procesos sobre la misma carpeta pueden crear dos trabajos para el mismo archivo.
 * La limpieza ocurre en el próximo alta o consulta; no hay un temporizador en segundo plano.
 * Un corte durante el renombrado puede dejar un .tmp, que la limpieza siguiente borra.
 */
export const INVOICE_ANALYSIS_JOB_TTL_MS = 24 * 60 * 60 * 1000
/** Un reclamo en curso usa la misma forma queued+unknown, como máximo el timeout del webhook. */
export const STALE_UNKNOWN_DISPATCH_MS = 150_000
/** Una lectura en curso se reutiliza durante esta ventana. Después no bloquea otra carga. */
export const ANALYSIS_JOB_ACTIVE_WINDOW_MS = 15 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const USER_RE = /^[A-Za-z0-9_-]{1,128}$/
const SHA_RE = /^[a-f0-9]{64}$/
const STATUSES = new Set(['queued', 'processing', 'ready', 'failed'])
const MEDIA_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])

export type InvoiceAnalysisJobStatus = 'queued' | 'processing' | 'ready' | 'failed'

export type InvoiceAnalysisJobFailureCode = 'INVALID_EXTRACTION' | 'ANALYSIS_FAILED' | 'DISPATCH_REJECTED'

export type InvoiceAnalysisJobDelivery = 'not_sent' | 'unknown' | 'accepted' | 'rejected'

export type InvoiceAnalysisJobRecord = {
  id: string
  userId: string
  organizationId: string
  locationId: string
  fileSha256: string
  byteSize: number
  mediaType: string
  status: InvoiceAnalysisJobStatus
  createdAt: string
  updatedAt: string
  expiresAt: string
  callbackTokenHash: string
  callbackTokenExpiresAt: string
  extractionSha256: string | null
  failureCode: InvoiceAnalysisJobFailureCode | null
  delivery: InvoiceAnalysisJobDelivery
}

export type InvoiceAnalysisJobFinish =
  | { kind: 'not_found' }
  | { kind: 'invalid_token' }
  | { kind: 'expired' }
  | { kind: 'conflict' }
  | { kind: 'replay'; job: InvoiceAnalysisJobRecord }
  | { kind: 'completed'; job: InvoiceAnalysisJobRecord }

export type InvoiceAnalysisJobStore = {
  enqueue(input: {
    userId: string
    organizationId: string
    locationId: string
    fileSha256: string
    byteSize: number
    mediaType: string
    bytes: Buffer
  }): Promise<{ job: InvoiceAnalysisJobRecord; callbackToken: string | null }>
  getForUser(id: string, userId: string): Promise<InvoiceAnalysisJobRecord | null>
  readResult(jobId: string): Promise<unknown | null>
  readDocument(jobId: string): Promise<{ bytes: Buffer; mediaType: string } | null>
  claimDispatch(jobId: string): Promise<'claimed' | 'skipped' | 'not_found'>
  settleDispatch(
    jobId: string,
    outcome: 'accepted' | 'rejected' | 'uncertain' | 'unsent',
  ): Promise<InvoiceAnalysisJobRecord | null>
  /**
   * Reabre un envío que no salió. Rota el token y reclama el intento en el mismo paso.
   * No actúa si el envío anterior pudo haber llegado.
   */
  resumeUnsentDispatch(jobId: string): Promise<{ token: string; job: InvoiceAnalysisJobRecord } | null>
  /** Nuevo token para el mismo trabajo. No envía el archivo ni cambia un resultado listo. */
  replaceCallbackToken(jobId: string): Promise<{ token: string; job: InvoiceAnalysisJobRecord } | null>
  finish(input: {
    jobId: string
    token: string
    extractionSha256: string
    produce: (job: InvoiceAnalysisJobRecord) => Promise<
      | { result: unknown }
      | { failureCode: InvoiceAnalysisJobFailureCode }
    >
  }): Promise<InvoiceAnalysisJobFinish>
}

type StoreOptions = {
  directory: string
  now?: () => Date
  ttlMs?: number
  callbackTokenTtlMs?: number
}

export function defaultInvoiceAnalysisJobsDirectory(): string {
  const configured = process.env.INVOICE_ANALYSIS_JOBS_DIR?.trim()
  if (configured) return path.resolve(configured)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.local/invoice-analysis-jobs')
}

export function createFileInvoiceAnalysisJobStore(options: StoreOptions): InvoiceAnalysisJobStore {
  const root = path.resolve(options.directory)
  const now = options.now ?? (() => new Date())
  const ttlMs = options.ttlMs ?? INVOICE_ANALYSIS_JOB_TTL_MS
  const callbackTokenTtlMs = options.callbackTokenTtlMs ?? ttlMs
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(callbackTokenTtlMs) || callbackTokenTtlMs <= 0) {
    throw new Error('JOB_TTL_INVALID')
  }

  return {
    async enqueue(input) {
      const userId = normalizeUserId(input.userId)
      assertIdentity(userId, input.organizationId, input.locationId, input.fileSha256)
      if (!MEDIA_TYPES.has(input.mediaType)) throw new Error('JOB_MEDIA_INVALID')
      if (!Buffer.isBuffer(input.bytes) || input.bytes.length !== input.byteSize || input.byteSize <= 0) {
        throw new Error('JOB_BYTES_INVALID')
      }
      const identity = { ...input, userId }
      await purgeExpired(root, now())
      const current = await readInProgress(root, identity, now())
      if (current) {
        const job = await promoteSettledUnknown(root, current, now())
        return { job, callbackToken: null }
      }

      const createdAt = now().toISOString()
      const callbackToken = randomBytes(32).toString('base64url')
      const record: InvoiceAnalysisJobRecord = {
        id: randomUUID(),
        userId,
        organizationId: input.organizationId.toLowerCase(),
        locationId: input.locationId.toLowerCase(),
        fileSha256: input.fileSha256,
        byteSize: input.byteSize,
        mediaType: input.mediaType,
        status: 'queued',
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
        callbackTokenHash: hashCallbackToken(callbackToken),
        callbackTokenExpiresAt: new Date(now().getTime() + Math.min(callbackTokenTtlMs, ttlMs)).toISOString(),
        extractionSha256: null,
        failureCode: null,
        delivery: 'not_sent',
      }
      await writeJob(root, record, input.bytes)
      const winner = await claimIndex(root, record)
      if (winner.id !== record.id) {
        await removeJob(root, record.id)
        return { job: winner, callbackToken: null }
      }
      return { job: record, callbackToken }
    },

    async getForUser(id, userId) {
      const owner = normalizeUserId(userId)
      if (!isUuid(id) || !USER_RE.test(owner)) return null
      await purgeExpired(root, now())
      const record = await readJob(root, id)
      if (!record || record.userId !== owner) return null
      if (Date.parse(record.expiresAt) <= now().getTime()) return null
      if (!(await isRegularFile(documentPath(root, record.id)))) return null
      return promoteSettledUnknown(root, record, now())
    },

    async readResult(jobId) {
      if (!isUuid(jobId)) return null
      return readResultFile(root, jobId)
    },

    async readDocument(jobId) {
      if (!isUuid(jobId)) return null
      const record = await readJob(root, jobId)
      if (!record) return null
      try {
        const bytes = await readFile(documentPath(root, jobId))
        return { bytes, mediaType: record.mediaType }
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return null
        throw error
      }
    },

    async claimDispatch(jobId) {
      if (!isUuid(jobId)) return 'not_found'
      return withJobLock(root, jobId, async () => {
        const current = await readJob(root, jobId)
        if (!current) return 'not_found' as const
        if (current.status !== 'queued' || current.delivery !== 'not_sent') return 'skipped' as const
        await writeMetadata(root, {
          ...current,
          delivery: 'unknown',
          updatedAt: now().toISOString(),
        })
        return 'claimed' as const
      })
    },

    async settleDispatch(jobId, outcome) {
      if (!isUuid(jobId)) return null
      return withJobLock(root, jobId, async () => {
        const current = await readJob(root, jobId)
        if (!current) return null
        const updatedAt = now().toISOString()
        const ownsAttempt = current.status === 'queued' && current.delivery === 'unknown'
        if (!ownsAttempt) {
          if (
            outcome === 'accepted'
            && current.delivery === 'unknown'
            && (current.status === 'ready' || current.status === 'failed' || current.status === 'processing')
          ) {
            const next: InvoiceAnalysisJobRecord = { ...current, delivery: 'accepted', updatedAt }
            await writeMetadata(root, next)
            return next
          }
          return current
        }
        if (outcome === 'accepted') {
          const next: InvoiceAnalysisJobRecord = {
            ...current,
            status: 'processing',
            delivery: 'accepted',
            updatedAt,
          }
          await writeMetadata(root, next)
          return next
        }
        if (outcome === 'rejected') {
          const next: InvoiceAnalysisJobRecord = {
            ...current,
            status: 'failed',
            delivery: 'rejected',
            failureCode: 'DISPATCH_REJECTED',
            updatedAt,
          }
          await writeMetadata(root, next)
          return next
        }
        if (outcome === 'unsent') {
          if (!ownsAttempt) return current
          const next: InvoiceAnalysisJobRecord = {
            ...current,
            status: 'queued',
            delivery: 'not_sent',
            updatedAt,
          }
          await writeMetadata(root, next)
          return next
        }
        if (current.status === 'ready' || current.status === 'failed') return current
        if (!ownsAttempt) return current
        const next: InvoiceAnalysisJobRecord = {
          ...current,
          status: 'processing',
          delivery: 'unknown',
          updatedAt,
        }
        await writeMetadata(root, next)
        return next
      })
    },

    async resumeUnsentDispatch(jobId) {
      if (!isUuid(jobId)) return null
      return withJobLock(root, jobId, async () => {
        const current = await readJob(root, jobId)
        if (!current || current.status !== 'queued' || current.delivery !== 'not_sent') return null
        if (Date.parse(current.expiresAt) <= now().getTime()) return null
        const token = randomBytes(32).toString('base64url')
        const updatedAt = now().toISOString()
        const claimed: InvoiceAnalysisJobRecord = {
          ...current,
          delivery: 'unknown',
          callbackTokenHash: hashCallbackToken(token),
          callbackTokenExpiresAt: new Date(now().getTime() + Math.min(callbackTokenTtlMs, ttlMs)).toISOString(),
          updatedAt,
        }
        await writeMetadata(root, claimed)
        return { token, job: claimed }
      })
    },

    async replaceCallbackToken(jobId) {
      if (!isUuid(jobId)) return null
      return withJobLock(root, jobId, async () => {
        const current = await readJob(root, jobId)
        if (!current || current.status === 'ready' || current.status === 'failed') return null
        if (current.delivery === 'unknown') return null
        const token = randomBytes(32).toString('base64url')
        const updatedAt = now().toISOString()
        const next: InvoiceAnalysisJobRecord = {
          ...current,
          status: 'queued',
          delivery: 'not_sent',
          callbackTokenHash: hashCallbackToken(token),
          callbackTokenExpiresAt: new Date(now().getTime() + Math.min(callbackTokenTtlMs, ttlMs)).toISOString(),
          updatedAt,
        }
        await writeMetadata(root, next)
        return { token, job: next }
      })
    },

    async finish(input) {
      if (!isUuid(input.jobId)) {
        hashCallbackToken(input.token)
        return { kind: 'not_found' }
      }
      return withJobLock(root, input.jobId, async () => {
        const current = await readJob(root, input.jobId)
        const tokenMatches = callbackTokenMatches(current?.callbackTokenHash ?? DUMMY_TOKEN_HASH, input.token)
        if (!current || !(await isRegularFile(documentPath(root, current.id)))) {
          return { kind: 'not_found' }
        }
        if (!tokenMatches) return { kind: 'invalid_token' }
        if (Date.parse(current.callbackTokenExpiresAt) <= now().getTime()) return { kind: 'expired' }
        if (current.status === 'ready') {
          if (current.extractionSha256 === input.extractionSha256) {
            return { kind: 'replay', job: current }
          }
          return { kind: 'conflict' }
        }
        if (current.status === 'failed' && current.extractionSha256 === input.extractionSha256) {
          return { kind: 'replay', job: current }
        }

        const produced = await input.produce(current)
        const updatedAt = now().toISOString()
        if ('failureCode' in produced) {
          const failed: InvoiceAnalysisJobRecord = {
            ...current,
            status: 'failed',
            updatedAt,
            extractionSha256: input.extractionSha256,
            failureCode: produced.failureCode,
          }
          await rm(resultPath(root, current.id), { force: true })
          await writeAtomic(metadataPath(root, current.id), `${JSON.stringify(toMetadata(failed))}\n`)
          return { kind: 'completed', job: failed }
        }

        const ready: InvoiceAnalysisJobRecord = {
          ...current,
          status: 'ready',
          updatedAt,
          extractionSha256: input.extractionSha256,
          failureCode: null,
        }
        await writeAtomic(resultPath(root, current.id), `${JSON.stringify(produced.result)}\n`)
        await writeAtomic(metadataPath(root, current.id), `${JSON.stringify(toMetadata(ready))}\n`)
        return { kind: 'completed', job: ready }
      })
    },
  }
}

function assertIdentity(userId: string, organizationId: string, locationId: string, fileSha256: string) {
  if (!USER_RE.test(userId) || !isUuid(organizationId) || !isUuid(locationId) || !SHA_RE.test(fileSha256)) {
    throw new Error('JOB_IDENTITY_INVALID')
  }
}

async function readInProgress(
  root: string,
  input: { userId: string; organizationId: string; locationId: string; fileSha256: string },
  now: Date,
): Promise<InvoiceAnalysisJobRecord | null> {
  const pointed = await readIndex(indexPath(root, input.userId, input.locationId, input.fileSha256))
  if (!pointed) return null
  const record = await readJob(root, pointed)
  if (!record || !sameWork(record, input) || !isInProgress(record, now)) return null
  if (!(await isRegularFile(documentPath(root, record.id)))) return null
  return record
}

async function claimIndex(root: string, record: InvoiceAnalysisJobRecord): Promise<InvoiceAnalysisJobRecord> {
  const index = indexPath(root, record.userId, record.locationId, record.fileSha256)
  await mkdir(path.dirname(index), { recursive: true, mode: 0o700 })
  try {
    await writeFile(index, `${record.id}\n`, { flag: 'wx', mode: 0o600 })
    return record
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
  }
  const pointed = await readIndex(index)
  const current = pointed ? await readJob(root, pointed) : null
  if (current && sameWork(current, record) && isInProgress(current, new Date(record.createdAt))) {
    return current
  }
  await writeAtomic(index, `${record.id}\n`)
  return record
}

async function writeJob(root: string, record: InvoiceAnalysisJobRecord, bytes: Buffer) {
  const directory = jobDirectory(root, record.id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeAtomic(documentPath(root, record.id), bytes)
  await writeAtomic(metadataPath(root, record.id), `${JSON.stringify(toMetadata(record))}\n`)
}

function toMetadata(record: InvoiceAnalysisJobRecord) {
  return {
    v: 1,
    id: record.id,
    userId: record.userId,
    organizationId: record.organizationId,
    locationId: record.locationId,
    fileSha256: record.fileSha256,
    byteSize: record.byteSize,
    mediaType: record.mediaType,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    callbackTokenHash: record.callbackTokenHash,
    callbackTokenExpiresAt: record.callbackTokenExpiresAt,
    extractionSha256: record.extractionSha256,
    failureCode: record.failureCode,
    delivery: record.delivery,
  }
}

async function writeMetadata(root: string, record: InvoiceAnalysisJobRecord) {
  await writeAtomic(metadataPath(root, record.id), `${JSON.stringify(toMetadata(record))}\n`)
}

async function purgeExpired(root: string, now: Date) {
  const jobsRoot = path.join(root, 'jobs')
  let entries
  try {
    entries = await readdir(jobsRoot, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isUuid(entry.name)) continue
    const directory = jobDirectory(root, entry.name)
    const record = await readJob(root, entry.name)
    if (!record) {
      await rm(directory, { recursive: true, force: true })
      continue
    }
    await removeTemporaryFiles(directory)
    if (Date.parse(record.expiresAt) > now.getTime()) continue
    await removeIndexIfPointsAt(root, record)
    await rm(directory, { recursive: true, force: true })
  }
}

async function removeTemporaryFiles(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.tmp')) continue
    await rm(path.join(directory, entry.name), { force: true })
  }
}

async function removeIndexIfPointsAt(root: string, record: InvoiceAnalysisJobRecord) {
  const index = indexPath(root, record.userId, record.locationId, record.fileSha256)
  const pointed = await readIndex(index)
  if (pointed !== record.id) return
  await rm(index, { force: true })
}

async function removeJob(root: string, id: string) {
  if (!isUuid(id)) return
  await rm(jobDirectory(root, id), { recursive: true, force: true })
}

async function readJob(root: string, id: string): Promise<InvoiceAnalysisJobRecord | null> {
  if (!isUuid(id)) return null
  let raw: string
  try {
    raw = await readFile(metadataPath(root, id), 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
  return parseRecord(raw)
}

function parseRecord(raw: string): InvoiceAnalysisJobRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const id = parsed.id
  const userId = parsed.userId
  const organizationId = parsed.organizationId
  const locationId = parsed.locationId
  const fileSha256 = parsed.fileSha256
  const byteSize = parsed.byteSize
  const mediaType = parsed.mediaType
  const status = parsed.status
  const createdAt = parsed.createdAt
  const updatedAt = parsed.updatedAt
  const expiresAt = parsed.expiresAt
  const callbackTokenHash = parsed.callbackTokenHash
  const callbackTokenExpiresAt = parsed.callbackTokenExpiresAt
  const extractionSha256 = parsed.extractionSha256
  const failureCode = parsed.failureCode
  const delivery = parsed.delivery
  if (
    typeof id !== 'string' || !isUuid(id)
    || typeof userId !== 'string' || !USER_RE.test(userId)
    || typeof organizationId !== 'string' || !isUuid(organizationId)
    || typeof locationId !== 'string' || !isUuid(locationId)
    || typeof fileSha256 !== 'string' || !SHA_RE.test(fileSha256)
    || typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize <= 0
    || typeof mediaType !== 'string' || !MEDIA_TYPES.has(mediaType)
    || typeof status !== 'string' || !STATUSES.has(status)
    || typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))
    || typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))
    || typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))
    || typeof callbackTokenHash !== 'string' || !SHA_RE.test(callbackTokenHash)
    || typeof callbackTokenExpiresAt !== 'string' || Number.isNaN(Date.parse(callbackTokenExpiresAt))
    || !(extractionSha256 === null || (typeof extractionSha256 === 'string' && SHA_RE.test(extractionSha256)))
    || !(failureCode === null || failureCode === 'INVALID_EXTRACTION' || failureCode === 'ANALYSIS_FAILED' || failureCode === 'DISPATCH_REJECTED')
    || !(delivery === 'not_sent' || delivery === 'unknown' || delivery === 'accepted' || delivery === 'rejected')
  ) {
    return null
  }
  return {
    id: id.toLowerCase(),
    userId,
    organizationId: organizationId.toLowerCase(),
    locationId: locationId.toLowerCase(),
    fileSha256,
    byteSize,
    mediaType,
    status: status as InvoiceAnalysisJobStatus,
    createdAt,
    updatedAt,
    expiresAt,
    callbackTokenHash,
    callbackTokenExpiresAt,
    extractionSha256,
    failureCode,
    delivery,
  }
}

function sameWork(
  record: InvoiceAnalysisJobRecord,
  input: { userId: string; organizationId: string; locationId: string; fileSha256: string },
) {
  return record.userId === input.userId
    && record.organizationId === input.organizationId.toLowerCase()
    && record.locationId === input.locationId.toLowerCase()
    && record.fileSha256 === input.fileSha256
}

function isInProgress(record: InvoiceAnalysisJobRecord, now: Date) {
  return jobStillBlocksUpload(record, now)
}

function jobStillBlocksUpload(record: InvoiceAnalysisJobRecord, now: Date) {
  if (record.status !== 'queued' && record.status !== 'processing') return false
  if (Date.parse(record.expiresAt) <= now.getTime()) return false
  if (record.delivery === 'rejected') return false
  const age = now.getTime() - Date.parse(record.createdAt)
  if (!Number.isFinite(age) || age >= ANALYSIS_JOB_ACTIVE_WINDOW_MS) return false
  return true
}

async function promoteSettledUnknown(
  root: string,
  record: InvoiceAnalysisJobRecord,
  now: Date,
): Promise<InvoiceAnalysisJobRecord> {
  if (!isStaleUnknown(record, now)) return record
  return withJobLock(root, record.id, async () => {
    const current = await readJob(root, record.id)
    if (!current || !isStaleUnknown(current, now)) return current ?? record
    const next: InvoiceAnalysisJobRecord = {
      ...current,
      status: 'processing',
      updatedAt: now.toISOString(),
    }
    await writeMetadata(root, next)
    return next
  })
}

function isStaleUnknown(record: InvoiceAnalysisJobRecord, now: Date) {
  return record.status === 'queued'
    && record.delivery === 'unknown'
    && now.getTime() - Date.parse(record.updatedAt) >= STALE_UNKNOWN_DISPATCH_MS
}

async function readIndex(file: string): Promise<string | null> {
  try {
    const value = (await readFile(file, 'utf8')).trim().toLowerCase()
    return isUuid(value) ? value : null
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

async function writeAtomic(file: string, data: Buffer | string) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { mode: 0o600 })
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function isRegularFile(file: string) {
  try {
    const stats = await lstat(file)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function jobDirectory(root: string, id: string) {
  return inside(root, 'jobs', id.toLowerCase())
}

function metadataPath(root: string, id: string) {
  return inside(root, 'jobs', id.toLowerCase(), 'job.json')
}

function documentPath(root: string, id: string) {
  return inside(root, 'jobs', id.toLowerCase(), 'document.bin')
}

function indexPath(root: string, userId: string, locationId: string, fileSha256: string) {
  return inside(root, 'index', userId, locationId.toLowerCase(), fileSha256)
}

function inside(root: string, ...parts: string[]) {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...parts)
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('JOB_PATH_ESCAPE')
  }
  return target
}

const DUMMY_TOKEN_HASH = '00'.repeat(32)

function hashCallbackToken(token: string) {
  return sha256Hex(Buffer.from(token, 'utf8'))
}

function callbackTokenMatches(storedHash: string, token: string) {
  const computed = hashCallbackToken(token)
  const stored = decodeHex(storedHash)
  const actual = decodeHex(computed)
  const left = stored.length === 32 ? stored : Buffer.alloc(32)
  const right = actual.length === 32 ? actual : Buffer.alloc(32)
  const equal = timingSafeEqual(left, right)
  return stored.length === 32 && actual.length === 32 && equal
}

function decodeHex(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return Buffer.alloc(0)
  return Buffer.from(value, 'hex')
}

async function withJobLock<T>(root: string, id: string, body: () => Promise<T>): Promise<T> {
  const lock = inside(root, 'jobs', id.toLowerCase(), 'result.lock')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await writeFile(lock, '1', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOENT')) throw error
      if (isNodeError(error, 'ENOENT')) return body()
      await delay(5)
      continue
    }
    try {
      return await body()
    } finally {
      await rm(lock, { force: true })
    }
  }
  throw new Error('JOB_LOCK_TIMEOUT')
}

async function readResultFile(root: string, id: string): Promise<unknown | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resultPath(root, id), 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

function resultPath(root: string, id: string) {
  return inside(root, 'jobs', id.toLowerCase(), 'result.json')
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeUserId(userId: string) {
  return isUuid(userId) ? userId.toLowerCase() : userId
}

function isUuid(value: string) {
  return UUID_RE.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

import { isIP } from 'node:net'
import { MAX_LOCAL_INVOICE_BYTES } from '../modules/invoice-intelligence/localInvoiceTool.js'
import type { InvoiceAnalysisJobRecord, InvoiceAnalysisJobStore } from './invoiceAnalysisJobStore.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000
const MIN_SECRET_LENGTH = 16
const MAX_SECRET_LENGTH = 256

export type N8nInvoiceWebhookConfig = {
  url: string
  secret: string
  timeoutMs: number
  maxBytes: number
  fetchImpl?: typeof fetch
}

export type InvoiceAnalysisDispatchResult = {
  kind: 'not_configured' | 'invalid_url' | 'not_found' | 'skipped' | 'accepted' | 'rejected' | 'unknown' | 'unavailable'
  job: InvoiceAnalysisJobRecord | null
}

const TRANSPORT_ATTEMPTS = 2
const TRANSPORT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
])
const AMBIGUOUS_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])
const SAFE_ERROR_NAMES = new Set(['TimeoutError', 'AbortError', 'TypeError', 'Error', 'DOMException'])

export function parseN8nWebhookUrl(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash) return null
  if (url.port && url.port !== '443') return null
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || host.endsWith('.')) return null
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
  ) return null
  if (isIP(host) || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return null
  return url
}

export function n8nInvoiceWebhookFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): N8nInvoiceWebhookConfig | null {
  const url = env.N8N_INVOICE_WEBHOOK_URL?.trim() ?? ''
  const secret = env.N8N_INVOICE_WEBHOOK_SECRET?.trim() ?? ''
  if (!url || !secret || !parseN8nWebhookUrl(url) || !isWebhookSecret(secret)) return null
  const timeoutRaw = env.N8N_INVOICE_WEBHOOK_TIMEOUT_MS?.trim()
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) return null
  return {
    url,
    secret,
    timeoutMs,
    maxBytes: MAX_LOCAL_INVOICE_BYTES,
  }
}

export function dispatchFailureName(error: unknown): string {
  return sanitizedErrorName(error)
}

export async function dispatchInvoiceAnalysisJob(input: {
  store: InvoiceAnalysisJobStore
  jobId: string
  callbackToken: string
  webhook: N8nInvoiceWebhookConfig | null
  alreadyClaimed?: boolean
}): Promise<InvoiceAnalysisDispatchResult> {
  if (!input.webhook) return { kind: 'not_configured', job: null }
  const url = parseN8nWebhookUrl(input.webhook.url)
  if (!url || !isWebhookSecret(input.webhook.secret)) return { kind: 'invalid_url', job: null }

  const document = await input.store.readDocument(input.jobId)
  if (!document) return { kind: 'not_found', job: null }
  const timeoutMs = input.webhook.timeoutMs
  const maxBytes = input.webhook.maxBytes
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return { kind: 'invalid_url', job: null }
  }
  let claimed = input.alreadyClaimed === true
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || document.bytes.length > maxBytes) {
    if (!claimed) {
      const claim = await input.store.claimDispatch(input.jobId)
      if (claim !== 'claimed') return { kind: claim === 'not_found' ? 'not_found' : 'skipped', job: null }
    }
    const job = await input.store.settleDispatch(input.jobId, 'rejected')
    logDispatch('WEBHOOK_PAYLOAD_TOO_LARGE')
    return { kind: 'rejected', job }
  }

  for (let attempt = 0; attempt < TRANSPORT_ATTEMPTS; attempt += 1) {
    if (!claimed) {
      const claim = await input.store.claimDispatch(input.jobId)
      if (claim !== 'claimed') return { kind: claim === 'not_found' ? 'not_found' : 'skipped', job: null }
    }
    claimed = false

    const form = new FormData()
    form.set('jobId', input.jobId)
    form.set('callbackToken', input.callbackToken)
    form.set(
      'file',
      new Blob([Uint8Array.from(document.bytes)], { type: document.mediaType }),
      filenameFor(document.mediaType),
    )

    let response: Response
    try {
      response = await (input.webhook.fetchImpl ?? fetch)(url.toString(), {
        method: 'POST',
        headers: { authorization: `Bearer ${input.webhook.secret}` },
        body: form,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const failure = classifyDispatchFailure(error)
      if (failure.kind === 'transport' && attempt + 1 < TRANSPORT_ATTEMPTS) {
        await input.store.settleDispatch(input.jobId, 'unsent')
        logDispatch('WEBHOOK_TRANSPORT', failure)
        continue
      }
      if (failure.kind === 'transport') {
        const job = await input.store.settleDispatch(input.jobId, 'unsent')
        logDispatch('WEBHOOK_TRANSPORT', failure)
        return { kind: 'unavailable', job }
      }
      const job = await input.store.settleDispatch(input.jobId, 'uncertain')
      logDispatch(failure.kind === 'timeout' ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_UNAVAILABLE', failure)
      return { kind: 'unknown', job }
    }

    if (!response || typeof response.status !== 'number') {
      const job = await input.store.settleDispatch(input.jobId, 'uncertain')
      logDispatch('WEBHOOK_UNAVAILABLE')
      return { kind: 'unknown', job }
    }
    await response.body?.cancel().catch(() => undefined)
    if (response.status >= 200 && response.status < 300) {
      const job = await input.store.settleDispatch(input.jobId, 'accepted')
      return { kind: 'accepted', job }
    }
    if (response.status >= 300 && response.status < 500) {
      const job = await input.store.settleDispatch(input.jobId, 'rejected')
      logDispatch('WEBHOOK_REJECTED', { status: response.status })
      return { kind: 'rejected', job }
    }
    const job = await input.store.settleDispatch(input.jobId, 'uncertain')
    logDispatch('WEBHOOK_UNAVAILABLE', { status: response.status })
    return { kind: 'unknown', job }
  }

  return { kind: 'unavailable', job: null }
}

function isWebhookSecret(secret: string) {
  return secret.length >= MIN_SECRET_LENGTH && secret.length <= MAX_SECRET_LENGTH && !/\s/.test(secret)
}

function filenameFor(mediaType: string) {
  if (mediaType === 'image/jpeg') return 'document.jpg'
  if (mediaType === 'image/png') return 'document.png'
  if (mediaType === 'image/webp') return 'document.webp'
  return 'document.pdf'
}

function classifyDispatchFailure(error: unknown): { kind: 'timeout' | 'transport' | 'ambiguous'; error: string; cause?: string } {
  const errorName = sanitizedErrorName(error)
  const cause = readCauseCode(error)
  if (
    errorName === 'TimeoutError'
    || cause === 'UND_ERR_HEADERS_TIMEOUT'
    || cause === 'UND_ERR_BODY_TIMEOUT'
    || (errorName === 'AbortError' && errorMentionsTimeout(error))
  ) {
    return { kind: 'timeout', error: errorName, cause }
  }
  if (cause && TRANSPORT_CODES.has(cause)) return { kind: 'transport', error: errorName, cause }
  return { kind: 'ambiguous', error: errorName, cause }
}

function sanitizedErrorName(error: unknown): string {
  const name = typeof error === 'object' && error && 'name' in error ? String(error.name) : 'Error'
  return SAFE_ERROR_NAMES.has(name) ? name : 'Error'
}

function errorMentionsTimeout(error: unknown): boolean {
  return error instanceof Error && /timeout/i.test(error.message)
}

function readCauseCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 4) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') {
    const safe = safeCauseCode(code)
    if (safe) return safe
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause && cause !== error) return readCauseCode(cause, depth + 1)
  return undefined
}

function safeCauseCode(code: string): string | undefined {
  if (!/^[A-Z0-9_]{1,40}$/.test(code)) return undefined
  if (TRANSPORT_CODES.has(code) || AMBIGUOUS_CODES.has(code)) return code
  return undefined
}

function logDispatch(
  code: string,
  detail: { error?: string; cause?: string; status?: number } = {},
) {
  const payload: Record<string, string | number> = { operation: 'n8n_invoice_dispatch', code }
  if (detail.error && SAFE_ERROR_NAMES.has(detail.error)) payload.error = detail.error
  if (detail.cause && safeCauseCode(detail.cause)) payload.cause = detail.cause
  if (Number.isInteger(detail.status) && detail.status! >= 100 && detail.status! <= 599) {
    payload.status = detail.status!
  }
  console.error(JSON.stringify(payload))
}

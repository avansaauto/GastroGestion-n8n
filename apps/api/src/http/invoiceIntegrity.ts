import { createHmac, timingSafeEqual } from 'node:crypto'
import { sha256Hex } from './fileHash.js'

export const INVOICE_INTEGRITY_TTL_SECONDS = 2 * 60 * 60
export const INVOICE_INTEGRITY_VERSION = 1 as const

export type InvoiceIntegritySnapshot = {
  document: unknown
  interpretation: unknown
  validation: unknown
  inventory: unknown
  metadata?: {
    provider?: unknown
    model?: unknown
    promptVersion?: unknown
    processingTimeMs?: unknown
    fileSha256?: unknown
    snapshotSha256?: unknown
    integrityToken?: unknown
    integrityExpiresAt?: unknown
    [key: string]: unknown
  }
}

export type InvoiceIntegrityClaims = {
  v: typeof INVOICE_INTEGRITY_VERSION
  sub: string
  fileSha256: string
  snapshotSha256: string
  iat: number
  exp: number
}

export class InvoiceIntegrityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'TOKEN_MISSING'
      | 'TOKEN_INVALID'
      | 'TOKEN_EXPIRED'
      | 'USER_MISMATCH'
      | 'FILE_MISMATCH'
      | 'SNAPSHOT_MISMATCH'
      | 'SECRET_MISSING',
  ) {
    super(message)
    this.name = 'InvoiceIntegrityError'
  }
}

function base64UrlEncode(value: Buffer | string): string {
  const buffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return buffer.toString('base64url')
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

function hmac(secret: string, encodedPayload: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest()
}

function equal(left: Buffer, right: Buffer) {
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (key === 'integrityToken' || key === 'integrityExpiresAt' || key === 'snapshotSha256') continue
    sorted[key] = canonicalize(source[key])
  }
  return sorted
}

export function hashAnalysisSnapshot(snapshot: InvoiceIntegritySnapshot): string {
  return sha256Hex(Buffer.from(JSON.stringify(canonicalize(snapshot)), 'utf8'))
}

export function issueInvoiceIntegrityToken(options: {
  userId: string
  fileSha256: string
  snapshot: InvoiceIntegritySnapshot
  secret: string
  ttlSeconds?: number
  now?: Date
}) {
  if (!options.secret) {
    throw new InvoiceIntegrityError('Falta la clave de integridad.', 'SECRET_MISSING')
  }
  const now = options.now ?? new Date()
  const iat = Math.floor(now.getTime() / 1000)
  const ttl = options.ttlSeconds ?? INVOICE_INTEGRITY_TTL_SECONDS
  const snapshotSha256 = hashAnalysisSnapshot(options.snapshot)
  const claims: InvoiceIntegrityClaims = {
    v: INVOICE_INTEGRITY_VERSION,
    sub: options.userId,
    fileSha256: options.fileSha256,
    snapshotSha256,
    iat,
    exp: iat + ttl,
  }
  const encodedPayload = base64UrlEncode(JSON.stringify(claims))
  const token = `${encodedPayload}.${base64UrlEncode(hmac(options.secret, encodedPayload))}`
  return {
    token,
    snapshotSha256,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    claims,
  }
}

function parseToken(token: string, secret: string): InvoiceIntegrityClaims {
  const [encodedPayload, encodedSignature] = token.split('.')
  if (!encodedPayload || !encodedSignature) {
    throw new InvoiceIntegrityError('El token de integridad no es válido.', 'TOKEN_INVALID')
  }
  const expected = hmac(secret, encodedPayload)
  const actual = base64UrlDecode(encodedSignature)
  if (!equal(expected, actual)) {
    throw new InvoiceIntegrityError('El token de integridad fue modificado.', 'TOKEN_INVALID')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'))
  } catch {
    throw new InvoiceIntegrityError('El token de integridad no es válido.', 'TOKEN_INVALID')
  }
  if (
    !isPlainObject(parsed)
    || parsed.v !== INVOICE_INTEGRITY_VERSION
    || typeof parsed.sub !== 'string'
    || typeof parsed.fileSha256 !== 'string'
    || typeof parsed.snapshotSha256 !== 'string'
    || typeof parsed.iat !== 'number'
    || typeof parsed.exp !== 'number'
  ) {
    throw new InvoiceIntegrityError('El token de integridad no es válido.', 'TOKEN_INVALID')
  }
  return parsed as InvoiceIntegrityClaims
}

export function verifyInvoiceIntegrity(options: {
  token: string | null | undefined
  userId: string
  fileSha256: string
  snapshot: InvoiceIntegritySnapshot
  secret: string
  now?: Date
}): InvoiceIntegrityClaims {
  if (!options.secret) {
    throw new InvoiceIntegrityError('Falta la clave de integridad.', 'SECRET_MISSING')
  }
  if (!options.token) {
    throw new InvoiceIntegrityError('Falta el token de integridad del análisis.', 'TOKEN_MISSING')
  }
  const claims = parseToken(options.token, options.secret)
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000)
  if (claims.exp <= nowSeconds) {
    throw new InvoiceIntegrityError('El análisis expiró. Volvé a analizar el comprobante.', 'TOKEN_EXPIRED')
  }
  if (claims.sub !== options.userId) {
    throw new InvoiceIntegrityError('El análisis pertenece a otro usuario.', 'USER_MISMATCH')
  }
  if (claims.fileSha256 !== options.fileSha256) {
    throw new InvoiceIntegrityError('El archivo no coincide con el analizado.', 'FILE_MISMATCH')
  }
  const snapshotSha256 = hashAnalysisSnapshot(options.snapshot)
  if (claims.snapshotSha256 !== snapshotSha256) {
    throw new InvoiceIntegrityError('El resultado del análisis fue modificado.', 'SNAPSHOT_MISMATCH')
  }
  const snapshotFileHash = options.snapshot.metadata?.fileSha256
  if (typeof snapshotFileHash === 'string' && snapshotFileHash !== options.fileSha256) {
    throw new InvoiceIntegrityError('El archivo no coincide con el analizado.', 'FILE_MISMATCH')
  }
  return claims
}

export type InvoiceIntegritySigner = {
  secret: string
  ttlSeconds?: number
  now?: () => Date
}

export function integrityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): InvoiceIntegritySigner | null {
  const secret = env.INVOICE_ANALYSIS_HMAC_SECRET?.trim()
  if (!secret) return null
  return { secret, ttlSeconds: INVOICE_INTEGRITY_TTL_SECONDS }
}

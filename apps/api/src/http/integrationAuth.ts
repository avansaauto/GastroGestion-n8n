import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Autenticación pura de una integración externa.
 * El secreto se hashea con HMAC-SHA256 usando el pepper como clave.
 * No consulta Supabase, no emite JWT de usuario y no escribe facturas.
 */
export const INVOICE_INGEST_SCOPE = 'invoices.ingest' as const
export const FUDO_CATALOG_SYNC_SCOPE = 'fudo.catalog.sync' as const

const UUID_PATTERN =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
const AUTHORIZATION_PATTERN = new RegExp(
  `^Bearer snd_(${UUID_PATTERN})\\.([A-Za-z0-9_-]{43,128})$`,
)
const DUMMY_SECRET_HASH = '00'.repeat(32)

const FORBIDDEN_CLIENT_KEYS = new Set([
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

export class IntegrationAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'MALFORMED'
      | 'CREDENTIAL_NOT_FOUND'
      | 'SECRET_MISMATCH'
      | 'REVOKED'
      | 'EXPIRED'
      | 'SCOPE_DENIED'
      | 'CLIENT_DESTINATION'
      | 'CREDENTIAL_INVALID'
      | 'PEPPER_MISSING'
      | 'LOOKUP_FAILED'
      | 'NOT_A_USER',
    public readonly status: number,
  ) {
    super(message)
    this.name = 'IntegrationAuthError'
  }
}

export type IntegrationCredentialStatus = 'active' | 'revoked'

export type IntegrationCredentialRecord = {
  id: string
  secretHash: string
  organizationId: string
  locationId: string
  scopes: readonly string[]
  status: IntegrationCredentialStatus
  expiresAt: string | null
}

export type IntegrationCredentialRepository = {
  findById(credentialId: string): Promise<IntegrationCredentialRecord | null>
}

export type IntegrationPrincipal = {
  kind: 'integration'
  integrationId: string
  organizationId: string
  locationId: string
  scopes: readonly string[]
}

export type HumanPrincipal = {
  kind: 'user'
  userId: string
}

export type PurchaseActor = HumanPrincipal | IntegrationPrincipal

export type AuthenticateIntegrationInput = {
  authorizationHeader: string | undefined
  body: unknown
  pepper: string
  repository: IntegrationCredentialRepository
  /** Alcance exigido para esta operación (p. ej. invoices.ingest o fudo.catalog.sync). */
  requiredScope: string
  now?: Date
}

const UUID_VALUE = new RegExp(`^${UUID_PATTERN}$`)

export function hashIntegrationSecret(secret: string, pepper: string): string {
  if (!pepper) {
    throw new IntegrationAuthError(
      'Falta la clave de verificación de integraciones.',
      'PEPPER_MISSING',
      500,
    )
  }
  return createHmac('sha256', pepper).update(secret, 'utf8').digest('hex')
}

export function isIntegrationPrincipal(actor: PurchaseActor): actor is IntegrationPrincipal {
  return actor.kind === 'integration'
}

export function isHumanPrincipal(actor: PurchaseActor): actor is HumanPrincipal {
  return actor.kind === 'user'
}

/** El id de una integración no puede ocupar actor_user_id. */
export function userIdFromActor(actor: PurchaseActor): string {
  if (actor.kind !== 'user') {
    throw new IntegrationAuthError(
      'Una integración no puede actuar como usuario.',
      'NOT_A_USER',
      403,
    )
  }
  return actor.userId
}

export async function authenticateIntegration(
  input: AuthenticateIntegrationInput,
): Promise<IntegrationPrincipal> {
  if (!input.pepper) {
    throw new IntegrationAuthError(
      'Falta la clave de verificación de integraciones.',
      'PEPPER_MISSING',
      500,
    )
  }
  if (!input.requiredScope?.trim()) {
    throw new IntegrationAuthError(
      'Falta el alcance requerido de la integración.',
      'SCOPE_DENIED',
      403,
    )
  }

  const parsed = parseAuthorization(input.authorizationHeader)
  assertClientDoesNotSelectDestination(input.body)

  let record: IntegrationCredentialRecord | null
  try {
    record = await input.repository.findById(parsed.credentialId)
  } catch {
    throw new IntegrationAuthError(
      'No se pudo verificar la credencial.',
      'LOOKUP_FAILED',
      500,
    )
  }

  const computed = hashIntegrationSecret(parsed.secret, input.pepper)
  const matches = secretMatches(record?.secretHash ?? DUMMY_SECRET_HASH, computed)
  if (!record || record.id.toLowerCase() !== parsed.credentialId) {
    throw new IntegrationAuthError('Credencial inválida.', 'CREDENTIAL_NOT_FOUND', 401)
  }
  if (!matches) {
    throw new IntegrationAuthError('Credencial inválida.', 'SECRET_MISMATCH', 401)
  }

  assertCredentialIsUsable(record, input.now ?? new Date(), input.requiredScope)

  return {
    kind: 'integration',
    integrationId: record.id.toLowerCase(),
    organizationId: record.organizationId.toLowerCase(),
    locationId: record.locationId.toLowerCase(),
    scopes: [...record.scopes],
  }
}

function parseAuthorization(header: string | undefined): { credentialId: string; secret: string } {
  const match = typeof header === 'string' ? AUTHORIZATION_PATTERN.exec(header) : null
  if (!match) {
    throw new IntegrationAuthError('Credencial inválida.', 'MALFORMED', 401)
  }
  return {
    credentialId: match[1].toLowerCase(),
    secret: match[2],
  }
}

function assertClientDoesNotSelectDestination(body: unknown): void {
  if (containsForbiddenKey(body)) {
    throw new IntegrationAuthError(
      'La solicitud no puede indicar organización, sucursal ni actor.',
      'CLIENT_DESTINATION',
      400,
    )
  }
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (!isPlainObject(value)) return false
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CLIENT_KEYS.has(key.toLowerCase())) return true
    if (containsForbiddenKey(nested)) return true
  }
  return false
}

function assertCredentialIsUsable(
  record: IntegrationCredentialRecord,
  now: Date,
  requiredScope: string,
): void {
  if (!UUID_VALUE.test(record.organizationId) || !UUID_VALUE.test(record.locationId)) {
    throw new IntegrationAuthError('Credencial inválida.', 'CREDENTIAL_INVALID', 401)
  }
  if (record.status !== 'active') {
    throw new IntegrationAuthError('Credencial revocada.', 'REVOKED', 401)
  }
  if (record.expiresAt != null) {
    const expiresAt = new Date(record.expiresAt)
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
      throw new IntegrationAuthError('Credencial vencida.', 'EXPIRED', 401)
    }
  }
  if (!Array.isArray(record.scopes)) {
    throw new IntegrationAuthError('Credencial inválida.', 'CREDENTIAL_INVALID', 401)
  }
  const scopes = new Set(record.scopes)
  if (!scopes.has(requiredScope)) {
    throw new IntegrationAuthError(
      'La credencial no tiene el alcance requerido.',
      'SCOPE_DENIED',
      403,
    )
  }
}

function secretMatches(storedHash: string, computedHash: string): boolean {
  const stored = decodeHex(storedHash)
  const computed = decodeHex(computedHash)
  const left = stored.length === 32 ? stored : Buffer.alloc(32)
  const right = computed.length === 32 ? computed : Buffer.alloc(32)
  const equal = timingSafeEqual(left, right)
  return stored.length === 32 && computed.length === 32 && equal
}

function decodeHex(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(value)) return Buffer.alloc(0)
  return Buffer.from(value, 'hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

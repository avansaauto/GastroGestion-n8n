import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { writeFudoCatalogBatch } from './fudoCatalogSync.js'
import {
  authenticateFudo,
  pullFudoCatalog,
  type FudoCatalogItem,
} from './fudoClient.js'
import { FudoClientError } from './fudoClient.js'
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from './providerSecretCipher.js'
import { FUDO_CATALOG_SYNC_SCOPE, FUDO_SYNC_RUN_SCOPE, type IntegrationPrincipal } from './integrationAuth.js'

export const PROVIDER_CREDENTIALS_KEY_ENV = 'PROVIDER_CREDENTIALS_KEY'

export type GastroProviderId = 'fudo' | 'maxirest' | 'bistrosoft'

export type PublicProvider = {
  id: GastroProviderId
  name: string
  availability: 'available' | 'soon'
  summary: string
}

export const GASTRO_PROVIDERS: PublicProvider[] = [
  {
    id: 'fudo',
    name: 'Fudo',
    availability: 'available',
    summary: 'Sincroniza el catálogo de productos de la sucursal. No crea recetas ni descuenta stock.',
  },
  {
    id: 'maxirest',
    name: 'Maxirest',
    availability: 'soon',
    summary: 'Próximamente.',
  },
  {
    id: 'bistrosoft',
    name: 'Bistrosoft',
    availability: 'soon',
    summary: 'Próximamente.',
  },
]

export type LocationAccess = {
  organizationId: string
  locationId: string
  organizationName: string | null
  locationName: string | null
  role: string | null
  memberStatus: string | null
}

export type StoredFudoIntegration = {
  id: string
  organizationId: string
  locationId: string
  status: 'connected' | 'disconnected' | 'invalid' | 'error'
  apiKeyCiphertext: string | null
  apiSecretCiphertext: string | null
  keyLast4: string | null
  lastConnectionOkAt: string | null
  lastConnectionError: string | null
  lastSyncAt: string | null
  lastSyncStatus: 'queued' | 'running' | 'succeeded' | 'failed' | null
  lastSyncError: string | null
  disconnectedAt: string | null
}

export type FudoSyncJob = {
  id: string
  integrationId: string
  organizationId: string
  locationId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  error: string | null
  received: number
  upserted: number
  deactivated: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type FudoIntegrationPublic = {
  provider: 'fudo'
  status: 'disconnected' | 'connected' | 'invalid' | 'error' | 'syncing'
  organizationId: string
  locationId: string
  organizationName: string | null
  locationName: string | null
  keyLast4: string | null
  lastConnectionOkAt: string | null
  lastSyncAt: string | null
  lastSyncStatus: FudoSyncJob['status'] | null
  lastSyncError: string | null
  productCount: number
  canManage: boolean
  jobId: string | null
}

export type FudoSyncJobPublic = {
  jobId: string
  organizationId: string
  locationId: string
  status: FudoSyncJob['status']
  error: string | null
  received: number
  upserted: number
  deactivated: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export class FudoIntegrationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'FudoIntegrationError'
  }
}

export type FudoIntegrationStore = {
  resolveAccess(userId: string, locationId: string): Promise<LocationAccess | null>
  readIntegration(locationId: string): Promise<StoredFudoIntegration | null>
  countCatalog(locationId: string): Promise<number>
  saveIntegration(row: StoredFudoIntegration): Promise<void>
  createJob(job: FudoSyncJob): Promise<void>
  readJob(jobId: string): Promise<FudoSyncJob | null>
  updateJob(job: FudoSyncJob): Promise<void>
  latestJob(locationId: string): Promise<FudoSyncJob | null>
}

export type FudoIntegrationDeps = {
  store: FudoIntegrationStore
  credentialsKey: Buffer
  now?: Date
  fetchImpl?: typeof fetch
  webhookUrl?: string
  webhookSecret?: string
  admin?: SupabaseClient
  pullCatalog?: (input: { apiKey: string; apiSecret: string }) => Promise<{ products: FudoCatalogItem[]; complete: boolean }>
  testCredentials?: (input: { apiKey: string; apiSecret: string }) => Promise<void>
  notifyWebhook?: (body: Record<string, string>) => Promise<void>
}

function nowIso(deps: FudoIntegrationDeps) {
  return (deps.now ?? new Date()).toISOString()
}

function assertMember(access: LocationAccess | null): LocationAccess {
  if (!access || access.memberStatus !== 'active') {
    throw new FudoIntegrationError('No tenés acceso a este local.', 'FORBIDDEN', 403)
  }
  return access
}

function assertAdmin(access: LocationAccess | null): LocationAccess {
  const member = assertMember(access)
  if (member.role !== 'admin') {
    throw new FudoIntegrationError('Solo un administrador puede gestionar la integración.', 'FORBIDDEN', 403)
  }
  return member
}

export function credentialHint(apiKey: string) {
  const trimmed = apiKey.trim()
  if (trimmed.length < 4) return null
  return trimmed.slice(-4)
}

export function parseFudoCredentialInput(body: unknown): { apiKey: string; apiSecret: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FudoIntegrationError('Indicá la API Key y el API Secret.', 'INVALID_BODY', 400)
  }
  const record = body as Record<string, unknown>
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  const apiSecret = typeof record.apiSecret === 'string' ? record.apiSecret.trim() : ''
  if (!apiKey || !apiSecret || apiKey.length > 256 || apiSecret.length > 256) {
    throw new FudoIntegrationError('Las credenciales de Fudo no son válidas.', 'INVALID_BODY', 400)
  }
  return { apiKey, apiSecret }
}

export function toPublicIntegration(input: {
  access: LocationAccess
  integration: StoredFudoIntegration | null
  productCount: number
  job: FudoSyncJob | null
}): FudoIntegrationPublic {
  const integration = input.integration
  const syncing = input.job?.status === 'queued' || input.job?.status === 'running'
  const status = syncing
    ? 'syncing'
    : integration?.status ?? 'disconnected'
  return {
    provider: 'fudo',
    status,
    organizationId: input.access.organizationId,
    locationId: input.access.locationId,
    organizationName: input.access.organizationName,
    locationName: input.access.locationName,
    keyLast4: integration?.status === 'connected' ? integration.keyLast4 : null,
    lastConnectionOkAt: integration?.lastConnectionOkAt ?? null,
    lastSyncAt: integration?.lastSyncAt ?? null,
    lastSyncStatus: input.job?.status ?? integration?.lastSyncStatus ?? null,
    lastSyncError: input.job?.error ?? integration?.lastSyncError ?? null,
    productCount: input.productCount,
    canManage: input.access.role === 'admin' && input.access.memberStatus === 'active',
    jobId: input.job?.id ?? null,
  }
}

export function toPublicJob(job: FudoSyncJob): FudoSyncJobPublic {
  return {
    jobId: job.id,
    organizationId: job.organizationId,
    locationId: job.locationId,
    status: job.status,
    error: job.error,
    received: job.received,
    upserted: job.upserted,
    deactivated: job.deactivated,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

function assertPublicHasNoSecrets(value: unknown, secrets: string[]) {
  const serialized = JSON.stringify(value)
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) {
      throw new FudoIntegrationError('La respuesta no puede incluir credenciales.', 'SECRET_LEAK', 500)
    }
  }
}

async function readView(deps: FudoIntegrationDeps, access: LocationAccess) {
  const integration = await deps.store.readIntegration(access.locationId)
  const productCount = await deps.store.countCatalog(access.locationId)
  const job = await deps.store.latestJob(access.locationId)
  return toPublicIntegration({ access, integration, productCount, job })
}

export async function getFudoIntegrationView(deps: FudoIntegrationDeps, userId: string, locationId: string) {
  const access = assertMember(await deps.store.resolveAccess(userId, locationId))
  const view = await readView(deps, access)
  return {
    providers: GASTRO_PROVIDERS,
    fudo: view,
  }
}

async function testPair(deps: FudoIntegrationDeps, apiKey: string, apiSecret: string) {
  const test = deps.testCredentials ?? ((input) => authenticateFudo({ ...input, fetchImpl: deps.fetchImpl }))
  try {
    await test({ apiKey, apiSecret })
  } catch (error) {
    if (error instanceof FudoClientError) {
      throw new FudoIntegrationError(error.message, error.code, error.status)
    }
    throw new FudoIntegrationError('No se pudo contactar a Fudo.', 'FUDO_UNAVAILABLE', 502)
  }
}

export async function connectFudoIntegration(
  deps: FudoIntegrationDeps,
  userId: string,
  locationId: string,
  body: unknown,
) {
  const access = assertAdmin(await deps.store.resolveAccess(userId, locationId))
  const credentials = parseFudoCredentialInput(body)
  await testPair(deps, credentials.apiKey, credentials.apiSecret)
  const existing = await deps.store.readIntegration(locationId)
  const timestamp = nowIso(deps)
  const row: StoredFudoIntegration = {
    id: existing?.id ?? randomUUID(),
    organizationId: access.organizationId,
    locationId: access.locationId,
    status: 'connected',
    apiKeyCiphertext: encryptProviderSecret(credentials.apiKey, deps.credentialsKey),
    apiSecretCiphertext: encryptProviderSecret(credentials.apiSecret, deps.credentialsKey),
    keyLast4: credentialHint(credentials.apiKey),
    lastConnectionOkAt: timestamp,
    lastConnectionError: null,
    lastSyncAt: existing?.lastSyncAt ?? null,
    lastSyncStatus: existing?.lastSyncStatus ?? null,
    lastSyncError: existing?.lastSyncError ?? null,
    disconnectedAt: null,
  }
  await deps.store.saveIntegration(row)
  const view = await readView(deps, access)
  assertPublicHasNoSecrets(view, [credentials.apiKey, credentials.apiSecret, row.apiKeyCiphertext ?? '', row.apiSecretCiphertext ?? ''])
  return view
}

export async function testFudoIntegration(
  deps: FudoIntegrationDeps,
  userId: string,
  locationId: string,
  body: unknown,
) {
  const access = assertAdmin(await deps.store.resolveAccess(userId, locationId))
  const provided = body && typeof body === 'object' && !Array.isArray(body)
    && (typeof (body as Record<string, unknown>).apiKey === 'string'
      || typeof (body as Record<string, unknown>).apiSecret === 'string')
  if (provided) {
    const credentials = parseFudoCredentialInput(body)
    await testPair(deps, credentials.apiKey, credentials.apiSecret)
    return { ok: true as const, source: 'input' as const }
  }
  const secrets = await requireStoredSecrets(deps, access.locationId)
  await testPair(deps, secrets.apiKey, secrets.apiSecret)
  const existing = await deps.store.readIntegration(locationId)
  if (existing) {
    existing.lastConnectionOkAt = nowIso(deps)
    existing.lastConnectionError = null
    existing.status = 'connected'
    await deps.store.saveIntegration(existing)
  }
  return { ok: true as const, source: 'stored' as const }
}

async function requireStoredSecrets(deps: FudoIntegrationDeps, locationId: string) {
  const existing = await deps.store.readIntegration(locationId)
  if (!existing || existing.status !== 'connected' || !existing.apiKeyCiphertext || !existing.apiSecretCiphertext) {
    throw new FudoIntegrationError('Fudo no está conectado en este local.', 'NOT_CONNECTED', 409)
  }
  try {
    return {
      integration: existing,
      apiKey: decryptProviderSecret(existing.apiKeyCiphertext, deps.credentialsKey),
      apiSecret: decryptProviderSecret(existing.apiSecretCiphertext, deps.credentialsKey),
    }
  } catch {
    throw new FudoIntegrationError('No se pudieron leer las credenciales guardadas.', 'CIPHER_INVALID', 500)
  }
}

export async function disconnectFudoIntegration(deps: FudoIntegrationDeps, userId: string, locationId: string) {
  const access = assertAdmin(await deps.store.resolveAccess(userId, locationId))
  const existing = await deps.store.readIntegration(locationId)
  const timestamp = nowIso(deps)
  const row: StoredFudoIntegration = {
    id: existing?.id ?? randomUUID(),
    organizationId: access.organizationId,
    locationId: access.locationId,
    status: 'disconnected',
    apiKeyCiphertext: null,
    apiSecretCiphertext: null,
    keyLast4: null,
    lastConnectionOkAt: existing?.lastConnectionOkAt ?? null,
    lastConnectionError: null,
    lastSyncAt: existing?.lastSyncAt ?? null,
    lastSyncStatus: existing?.lastSyncStatus ?? null,
    lastSyncError: existing?.lastSyncError ?? null,
    disconnectedAt: timestamp,
  }
  await deps.store.saveIntegration(row)
  return readView(deps, access)
}

async function notifyJob(deps: FudoIntegrationDeps, job: FudoSyncJob) {
  const body = {
    jobId: job.id,
    integrationId: job.integrationId,
    organizationId: job.organizationId,
    locationId: job.locationId,
    provider: 'fudo',
    kind: 'catalog',
  }
  if (deps.notifyWebhook) {
    await deps.notifyWebhook(body)
    return
  }
  if (!deps.webhookUrl) return
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (deps.webhookSecret) headers['X-Senda-Webhook-Secret'] = deps.webhookSecret
  const fetchImpl = deps.fetchImpl ?? fetch
  const response = await fetchImpl(deps.webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new FudoIntegrationError('No se pudo avisar a la automatización.', 'WEBHOOK_FAILED', 502)
  }
}

export async function requestFudoCatalogSync(deps: FudoIntegrationDeps, userId: string, locationId: string) {
  const access = assertAdmin(await deps.store.resolveAccess(userId, locationId))
  const secrets = await requireStoredSecrets(deps, locationId)
  const current = await deps.store.latestJob(locationId)
  if (current && (current.status === 'queued' || current.status === 'running')) {
    throw new FudoIntegrationError('Ya hay una sincronización en curso.', 'SYNC_IN_PROGRESS', 409)
  }
  const timestamp = nowIso(deps)
  const job: FudoSyncJob = {
    id: randomUUID(),
    integrationId: secrets.integration.id,
    organizationId: access.organizationId,
    locationId: access.locationId,
    status: 'queued',
    error: null,
    received: 0,
    upserted: 0,
    deactivated: 0,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
  }
  await deps.store.createJob(job)
  if (deps.webhookUrl || deps.notifyWebhook) {
    try {
      await notifyJob(deps, job)
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof FudoIntegrationError ? error.message : 'No se pudo avisar a la automatización.'
      job.finishedAt = timestamp
      await deps.store.updateJob(job)
      throw error instanceof FudoIntegrationError
        ? error
        : new FudoIntegrationError(job.error, 'WEBHOOK_FAILED', 502)
    }
    return toPublicJob(job)
  }
  return runStoredCatalogPull(deps, job, secrets.apiKey, secrets.apiSecret)
}

export async function runFudoSyncJob(deps: FudoIntegrationDeps, principal: IntegrationPrincipal, jobId: string) {
  const allowed = principal.scopes.includes(FUDO_SYNC_RUN_SCOPE)
    || (principal.scopes.includes(FUDO_CATALOG_SYNC_SCOPE))
  if (!allowed) {
    throw new FudoIntegrationError('La credencial no puede ejecutar esta sincronización.', 'SCOPE_DENIED', 403)
  }
  const job = await deps.store.readJob(jobId)
  if (!job) throw new FudoIntegrationError('Trabajo no disponible.', 'NOT_FOUND', 404)
  if (!principal.scopes.includes(FUDO_SYNC_RUN_SCOPE) && principal.locationId !== job.locationId) {
    throw new FudoIntegrationError('El trabajo no pertenece a esta credencial.', 'FORBIDDEN', 403)
  }
  if (job.status === 'succeeded') return toPublicJob(job)
  if (job.status === 'running') {
    throw new FudoIntegrationError('La sincronización ya está en curso.', 'SYNC_IN_PROGRESS', 409)
  }
  const secrets = await requireStoredSecrets(deps, job.locationId)
  if (secrets.integration.organizationId !== job.organizationId) {
    throw new FudoIntegrationError('El trabajo no coincide con la integración.', 'FORBIDDEN', 403)
  }
  return runStoredCatalogPull(deps, job, secrets.apiKey, secrets.apiSecret)
}

export async function getFudoSyncJob(deps: FudoIntegrationDeps, principal: IntegrationPrincipal, jobId: string) {
  const allowed = principal.scopes.includes(FUDO_SYNC_RUN_SCOPE)
    || principal.scopes.includes(FUDO_CATALOG_SYNC_SCOPE)
  if (!allowed) {
    throw new FudoIntegrationError('La credencial no puede consultar este trabajo.', 'SCOPE_DENIED', 403)
  }
  const job = await deps.store.readJob(jobId)
  if (!job) throw new FudoIntegrationError('Trabajo no disponible.', 'NOT_FOUND', 404)
  if (!principal.scopes.includes(FUDO_SYNC_RUN_SCOPE) && principal.locationId !== job.locationId) {
    throw new FudoIntegrationError('El trabajo no pertenece a esta credencial.', 'FORBIDDEN', 403)
  }
  const view = toPublicJob(job)
  assertPublicHasNoSecrets(view, [])
  return view
}

async function runStoredCatalogPull(
  deps: FudoIntegrationDeps,
  job: FudoSyncJob,
  apiKey: string,
  apiSecret: string,
) {
  if (!deps.admin) {
    throw new FudoIntegrationError('La sincronización no está configurada.', 'ADMIN_MISSING', 503)
  }
  const timestamp = nowIso(deps)
  job.status = 'running'
  job.startedAt = timestamp
  job.error = null
  await deps.store.updateJob(job)
  const pull = deps.pullCatalog ?? ((input) => pullFudoCatalog({ ...input, fetchImpl: deps.fetchImpl }))
  try {
    const catalog = await pull({ apiKey, apiSecret })
    if (!catalog.complete) {
      throw new FudoIntegrationError(
        'El catálogo de Fudo llegó incompleto. No se desactivó ningún producto.',
        'INCOMPLETE_CATALOG',
        502,
      )
    }
    const written = await writeFudoCatalogBatch({
      admin: deps.admin,
      organizationId: job.organizationId,
      locationId: job.locationId,
      products: catalog.products,
      markMissingInactive: true,
      now: deps.now,
    })
    job.status = 'succeeded'
    job.received = written.received
    job.upserted = written.upserted
    job.deactivated = written.deactivated
    job.finishedAt = written.lastSyncedAt
    job.error = null
    await deps.store.updateJob(job)
    const integration = await deps.store.readIntegration(job.locationId)
    if (integration) {
      integration.lastSyncAt = written.lastSyncedAt
      integration.lastSyncStatus = 'succeeded'
      integration.lastSyncError = null
      integration.status = 'connected'
      await deps.store.saveIntegration(integration)
    }
    const view = toPublicJob(job)
    assertPublicHasNoSecrets(view, [apiKey, apiSecret])
    return view
  } catch (error) {
    job.status = 'failed'
    job.finishedAt = nowIso(deps)
    job.error = error instanceof FudoIntegrationError || error instanceof FudoClientError
      ? error.message
      : 'No se pudo sincronizar el catálogo.'
    await deps.store.updateJob(job)
    const integration = await deps.store.readIntegration(job.locationId)
    if (integration && integration.status === 'connected') {
      integration.lastSyncStatus = 'failed'
      integration.lastSyncError = job.error
      if (error instanceof FudoClientError && error.code === 'INVALID_CREDENTIALS') {
        integration.status = 'invalid'
      }
      await deps.store.saveIntegration(integration)
    }
    if (error instanceof FudoIntegrationError || error instanceof FudoClientError) throw error
    throw new FudoIntegrationError(job.error, 'SYNC_FAILED', 502)
  }
}

export function createMemoryFudoStore(seed?: {
  access?: LocationAccess | null
  integration?: StoredFudoIntegration | null
  catalogCount?: number
}): FudoIntegrationStore & {
  integrations: StoredFudoIntegration[]
  jobs: FudoSyncJob[]
  catalogDeletes: number
} {
  const integrations: StoredFudoIntegration[] = seed?.integration ? [seed.integration] : []
  const jobs: FudoSyncJob[] = []
  return {
    integrations,
    jobs,
    catalogDeletes: 0,
    async resolveAccess() {
      return seed?.access ?? null
    },
    async readIntegration(locationId) {
      return integrations.find((row) => row.locationId === locationId && row.status !== undefined) ?? null
    },
    async countCatalog() {
      return seed?.catalogCount ?? 0
    },
    async saveIntegration(row) {
      const index = integrations.findIndex((item) => item.locationId === row.locationId)
      if (index >= 0) integrations[index] = row
      else integrations.push(row)
    },
    async createJob(job) {
      jobs.push(job)
    },
    async readJob(jobId) {
      return jobs.find((job) => job.id === jobId) ?? null
    },
    async updateJob(job) {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index >= 0) jobs[index] = job
    },
    async latestJob(locationId) {
      const rows = jobs.filter((job) => job.locationId === locationId)
      return rows[rows.length - 1] ?? null
    },
  }
}

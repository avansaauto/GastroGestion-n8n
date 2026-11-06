import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FudoIntegrationError,
  type FudoIntegrationStore,
  type FudoSyncJob,
  type LocationAccess,
  type StoredFudoIntegration,
} from './fudoIntegration.js'

function asText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function missingRelation(error: { message?: string } | null) {
  const message = error?.message ?? ''
  return /location_provider_integrations|integration_sync_jobs|schema cache|does not exist/i.test(message)
}

function assertQuery(error: { message?: string } | null) {
  if (!error) return
  if (missingRelation(error)) {
    throw new FudoIntegrationError(
      'Falta aplicar la migración de integraciones.',
      'MIGRATION_PENDING',
      503,
    )
  }
  throw new FudoIntegrationError('No se pudo consultar la integración.', 'LOOKUP_FAILED', 500)
}

function organizationName(value: unknown) {
  if (!value) return null
  if (Array.isArray(value)) return asText((value[0] as { name?: unknown } | undefined)?.name)
  if (typeof value === 'object') return asText((value as { name?: unknown }).name)
  return null
}

function mapIntegration(row: Record<string, unknown>): StoredFudoIntegration {
  const status = row.status
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    locationId: String(row.location_id),
    status: status === 'connected' || status === 'invalid' || status === 'error' ? status : 'disconnected',
    apiKeyCiphertext: asText(row.api_key_ciphertext),
    apiSecretCiphertext: asText(row.api_secret_ciphertext),
    keyLast4: asText(row.key_last4),
    lastConnectionOkAt: asText(row.last_connection_ok_at),
    lastConnectionError: asText(row.last_connection_error),
    lastSyncAt: asText(row.last_sync_at),
    lastSyncStatus: row.last_sync_status === 'queued'
      || row.last_sync_status === 'running'
      || row.last_sync_status === 'succeeded'
      || row.last_sync_status === 'failed'
      ? row.last_sync_status
      : null,
    lastSyncError: asText(row.last_sync_error),
    disconnectedAt: asText(row.disconnected_at),
  }
}

function integrationPayload(row: StoredFudoIntegration, timestamp: string) {
  return {
    id: row.id,
    organization_id: row.organizationId,
    location_id: row.locationId,
    provider: 'fudo',
    status: row.status,
    api_key_ciphertext: row.apiKeyCiphertext,
    api_secret_ciphertext: row.apiSecretCiphertext,
    key_last4: row.keyLast4,
    last_connection_ok_at: row.lastConnectionOkAt,
    last_connection_error: row.lastConnectionError,
    last_sync_at: row.lastSyncAt,
    last_sync_status: row.lastSyncStatus,
    last_sync_error: row.lastSyncError,
    disconnected_at: row.disconnectedAt,
    updated_at: timestamp,
  }
}

function mapJob(row: Record<string, unknown>): FudoSyncJob {
  const status = row.status
  return {
    id: String(row.id),
    integrationId: String(row.integration_id),
    organizationId: String(row.organization_id),
    locationId: String(row.location_id),
    status: status === 'queued' || status === 'running' || status === 'succeeded' || status === 'failed'
      ? status
      : 'failed',
    error: asText(row.error),
    received: Number(row.received ?? 0),
    upserted: Number(row.upserted ?? 0),
    deactivated: Number(row.deactivated ?? 0),
    createdAt: asText(row.created_at) ?? new Date(0).toISOString(),
    startedAt: asText(row.started_at),
    finishedAt: asText(row.finished_at),
  }
}

export function createSupabaseFudoIntegrationStore(admin: SupabaseClient): FudoIntegrationStore {
  return {
    async resolveAccess(userId, locationId) {
      const { data, error } = await admin
        .from('locations')
        .select('id, organization_id, name, organizations(name)')
        .eq('id', locationId)
        .maybeSingle()
      if (error) throw new FudoIntegrationError('No se pudo consultar el local.', 'LOOKUP_FAILED', 500)
      if (!data) return null
      const location = data as Record<string, unknown>
      const organizationId = asText(location.organization_id)
      if (!organizationId) return null
      const { data: member, error: memberError } = await admin
        .from('organization_members')
        .select('role, status')
        .eq('organization_id', organizationId)
        .eq('user_id', userId)
        .maybeSingle()
      if (memberError) {
        throw new FudoIntegrationError('No se pudo consultar la membresía.', 'LOOKUP_FAILED', 500)
      }
      const membership = member as { role?: unknown; status?: unknown } | null
      const access: LocationAccess = {
        organizationId,
        locationId,
        organizationName: organizationName(location.organizations),
        locationName: asText(location.name),
        role: asText(membership?.role),
        memberStatus: asText(membership?.status),
      }
      return access
    },

    async readIntegration(locationId) {
      const { data, error } = await admin
        .from('location_provider_integrations')
        .select('*')
        .eq('location_id', locationId)
        .eq('provider', 'fudo')
        .maybeSingle()
      assertQuery(error)
      if (!data) return null
      return mapIntegration(data as Record<string, unknown>)
    },

    async countCatalog(locationId) {
      const { count, error } = await admin
        .from('fudo_product_catalog')
        .select('id', { count: 'exact', head: true })
        .eq('location_id', locationId)
        .eq('source', 'fudo')
      if (error) {
        const message = error.message ?? ''
        if (/fudo_product_catalog|schema cache|does not exist/i.test(message)) return 0
        throw new FudoIntegrationError('No se pudo contar el catálogo.', 'LOOKUP_FAILED', 500)
      }
      return count ?? 0
    },

    async saveIntegration(row) {
      const { error } = await admin
        .from('location_provider_integrations')
        .upsert(integrationPayload(row, new Date().toISOString()), { onConflict: 'location_id,provider' })
      assertQuery(error)
    },

    async createJob(job) {
      const { error } = await admin.from('integration_sync_jobs').insert({
        id: job.id,
        integration_id: job.integrationId,
        organization_id: job.organizationId,
        location_id: job.locationId,
        provider: 'fudo',
        kind: 'catalog',
        status: job.status,
        error: job.error,
        received: job.received,
        upserted: job.upserted,
        deactivated: job.deactivated,
        created_at: job.createdAt,
        started_at: job.startedAt,
        finished_at: job.finishedAt,
      })
      assertQuery(error)
    },

    async readJob(jobId) {
      const { data, error } = await admin
        .from('integration_sync_jobs')
        .select('*')
        .eq('id', jobId)
        .maybeSingle()
      assertQuery(error)
      if (!data) return null
      return mapJob(data as Record<string, unknown>)
    },

    async updateJob(job) {
      const { error } = await admin
        .from('integration_sync_jobs')
        .update({
          status: job.status,
          error: job.error,
          received: job.received,
          upserted: job.upserted,
          deactivated: job.deactivated,
          started_at: job.startedAt,
          finished_at: job.finishedAt,
        })
        .eq('id', job.id)
      assertQuery(error)
    },

    async latestJob(locationId) {
      const { data, error } = await admin
        .from('integration_sync_jobs')
        .select('*')
        .eq('location_id', locationId)
        .eq('provider', 'fudo')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      assertQuery(error)
      if (!data) return null
      return mapJob(data as Record<string, unknown>)
    },
  }
}

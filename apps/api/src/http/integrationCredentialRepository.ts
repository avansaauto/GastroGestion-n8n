import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  IntegrationCredentialRecord,
  IntegrationCredentialRepository,
  IntegrationCredentialStatus,
} from './integrationAuth.js'

export function createIntegrationCredentialRepository(
  admin: SupabaseClient,
): IntegrationCredentialRepository {
  return {
    async findById(credentialId: string): Promise<IntegrationCredentialRecord | null> {
      const { data, error } = await admin
        .from('integration_credentials')
        .select('id, secret_hash, organization_id, location_id, scopes, status, expires_at')
        .eq('id', credentialId)
        .maybeSingle()

      if (error || !data) return null
      const row = data as {
        id: string
        secret_hash: string
        organization_id: string
        location_id: string
        scopes: string[] | null
        status: string
        expires_at: string | null
      }
      const status: IntegrationCredentialStatus = row.status === 'revoked' ? 'revoked' : 'active'
      return {
        id: row.id,
        secretHash: row.secret_hash,
        organizationId: row.organization_id,
        locationId: row.location_id,
        scopes: Array.isArray(row.scopes) ? row.scopes : [],
        status,
        expiresAt: row.expires_at,
      }
    },
  }
}

import { supabase } from './supabase'

const API_URL = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '')

export type GastroProvider = {
  id: 'fudo' | 'maxirest' | 'bistrosoft'
  name: string
  availability: 'available' | 'soon'
  summary: string
}

export type FudoIntegrationStatus = 'disconnected' | 'connected' | 'invalid' | 'error' | 'syncing'

export type FudoIntegrationView = {
  provider: 'fudo'
  status: FudoIntegrationStatus
  organizationId: string
  locationId: string
  organizationName: string | null
  locationName: string | null
  keyLast4: string | null
  lastConnectionOkAt: string | null
  lastSyncAt: string | null
  lastSyncStatus: 'queued' | 'running' | 'succeeded' | 'failed' | null
  lastSyncError: string | null
  productCount: number
  canManage: boolean
  jobId: string | null
}

export type IntegrationOverview = {
  providers: GastroProvider[]
  fudo: FudoIntegrationView
}

export type FudoSyncJobView = {
  jobId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  error: string | null
  received: number
  upserted: number
  deactivated: number
  finishedAt: string | null
}

async function accessToken() {
  if (!supabase) throw new Error('Supabase todavía no está configurado.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session?.access_token) throw new Error('La sesión no está disponible.')
  return data.session.access_token
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as { data?: T; error?: string }
  if (!response.ok) throw new Error(payload.error || 'No se pudo completar la operación.')
  return payload.data as T
}

export function getLocationIntegrations(locationId: string) {
  return send<IntegrationOverview>(`/api/locations/${encodeURIComponent(locationId)}/integrations`, 'GET')
}

export function connectFudo(locationId: string, input: { apiKey: string; apiSecret: string }) {
  return send<FudoIntegrationView>(
    `/api/locations/${encodeURIComponent(locationId)}/integrations/fudo`,
    'POST',
    input,
  )
}

export function updateFudoCredentials(locationId: string, input: { apiKey: string; apiSecret: string }) {
  return send<FudoIntegrationView>(
    `/api/locations/${encodeURIComponent(locationId)}/integrations/fudo`,
    'PUT',
    input,
  )
}

export function testFudoConnection(locationId: string, input?: { apiKey: string; apiSecret: string }) {
  return send<{ ok: boolean }>(
    `/api/locations/${encodeURIComponent(locationId)}/integrations/fudo/test`,
    'POST',
    input ?? {},
  )
}

export function disconnectFudo(locationId: string) {
  return send<FudoIntegrationView>(
    `/api/locations/${encodeURIComponent(locationId)}/integrations/fudo`,
    'DELETE',
  )
}

export function syncFudoCatalog(locationId: string) {
  return send<FudoSyncJobView>(
    `/api/locations/${encodeURIComponent(locationId)}/integrations/fudo/sync`,
    'POST',
  )
}

import { Router, type RequestHandler } from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FudoIntegrationError,
  connectFudoIntegration,
  disconnectFudoIntegration,
  getFudoIntegrationView,
  requestFudoCatalogSync,
  testFudoIntegration,
  type FudoIntegrationDeps,
} from '../http/fudoIntegration.js'
import { createSupabaseFudoIntegrationStore } from '../http/fudoIntegrationRepository.js'
import { ProviderSecretCipherError, decodeProviderCredentialsKey } from '../http/providerSecretCipher.js'
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js'
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '../lib/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function param(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

export type FudoIntegrationRouterOptions = {
  auth?: RequestHandler
  depsFor?: () => FudoIntegrationDeps
}

function sendError(response: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown) {
  if (error instanceof FudoIntegrationError) {
    response.status(error.status).json({ error: error.message, code: error.code })
    return
  }
  if (error instanceof ProviderSecretCipherError) {
    response.status(503).json({
      error: 'El cifrado de credenciales no está configurado.',
      code: error.code,
    })
    return
  }
  response.status(500).json({ error: 'No se pudo completar la operación.' })
}

export function fudoIntegrationDepsFromEnv(admin: SupabaseClient | null = null): FudoIntegrationDeps {
  const client = admin ?? (isSupabaseAdminConfigured() ? getSupabaseAdmin() : null)
  if (!client) {
    throw new FudoIntegrationError('La integración no está configurada.', 'ADMIN_MISSING', 503)
  }
  return {
    store: createSupabaseFudoIntegrationStore(client),
    credentialsKey: decodeProviderCredentialsKey(process.env.PROVIDER_CREDENTIALS_KEY),
    admin: client,
    webhookUrl: process.env.N8N_FUDO_CATALOG_WEBHOOK_URL?.trim() || undefined,
    webhookSecret: process.env.N8N_FUDO_CATALOG_WEBHOOK_SECRET?.trim() || undefined,
  }
}

export function createFudoIntegrationRouter(options: FudoIntegrationRouterOptions = {}) {
  const router = Router()
  const auth = options.auth ?? requireAuth
  const depsFor = options.depsFor ?? (() => fudoIntegrationDepsFromEnv())

  router.get('/locations/:locationId/integrations', auth, async (request, response) => {
    const locationId = param(request.params.locationId)
    if (!UUID.test(locationId)) {
      response.status(400).json({ error: 'Local inválido.' })
      return
    }
    try {
      const { user } = request as AuthenticatedRequest
      response.json({ data: await getFudoIntegrationView(depsFor(), user.id, locationId) })
    } catch (error) {
      sendError(response, error)
    }
  })

  router.post('/locations/:locationId/integrations/fudo', auth, async (request, response) => {
    await write(request, response, depsFor, (deps, userId, locationId) => (
      connectFudoIntegration(deps, userId, locationId, request.body)
    ))
  })

  router.put('/locations/:locationId/integrations/fudo', auth, async (request, response) => {
    await write(request, response, depsFor, (deps, userId, locationId) => (
      connectFudoIntegration(deps, userId, locationId, request.body)
    ))
  })

  router.post('/locations/:locationId/integrations/fudo/test', auth, async (request, response) => {
    await write(request, response, depsFor, (deps, userId, locationId) => (
      testFudoIntegration(deps, userId, locationId, request.body)
    ))
  })

  router.delete('/locations/:locationId/integrations/fudo', auth, async (request, response) => {
    await write(request, response, depsFor, (deps, userId, locationId) => (
      disconnectFudoIntegration(deps, userId, locationId)
    ))
  })

  router.post('/locations/:locationId/integrations/fudo/sync', auth, async (request, response) => {
    await write(request, response, depsFor, (deps, userId, locationId) => (
      requestFudoCatalogSync(deps, userId, locationId)
    ))
  })

  return router
}

async function write(
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
  depsFor: () => FudoIntegrationDeps,
  action: (deps: FudoIntegrationDeps, userId: string, locationId: string) => Promise<unknown>,
) {
  const locationId = param(request.params.locationId)
  if (!UUID.test(locationId)) {
    response.status(400).json({ error: 'Local inválido.' })
    return
  }
  try {
    const { user } = request as AuthenticatedRequest
    response.json({ data: await action(depsFor(), user.id, locationId) })
  } catch (error) {
    sendError(response, error)
  }
}

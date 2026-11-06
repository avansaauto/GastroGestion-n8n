import { Router } from 'express'
import {
  FudoIntegrationError,
  getFudoSyncJob,
  runFudoSyncJob,
  type FudoIntegrationDeps,
} from '../http/fudoIntegration.js'
import {
  FUDO_CATALOG_SYNC_SCOPE,
  FUDO_SYNC_RUN_SCOPE,
  IntegrationAuthError,
  authenticateIntegration,
  type IntegrationPrincipal,
} from '../http/integrationAuth.js'
import { createIntegrationCredentialRepository } from '../http/integrationCredentialRepository.js'
import { ProviderSecretCipherError } from '../http/providerSecretCipher.js'
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '../lib/supabase.js'
import { fudoIntegrationDepsFromEnv } from './fudoIntegration.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function param(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

export type FudoSyncJobRouterOptions = {
  depsFor?: () => FudoIntegrationDeps
  pepper?: string
  repository?: ReturnType<typeof createIntegrationCredentialRepository>
}

function sendError(response: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown) {
  if (error instanceof FudoIntegrationError || error instanceof IntegrationAuthError) {
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
  response.status(500).json({ error: 'No se pudo completar la sincronización.' })
}

export function createFudoSyncJobRouter(options: FudoSyncJobRouterOptions = {}) {
  const router = Router()

  async function principalOf(request: { header: (name: string) => string | undefined; body: unknown }): Promise<IntegrationPrincipal> {
    const pepper = options.pepper ?? process.env.INTEGRATION_AUTH_PEPPER?.trim() ?? ''
    if (!pepper) {
      throw new FudoIntegrationError('La sincronización no está configurada.', 'PEPPER_MISSING', 503)
    }
    if (!options.repository && !isSupabaseAdminConfigured()) {
      throw new FudoIntegrationError('La sincronización no está configurada.', 'ADMIN_MISSING', 503)
    }
    const repository = options.repository
      ?? createIntegrationCredentialRepository(getSupabaseAdmin())
    try {
      return await authenticateIntegration({
        authorizationHeader: request.header('authorization'),
        body: request.body,
        pepper,
        repository,
        requiredScope: FUDO_CATALOG_SYNC_SCOPE,
      })
    } catch (error) {
      if (!(error instanceof IntegrationAuthError) || error.code !== 'SCOPE_DENIED') throw error
    }
    return authenticateIntegration({
      authorizationHeader: request.header('authorization'),
      body: request.body,
      pepper,
      repository,
      requiredScope: FUDO_SYNC_RUN_SCOPE,
    })
  }

  router.get('/integrations/fudo/sync-jobs/:jobId', async (request, response) => {
    if (!UUID.test(param(request.params.jobId))) {
      response.status(400).json({ error: 'Trabajo inválido.' })
      return
    }
    try {
      const deps = (options.depsFor ?? (() => fudoIntegrationDepsFromEnv()))()
      const principal = await principalOf(request)
      response.json({ data: await getFudoSyncJob(deps, principal, param(request.params.jobId)) })
    } catch (error) {
      sendError(response, error)
    }
  })

  router.post('/integrations/fudo/sync-jobs/:jobId/run', async (request, response) => {
    if (!UUID.test(param(request.params.jobId))) {
      response.status(400).json({ error: 'Trabajo inválido.' })
      return
    }
    try {
      const deps = (options.depsFor ?? (() => fudoIntegrationDepsFromEnv()))()
      const principal = await principalOf(request)
      const result = await runFudoSyncJob(deps, principal, param(request.params.jobId))
      response.json({ data: result })
    } catch (error) {
      sendError(response, error)
    }
  })

  return router
}

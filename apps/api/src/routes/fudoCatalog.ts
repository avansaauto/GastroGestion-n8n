import { Router } from 'express'
import {
  FudoCatalogSyncError,
  syncFudoProductCatalog,
} from '../http/fudoCatalogSync.js'
import { createIntegrationCredentialRepository } from '../http/integrationCredentialRepository.js'
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '../lib/supabase.js'

export function createFudoCatalogRouter() {
  const router = Router()

  router.post('/integrations/fudo/catalog', async (request, response) => {
    const pepper = process.env.INTEGRATION_AUTH_PEPPER?.trim() ?? ''
    if (!pepper) {
      response.status(503).json({
        error: 'La sincronización de catálogo no está configurada.',
        code: 'PEPPER_MISSING',
      })
      return
    }
    if (!isSupabaseAdminConfigured()) {
      response.status(503).json({
        error: 'La sincronización de catálogo no está configurada.',
        code: 'ADMIN_MISSING',
      })
      return
    }

    try {
      const admin = getSupabaseAdmin()
      const result = await syncFudoProductCatalog({
        authorizationHeader: request.header('authorization'),
        body: request.body,
        pepper,
        repository: createIntegrationCredentialRepository(admin),
        admin,
      })
      response.json({ data: result })
    } catch (error) {
      if (error instanceof FudoCatalogSyncError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudo sincronizar el catálogo Fudo.' })
    }
  })

  return router
}

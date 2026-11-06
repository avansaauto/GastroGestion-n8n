import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FUDO_CATALOG_SYNC_SCOPE,
  IntegrationAuthError,
  authenticateIntegration,
  type IntegrationCredentialRepository,
} from './integrationAuth.js'

export const FUDO_CATALOG_SYNC_MAX_BATCH = 500

export type FudoCatalogProductInput = {
  externalProductId: string
  name: string
  active: boolean
}

export type FudoCatalogSyncResult = {
  organizationId: string
  locationId: string
  received: number
  upserted: number
  deactivated: number
  lastSyncedAt: string
}

export class FudoCatalogSyncError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'FudoCatalogSyncError'
  }
}

export function parseFudoCatalogSyncBody(body: unknown): {
  products: FudoCatalogProductInput[]
  markMissingInactive: boolean
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FudoCatalogSyncError('El cuerpo debe ser un objeto.', 'INVALID_BODY', 400)
  }
  const record = body as Record<string, unknown>
  if (!Array.isArray(record.products)) {
    throw new FudoCatalogSyncError('Falta products.', 'INVALID_PRODUCTS', 400)
  }
  if (record.products.length === 0) {
    throw new FudoCatalogSyncError('El lote no puede estar vacío.', 'EMPTY_BATCH', 400)
  }
  if (record.products.length > FUDO_CATALOG_SYNC_MAX_BATCH) {
    throw new FudoCatalogSyncError(
      `El lote supera ${FUDO_CATALOG_SYNC_MAX_BATCH} productos.`,
      'BATCH_TOO_LARGE',
      400,
    )
  }

  const seen = new Set<string>()
  const products: FudoCatalogProductInput[] = []
  for (const raw of record.products) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new FudoCatalogSyncError('Producto inválido.', 'INVALID_PRODUCT', 400)
    }
    const row = raw as Record<string, unknown>
    const externalProductId = text(row.externalProductId ?? row.external_product_id ?? row.product_id)
    const name = text(row.name)
    if (!externalProductId || !name) {
      throw new FudoCatalogSyncError(
        'Cada producto necesita externalProductId y name.',
        'INVALID_PRODUCT',
        400,
      )
    }
    if (seen.has(externalProductId)) {
      throw new FudoCatalogSyncError(
        `ID externo duplicado en el lote: ${externalProductId}.`,
        'DUPLICATE_IN_BATCH',
        400,
      )
    }
    seen.add(externalProductId)
    const active = row.active === undefined ? true : row.active === true
    if (row.active !== undefined && typeof row.active !== 'boolean') {
      throw new FudoCatalogSyncError('active debe ser boolean.', 'INVALID_PRODUCT', 400)
    }
    products.push({ externalProductId, name, active })
  }

  const markMissingInactive = record.markMissingInactive === true
    || record.mark_missing_inactive === true

  return { products, markMissingInactive }
}

export async function syncFudoProductCatalog(input: {
  authorizationHeader: string | undefined
  body: unknown
  pepper: string
  repository: IntegrationCredentialRepository
  admin: SupabaseClient
  now?: Date
}): Promise<FudoCatalogSyncResult> {
  let principal
  try {
    principal = await authenticateIntegration({
      authorizationHeader: input.authorizationHeader,
      body: input.body,
      pepper: input.pepper,
      repository: input.repository,
      requiredScope: FUDO_CATALOG_SYNC_SCOPE,
      now: input.now,
    })
  } catch (error) {
    if (error instanceof IntegrationAuthError) {
      throw new FudoCatalogSyncError(error.message, error.code, error.status)
    }
    throw error
  }

  const parsed = parseFudoCatalogSyncBody(input.body)
  return writeFudoCatalogBatch({
    admin: input.admin,
    organizationId: principal.organizationId,
    locationId: principal.locationId,
    products: parsed.products,
    markMissingInactive: parsed.markMissingInactive,
    now: input.now,
  })
}

/** Upsert idempotente. No desactiva ausentes salvo un lote marcado como completo. */
export async function writeFudoCatalogBatch(input: {
  admin: SupabaseClient
  organizationId: string
  locationId: string
  products: FudoCatalogProductInput[]
  markMissingInactive: boolean
  now?: Date
}): Promise<FudoCatalogSyncResult> {
  const syncedAt = (input.now ?? new Date()).toISOString()
  const rows = input.products.map((product) => ({
    organization_id: input.organizationId,
    location_id: input.locationId,
    source: 'fudo',
    external_product_id: product.externalProductId,
    name: product.name,
    active: product.active,
    last_synced_at: syncedAt,
    updated_at: syncedAt,
  }))

  const { error } = await input.admin
    .from('fudo_product_catalog')
    .upsert(rows, { onConflict: 'location_id,source,external_product_id' })

  if (error) {
    throw new FudoCatalogSyncError(
      'No se pudo guardar el catálogo.',
      'UPSERT_FAILED',
      500,
    )
  }

  let deactivated = 0
  if (input.markMissingInactive) {
    const ids = input.products.map((product) => product.externalProductId)
    const { data: existing, error: listError } = await input.admin
      .from('fudo_product_catalog')
      .select('external_product_id')
      .eq('location_id', input.locationId)
      .eq('source', 'fudo')
      .eq('active', true)

    if (listError) {
      throw new FudoCatalogSyncError(
        'No se pudo revisar productos ausentes.',
        'DEACTIVATE_FAILED',
        500,
      )
    }

    const present = new Set(ids)
    const missing = (existing ?? [])
      .map((row) => String((row as { external_product_id?: string }).external_product_id ?? ''))
      .filter((id) => id && !present.has(id))

    if (missing.length > 0) {
      const { error: deactivateError } = await input.admin
        .from('fudo_product_catalog')
        .update({ active: false, updated_at: syncedAt, last_synced_at: syncedAt })
        .eq('location_id', input.locationId)
        .eq('source', 'fudo')
        .in('external_product_id', missing)

      if (deactivateError) {
        throw new FudoCatalogSyncError(
          'No se pudieron desactivar productos ausentes.',
          'DEACTIVATE_FAILED',
          500,
        )
      }
      deactivated = missing.length
    }
  }

  return {
    organizationId: input.organizationId,
    locationId: input.locationId,
    received: input.products.length,
    upserted: input.products.length,
    deactivated,
    lastSyncedAt: syncedAt,
  }
}

function text(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return ''
}

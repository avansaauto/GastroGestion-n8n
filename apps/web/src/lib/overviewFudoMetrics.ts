import type { PendingProduct } from '@/lib/api'
import { fudoProductAlreadyLinked } from '@/lib/fudoProductPicker'
import { pendingProductIdentity } from '@/lib/pendingRecipe'

export type OverviewFudoMetrics = {
  /** Productos Fudo únicos conocidos (catálogo y/o detecciones históricas). */
  detectedTotal: number
  /** Filas históricas con status=pending. */
  pendingDetected: number
  /** Sin mapping activo. */
  withoutActiveLink: number
  /** Con mapping activo / recipe_id. */
  linked: number
  /** Filas del catálogo sincronizado (incluye inactivos). */
  catalogSynced: number
  /** Catálogo con active=true. */
  catalogActive: number
  /** Activos del catálogo sin mapping. */
  catalogUnlinkedActive: number
  /** Hay al menos un producto del catálogo persistente. */
  hasCatalog: boolean
}

function identityKey(source: string, externalProductId: string) {
  return `${source}::${externalProductId}`
}

function isFudoProduct(product: PendingProduct) {
  const identity = pendingProductIdentity(product)
  return identity?.source === 'fudo'
}

function isPendingStatus(product: PendingProduct) {
  const status = typeof product.status === 'string' ? product.status.trim().toLowerCase() : ''
  return !status || status === 'pending'
}

/**
 * Contadores del Resumen a partir de pending_product_mappings (+ relations).
 * Deduplica por (source, external_product_id). No representa el catálogo Fudo completo.
 */
export function summarizeOverviewFudoMetrics(
  products: PendingProduct[],
): OverviewFudoMetrics {
  const byKey = new Map<string, PendingProduct>()

  for (const product of products) {
    if (!isFudoProduct(product)) continue
    const identity = pendingProductIdentity(product)
    if (!identity) continue
    const key = identityKey(identity.source, identity.externalProductId)
    const current = byKey.get(key)
    if (!current) {
      byKey.set(key, product)
      continue
    }
    // Preferir la fila vinculada si hubiera duplicados anómalos.
    if (fudoProductAlreadyLinked(product) && !fudoProductAlreadyLinked(current)) {
      byKey.set(key, product)
    }
  }

  let pendingDetected = 0
  let withoutActiveLink = 0
  let linked = 0
  let catalogSynced = 0
  let catalogActive = 0
  let catalogUnlinkedActive = 0

  for (const product of byKey.values()) {
    const inCatalog = product.catalog_active === true || product.catalog_active === false
    if (inCatalog) catalogSynced += 1
    if (product.catalog_active === true) catalogActive += 1

    if (fudoProductAlreadyLinked(product)) {
      linked += 1
      continue
    }
    withoutActiveLink += 1
    if (product.catalog_active === true) catalogUnlinkedActive += 1
    if (isPendingStatus(product)) pendingDetected += 1
  }

  return {
    detectedTotal: byKey.size,
    pendingDetected,
    withoutActiveLink,
    linked,
    catalogSynced,
    catalogActive,
    catalogUnlinkedActive,
    hasCatalog: catalogSynced > 0,
  }
}

export const OVERVIEW_FUDO_COVERAGE_NOTE =
  'Detección histórica por ventas · el catálogo completo todavía no está sincronizado'

export const OVERVIEW_FUDO_CATALOG_NOTE =
  'Catálogo Fudo sincronizado · los inactivos no se ofrecen para nuevas vinculaciones'

import type { PendingProduct, RecipeListMapping } from './api'
import {
  pendingProductIdentity,
  pendingProductName,
  pendingTimestamp,
} from './pendingRecipe'

export type RecipePageView = 'recetas' | 'historial'
export type FudoHistoryFilter = 'all' | 'pending' | 'resolved'

export type RecipeFudoRecord = {
  source: string
  externalProductId: string
  externalProductName: string | null
  firstSeenAt: string | null
  lastSeenAt: string | null
  pendingStatus: string | null
  mappingActive: boolean
}

export type FudoHistoryItem = {
  id: string
  name: string
  source: string
  externalProductId: string
  status: 'pending' | 'resolved'
  firstSeenAt: string | null
  lastSeenAt: string | null
  recipeId: string | null
  recipeName: string | null
  mappingActive: boolean | null
}

export function fudoIdentityKey(source: string, externalProductId: string) {
  return `${source}::${externalProductId}`
}

export function parseRecipePageView(search: URLSearchParams): RecipePageView {
  return search.get('vista') === 'historial' ? 'historial' : 'recetas'
}

export function parseFudoHistoryFilter(search: URLSearchParams): FudoHistoryFilter {
  const value = search.get('fudo')
  if (value === 'pending' || value === 'resolved') return value
  return 'all'
}

export function recipePagePath(view: RecipePageView, fudo: FudoHistoryFilter = 'all') {
  if (view !== 'historial') return '/recetas'
  const params = new URLSearchParams({ vista: 'historial' })
  if (fudo !== 'all') params.set('fudo', fudo)
  return `/recetas?${params}`
}

export function pendingListRedirectPath(_search: URLSearchParams) {
  return '/recetas'
}

export function pendingCreateRedirectPath(search: URLSearchParams) {
  const query = search.toString()
  return query ? `/recetas/crear?${query}` : '/recetas/crear'
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return null
}

export function indexFudoDetections(products: PendingProduct[]) {
  const byKey = new Map<string, PendingProduct>()
  for (const product of products) {
    const identity = pendingProductIdentity(product)
    if (!identity) continue
    const key = fudoIdentityKey(identity.source, identity.externalProductId)
    if (!byKey.has(key)) byKey.set(key, product)
  }
  return byKey
}

export function fudoRecordsForMappings(
  mappings: RecipeListMapping[],
  detections: Map<string, PendingProduct>,
): RecipeFudoRecord[] {
  const records: RecipeFudoRecord[] = []
  const seen = new Set<string>()
  for (const mapping of mappings) {
    if (!mapping.active) continue
    const key = fudoIdentityKey(mapping.source, mapping.externalProductId)
    if (seen.has(key)) continue
    seen.add(key)
    const detection = detections.get(key)
    records.push({
      source: mapping.source,
      externalProductId: mapping.externalProductId,
      externalProductName: mapping.externalProductName,
      firstSeenAt: pendingTimestamp(detection?.first_seen_at),
      lastSeenAt: pendingTimestamp(detection?.last_seen_at),
      pendingStatus: optionalText(detection?.status),
      mappingActive: true,
    })
  }
  return records
}

export function buildFudoHistory(products: PendingProduct[]): FudoHistoryItem[] {
  const items: FudoHistoryItem[] = []
  const seen = new Set<string>()
  for (const product of products) {
    const identity = pendingProductIdentity(product)
    if (!identity || seen.has(product.id)) continue
    seen.add(product.id)
    const recipeId = optionalText(product.recipe_id)
    items.push({
      id: product.id,
      name: pendingProductName(product),
      source: identity.source,
      externalProductId: identity.externalProductId,
      status: product.status === 'resolved' ? 'resolved' : 'pending',
      firstSeenAt: pendingTimestamp(product.first_seen_at),
      lastSeenAt: pendingTimestamp(product.last_seen_at),
      recipeId,
      recipeName: optionalText(product.recipe_name),
      mappingActive: optionalBoolean(product.mapping_active),
    })
  }
  return items
}

export function filterFudoHistory(
  items: FudoHistoryItem[],
  search: string,
  status: FudoHistoryFilter = 'all',
) {
  const term = search.trim().toLocaleLowerCase('es')
  return items.filter((item) => {
    if (status !== 'all' && item.status !== status) return false
    if (!term) return true
    return [
      item.name,
      item.source,
      item.externalProductId,
      item.recipeName,
    ].some((value) => value?.toLocaleLowerCase('es').includes(term))
  })
}

export function fudoHistoryCanCreate(item: Pick<FudoHistoryItem, 'status' | 'mappingActive'>) {
  return item.status === 'pending' && item.mappingActive !== true
}

export function fudoMappingStatusLabel(active: boolean | null) {
  if (active === true) return 'Activo'
  if (active === false) return 'Inactivo'
  return '—'
}

export function fudoLinkedRecipeLabel(item: Pick<FudoHistoryItem, 'recipeName' | 'recipeId'>) {
  return item.recipeName?.trim() || '—'
}

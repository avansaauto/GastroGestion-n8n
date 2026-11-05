import { AlertCircle, Loader2, Pencil, Search, Trash2, UtensilsCrossed } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import {
  getLocationRecipes,
  getLocationRecipePrices,
  setLocationRecipePrice,
  getOrganizationRecipeCategories,
  getOrganizationRecipeUsage,
  getOrganizationRecipes,
  getRecipe,
  RecipeSaveApiError,
  deleteOrganizationRecipe,
  setOrganizationRecipeActive,
  type OrganizationRecipeItem,
  type PendingProduct,
  type RecipeCategory,
  type RecipeComponentDetail,
  type RecipeConsumptionMode,
  type RecipeDetail,
  type LocationRecipePrice,
  type RecipeListItem,
  type RecipeListMapping,
  type RecipeUsage,
} from '@/lib/api'
import {
  filterFudoHistory,
  fudoHistoryCanCreate,
  fudoIdentityKey,
  fudoLinkedRecipeLabel,
  fudoMappingStatusLabel,
  fudoRecordsForMappings,
  indexFudoDetections,
  parseRecipePageView,
  pendingCreateRedirectPath,
  pendingListRedirectPath,
  type FudoHistoryFilter,
  type FudoHistoryItem,
  type RecipeFudoRecord,
} from '@/lib/fudoHistory'
import {
  canBeginRecipeSave,
  createRecipePath,
  formatPendingTimestamp,
  pendingProductIdentity,
  pendingProductName,
  pendingTimestamp,
  recipeSaveErrorMessage,
} from '@/lib/pendingRecipe'
import { recipeCategoryTabs } from '@/lib/recipeCategories'
import {
  RECIPE_INACTIVE_UNAVAILABLE,
  RECIPE_PENDING_DISCARD_BLOCKED,
  RECIPE_PRICE_CONFLICT,
  RECIPE_PRICE_UNIT_ONLY,
} from '@/lib/recipeDraft'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import { locationName, organizationName } from '@/lib/operations'

export type RecipeCostKind = 'none' | 'pending' | 'complete'

export type RecipeCostFields = {
  consumptionMode: RecipeConsumptionMode
  costPerYield: number | null
  costIncomplete: boolean
}

export type RecipeCatalogKind = 'recipe' | 'pending_fudo'

export type RecipeCatalogItem = {
  id: string
  kind: RecipeCatalogKind
  name: string
  recipeType: string
  active: boolean
  yieldQuantity: number
  yieldUnit: string
  consumptionMode: RecipeConsumptionMode
  componentCount: number
  category: string | null
  categoryId: string | null
  mappings: RecipeListMapping[]
  pendingStatus: string | null
  pendingIdentity: { source: string; externalProductId: string } | null
  fudoRecords: RecipeFudoRecord[]
  firstSeenAt: string | null
  lastSeenAt: string | null
  costPerYield: number | null
  costIncomplete: boolean
  hasInvalidQuantities: boolean
  salePrice: number | null
  salePriceVersion: number | null
}

export const RECIPE_CATEGORIES_EMPTY =
  'Todavía no hay categorías. Vas a poder crearlas al guardar una receta.'
export const RECIPE_CATALOG_EMPTY = 'Todavía no hay recetas.'
export const RECIPE_INACTIVE_EMPTY = 'No hay recetas inactivas.'
export const RECIPE_FUDO_MAPPING_WARNING =
  'Esta receta tiene mappings Fudo activos. Los mappings no se desactivan.'

export type RecipeLinkFilter = 'all' | 'pending' | 'linked' | 'unlinked'
export type RecipeStatusFilter = 'active' | 'inactive' | 'all'

export const RECIPE_LINK_FILTERS: Array<{ id: RecipeLinkFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'linked', label: 'Vinculado' },
  { id: 'unlinked', label: 'Sin vincular' },
]

export const RECIPE_STATUS_FILTERS: Array<{ id: RecipeStatusFilter; label: string }> = [
  { id: 'active', label: 'Activas' },
  { id: 'inactive', label: 'Inactivas' },
  { id: 'all', label: 'Todas' },
]

export function matchesRecipeStatusFilter(item: Pick<RecipeCatalogItem, 'kind' | 'active'>, filter: RecipeStatusFilter) {
  if (item.kind === 'pending_fudo') return false
  if (filter === 'all') return true
  if (filter === 'inactive') return item.active === false
  return item.active !== false
}

export function recipeStatusActionLabel(active: boolean) {
  return active ? 'Desactivar' : 'Reactivar'
}

export function recipeDependentsBlockMessage(names: string[]) {
  const list = names.filter(Boolean)
  if (list.length === 0) {
    return 'No se puede desactivar porque otras recetas activas la usan como subreceta.'
  }
  return `No se puede desactivar porque estas recetas activas la usan como subreceta: ${list.join(', ')}.`
}

export function recipeFudoMappingWarning(count: number) {
  if (count <= 0) return null
  return RECIPE_FUDO_MAPPING_WARNING
}

export function recipesScopeKey(organizationId: string, locationId: string) {
  return `${organizationId}::${locationId}`
}

export function recipesForScope<T>(loadedKey: string, scopeKey: string, recipes: T[]) {
  return loadedKey === scopeKey ? recipes : []
}

export function recipeListRowKey(item: { id: string }) {
  return item.id
}

export function recipeConsumptionLabel(mode: RecipeConsumptionMode) {
  if (mode === 'none') return 'Sin consumo'
  if (mode === 'direct') return 'Directo'
  return 'Compuesto'
}

export function recipeCostKind(item: RecipeCostFields): RecipeCostKind {
  if (item.consumptionMode === 'none') return 'none'
  if (item.costIncomplete || item.costPerYield == null) return 'pending'
  return 'complete'
}

export function formatRecipeCost(value: number) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value)
}

export function recipeCostAmountLabel(item: RecipeCostFields & { kind?: RecipeCatalogKind }) {
  if (item.kind === 'pending_fudo') return '—'
  const kind = recipeCostKind(item)
  if (kind === 'none') return 'Sin consumo'
  if (kind === 'pending') return 'Costo pendiente'
  return formatRecipeCost(item.costPerYield ?? 0)
}

export function recipeCostStatusLabel(item: RecipeCostFields) {
  const kind = recipeCostKind(item)
  if (kind === 'none') return 'Sin consumo'
  if (kind === 'pending') return 'Pendiente'
  return 'Completo'
}

export function recipeHasComparableSellableYield(
  item: Pick<RecipeCatalogItem, 'kind' | 'yieldQuantity' | 'yieldUnit'>,
) {
  if (item.kind === 'pending_fudo') return false
  return item.yieldUnit === 'unit' && Number.isFinite(item.yieldQuantity) && item.yieldQuantity > 0
}

export function recipeGrossMarginPct(item: RecipeCatalogItem): number | null {
  if (item.kind === 'pending_fudo') return null
  if (item.salePrice == null || !(item.salePrice > 0)) return null
  if (!recipeHasComparableSellableYield(item)) return null
  if (item.costIncomplete || item.costPerYield == null || !Number.isFinite(item.costPerYield) || item.costPerYield < 0) {
    return null
  }
  return ((item.salePrice - item.costPerYield) / item.salePrice) * 100
}

export function formatRecipeMarginPct(value: number) {
  return `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(value)}%`
}

export function recipeSalePriceLabel(item?: RecipeCatalogItem) {
  if (!item || item.kind === 'pending_fudo' || item.salePrice == null || !(item.salePrice > 0)) return '—'
  return formatRecipeCost(item.salePrice)
}

export const RECIPE_SALE_PRICE_MAX = 9999999999.99

export function parseArgentineMoneyInput(raw: string): number | null {
  let text = raw.trim().replace(/\$/g, '').replace(/\s/g, '')
  if (!text || text === '—') return null
  const hasComma = text.includes(',')
  const hasDot = text.includes('.')
  if (hasComma && hasDot) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '')
  } else if (hasComma) {
    text = text.replace(/\./g, '').replace(',', '.')
  } else if (hasDot) {
    const parts = text.split('.')
    if (parts.length > 2 || (parts[1]?.length ?? 0) === 3) {
      text = text.replace(/\./g, '')
    }
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

export function formatArgentineMoneyDraft(value: number) {
  if (!Number.isFinite(value)) return ''
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value)
}

export function recipePriceDraftValue(item: Pick<RecipeCatalogItem, 'salePrice'>) {
  if (item.salePrice == null || !(item.salePrice > 0)) return ''
  return formatArgentineMoneyDraft(item.salePrice)
}

export function recipePriceEditable(
  item: Pick<RecipeCatalogItem, 'kind' | 'active' | 'yieldUnit'>,
) {
  return item.kind === 'recipe' && item.active !== false && item.yieldUnit === 'unit'
}

export function recipePriceFieldTitle(
  item: Pick<RecipeCatalogItem, 'kind' | 'active' | 'yieldUnit'>,
) {
  if (item.kind !== 'recipe') return undefined
  if (item.active === false) return RECIPE_INACTIVE_UNAVAILABLE
  if (item.yieldUnit !== 'unit') return RECIPE_PRICE_UNIT_ONLY
  return undefined
}

export function expectedVersionForPrice(item: Pick<RecipeCatalogItem, 'salePriceVersion'>) {
  return item.salePriceVersion != null && Number.isInteger(item.salePriceVersion) && item.salePriceVersion > 0
    ? item.salePriceVersion
    : null
}

export function locationRecipePriceSaveBody(
  item: Pick<RecipeCatalogItem, 'salePriceVersion'>,
  draft: string,
): { ok: true; salePrice: number; expectedVersion: number | null } | { ok: false; error: string } {
  const parsed = parseArgentineMoneyInput(draft)
  if (parsed == null || !Number.isFinite(parsed)) {
    return { ok: false, error: 'Indicá un precio de venta válido.' }
  }
  const salePrice = Math.round(parsed * 100) / 100
  if (!(salePrice > 0) || salePrice > RECIPE_SALE_PRICE_MAX) {
    return { ok: false, error: 'Indicá un precio de venta válido.' }
  }
  return { ok: true, salePrice, expectedVersion: expectedVersionForPrice(item) }
}

export function locationRecipePriceSaveError(error: unknown) {
  const conflict = error instanceof RecipeSaveApiError && error.code === 'CONCURRENT_UPDATE'
  return {
    conflict,
    message: conflict ? RECIPE_PRICE_CONFLICT : recipeSaveErrorMessage(error),
  }
}

export function applySavedLocationPrice(
  recipes: RecipeCatalogItem[],
  recipeId: string,
  salePrice: number,
  version: number,
) {
  return recipes.map((row) => (
    row.id === recipeId && row.kind === 'recipe'
      ? { ...row, salePrice, salePriceVersion: version }
      : row
  ))
}

export function recipeMarginLabel(item?: RecipeCatalogItem) {
  if (!item) return '—'
  const pct = recipeGrossMarginPct(item)
  return pct == null ? '—' : formatRecipeMarginPct(pct)
}

export function recipeCategoryLabel(category: string | null | undefined) {
  const value = category?.trim()
  return value || '—'
}

export function recipeFudoProductIds(item: Pick<RecipeCatalogItem, 'mappings'>) {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const mapping of item.mappings) {
    if (!mapping.active) continue
    const value = mapping.externalProductId
    if (!value || seen.has(`${mapping.source}::${value}`)) continue
    seen.add(`${mapping.source}::${value}`)
    ids.push(value)
  }
  return ids
}

export function recipeFudoStatusLabel(item: Pick<RecipeCatalogItem, 'kind' | 'mappings'>) {
  if (item.kind === 'pending_fudo') return 'Sin vincular'
  return recipeFudoProductIds(item).length > 0 ? 'Vinculado' : 'Sin vincular'
}

export function recipeCatalogPencilHref(item: RecipeCatalogItem) {
  if (item.kind === 'pending_fudo' && item.pendingIdentity) {
    return createRecipePath(item.pendingIdentity)
  }
  if (item.kind === 'recipe' && item.active !== false) {
    return `/recetas/${encodeURIComponent(item.id)}/editar`
  }
  return null
}

export function recipeLinkFilter(item: Pick<RecipeCatalogItem, 'kind' | 'mappings'>): RecipeLinkFilter {
  if (item.kind === 'pending_fudo') return 'pending'
  return recipeFudoProductIds(item).length > 0 ? 'linked' : 'unlinked'
}

export function pendingCatalogRowId(pendingId: string) {
  return `pending:${pendingId}`
}

export { fudoIdentityKey } from '@/lib/fudoHistory'

export type RecipeComponentIssue = 'invalid_quantity' | 'missing_unit_cost' | 'nested_recipe' | null

export function recipeComponentIssue(component: RecipeComponentDetail): RecipeComponentIssue {
  if (!(component.quantity > 0)) return 'invalid_quantity'
  if (component.componentRecipeId) return 'nested_recipe'
  if (component.costMissing || component.unitCost == null) return 'missing_unit_cost'
  return null
}

export function recipeComponentIssueLabel(issue: RecipeComponentIssue) {
  if (issue === 'invalid_quantity') return 'Cantidad inválida'
  if (issue === 'missing_unit_cost') return 'Sin valuación'
  if (issue === 'nested_recipe') return 'Subreceta sin calcular'
  return null
}

export function recipeYieldLabel(quantity: number, unit: string) {
  const amount = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(quantity)
  if (unit === 'g') return `${amount} g`
  if (unit === 'ml') return `${amount} ml`
  if (unit === 'unit') return `${amount} u`
  return `${amount} ${unit}`
}

export function recipeYieldDisplay(item: RecipeCatalogItem) {
  if (item.kind === 'pending_fudo') return '—'
  return recipeYieldLabel(item.yieldQuantity, item.yieldUnit)
}

export function matchesRecipeSearch(item: RecipeCatalogItem, search: string) {
  const term = search.trim().toLocaleLowerCase('es')
  if (!term) return true
  return [
    item.name,
    ...item.mappings.map((mapping) => mapping.externalProductName),
  ].some((value) => value?.toLocaleLowerCase('es').includes(term))
}

export function filterRecipeCatalog(
  recipes: RecipeCatalogItem[],
  search: string,
  categoryId = 'all',
  linkFilter: RecipeLinkFilter = 'all',
  statusFilter: RecipeStatusFilter = 'all',
) {
  return recipes.filter((item) => {
    if (item.kind === 'pending_fudo') return false
    if (!matchesRecipeSearch(item, search)) return false
    if (linkFilter !== 'all' && recipeLinkFilter(item) !== linkFilter) return false
    if (!matchesRecipeStatusFilter(item, statusFilter)) return false
    if (categoryId === 'all') return true
    return item.categoryId === categoryId
  })
}

type RecipeCostOverlay = {
  id: string
  mapping?: RecipeListMapping | null
  pendingStatus?: string | null
  costPerYield: number | null
  costIncomplete: boolean
  hasInvalidQuantities: boolean
  consumptionMode?: RecipeConsumptionMode
  componentCount?: number
}

function collectRecipeMappings(
  locationRecipes: RecipeListItem[],
  detail?: RecipeCostOverlay,
) {
  const mappings: RecipeListMapping[] = []
  const seen = new Set<string>()
  for (const row of locationRecipes) {
    const mapping = row.mapping
    if (!mapping?.active) continue
    const key = fudoIdentityKey(mapping.source, mapping.externalProductId)
    if (seen.has(key)) continue
    seen.add(key)
    mappings.push(mapping)
  }
  if (detail?.mapping?.active) {
    const key = fudoIdentityKey(detail.mapping.source, detail.mapping.externalProductId)
    if (!seen.has(key)) mappings.push(detail.mapping)
  }
  return mappings
}

export function pendingCatalogRow(product: PendingProduct): RecipeCatalogItem | null {
  if (product.status === 'resolved') return null
  const identity = pendingProductIdentity(product)
  if (!identity) return null
  const name = pendingProductName(product)
  return {
    id: pendingCatalogRowId(product.id),
    kind: 'pending_fudo',
    name: name === '—' ? identity.externalProductId : name,
    recipeType: 'sale_product',
    active: true,
    yieldQuantity: 1,
    yieldUnit: 'unit',
    consumptionMode: 'none',
    componentCount: 0,
    category: null,
    categoryId: null,
    mappings: [],
    pendingStatus: product.status ?? 'pending',
    pendingIdentity: identity,
    fudoRecords: [{
      source: identity.source,
      externalProductId: identity.externalProductId,
      externalProductName: name === '—' ? null : name,
      firstSeenAt: pendingTimestamp(product.first_seen_at),
      lastSeenAt: pendingTimestamp(product.last_seen_at),
      pendingStatus: product.status ?? 'pending',
      mappingActive: false,
    }],
    firstSeenAt: pendingTimestamp(product.first_seen_at),
    lastSeenAt: pendingTimestamp(product.last_seen_at),
    costPerYield: null,
    costIncomplete: false,
    hasInvalidQuantities: false,
    salePrice: null,
    salePriceVersion: null,
  }
}

export function unifyRecipeCatalog(
  recipes: RecipeCatalogItem[],
  pendingProducts: PendingProduct[] = [],
): RecipeCatalogItem[] {
  const linked = new Set<string>()
  for (const recipe of recipes) {
    for (const mapping of recipe.mappings) {
      if (mapping.active) linked.add(fudoIdentityKey(mapping.source, mapping.externalProductId))
    }
  }
  const pendingRows: RecipeCatalogItem[] = []
  const seenPending = new Set<string>()
  for (const product of pendingProducts) {
    const row = pendingCatalogRow(product)
    if (!row?.pendingIdentity) continue
    const key = fudoIdentityKey(row.pendingIdentity.source, row.pendingIdentity.externalProductId)
    if (linked.has(key) || seenPending.has(key)) continue
    seenPending.add(key)
    pendingRows.push(row)
  }
  return [...recipes, ...pendingRows].sort((left, right) => left.name.localeCompare(right.name, 'es'))
}

export function overlayFudoDetections(
  recipes: RecipeCatalogItem[],
  detections: PendingProduct[],
): RecipeCatalogItem[] {
  const byKey = indexFudoDetections(detections)
  return recipes.map((recipe) => {
    if (recipe.kind === 'pending_fudo') return recipe
    const fudoRecords = fudoRecordsForMappings(recipe.mappings, byKey)
    const first = fudoRecords[0]
    return {
      ...recipe,
      fudoRecords,
      firstSeenAt: first?.firstSeenAt ?? null,
      lastSeenAt: first?.lastSeenAt ?? null,
    }
  })
}

export function mergeOrganizationRecipes(
  organizationRecipes: OrganizationRecipeItem[],
  locationRecipes: RecipeListItem[],
  details: RecipeCostOverlay[] = [],
): RecipeCatalogItem[] {
  const locationById = new Map<string, RecipeListItem[]>()
  for (const row of locationRecipes) {
    const list = locationById.get(row.id) ?? []
    list.push(row)
    locationById.set(row.id, list)
  }
  const detailById = new Map(details.map((row) => [row.id, row]))

  return organizationRecipes
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, 'es'))
    .map((row) => {
      const locationRows = locationById.get(row.id) ?? []
      const location = locationRows[0]
      const detail = detailById.get(row.id)
      const overlay = location ?? detail
      const mappings = collectRecipeMappings(locationRows, detail)
      const consumptionMode = overlay?.consumptionMode ?? row.consumptionMode
      if (!overlay) {
        const none = consumptionMode === 'none'
        return {
          id: row.id,
          kind: 'recipe' as const,
          name: row.name,
          recipeType: row.recipeType,
          active: row.active,
          yieldQuantity: row.yieldQuantity,
          yieldUnit: row.yieldUnit,
          consumptionMode,
          componentCount: row.componentCount,
          category: row.category?.name ?? null,
          categoryId: row.category?.id ?? null,
          mappings,
          pendingStatus: null,
          pendingIdentity: null,
          fudoRecords: [],
          firstSeenAt: null,
          lastSeenAt: null,
          costPerYield: none ? 0 : null,
          costIncomplete: !none,
          hasInvalidQuantities: false,
          salePrice: null,
          salePriceVersion: null,
        }
      }
      return {
        id: row.id,
        kind: 'recipe' as const,
        name: row.name,
        recipeType: row.recipeType,
        active: row.active,
        yieldQuantity: row.yieldQuantity,
        yieldUnit: row.yieldUnit,
        consumptionMode,
        componentCount: overlay.componentCount ?? row.componentCount,
        category: row.category?.name ?? null,
        categoryId: row.category?.id ?? null,
        mappings,
        pendingStatus: overlay.pendingStatus ?? null,
        pendingIdentity: null,
        fudoRecords: [],
        firstSeenAt: null,
        lastSeenAt: null,
        costPerYield: overlay.costPerYield,
        costIncomplete: overlay.costIncomplete,
        hasInvalidQuantities: overlay.hasInvalidQuantities,
        salePrice: null,
        salePriceVersion: null,
      }
    })
}

export function overlayLocationPrices(
  recipes: RecipeCatalogItem[],
  prices: LocationRecipePrice[],
): RecipeCatalogItem[] {
  const byRecipe = new Map<string, LocationRecipePrice>()
  for (const price of prices) {
    if (!(price.salePrice > 0) || !Number.isInteger(price.version) || price.version <= 0) continue
    byRecipe.set(price.recipeId, price)
  }
  return recipes.map((recipe) => {
    if (recipe.kind === 'pending_fudo') {
      return { ...recipe, salePrice: null, salePriceVersion: null }
    }
    const price = byRecipe.get(recipe.id)
    if (!price) return { ...recipe, salePrice: null, salePriceVersion: null }
    return {
      ...recipe,
      salePrice: price.salePrice,
      salePriceVersion: price.version,
    }
  })
}

export function toggleRecipeSelection(selected: string[], recipeId: string) {
  return selected.includes(recipeId)
    ? selected.filter((id) => id !== recipeId)
    : [...selected, recipeId]
}

export function selectVisibleRecipes(visibleIds: string[], checked: boolean) {
  return checked ? [...visibleIds] : []
}

export function pruneRecipeSelection(selected: string[], visibleIds: string[]) {
  const allowed = new Set(visibleIds)
  const next = selected.filter((id) => allowed.has(id))
  if (next.length === selected.length && next.every((id, index) => id === selected[index])) {
    return selected
  }
  return next
}

export function visibleRecipeSelectionState(selected: string[], visibleIds: string[]) {
  if (visibleIds.length === 0 || selected.length === 0) return 'none' as const
  const selectedSet = new Set(selected)
  const selectedVisible = visibleIds.filter((id) => selectedSet.has(id)).length
  if (selectedVisible === 0) return 'none' as const
  if (selectedVisible === visibleIds.length) return 'all' as const
  return 'some' as const
}

export const RECIPE_SELECT_ALL_VISIBLE_HINT =
  'Seleccionar todos marca solo las recetas visibles de esta página, no todos los resultados filtrados.'

export const RECIPE_BULK_RETIRE_LABEL = 'Retirar seleccionadas'
export const RECIPE_BULK_DELETE_LABEL = 'Eliminar definitivamente'

export function recipeBulkActionLabel(statusFilter: RecipeStatusFilter) {
  return statusFilter === 'inactive' ? RECIPE_BULK_DELETE_LABEL : RECIPE_BULK_RETIRE_LABEL
}

export function recipeBulkSelectionLabel(count: number) {
  return count === 1
    ? '1 receta visible seleccionada'
    : `${count} recetas visibles seleccionadas`
}

export type RecipeRetireKind = 'eligible' | 'pending_fudo' | 'already_inactive' | 'blocked'

export type RecipeRetireClassification = {
  id: string
  name: string
  kind: RecipeRetireKind
  usedByNames: string[]
  mappingWarning: boolean
}

export function classifyRecipeForRetire(
  item: RecipeCatalogItem,
  usage: RecipeUsage | null,
): RecipeRetireClassification {
  if (item.kind === 'pending_fudo') {
    return {
      id: item.id,
      name: item.name,
      kind: 'pending_fudo',
      usedByNames: [],
      mappingWarning: false,
    }
  }
  if (!item.active) {
    return {
      id: item.id,
      name: item.name,
      kind: 'already_inactive',
      usedByNames: [],
      mappingWarning: false,
    }
  }
  const usedByNames = (usage?.usedBy ?? []).map((row) => row.name).filter(Boolean)
  if (usedByNames.length > 0) {
    return {
      id: item.id,
      name: item.name,
      kind: 'blocked',
      usedByNames,
      mappingWarning: false,
    }
  }
  return {
    id: item.id,
    name: item.name,
    kind: 'eligible',
    usedByNames: [],
    mappingWarning: (usage?.activeMappingCount ?? item.mappings.length) > 0,
  }
}

export function recipeRetireSkipMessage(row: RecipeRetireClassification) {
  if (row.kind === 'pending_fudo') return RECIPE_PENDING_DISCARD_BLOCKED
  if (row.kind === 'already_inactive') {
    return 'Ya está retirada. Usá Eliminar definitivamente en Inactivas.'
  }
  if (row.kind === 'blocked') return recipeDependentsBlockMessage(row.usedByNames)
  return null
}

export type RecipeDeleteKind = 'eligible' | 'pending_fudo' | 'still_active' | 'blocked'

export type RecipeDeleteClassification = {
  id: string
  name: string
  kind: RecipeDeleteKind
  usedByNames: string[]
  mappingCount: number
}

export function classifyRecipeForPermanentDelete(
  item: RecipeCatalogItem,
  usage: RecipeUsage | null,
): RecipeDeleteClassification {
  if (item.kind === 'pending_fudo') {
    return {
      id: item.id,
      name: item.name,
      kind: 'pending_fudo',
      usedByNames: [],
      mappingCount: 0,
    }
  }
  if (item.active) {
    return {
      id: item.id,
      name: item.name,
      kind: 'still_active',
      usedByNames: [],
      mappingCount: item.mappings.length,
    }
  }
  const usedByNames = (usage?.usedBy ?? []).map((row) => row.name).filter(Boolean)
  if (usedByNames.length > 0) {
    return {
      id: item.id,
      name: item.name,
      kind: 'blocked',
      usedByNames,
      mappingCount: usage?.activeMappingCount ?? item.mappings.length,
    }
  }
  return {
    id: item.id,
    name: item.name,
    kind: 'eligible',
    usedByNames: [],
    mappingCount: usage?.activeMappingCount ?? item.mappings.length,
  }
}

export function recipeDeleteSkipMessage(row: RecipeDeleteClassification) {
  if (row.kind === 'pending_fudo') return RECIPE_PENDING_DISCARD_BLOCKED
  if (row.kind === 'still_active') return 'Todavía está activa. Retirala antes de eliminarla.'
  if (row.kind === 'blocked') return recipeDependentsBlockMessage(row.usedByNames)
  return null
}

export type RecipeBulkRetireOutcome = {
  id: string
  name: string
  result: 'retired' | 'skipped' | 'failed'
  reason?: string
  replay?: boolean
}

export type RecipeBulkRetireDialogState = {
  items: RecipeCatalogItem[]
  classifications: RecipeRetireClassification[]
  loading: boolean
  submitting: boolean
  error: string
  outcomes: RecipeBulkRetireOutcome[] | null
}

export type RecipeBulkDeleteOutcome = {
  id: string
  name: string
  result: 'deleted' | 'skipped' | 'failed'
  reason?: string
}

export type RecipeBulkDeleteDialogState = {
  items: RecipeCatalogItem[]
  classifications: RecipeDeleteClassification[]
  loading: boolean
  submitting: boolean
  error: string
  outcomes: RecipeBulkDeleteOutcome[] | null
}

async function loadRecipeCatalog(organizationId: string, locationId: string) {
  const [organizationRecipes, categories] = await Promise.all([
    getOrganizationRecipes(organizationId, { includeInactive: true }),
    getOrganizationRecipeCategories(organizationId).catch(() => [] as RecipeCategory[]),
  ])
  let locationRecipes: RecipeListItem[] = []
  let prices: LocationRecipePrice[] = []
  if (locationId) {
    const [mapped, locationPrices] = await Promise.all([
      getLocationRecipes(locationId).catch(() => [] as RecipeListItem[]),
      getLocationRecipePrices(organizationId, locationId).catch(() => [] as LocationRecipePrice[]),
    ])
    locationRecipes = mapped
    prices = locationPrices
  }
  const mappedIds = new Set(locationRecipes.map((row) => row.id))
  const missing = organizationRecipes.filter((row) => (
    row.active !== false && !mappedIds.has(row.id) && row.consumptionMode !== 'none' && locationId
  ))
  const details: RecipeDetail[] = []
  if (missing.length > 0) {
    const loaded = await Promise.all(missing.map((row) => (
      getRecipe(row.id, locationId).catch(() => null)
    )))
    for (const detail of loaded) {
      if (detail) details.push(detail)
    }
  }
  return {
    recipes: overlayLocationPrices(
      mergeOrganizationRecipes(organizationRecipes, locationRecipes, details),
      prices,
    ),
    history: [] as FudoHistoryItem[],
    categories,
  }
}

export function FudoDetailFields({
  locationLabel,
  records,
}: {
  locationLabel: string
  records: RecipeFudoRecord[]
}) {
  if (records.length === 0) {
    return (
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Local</dt>
          <dd className="mb-0 mt-1">{locationLabel.trim() || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Origen</dt>
          <dd className="mb-0 mt-1">—</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Identidad externa</dt>
          <dd className="mb-0 mt-1">—</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Nombre externo</dt>
          <dd className="mb-0 mt-1">—</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Primera detección</dt>
          <dd className="mb-0 mt-1">—</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Última detección</dt>
          <dd className="mb-0 mt-1">—</dd>
        </div>
      </dl>
    )
  }

  return (
    <div className="space-y-5">
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Local</dt>
          <dd className="mb-0 mt-1">{locationLabel.trim() || '—'}</dd>
        </div>
      </dl>
      {records.map((record) => (
        <dl className="space-y-3 border-t border-senda-border pt-4 text-sm" key={fudoIdentityKey(record.source, record.externalProductId)}>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Origen</dt>
            <dd className="mb-0 mt-1 font-semibold">{record.source || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Identidad externa</dt>
            <dd className="mb-0 mt-1">
              <Badge tone="success">{record.externalProductId}</Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Nombre externo</dt>
            <dd className="mb-0 mt-1">{record.externalProductName?.trim() || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Primera detección</dt>
            <dd className="mb-0 mt-1">{formatPendingTimestamp(record.firstSeenAt)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Última detección</dt>
            <dd className="mb-0 mt-1">{formatPendingTimestamp(record.lastSeenAt)}</dd>
          </div>
        </dl>
      ))}
    </div>
  )
}

const FUDO_HISTORY_FILTERS: Array<{ id: FudoHistoryFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'pending', label: 'Pendientes' },
  { id: 'resolved', label: 'Resueltos' },
]

export function FudoHistoryPanel({
  items,
  search,
  onSearch,
  status,
  onStatus,
  loading,
  error,
  locationLabel,
  detailItem,
  onOpenDetail,
  onCloseDetail,
}: {
  items: FudoHistoryItem[]
  search: string
  onSearch: (value: string) => void
  status: FudoHistoryFilter
  onStatus: (value: FudoHistoryFilter) => void
  loading: boolean
  error: string
  locationLabel: string
  detailItem: FudoHistoryItem | null
  onOpenDetail: (item: FudoHistoryItem) => void
  onCloseDetail: () => void
}) {
  const rows = useMemo(
    () => filterFudoHistory(items, search, status),
    [items, search, status],
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
          Buscar detecciones Fudo
          <span className="relative block">
            <Search className="absolute left-3 top-3 text-slate-400" size={17} />
            <Input
              className="pl-9"
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Buscar producto, ID o receta…"
              value={search}
            />
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          {FUDO_HISTORY_FILTERS.map((filter) => {
            const active = status === filter.id
            return (
              <button
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  active
                    ? 'bg-senda-navy text-white'
                    : 'border border-senda-border bg-white text-senda-muted hover:text-senda-ink'
                }`}
                key={filter.id}
                onClick={() => onStatus(filter.id)}
                type="button"
              >
                {filter.label}
              </button>
            )
          })}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-senda-muted">
            <Loader2 className="animate-spin" size={19} /> Cargando historial Fudo…
          </div>
        ) : rows.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-5 text-center text-sm text-senda-muted">
            {search
              ? 'No hay resultados para la búsqueda.'
              : 'No hay detecciones Fudo para el estado seleccionado.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className="border-b border-senda-border bg-senda-subtle text-xs uppercase tracking-wide text-senda-muted">
                <tr>
                  {['Producto', 'ID externo Fudo', 'Origen', 'Estado', 'Primera detección', 'Última detección', 'Receta vinculada', 'Mapping', 'Acciones'].map((label) => (
                    <th className="px-5 py-3 font-semibold" key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr className="border-b border-senda-border last:border-0" key={item.id}>
                    <td className="px-5 py-4 font-semibold">{item.name}</td>
                    <td className="px-5 py-4">
                      <Badge tone="success">{item.externalProductId}</Badge>
                    </td>
                    <td className="px-5 py-4">{item.source || '—'}</td>
                    <td className="px-5 py-4">
                      <Badge tone={item.status === 'resolved' ? 'success' : 'warning'}>
                        {item.status === 'resolved' ? 'resolved' : 'pending'}
                      </Badge>
                    </td>
                    <td className="px-5 py-4 text-senda-muted">{formatPendingTimestamp(item.firstSeenAt)}</td>
                    <td className="px-5 py-4 text-senda-muted">{formatPendingTimestamp(item.lastSeenAt)}</td>
                    <td className="px-5 py-4">{fudoLinkedRecipeLabel(item)}</td>
                    <td className="px-5 py-4">{fudoMappingStatusLabel(item.mappingActive)}</td>
                    <td className="px-5 py-4">
                      <div className="flex flex-col gap-2">
                        {fudoHistoryCanCreate(item) ? (
                          <>
                            <Link
                              className="text-sm font-semibold text-senda-navy hover:underline"
                              to={createRecipePath({
                                source: item.source,
                                externalProductId: item.externalProductId,
                              })}
                            >
                              Crear receta
                            </Link>
                            <Link
                              className="text-sm font-semibold text-senda-navy hover:underline"
                              to={createRecipePath({
                                source: item.source,
                                externalProductId: item.externalProductId,
                                intent: 'link',
                              })}
                            >
                              Vincular receta existente
                            </Link>
                          </>
                        ) : null}
                        <button
                          className="text-left text-sm font-semibold text-senda-navy hover:underline"
                          onClick={() => onOpenDetail(item)}
                          type="button"
                        >
                          Ver detalle
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={Boolean(detailItem)}
        title="Detalle del producto Fudo"
        onClose={onCloseDetail}
      >
        {detailItem && (
          <FudoDetailFields
            locationLabel={locationLabel}
            records={[{
              source: detailItem.source,
              externalProductId: detailItem.externalProductId,
              externalProductName: detailItem.name === '—' ? null : detailItem.name,
              firstSeenAt: detailItem.firstSeenAt,
              lastSeenAt: detailItem.lastSeenAt,
              pendingStatus: detailItem.status,
              mappingActive: detailItem.mappingActive === true,
            }]}
          />
        )}
      </Modal>
    </div>
  )
}

export type RecipeStatusDialogState = {
  item: RecipeCatalogItem
  nextActive: boolean
  usage: RecipeUsage | null
  loading: boolean
  error: string
  submitting: boolean
}

export function RecipeBulkRetireConfirm({
  dialog,
  onClose,
  onConfirm,
}: {
  dialog: RecipeBulkRetireDialogState | null
  onClose: () => void
  onConfirm: () => void
}) {
  if (!dialog) return null
  const eligible = dialog.classifications.filter((row) => row.kind === 'eligible')
  const skipped = dialog.classifications.filter((row) => row.kind !== 'eligible')
  const done = dialog.outcomes != null
  const retired = dialog.outcomes?.filter((row) => row.result === 'retired') ?? []
  const failed = dialog.outcomes?.filter((row) => row.result !== 'retired') ?? []
  const mappingWarning = eligible.some((row) => row.mappingWarning)
  const busy = dialog.loading || dialog.submitting

  return (
    <Modal open title="Retirar recetas" onClose={onClose}>
      <div className="space-y-4 text-sm">
        {!done && (
          <p className="mb-0">
            {eligible.length > 0
              ? `¿Retirar ${eligible.length} receta${eligible.length === 1 ? '' : 's'} visible${eligible.length === 1 ? '' : 's'}? Se desactivan sin borrar ingredientes, categoría, rendimiento, mappings Fudo, historial, stock ni ventas.`
              : 'Ninguna de las recetas seleccionadas se puede retirar con la operación actual.'}
          </p>
        )}
        <p className="mb-0 text-xs text-senda-muted">{RECIPE_SELECT_ALL_VISIBLE_HINT}</p>
        {dialog.loading && (
          <p className="mb-0 flex items-center gap-2 text-senda-muted">
            <Loader2 className="animate-spin" size={16} /> Consultando dependencias…
          </p>
        )}
        {!done && !dialog.loading && eligible.length > 0 && (
          <ul className="mb-0 list-disc space-y-1 pl-5">
            {eligible.map((row) => (
              <li key={row.id}>{row.name}</li>
            ))}
          </ul>
        )}
        {!done && skipped.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900">
            <p className="mb-2 font-semibold">No se retiran</p>
            <ul className="mb-0 list-disc space-y-1 pl-5">
              {skipped.map((row) => (
                <li key={row.id}>
                  {row.name}. {recipeRetireSkipMessage(row)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {mappingWarning && !done && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900">
            {RECIPE_FUDO_MAPPING_WARNING}
          </div>
        )}
        {done && (
          <div className="space-y-3">
            <p className="mb-0 font-semibold">
              {`${retired.length} retirada${retired.length === 1 ? '' : 's'}, ${failed.length} sin cambios.`}
            </p>
            {retired.length > 0 && (
              <ul className="mb-0 list-disc space-y-1 pl-5">
                {retired.map((row) => (
                  <li key={row.id}>
                    {row.name}
                    {row.replay ? ' (ya estaba retirada)' : ''}
                  </li>
                ))}
              </ul>
            )}
            {failed.length > 0 && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
                <ul className="mb-0 list-disc space-y-1 pl-5">
                  {failed.map((row) => (
                    <li key={row.id}>{row.name}. {row.reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {dialog.error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
            <AlertCircle size={16} /> {dialog.error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          {done ? (
            <Button onClick={onClose} variant="secondary">Cerrar</Button>
          ) : (
            <>
              <Button disabled={dialog.submitting} onClick={onClose} variant="secondary">Cancelar</Button>
              <Button
                disabled={busy || eligible.length === 0 || dialog.loading}
                onClick={onConfirm}
              >
                {dialog.submitting ? 'Retirando…' : 'Retirar'}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function RecipeBulkDeleteConfirm({
  dialog,
  onClose,
  onConfirm,
}: {
  dialog: RecipeBulkDeleteDialogState | null
  onClose: () => void
  onConfirm: () => void
}) {
  if (!dialog) return null
  const eligible = dialog.classifications.filter((row) => row.kind === 'eligible')
  const skipped = dialog.classifications.filter((row) => row.kind !== 'eligible')
  const done = dialog.outcomes != null
  const deleted = dialog.outcomes?.filter((row) => row.result === 'deleted') ?? []
  const failed = dialog.outcomes?.filter((row) => row.result !== 'deleted') ?? []
  const mappingCount = eligible.reduce((sum, row) => sum + row.mappingCount, 0)
  const busy = dialog.loading || dialog.submitting

  return (
    <Modal open title="Eliminar recetas definitivamente" onClose={onClose}>
      <div className="space-y-4 text-sm">
        {!done && (
          <p className="mb-0">
            {eligible.length > 0
              ? `¿Eliminar definitivamente ${eligible.length} receta${eligible.length === 1 ? '' : 's'} inactiva${eligible.length === 1 ? '' : 's'}? Se borran BOM, precios por local y vínculos Fudo. No se puede deshacer.`
              : 'Ninguna de las recetas seleccionadas se puede eliminar definitivamente.'}
          </p>
        )}
        <p className="mb-0 text-xs text-senda-muted">{RECIPE_SELECT_ALL_VISIBLE_HINT}</p>
        {dialog.loading && (
          <p className="mb-0 flex items-center gap-2 text-senda-muted">
            <Loader2 className="animate-spin" size={16} /> Consultando dependencias…
          </p>
        )}
        {!done && !dialog.loading && eligible.length > 0 && (
          <ul className="mb-0 list-disc space-y-1 pl-5">
            {eligible.map((row) => (
              <li key={row.id}>
                {row.name}
                {row.mappingCount > 0 ? ` (${row.mappingCount} vínculo${row.mappingCount === 1 ? '' : 's'} Fudo)` : ''}
              </li>
            ))}
          </ul>
        )}
        {!done && skipped.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900">
            <p className="mb-2 font-semibold">No se eliminan</p>
            <ul className="mb-0 list-disc space-y-1 pl-5">
              {skipped.map((row) => (
                <li key={row.id}>
                  {row.name}. {recipeDeleteSkipMessage(row)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {mappingCount > 0 && !done && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900">
            Se quitarán los vínculos Fudo de estas recetas. Un vínculo no es una venta histórica.
          </div>
        )}
        {done && (
          <div className="space-y-3">
            <p className="mb-0 font-semibold">
              {`${deleted.length} eliminada${deleted.length === 1 ? '' : 's'}, ${failed.length} sin cambios.`}
            </p>
            {deleted.length > 0 && (
              <ul className="mb-0 list-disc space-y-1 pl-5">
                {deleted.map((row) => (
                  <li key={row.id}>{row.name}</li>
                ))}
              </ul>
            )}
            {failed.length > 0 && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
                <ul className="mb-0 list-disc space-y-1 pl-5">
                  {failed.map((row) => (
                    <li key={row.id}>{row.name}. {row.reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {dialog.error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
            <AlertCircle size={16} /> {dialog.error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          {done ? (
            <Button onClick={onClose} variant="secondary">Cerrar</Button>
          ) : (
            <>
              <Button disabled={dialog.submitting} onClick={onClose} variant="secondary">Cancelar</Button>
              <Button
                disabled={busy || eligible.length === 0 || dialog.loading}
                onClick={onConfirm}
              >
                {dialog.submitting ? 'Eliminando…' : 'Eliminar definitivamente'}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function RecipeStatusConfirm({
  dialog,
  onClose,
  onConfirm,
}: {
  dialog: RecipeStatusDialogState | null
  onClose: () => void
  onConfirm: () => void
}) {
  if (!dialog) return null
  const dependents = dialog.usage?.usedBy ?? []
  const mappingCount = dialog.usage?.activeMappingCount ?? 0
  const blocked = !dialog.nextActive && dependents.length > 0
  const fudoWarning = !dialog.nextActive ? recipeFudoMappingWarning(mappingCount) : null
  const busy = dialog.loading || dialog.submitting || !canBeginRecipeSave(dialog.submitting)

  return (
    <Modal
      open
      title={dialog.nextActive ? 'Reactivar receta' : 'Retirar receta'}
      onClose={onClose}
    >
      <div className="space-y-4 text-sm">
        <p className="mb-0">
          {dialog.nextActive
            ? `¿Reactivar “${dialog.item.name}”? Volverá a estar disponible para edición y nuevas vinculaciones.`
            : `¿Retirar “${dialog.item.name}” de la lista de trabajo? Se desactiva sin borrar ingredientes, categoría, rendimiento, mappings Fudo, historial, stock ni ventas.`}
        </p>
        {dialog.loading && (
          <p className="mb-0 flex items-center gap-2 text-senda-muted">
            <Loader2 className="animate-spin" size={16} /> Consultando dependencias…
          </p>
        )}
        {blocked && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
            {recipeDependentsBlockMessage(dependents.map((item) => item.name))}
          </div>
        )}
        {fudoWarning && !blocked && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900">
            {fudoWarning}
          </div>
        )}
        {dialog.error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
            <AlertCircle size={16} /> {dialog.error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary">Cancelar</Button>
          <Button
            disabled={busy || blocked || dialog.loading || (!dialog.nextActive && !dialog.usage)}
            onClick={onConfirm}
          >
            {dialog.submitting ? 'Guardando…' : dialog.nextActive ? 'Reactivar' : 'Retirar'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function RecipePriceField({
  item,
  organizationId,
  locationId,
  onSaved,
  onReloadPrices,
}: {
  item: RecipeCatalogItem
  organizationId?: string
  locationId?: string
  onSaved?: (recipeId: string, salePrice: number, version: number) => void
  onReloadPrices?: () => Promise<void>
}) {
  const committed = recipePriceDraftValue(item)
  const [draft, setDraft] = useState(committed)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle')
  const [message, setMessage] = useState('')
  const lastCommitted = useRef(committed)

  useEffect(() => {
    if (committed === lastCommitted.current) return
    lastCommitted.current = committed
    setDraft(committed)
    setStatus('idle')
    setMessage('')
  }, [committed])

  if (item.kind !== 'recipe') return recipeSalePriceLabel(item)

  const editable = recipePriceEditable(item)
  const title = recipePriceFieldTitle(item)

  async function save() {
    if (!editable || !organizationId || !locationId || !onSaved) return
    const parsed = locationRecipePriceSaveBody(item, draft)
    if (!parsed.ok) {
      setStatus('error')
      setMessage(parsed.error)
      return
    }
    setStatus('saving')
    setMessage('')
    try {
      const result = await setLocationRecipePrice(organizationId, locationId, item.id, {
        salePrice: parsed.salePrice,
        expectedVersion: parsed.expectedVersion,
      })
      onSaved(result.recipeId, result.salePrice, result.version)
      const nextDraft = formatArgentineMoneyDraft(result.salePrice)
      lastCommitted.current = nextDraft
      setDraft(nextDraft)
      setStatus('saved')
      setMessage(result.replay ? 'El precio ya estaba guardado.' : 'Precio actualizado.')
    } catch (reason) {
      const next = locationRecipePriceSaveError(reason)
      setStatus(next.conflict ? 'conflict' : 'error')
      setMessage(next.message)
    }
  }

  return (
    <div className="flex min-w-[10rem] flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          aria-label={`Precio de venta de ${item.name}`}
          className="w-28 rounded-lg border border-senda-border bg-white px-2 py-1 text-sm text-senda-ink disabled:cursor-not-allowed disabled:bg-senda-subtle disabled:text-senda-muted"
          disabled={!editable}
          inputMode="decimal"
          onChange={(event) => {
            if (!editable) return
            setDraft(event.target.value)
            setStatus('idle')
            setMessage('')
          }}
          placeholder="—"
          readOnly={!editable}
          title={title}
          value={editable ? draft : committed}
        />
        {editable ? (
          <Button
            className="min-h-8 px-2 text-xs"
            disabled={status === 'saving' || !organizationId || !locationId}
            onClick={() => {
              void save()
            }}
            type="button"
            variant="secondary"
          >
            {status === 'saving' ? 'Guardando…' : 'Guardar'}
          </Button>
        ) : null}
      </div>
      {status === 'saved' && message ? (
        <p className="mb-0 text-xs text-senda-muted">{message}</p>
      ) : null}
      {message && (status === 'error' || status === 'conflict') ? (
        <p className="mb-0 text-xs text-red-700">{message}</p>
      ) : null}
      {status === 'conflict' && onReloadPrices ? (
        <button
          className="text-left text-xs font-semibold text-senda-navy hover:underline"
          onClick={() => {
            void onReloadPrices()
              .then(() => {
                setStatus('idle')
                setMessage('')
              })
              .catch((reason: unknown) => {
                const next = locationRecipePriceSaveError(reason)
                setStatus(next.conflict ? 'conflict' : 'error')
                setMessage(next.message)
              })
          }}
          type="button"
        >
          Recargar precio
        </button>
      ) : null}
    </div>
  )
}

export function RecipesCatalog({
  recipes,
  search,
  onSearch,
  loading,
  error,
  selectedIds,
  onToggle,
  onToggleAll,
  onRequestBulkAction,
  categoryId,
  onCategory,
  categories = [],
  linkFilter = 'all',
  onLinkFilter,
  statusFilter = 'active',
  onStatusFilter,
  onRequestStatusChange,
  onRequestPermanentDelete,
  organizationId,
  locationId,
  onPriceSaved,
  onReloadPrices,
}: {
  recipes: RecipeCatalogItem[]
  search: string
  onSearch: (value: string) => void
  loading: boolean
  error: string
  selectedIds: string[]
  onToggle: (recipeId: string) => void
  onToggleAll: (checked: boolean) => void
  onRequestBulkAction?: () => void
  categoryId: string
  onCategory: (categoryId: string) => void
  categories?: RecipeCategory[]
  linkFilter?: RecipeLinkFilter
  onLinkFilter?: (filter: RecipeLinkFilter) => void
  statusFilter?: RecipeStatusFilter
  onStatusFilter?: (filter: RecipeStatusFilter) => void
  onRequestStatusChange?: (item: RecipeCatalogItem, nextActive: boolean) => void
  onRequestPermanentDelete?: (item: RecipeCatalogItem) => void
  organizationId?: string
  locationId?: string
  onPriceSaved?: (recipeId: string, salePrice: number, version: number) => void
  onReloadPrices?: () => Promise<void>
}) {
  const tabs = useMemo(() => recipeCategoryTabs(categories), [categories])
  const rows = useMemo(
    () => filterRecipeCatalog(recipes, search, categoryId, linkFilter, statusFilter),
    [categoryId, linkFilter, recipes, search, statusFilter],
  )
  const visibleIds = rows.map((row) => row.id)
  const selectionState = visibleRecipeSelectionState(selectedIds, visibleIds)
  const selectedSet = new Set(selectedIds)
  const selectedVisibleCount = visibleIds.filter((id) => selectedSet.has(id)).length
  const [pendingDiscard, setPendingDiscard] = useState<RecipeCatalogItem | null>(null)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
          Buscar recetas
          <span className="relative block">
            <Search className="absolute left-3 top-3 text-slate-400" size={17} />
            <Input
              className="pl-9"
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Buscar receta o producto…"
              value={search}
            />
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          {RECIPE_STATUS_FILTERS.map((filter) => {
            const active = statusFilter === filter.id
            return (
              <button
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  active
                    ? 'bg-senda-navy text-white'
                    : 'border border-senda-border bg-white text-senda-muted hover:text-senda-ink'
                }`}
                key={filter.id}
                onClick={() => onStatusFilter?.(filter.id)}
                type="button"
              >
                {filter.label}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap gap-2">
          {RECIPE_LINK_FILTERS.map((filter) => {
            const active = linkFilter === filter.id
            return (
              <button
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  active
                    ? 'bg-senda-navy text-white'
                    : 'border border-senda-border bg-white text-senda-muted hover:text-senda-ink'
                }`}
                key={filter.id}
                onClick={() => onLinkFilter?.(filter.id)}
                type="button"
              >
                {filter.label}
              </button>
            )
          })}
        </div>

        <div>
          <div className="flex gap-1 overflow-x-auto border-b border-senda-border pb-px">
            {tabs.map((tab) => {
              const active = categoryId === tab.id
              return (
                <button
                  className={`shrink-0 rounded-t-lg px-4 py-2.5 text-sm font-semibold transition ${
                    active
                      ? 'border-b-2 border-senda-navy text-senda-navy'
                      : 'text-senda-muted hover:text-senda-ink'
                  }`}
                  key={tab.id}
                  onClick={() => onCategory(tab.id)}
                  type="button"
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
          {categories.length === 0 && (
            <p className="mb-0 mt-2 text-xs text-senda-muted">{RECIPE_CATEGORIES_EMPTY}</p>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {!loading && rows.length > 0 && selectedVisibleCount > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-senda-border bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="mb-0 text-sm font-semibold">{recipeBulkSelectionLabel(selectedVisibleCount)}</p>
            <p className="mb-0 mt-1 text-xs text-senda-muted">{RECIPE_SELECT_ALL_VISIBLE_HINT}</p>
          </div>
          <Button
            disabled={!onRequestBulkAction}
            onClick={onRequestBulkAction}
            type="button"
            variant="secondary"
          >
            {recipeBulkActionLabel(statusFilter)}
          </Button>
        </div>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-senda-muted">
            <Loader2 className="animate-spin" size={19} /> Cargando recetas…
          </div>
        ) : rows.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-5 text-center text-sm text-senda-muted">
            {search
              ? 'No hay resultados para la búsqueda.'
              : statusFilter === 'inactive'
                ? RECIPE_INACTIVE_EMPTY
                : RECIPE_CATALOG_EMPTY}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-senda-border bg-senda-subtle/70 text-xs uppercase tracking-wide text-senda-muted">
                  <th className="w-12 px-5 py-3">
                    <input
                      aria-checked={selectionState === 'some' ? 'mixed' : selectionState === 'all'}
                      aria-label="Seleccionar todas las recetas visibles"
                      checked={selectionState === 'all'}
                      onChange={(event) => onToggleAll(event.target.checked)}
                      type="checkbox"
                    />
                  </th>
                  <th className="px-5 py-3 font-semibold">Receta</th>
                  <th className="px-5 py-3 font-semibold">Categoría</th>
                  <th className="px-5 py-3 font-semibold">Rendimiento</th>
                  <th className="px-5 py-3 font-semibold">Costo por porción</th>
                  <th className="px-5 py-3 font-semibold">Precio de venta</th>
                  <th className="px-5 py-3 font-semibold">Margen %</th>
                  <th className="px-5 py-3 font-semibold">Vinculación</th>
                  <th className="px-5 py-3 font-semibold">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const costKind = recipeCostKind(row)
                  const statusLabel = recipeFudoStatusLabel(row)
                  const pendingIdentity = row.kind === 'pending_fudo' ? row.pendingIdentity : null
                  const inactive = row.kind === 'recipe' && row.active === false
                  return (
                    <tr
                      className={`border-b border-senda-border last:border-0 ${inactive ? 'bg-senda-subtle/60 text-senda-muted' : ''}`}
                      key={row.id}
                    >
                      <td className="px-5 py-4">
                        <input
                          aria-label={`Seleccionar ${row.name}`}
                          checked={selectedSet.has(row.id)}
                          onChange={() => onToggle(row.id)}
                          type="checkbox"
                        />
                      </td>
                      <td className={`px-5 py-4 ${inactive ? 'font-medium' : 'font-semibold'}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{row.name}</span>
                          {inactive ? <Badge tone="neutral">Inactiva</Badge> : null}
                        </div>
                      </td>
                      <td className="px-5 py-4 text-senda-muted">{recipeCategoryLabel(row.category)}</td>
                      <td className="px-5 py-4">{recipeYieldDisplay(row)}</td>
                      <td className={`px-5 py-4 ${costKind === 'complete' && row.kind !== 'pending_fudo' ? 'font-semibold' : 'text-senda-muted'}`}>
                        {recipeCostAmountLabel(row)}
                      </td>
                      <td className="px-5 py-4 text-senda-muted">
                        <RecipePriceField
                          item={row}
                          locationId={locationId}
                          organizationId={organizationId}
                          onReloadPrices={onReloadPrices}
                          onSaved={onPriceSaved}
                        />
                      </td>
                      <td className="px-5 py-4 text-senda-muted">{recipeMarginLabel(row)}</td>
                      <td className="px-5 py-4">
                        <Badge tone={statusLabel === 'Vinculado' ? 'success' : 'neutral'}>
                          {statusLabel}
                        </Badge>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-1">
                          {recipeCatalogPencilHref(row) ? (
                            <Link
                              aria-label={pendingIdentity ? `Crear receta de ${row.name}` : `Editar ${row.name}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-senda-navy hover:bg-senda-subtle"
                              to={recipeCatalogPencilHref(row)!}
                            >
                              <Pencil size={16} />
                            </Link>
                          ) : (
                            <button
                              aria-label={`Editar ${row.name}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-senda-muted disabled:cursor-not-allowed disabled:opacity-50"
                              disabled
                              title={RECIPE_INACTIVE_UNAVAILABLE}
                              type="button"
                            >
                              <Pencil size={16} />
                            </button>
                          )}
                          {inactive ? (
                            <>
                              <button
                                aria-label={`Reactivar ${row.name}`}
                                className="rounded-lg px-2 py-1 text-sm font-semibold text-senda-navy hover:bg-senda-subtle"
                                onClick={() => onRequestStatusChange?.(row, true)}
                                type="button"
                              >
                                Reactivar
                              </button>
                              <button
                                aria-label={`Eliminar definitivamente ${row.name}`}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-700 hover:bg-red-50"
                                onClick={() => onRequestPermanentDelete?.(row)}
                                title={`Eliminar definitivamente ${row.name}`}
                                type="button"
                              >
                                <Trash2 size={16} />
                              </button>
                            </>
                          ) : (
                            <button
                              aria-label={`Retirar ${row.name}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-senda-navy hover:bg-senda-subtle"
                              onClick={() => (
                                pendingIdentity
                                  ? setPendingDiscard(row)
                                  : onRequestStatusChange?.(row, false)
                              )}
                              type="button"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={Boolean(pendingDiscard)}
        title="Retirar producto Fudo"
        onClose={() => setPendingDiscard(null)}
      >
        <div className="space-y-4 text-sm">
          <p className="mb-0">{RECIPE_PENDING_DISCARD_BLOCKED}</p>
          <div className="flex justify-end">
            <Button onClick={() => setPendingDiscard(null)} type="button" variant="secondary">Cerrar</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

export function PendingProductsRedirect() {
  const [params] = useSearchParams()
  return <Navigate replace to={pendingListRedirectPath(params)} />
}

export function PendingCreateRedirect() {
  const [params] = useSearchParams()
  return <Navigate replace to={pendingCreateRedirectPath(params)} />
}

export function RecipesPage() {
  const { previewMode } = useAuth()
  const [params] = useSearchParams()
  const view = parseRecipePageView(params)
  const {
    organization,
    organizationId,
    location,
    locationId,
    loading: scopeLoading,
    error: scopeError,
  } = useAuthorizedScopeContext()
  const scopeKey = recipesScopeKey(organizationId, locationId)
  const [load, setLoad] = useState<{
    key: string
    recipes: RecipeCatalogItem[]
    history: FudoHistoryItem[]
    categories: RecipeCategory[]
    error: string
  }>({
    key: '',
    recipes: [],
    history: [],
    categories: [],
    error: '',
  })
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('all')
  const [linkFilter, setLinkFilter] = useState<RecipeLinkFilter>('all')
  const [statusFilter, setStatusFilter] = useState<RecipeStatusFilter>('active')
  const [statusDialog, setStatusDialog] = useState<RecipeStatusDialogState | null>(null)
  const [bulkDialog, setBulkDialog] = useState<RecipeBulkRetireDialogState | null>(null)
  const [bulkDeleteDialog, setBulkDeleteDialog] = useState<RecipeBulkDeleteDialogState | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const requestRef = useRef(0)
  const recipes = recipesForScope(load.key, scopeKey, load.recipes)
  const categories = recipesForScope(load.key, scopeKey, load.categories)
  const error = load.key === scopeKey ? load.error : ''
  const loading = scopeLoading || (Boolean(organizationId) && load.key !== scopeKey)
  const visible = useMemo(
    () => filterRecipeCatalog(recipes, search, categoryId, linkFilter, statusFilter),
    [categoryId, linkFilter, recipes, search, statusFilter],
  )

  useEffect(() => {
    setSelectedIds([])
    setSearch('')
    setCategoryId('all')
    setLinkFilter('all')
    setStatusFilter('active')
    setStatusDialog(null)
    setBulkDialog(null)
  }, [scopeKey])

  useEffect(() => {
    setSelectedIds((current) => pruneRecipeSelection(current, visible.map((row) => row.id)))
  }, [visible])

  useEffect(() => {
    if (categoryId === 'all') return
    if (!categories.some((item) => item.id === categoryId)) setCategoryId('all')
  }, [categories, categoryId])

  useEffect(() => {
    if (previewMode || !organizationId) {
      requestRef.current += 1
      setLoad({
        key: recipesScopeKey(organizationId, locationId),
        recipes: [],
        history: [],
        categories: [],
        error: '',
      })
      return
    }
    const key = recipesScopeKey(organizationId, locationId)
    const requestId = ++requestRef.current
    loadRecipeCatalog(organizationId, locationId)
      .then((next) => {
        if (requestId !== requestRef.current) return
        setLoad({
          key,
          recipes: next.recipes,
          history: next.history,
          categories: next.categories,
          error: '',
        })
      })
      .catch((reason: Error) => {
        if (requestId !== requestRef.current) return
        setLoad({ key, recipes: [], history: [], categories: [], error: reason.message })
      })
  }, [locationId, organizationId, previewMode])

  if (view === 'historial') {
    return <Navigate replace to="/recetas" />
  }

  if (previewMode) {
    return (
      <Card className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
        <span className="rounded-2xl bg-senda-subtle p-4 text-senda-muted"><UtensilsCrossed size={30} /></span>
        <h2 className="mb-0 mt-5 text-xl font-bold">Supabase todavía no está configurado</h2>
        <p className="mb-0 mt-2 max-w-lg text-sm leading-6 text-senda-muted">
          Configurá las variables del frontend y la API para consultar recetas reales. El modo vista previa nunca solicita información operativa.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="m-0 text-2xl font-extrabold tracking-tight">Recetas</h2>
          <p className="mb-0 mt-2 text-sm text-senda-muted">
            Gestioná tus recetas y productos de venta
          </p>
          {organization && location && (
            <p className="mb-0 mt-2 text-xs text-senda-muted">
              {locationName(location)} · {organizationName(organization)}
            </p>
          )}
        </div>
        <Link
          className="inline-flex min-h-10 w-auto shrink-0 items-center justify-center gap-2 self-start rounded-lg bg-senda-navy px-4 text-sm font-semibold text-white hover:bg-[#132a45]"
          to="/recetas/crear"
        >
          + Crear receta
        </Link>
      </div>

      <RecipesCatalog
          categories={categories}
          categoryId={categoryId}
          error={error || scopeError}
          linkFilter={linkFilter}
          loading={loading}
          locationId={locationId}
          organizationId={organizationId}
          recipes={recipes}
          search={search}
          selectedIds={selectedIds}
          statusFilter={statusFilter}
          onCategory={setCategoryId}
          onLinkFilter={setLinkFilter}
          onPriceSaved={(recipeId, salePrice, version) => {
            setLoad((current) => ({
              ...current,
              recipes: applySavedLocationPrice(current.recipes, recipeId, salePrice, version),
            }))
          }}
          onReloadPrices={async () => {
            if (!organizationId || !locationId) return
            const prices = await getLocationRecipePrices(organizationId, locationId)
            setLoad((current) => ({
              ...current,
              recipes: overlayLocationPrices(current.recipes, prices),
            }))
          }}
          onRequestStatusChange={(item, nextActive) => {
            if (!organizationId || item.kind !== 'recipe') return
            setStatusDialog({
              item,
              nextActive,
              usage: null,
              loading: true,
              error: '',
              submitting: false,
            })
            getOrganizationRecipeUsage(organizationId, item.id)
              .then((usage) => {
                setStatusDialog((current) => (
                  current && current.item.id === item.id
                    ? { ...current, usage, loading: false }
                    : current
                ))
              })
              .catch((reason: Error) => {
                setStatusDialog((current) => (
                  current && current.item.id === item.id
                    ? { ...current, loading: false, error: recipeSaveErrorMessage(reason) }
                    : current
                ))
              })
          }}
          onSearch={setSearch}
          onStatusFilter={(next) => {
            setStatusFilter(next)
            setSelectedIds([])
          }}
          onToggle={(recipeId) => setSelectedIds((current) => toggleRecipeSelection(current, recipeId))}
          onToggleAll={(checked) => setSelectedIds(selectVisibleRecipes(visible.map((row) => row.id), checked))}
          onRequestPermanentDelete={(item) => {
            if (!organizationId || item.kind !== 'recipe') return
            setBulkDeleteDialog({
              items: [item],
              classifications: [classifyRecipeForPermanentDelete(item, null)],
              loading: true,
              submitting: false,
              error: '',
              outcomes: null,
            })
            getOrganizationRecipeUsage(organizationId, item.id)
              .then((usage) => {
                setBulkDeleteDialog((current) => (
                  current
                    ? {
                      ...current,
                      classifications: [classifyRecipeForPermanentDelete(item, usage)],
                      loading: false,
                    }
                    : current
                ))
              })
              .catch((reason: Error) => {
                setBulkDeleteDialog((current) => (
                  current
                    ? { ...current, loading: false, error: recipeSaveErrorMessage(reason) }
                    : current
                ))
              })
          }}
          onRequestBulkAction={() => {
            if (!organizationId) return
            const selected = visible.filter((row) => selectedIds.includes(row.id))
            if (selected.length === 0) return
            if (statusFilter === 'inactive') {
              setBulkDeleteDialog({
                items: selected,
                classifications: selected.map((item) => classifyRecipeForPermanentDelete(item, null)),
                loading: true,
                submitting: false,
                error: '',
                outcomes: null,
              })
              Promise.all(selected.map(async (item) => {
                if (item.kind !== 'recipe' || item.active) {
                  return classifyRecipeForPermanentDelete(item, null)
                }
                const usage = await getOrganizationRecipeUsage(organizationId, item.id)
                return classifyRecipeForPermanentDelete(item, usage)
              }))
                .then((classifications) => {
                  setBulkDeleteDialog((current) => (
                    current
                      ? { ...current, classifications, loading: false }
                      : current
                  ))
                })
                .catch((reason: Error) => {
                  setBulkDeleteDialog((current) => (
                    current
                      ? { ...current, loading: false, error: recipeSaveErrorMessage(reason) }
                      : current
                  ))
                })
              return
            }
            setBulkDialog({
              items: selected,
              classifications: selected.map((item) => classifyRecipeForRetire(item, null)),
              loading: true,
              submitting: false,
              error: '',
              outcomes: null,
            })
            Promise.all(selected.map(async (item) => {
              if (item.kind !== 'recipe' || !item.active) {
                return classifyRecipeForRetire(item, null)
              }
              const usage = await getOrganizationRecipeUsage(organizationId, item.id)
              return classifyRecipeForRetire(item, usage)
            }))
              .then((classifications) => {
                setBulkDialog((current) => (
                  current
                    ? { ...current, classifications, loading: false }
                    : current
                ))
              })
              .catch((reason: Error) => {
                setBulkDialog((current) => (
                  current
                    ? { ...current, loading: false, error: recipeSaveErrorMessage(reason) }
                    : current
                ))
              })
          }}
        />
      <RecipeStatusConfirm
        dialog={statusDialog}
        onClose={() => {
          if (statusDialog?.submitting) return
          setStatusDialog(null)
        }}
        onConfirm={() => {
          if (!organizationId || !statusDialog || statusDialog.submitting || statusDialog.loading) return
          if (!statusDialog.nextActive && (statusDialog.usage?.usedBy.length ?? 0) > 0) return
          setStatusDialog({ ...statusDialog, submitting: true, error: '' })
          setOrganizationRecipeActive(organizationId, statusDialog.item.id, {
            active: statusDialog.nextActive,
            expectedActive: statusDialog.item.active,
          })
            .then((result) => {
              setStatusDialog(null)
              setLoad((current) => ({
                ...current,
                recipes: current.recipes.map((row) => (
                  row.id === result.recipeId
                    ? { ...row, active: result.active }
                    : row
                )),
              }))
            })
            .catch((reason: unknown) => {
              const usedBy = reason instanceof RecipeSaveApiError ? reason.usedBy : []
              setStatusDialog((current) => (
                current
                  ? {
                    ...current,
                    submitting: false,
                    error: recipeSaveErrorMessage(reason),
                    usage: usedBy.length > 0
                      ? {
                        recipeId: current.item.id,
                        active: current.item.active,
                        usedBy,
                        activeMappingCount: current.usage?.activeMappingCount ?? 0,
                      }
                      : current.usage,
                  }
                  : current
              ))
            })
        }}
      />
      <RecipeBulkRetireConfirm
        dialog={bulkDialog}
        onClose={() => {
          if (bulkDialog?.submitting) return
          setBulkDialog(null)
        }}
        onConfirm={() => {
          if (!organizationId || !bulkDialog || bulkDialog.submitting || bulkDialog.loading) return
          const eligible = bulkDialog.items.filter((item) => (
            bulkDialog.classifications.some((row) => row.id === item.id && row.kind === 'eligible')
          ))
          if (eligible.length === 0) return
          setBulkDialog({ ...bulkDialog, submitting: true, error: '' })
          const outcomes: RecipeBulkRetireOutcome[] = []
          const skipped = bulkDialog.classifications.filter((row) => row.kind !== 'eligible')
          for (const row of skipped) {
            outcomes.push({
              id: row.id,
              name: row.name,
              result: 'skipped',
              reason: recipeRetireSkipMessage(row) ?? undefined,
            })
          }
          void (async () => {
            for (const item of eligible) {
              try {
                const result = await setOrganizationRecipeActive(organizationId, item.id, {
                  active: false,
                  expectedActive: item.active,
                })
                outcomes.push({
                  id: item.id,
                  name: item.name,
                  result: 'retired',
                  replay: result.replay,
                })
              } catch (reason: unknown) {
                const usedBy = reason instanceof RecipeSaveApiError ? reason.usedBy : []
                outcomes.push({
                  id: item.id,
                  name: item.name,
                  result: 'failed',
                  reason: usedBy.length > 0
                    ? recipeDependentsBlockMessage(usedBy.map((row) => row.name))
                    : recipeSaveErrorMessage(reason),
                })
              }
            }
            setLoad((current) => ({
              ...current,
              recipes: current.recipes.map((row) => {
                const retired = outcomes.find((item) => item.id === row.id && item.result === 'retired')
                return retired ? { ...row, active: false } : row
              }),
            }))
            setSelectedIds((current) => current.filter((id) => (
              !outcomes.some((row) => row.id === id && row.result === 'retired')
            )))
            setBulkDialog((current) => (
              current
                ? { ...current, submitting: false, outcomes }
                : current
            ))
          })()
        }}
      />
      <RecipeBulkDeleteConfirm
        dialog={bulkDeleteDialog}
        onClose={() => {
          if (bulkDeleteDialog?.submitting) return
          setBulkDeleteDialog(null)
        }}
        onConfirm={() => {
          if (!organizationId || !bulkDeleteDialog || bulkDeleteDialog.submitting || bulkDeleteDialog.loading) return
          const eligible = bulkDeleteDialog.items.filter((item) => (
            bulkDeleteDialog.classifications.some((row) => row.id === item.id && row.kind === 'eligible')
          ))
          if (eligible.length === 0) return
          setBulkDeleteDialog({ ...bulkDeleteDialog, submitting: true, error: '' })
          const outcomes: RecipeBulkDeleteOutcome[] = []
          const skipped = bulkDeleteDialog.classifications.filter((row) => row.kind !== 'eligible')
          for (const row of skipped) {
            outcomes.push({
              id: row.id,
              name: row.name,
              result: 'skipped',
              reason: recipeDeleteSkipMessage(row) ?? undefined,
            })
          }
          void (async () => {
            for (const item of eligible) {
              try {
                await deleteOrganizationRecipe(organizationId, item.id)
                outcomes.push({
                  id: item.id,
                  name: item.name,
                  result: 'deleted',
                })
              } catch (reason: unknown) {
                const usedBy = reason instanceof RecipeSaveApiError ? reason.usedBy : []
                outcomes.push({
                  id: item.id,
                  name: item.name,
                  result: 'failed',
                  reason: usedBy.length > 0
                    ? recipeDependentsBlockMessage(usedBy.map((row) => row.name))
                    : recipeSaveErrorMessage(reason),
                })
              }
            }
            const deletedIds = new Set(
              outcomes.filter((row) => row.result === 'deleted').map((row) => row.id),
            )
            setLoad((current) => ({
              ...current,
              recipes: current.recipes.filter((row) => !deletedIds.has(row.id)),
            }))
            setSelectedIds((current) => current.filter((id) => !deletedIds.has(id)))
            setBulkDeleteDialog((current) => (
              current
                ? { ...current, submitting: false, outcomes }
                : current
            ))
          })()
        }}
      />
    </div>
  )
}

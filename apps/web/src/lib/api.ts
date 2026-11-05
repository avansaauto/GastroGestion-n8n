import { supabase } from './supabase'

const API_URL = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '')

interface ApiEnvelope<T> {
  data: T
}

async function accessToken() {
  if (!supabase) throw new Error('Supabase todav?a no est? configurado.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session?.access_token) throw new Error('La sesi?n no est? disponible.')
  return data.session.access_token
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  })

  const payload = await response.json().catch(() => ({})) as Partial<ApiEnvelope<T>> & { error?: string }
  if (!response.ok) throw new Error(payload.error || 'No se pudo completar la consulta.')
  return payload.data as T
}

export interface Organization {
  id: string
  name?: string | null
  nombre?: string | null
  [key: string]: unknown
}

export interface Location {
  id: string
  organization_id: string
  name?: string | null
  nombre?: string | null
  [key: string]: unknown
}

export interface PendingProduct {
  id: string
  location_id: string
  product_name?: string | null
  external_product_id?: string | null
  source?: string | null
  status?: 'pending' | 'resolved' | 'catalog' | 'linked' | string | null
  catalog_active?: boolean | null
  last_synced_at?: string | null
  first_seen_at?: string | null
  last_seen_at?: string | null
  mapping_id?: string | null
  mapping_active?: boolean | null
  recipe_id?: string | null
  recipe_name?: string | null
  [key: string]: unknown
}

export function getOrganizations() {
  return apiGet<Organization[]>('/api/organizations')
}

export function getLocations(organizationId: string) {
  return apiGet<Location[]>(`/api/organizations/${encodeURIComponent(organizationId)}/locations`)
}

export function getPendingProducts(
  locationId: string,
  status?: 'pending' | 'resolved',
) {
  const query = new URLSearchParams()
  if (status) query.set('status', status)
  const suffix = query.toString() ? `?${query}` : ''
  return apiGet<PendingProduct[]>(
    `/api/locations/${encodeURIComponent(locationId)}/pending-products${suffix}`,
  )
}

export function getFudoCatalog(locationId: string) {
  return apiGet<PendingProduct[]>(
    `/api/locations/${encodeURIComponent(locationId)}/fudo-catalog`,
  )
}

export type RecipeConsumptionMode = 'none' | 'direct' | 'compound'

export type RecipeListMapping = {
  id: string
  source: string
  externalProductId: string
  externalProductName: string | null
  active: boolean
}

export type RecipeListItem = {
  id: string
  name: string
  recipeType: string
  active: boolean
  yieldQuantity: number
  yieldUnit: string
  consumptionMode: RecipeConsumptionMode
  componentCount: number
  mapping: RecipeListMapping
  pendingStatus: string | null
  costPerYield: number | null
  costIncomplete: boolean
  hasInvalidQuantities: boolean
}

export type RecipeComponentDetail = {
  id: string
  inventoryProductId: string | null
  componentRecipeId: string | null
  name: string | null
  baseUnit: string | null
  quantity: number
  unitCost: number | null
  lineCost: number | null
  costMissing: boolean
}

export type RecipeCategory = {
  id: string
  name: string
}

export type RecipeDetail = Omit<RecipeListItem, 'mapping'> & {
  organizationId: string
  locationId: string
  mapping: RecipeListMapping | null
  sharedLocationCount: number
  category: RecipeCategory | null
  components: RecipeComponentDetail[]
}

export type LocationRecipePrice = {
  recipeId: string
  salePrice: number
  version: number
}

export type LocationRecipePriceSaveResult = {
  locationId: string
  recipeId: string
  salePrice: number
  version: number
  updatedAt: string | null
  replay: boolean
}

export function getLocationRecipes(locationId: string) {
  return apiGet<RecipeListItem[]>(
    `/api/locations/${encodeURIComponent(locationId)}/recipes`,
  )
}

export async function getLocationRecipePrices(organizationId: string, locationId: string) {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/locations/${encodeURIComponent(locationId)}/recipe-prices`,
    { headers: { Authorization: `Bearer ${await accessToken()}` } },
  )
  if (response.status === 503) return [] as LocationRecipePrice[]
  const payload = await response.json().catch(() => ({})) as Partial<ApiEnvelope<LocationRecipePrice[]>> & {
    error?: string
  }
  if (!response.ok) throw new Error(payload.error || 'No se pudieron consultar los precios de venta.')
  return Array.isArray(payload.data) ? payload.data : []
}

export async function setLocationRecipePrice(
  organizationId: string,
  locationId: string,
  recipeId: string,
  input: { salePrice: number; expectedVersion: number | null },
): Promise<LocationRecipePriceSaveResult> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/locations/${encodeURIComponent(locationId)}/recipe-prices/${encodeURIComponent(recipeId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        salePrice: input.salePrice,
        expectedVersion: input.expectedVersion,
      }),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: LocationRecipePriceSaveResult
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw new RecipeSaveApiError(
      payload.error || 'No se pudo guardar el precio de venta.',
      response.status,
      payload.code || 'PRICE_SAVE_FAILED',
    )
  }
  if (!payload.data?.recipeId || !(payload.data.salePrice > 0) || !payload.data.version) {
    throw new RecipeSaveApiError('La respuesta de precio est? incompleta.', 502, 'PRICE_SAVE_FAILED')
  }
  return payload.data
}

export function getRecipe(recipeId: string, locationId: string) {
  const query = new URLSearchParams({ locationId })
  return apiGet<RecipeDetail>(
    `/api/recipes/${encodeURIComponent(recipeId)}?${query}`,
  )
}

export type OrganizationRecipeItem = {
  id: string
  name: string
  recipeType: string
  active: boolean
  yieldQuantity: number
  yieldUnit: string
  consumptionMode: RecipeConsumptionMode
  componentCount: number
  category: RecipeCategory | null
}

export function getOrganizationRecipes(
  organizationId: string,
  options: { q?: string; includeInactive?: boolean } = {},
) {
  const query = new URLSearchParams()
  if (options.q?.trim()) query.set('q', options.q.trim())
  if (options.includeInactive) query.set('includeInactive', 'true')
  const suffix = query.toString() ? `?${query}` : ''
  return apiGet<OrganizationRecipeItem[]>(
    `/api/organizations/${encodeURIComponent(organizationId)}/recipes${suffix}`,
  )
}

export type RecipeUsedBy = {
  recipeId: string
  name: string
}

export class RecipeSaveApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly usedBy: RecipeUsedBy[] = [],
  ) {
    super(message)
    this.name = 'RecipeSaveApiError'
  }
}

export type RecipeUsage = {
  recipeId: string
  active: boolean
  usedBy: RecipeUsedBy[]
  activeMappingCount: number
}

export function getOrganizationRecipeUsage(organizationId: string, recipeId: string) {
  return apiGet<RecipeUsage>(
    `/api/organizations/${encodeURIComponent(organizationId)}/recipes/${encodeURIComponent(recipeId)}/usage`,
  )
}

export type RecipeStatusResult = {
  recipeId: string
  active: boolean
  replay: boolean
  usedBy: RecipeUsedBy[]
  activeMappingCount: number
}

export async function setOrganizationRecipeActive(
  organizationId: string,
  recipeId: string,
  input: { active: boolean; expectedActive: boolean },
): Promise<RecipeStatusResult> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/recipes/${encodeURIComponent(recipeId)}/status`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: RecipeStatusResult
    error?: string
    code?: string
    usedBy?: RecipeUsedBy[]
  }
  if (!response.ok) {
    throw new RecipeSaveApiError(
      payload.error || 'No se pudo cambiar el estado de la receta.',
      response.status,
      payload.code || 'STATUS_FAILED',
      Array.isArray(payload.usedBy) ? payload.usedBy : [],
    )
  }
  if (!payload.data?.recipeId || typeof payload.data.active !== 'boolean') {
    throw new RecipeSaveApiError('La respuesta de estado está incompleta.', 502, 'STATUS_FAILED')
  }
  return payload.data
}

export type RecipeDeleteResult = {
  recipeId: string
  deleted: true
  removedMappingCount: number
  removedPriceCount: number
  removedComponentCount: number
}

export async function deleteOrganizationRecipe(
  organizationId: string,
  recipeId: string,
): Promise<RecipeDeleteResult> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/recipes/${encodeURIComponent(recipeId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
      },
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: RecipeDeleteResult
    error?: string
    code?: string
    usedBy?: RecipeUsedBy[]
  }
  if (!response.ok) {
    throw new RecipeSaveApiError(
      payload.error || 'No se pudo eliminar la receta.',
      response.status,
      payload.code || 'DELETE_FAILED',
      Array.isArray(payload.usedBy) ? payload.usedBy : [],
    )
  }
  if (!payload.data?.recipeId || payload.data.deleted !== true) {
    throw new RecipeSaveApiError('La respuesta de eliminación está incompleta.', 502, 'DELETE_FAILED')
  }
  return payload.data
}

export function getOrganizationRecipeCategories(organizationId: string) {
  return apiGet<RecipeCategory[]>(
    `/api/organizations/${encodeURIComponent(organizationId)}/recipe-categories`,
  )
}

export type CreateOrganizationRecipeInput = {
  name: string
  yieldQuantity: number
  yieldUnit: string
  components?: Array<{ inventoryProductId: string; quantity: number }>
  categoryId?: string
  categoryName?: string
}

export type OrganizationRecipeCreateResult = {
  recipeId: string
  name: string
  yieldQuantity: number
  yieldUnit: string
  componentCount: number
  category: RecipeCategory | null
}

export type UpdateOrganizationRecipeInput = CreateOrganizationRecipeInput & {
  expected: {
    name: string
    yieldQuantity: number
    yieldUnit: string
    categoryId: string | null
    components: Array<{ inventoryProductId: string; quantity: number }>
  }
}

export type OrganizationRecipeUpdateResult = OrganizationRecipeCreateResult & {
  sharedLocationCount: number
}

export async function updateOrganizationRecipe(
  organizationId: string,
  recipeId: string,
  input: UpdateOrganizationRecipeInput,
): Promise<OrganizationRecipeUpdateResult> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/recipes/${encodeURIComponent(recipeId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: OrganizationRecipeUpdateResult
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw new RecipeSaveApiError(
      payload.error || 'No se pudo guardar la receta.',
      response.status,
      payload.code || 'UPDATE_FAILED',
    )
  }
  if (!payload.data?.recipeId) {
    throw new RecipeSaveApiError('La respuesta de edici?n est? incompleta.', 502, 'UPDATE_FAILED')
  }
  return payload.data
}

export async function createOrganizationRecipe(
  organizationId: string,
  input: CreateOrganizationRecipeInput,
): Promise<OrganizationRecipeCreateResult> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/recipes`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: OrganizationRecipeCreateResult
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw new RecipeSaveApiError(
      payload.error || 'No se pudo crear la receta.',
      response.status,
      payload.code || 'CREATE_FAILED',
    )
  }
  if (!payload.data?.recipeId) {
    throw new RecipeSaveApiError('La respuesta de alta est? incompleta.', 502, 'CREATE_FAILED')
  }
  return payload.data
}

export type RecipeSaveResult = {
  recipeId: string
  mappingId: string
  pendingId: string
  replay: boolean
}

export type SaveFudoRecipeInput = {
  intent: 'create' | 'link'
  source: string
  externalProductId: string
  name?: string
  yieldQuantity?: number
  yieldUnit?: string
  components?: Array<{ inventoryProductId: string; quantity: number }>
  existingRecipeId?: string
  categoryId?: string
  categoryName?: string
}

export async function saveFudoRecipe(
  locationId: string,
  input: SaveFudoRecipeInput,
): Promise<RecipeSaveResult> {
  const response = await fetch(
    `${API_URL}/api/locations/${encodeURIComponent(locationId)}/recipes`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: RecipeSaveResult
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw new RecipeSaveApiError(
      payload.error || 'No se pudo guardar la receta.',
      response.status,
      payload.code || 'SAVE_FAILED',
    )
  }
  if (!payload.data?.recipeId) {
    throw new RecipeSaveApiError('La respuesta de guardado est? incompleta.', 502, 'SAVE_FAILED')
  }
  return payload.data
}

export type InventoryProduct = {
  id: string
  organizationId: string
  name: string
  baseUnit: string | null
  active: boolean
  onHand: number | null
  averageUnitCost?: number | null
  minimumStock?: number | null
  category?: string | null
  supplierName?: string | null
  preferredSupplierId?: string | null
  presentationUnit?: string | null
  conversionFactor?: number | null
  /** false = solo unidades comerciales enteras en recetas. */
  divisible?: boolean | null
}

export type OrganizationSupplier = {
  id: string
  organizationId: string
  name: string
  taxId: string | null
  source: 'suppliers' | 'invoice_issuer'
}

export class InventoryApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'InventoryApiError'
  }
}

export function getInventoryProducts(
  organizationId: string,
  options: { q?: string; locationId?: string; includeInactive?: boolean } = {},
) {
  const query = new URLSearchParams()
  if (options.q?.trim()) query.set('q', options.q.trim())
  if (options.locationId) query.set('locationId', options.locationId)
  if (options.includeInactive) query.set('includeInactive', 'true')
  const suffix = query.toString() ? `?${query}` : ''
  return apiGet<InventoryProduct[]>(
    `/api/organizations/${encodeURIComponent(organizationId)}/inventory-products${suffix}`,
  )
}

export function getOrganizationSuppliers(organizationId: string) {
  return apiGet<OrganizationSupplier[]>(
    `/api/organizations/${encodeURIComponent(organizationId)}/suppliers`,
  )
}

export async function createInventoryProduct(
  organizationId: string,
  input: {
    name: string
    baseUnit: string
    category?: string | null
    minimumStock?: number | null
    locationId?: string
    presentationUnit?: string | null
    conversionFactor?: number | null
    preferredSupplierId?: string | null
    preferredSupplierName?: string | null
  },
): Promise<InventoryProduct> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/inventory-products`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: InventoryProduct
    error?: string
    code?: string
    details?: Record<string, unknown>
  }
  if (!response.ok) {
    throw new InventoryApiError(
      payload.error || 'No se pudo crear el insumo.',
      response.status,
      payload.code || 'CREATE_FAILED',
      payload.details ?? {},
    )
  }
  if (!payload.data?.id) {
    throw new InventoryApiError('La respuesta de creaci?n est? incompleta.', 502, 'CREATE_FAILED')
  }
  return payload.data
}

export async function reactivateInventoryProduct(
  organizationId: string,
  inventoryProductId: string,
  input: {
    locationId?: string
    category?: string | null
    minimumStock?: number | null
  } = {},
): Promise<InventoryProduct> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/inventory-products/${encodeURIComponent(inventoryProductId)}/reactivate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: Record<string, unknown>
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw new InventoryApiError(
      payload.error || 'No se pudo reactivar el insumo.',
      response.status,
      payload.code || 'REACTIVATE_FAILED',
    )
  }
  const row = payload.data ?? {}
  const id = typeof row.inventory_product_id === 'string'
    ? row.inventory_product_id
    : inventoryProductId
  return {
    id,
    organizationId,
    name: typeof row.name === 'string' ? row.name : 'Insumo',
    baseUnit: typeof row.base_unit === 'string' ? row.base_unit : null,
    active: true,
    onHand: null,
    category: input.category ?? null,
    minimumStock: input.minimumStock ?? null,
  }
}

export type InventoryPurchaseCostResult = {
  inventoryProductId: string
  locationId: string
  purchaseQuantity: number
  purchaseCost: number
  averageUnitCost: number
  lastPurchaseUnitCost: number
  onHand: number
  replay: boolean
}

export async function updateInventoryProduct(
  organizationId: string,
  locationId: string,
  inventoryProductId: string,
  input: {
    name?: string
    category?: string | null
    minimumStock?: number | null
    presentationUnit?: string | null
    conversionFactor?: number | null
    preferredSupplierId?: string | null
    preferredSupplierName?: string | null
  },
): Promise<unknown> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/locations/${encodeURIComponent(locationId)}/inventory-products/${encodeURIComponent(inventoryProductId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: unknown
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw new InventoryApiError(
      payload.error || 'No se pudo editar el insumo.',
      response.status,
      payload.code || 'UPDATE_FAILED',
    )
  }
  return payload.data
}

export type InventoryMovement = {
  id: string
  occurredAt: string | null
  productId: string
  productName: string
  /** false = soft-delete. null/undefined = sin afirmar eliminación. */
  productActive?: boolean | null
  baseUnit: string | null
  quantity: number
  kind: string
  label: string
  detail: string | null
}

export type InventoryMovementPage = {
  items: InventoryMovement[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export function getInventoryMovements(
  organizationId: string,
  locationId: string,
  options: { page?: number } = {},
) {
  const query = new URLSearchParams()
  if (options.page && options.page > 1) query.set('page', String(options.page))
  const suffix = query.toString() ? `?${query}` : ''
  return apiGet<InventoryMovementPage>(
    `/api/organizations/${encodeURIComponent(organizationId)}/locations/${encodeURIComponent(locationId)}/inventory-movements${suffix}`,
  )
}

export type SaleConsumptionStatus =
  | 'registered'
  | 'reversed'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'duplicate'

export type SaleConsumptionLineStatus = 'registered' | 'reversed' | 'failed' | 'duplicate'

export type SaleConsumptionLine = {
  id: string
  occurredAt: string | null
  productId: string | null
  productName: string
  baseUnit: string | null
  quantity: number
  status: SaleConsumptionLineStatus
  errorCode: string | null
}

export type SaleConsumptionGroup = {
  sourceType: string
  sourceId: string
  occurredAt: string | null
  status: SaleConsumptionStatus
  soldProductName: string | null
  soldProductId: string | null
  recipeName: string | null
  recipeId: string | null
  soldQuantity: number | null
  soldUnit: string | null
  errorCode: string | null
  lines: SaleConsumptionLine[]
}

export function getSaleConsumptions(organizationId: string, locationId: string) {
  return apiGet<SaleConsumptionGroup[]>(
    `/api/organizations/${encodeURIComponent(organizationId)}/locations/${encodeURIComponent(locationId)}/sale-consumptions`,
  )
}

export async function adjustInventoryProductStock(
  organizationId: string,
  locationId: string,
  inventoryProductId: string,
  input: {
    quantityDelta: number
    reason: string
    idempotencyKey: string
    kind?: 'correction' | 'waste'
  },
): Promise<unknown> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/locations/${encodeURIComponent(locationId)}/inventory-products/${encodeURIComponent(inventoryProductId)}/adjust`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: unknown
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw new InventoryApiError(
      payload.error || 'No se pudo ajustar el stock.',
      response.status,
      payload.code || 'ADJUST_FAILED',
    )
  }
  return payload.data
}

export async function deleteInventoryProduct(
  organizationId: string,
  inventoryProductId: string,
): Promise<{ mode?: 'hard' | 'soft' }> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/inventory-products/${encodeURIComponent(inventoryProductId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
      },
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: { mode?: 'hard' | 'soft' }
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw new InventoryApiError(
      payload.error || 'No se pudo eliminar el insumo.',
      response.status,
      payload.code || 'DELETE_FAILED',
    )
  }
  return payload.data ?? {}
}

export async function setInventoryPurchaseCost(
  organizationId: string,
  locationId: string,
  inventoryProductId: string,
  input: { purchaseQuantity: number; purchaseCost: number },
): Promise<InventoryPurchaseCostResult> {
  const response = await fetch(
    `${API_URL}/api/organizations/${encodeURIComponent(organizationId)}/locations/${encodeURIComponent(locationId)}/inventory-products/${encodeURIComponent(inventoryProductId)}/purchase-cost`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const payload = await response.json().catch(() => ({})) as {
    data?: InventoryPurchaseCostResult
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw new InventoryApiError(
      payload.error || 'No se pudo guardar el costo de compra.',
      response.status,
      payload.code || 'COST_SAVE_FAILED',
    )
  }
  if (
    !payload.data?.inventoryProductId
    || payload.data.averageUnitCost == null
    || !Number.isFinite(payload.data.averageUnitCost)
  ) {
    throw new InventoryApiError('La respuesta de costo est? incompleta.', 502, 'COST_SAVE_FAILED')
  }
  return payload.data
}

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  consumptionModeFromComponentCount,
  estimateRecipeCost,
  parseRecipeNumber,
  type ConsumptionMode,
} from './recipeCost.js'
import { RecipeQueryError } from './recipeQueryError.js'

export type RecipeMapping = {
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
  consumptionMode: ConsumptionMode
  componentCount: number
  mapping: RecipeMapping
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

export type RecipeDetail = Omit<RecipeListItem, 'mapping'> & {
  organizationId: string
  locationId: string
  mapping: RecipeMapping | null
  sharedLocationCount: number
  category: RecipeCategoryItem | null
  components: RecipeComponentDetail[]
}

export type RecipeCategoryItem = {
  id: string
  name: string
}

export type OrganizationRecipeItem = {
  id: string
  name: string
  recipeType: string
  active: boolean
  yieldQuantity: number
  yieldUnit: string
  consumptionMode: ConsumptionMode
  componentCount: number
  category: RecipeCategoryItem | null
}

export type RecipeUsedByItem = {
  recipeId: string
  name: string
}

export type RecipeUsage = {
  recipeId: string
  active: boolean
  usedBy: RecipeUsedByItem[]
  activeMappingCount: number
}

export interface RecipeQuery {
  listLocationRecipes(
    client: SupabaseClient,
    locationId: string,
  ): Promise<RecipeListItem[]>
  getRecipeDetail(
    client: SupabaseClient,
    recipeId: string,
    locationId: string,
  ): Promise<RecipeDetail>
  listOrganizationRecipes(
    client: SupabaseClient,
    organizationId: string,
    options?: { search?: string; includeInactive?: boolean },
  ): Promise<OrganizationRecipeItem[] | null>
  getRecipeUsage(
    client: SupabaseClient,
    organizationId: string,
    recipeId: string,
  ): Promise<RecipeUsage | null>
  listOrganizationRecipeCategories(
    client: SupabaseClient,
    organizationId: string,
  ): Promise<RecipeCategoryItem[] | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  return (Array.isArray(data) ? data : []).filter(isRecord)
}

function lookupFailed(message = 'No se pudieron consultar las recetas.'): never {
  throw new RecipeQueryError(message, 'LOOKUP_FAILED', 500)
}

function errorBlob(error: { code?: string; message?: string; details?: string } | null): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
}

export function isRecipeCategorySchemaMissing(
  error: { code?: string; message?: string; details?: string } | null,
): boolean {
  const blob = errorBlob(error)
  if (/\b(42P01|PGRST205)\b/.test(blob) && /recipe_categories/i.test(blob)) return true
  if (/\b(42703|PGRST204)\b/.test(blob) && /category_id/i.test(blob)) return true
  return /could not find the table/i.test(blob) && /recipe_categories/i.test(blob)
}

type LocationRow = { id: string; organizationId: string }

async function loadAuthorizedOrganization(
  client: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .maybeSingle()
  if (error) lookupFailed()
  return isRecord(data) && asString(data.id) === organizationId
}

async function loadAuthorizedLocation(
  client: SupabaseClient,
  locationId: string,
): Promise<LocationRow> {
  const { data, error } = await client
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) lookupFailed('No se pudo consultar el local.')
  const organizationId = isRecord(data) && asString(data.id) === locationId
    ? asString(data.organization_id)
    : null
  if (!organizationId) {
    throw new RecipeQueryError('Local no disponible.', 'NOT_FOUND', 404)
  }
  return { id: locationId, organizationId }
}

type MappingRow = {
  id: string
  recipeId: string
  source: string
  externalProductId: string
  externalProductName: string | null
  active: boolean
}

function mapMapping(row: Record<string, unknown>, locationId: string): MappingRow | null {
  if (asString(row.location_id) !== locationId) return null
  const id = asString(row.id)
  const recipeId = asString(row.recipe_id)
  const source = asString(row.source)
  const externalProductId = asString(row.external_product_id)
  if (!id || !recipeId || !source || !externalProductId) return null
  return {
    id,
    recipeId,
    source,
    externalProductId,
    externalProductName: asString(row.external_product_name),
    active: row.active !== false,
  }
}

type RecipeRow = {
  id: string
  organizationId: string
  name: string
  recipeType: string
  active: boolean
  yieldQuantity: number
  yieldUnit: string
  categoryId: string | null
}

function mapRecipe(row: Record<string, unknown>, organizationId: string): RecipeRow | null {
  const id = asString(row.id)
  if (!id || asString(row.organization_id) !== organizationId) return null
  const yieldQuantity = parseRecipeNumber(row.yield_quantity)
  return {
    id,
    organizationId,
    name: asString(row.name) ?? 'Receta',
    recipeType: asString(row.recipe_type) ?? 'sale_product',
    active: row.active !== false,
    yieldQuantity: yieldQuantity ?? 0,
    yieldUnit: asString(row.yield_unit) ?? 'unit',
    categoryId: asString(row.category_id),
  }
}

function mapCategory(
  row: Record<string, unknown>,
  organizationId: string,
): RecipeCategoryItem | null {
  const id = asString(row.id)
  const name = asString(row.name)
  if (!id || !name || asString(row.organization_id) !== organizationId) return null
  return { id, name }
}

type ComponentRow = {
  id: string
  recipeId: string
  inventoryProductId: string | null
  componentRecipeId: string | null
  quantity: number
}

function mapComponent(row: Record<string, unknown>): ComponentRow | null {
  const id = asString(row.id)
  const recipeId = asString(row.recipe_id)
  if (!id || !recipeId) return null
  const quantity = parseRecipeNumber(row.quantity)
  return {
    id,
    recipeId,
    inventoryProductId: asString(row.inventory_product_id),
    componentRecipeId: asString(row.component_recipe_id),
    quantity: quantity ?? 0,
  }
}

async function loadMappings(
  client: SupabaseClient,
  locationId: string,
  recipeId?: string,
): Promise<MappingRow[]> {
  let query = client
    .from('sales_product_mappings')
    .select('id, location_id, source, external_product_id, external_product_name, recipe_id, active')
    .eq('location_id', locationId)
  if (recipeId) query = query.eq('recipe_id', recipeId)
  const { data, error } = await query
  if (error) lookupFailed()
  return rowsOf(data)
    .map((row) => mapMapping(row, locationId))
    .filter((row): row is MappingRow => Boolean(row))
}

async function loadCategoriesById(
  client: SupabaseClient,
  organizationId: string,
  ids: string[],
): Promise<Map<string, RecipeCategoryItem>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const { data, error } = await client
    .from('recipe_categories')
    .select('id, organization_id, name')
    .eq('organization_id', organizationId)
    .in('id', unique)
  if (error) {
    if (isRecipeCategorySchemaMissing(error)) return new Map()
    lookupFailed('No se pudieron consultar las categorías.')
  }
  const byId = new Map<string, RecipeCategoryItem>()
  for (const row of rowsOf(data)) {
    const category = mapCategory(row, organizationId)
    if (category) byId.set(category.id, category)
  }
  return byId
}

async function loadOrganizationRecipeRows(
  client: SupabaseClient,
  organizationId: string,
) {
  const withCategory = 'id, organization_id, name, recipe_type, active, yield_quantity, yield_unit, category_id'
  const withoutCategory = 'id, organization_id, name, recipe_type, active, yield_quantity, yield_unit'
  const first = await client
    .from('recipes')
    .select(withCategory)
    .eq('organization_id', organizationId)
  if (first.error && isRecipeCategorySchemaMissing(first.error)) {
    const fallback = await client
      .from('recipes')
      .select(withoutCategory)
      .eq('organization_id', organizationId)
    if (fallback.error) lookupFailed()
    return rowsOf(fallback.data)
  }
  if (first.error) lookupFailed()
  return rowsOf(first.data)
}

async function loadRecipesById(
  client: SupabaseClient,
  organizationId: string,
  ids: string[],
): Promise<Map<string, RecipeRow>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const { data, error } = await client
    .from('recipes')
    .select('id, organization_id, name, recipe_type, active, yield_quantity, yield_unit')
    .eq('organization_id', organizationId)
    .in('id', unique)
  if (error) lookupFailed()
  const byId = new Map<string, RecipeRow>()
  for (const row of rowsOf(data)) {
    const recipe = mapRecipe(row, organizationId)
    if (recipe) byId.set(recipe.id, recipe)
  }
  return byId
}

async function loadComponents(
  client: SupabaseClient,
  recipeIds: string[],
): Promise<ComponentRow[]> {
  const unique = [...new Set(recipeIds)]
  if (unique.length === 0) return []
  const { data, error } = await client
    .from('recipe_components')
    .select('id, recipe_id, inventory_product_id, component_recipe_id, quantity')
    .in('recipe_id', unique)
  if (error) lookupFailed()
  return rowsOf(data).map(mapComponent).filter((row): row is ComponentRow => Boolean(row))
}

async function loadPendingStatus(
  client: SupabaseClient,
  locationId: string,
): Promise<Map<string, string>> {
  const { data, error } = await client
    .from('pending_product_mappings')
    .select('location_id, source, external_product_id, status')
    .eq('location_id', locationId)
  if (error) lookupFailed('No se pudieron consultar los productos pendientes.')
  const byKey = new Map<string, string>()
  for (const row of rowsOf(data)) {
    if (asString(row.location_id) !== locationId) continue
    const source = asString(row.source)
    const externalId = asString(row.external_product_id)
    const status = asString(row.status)
    if (!source || !externalId || !status) continue
    byKey.set(`${source}::${externalId}`, status)
  }
  return byKey
}

type ProductInfo = { name: string; baseUnit: string | null }

async function loadProducts(
  client: SupabaseClient,
  organizationId: string,
  ids: string[],
): Promise<Map<string, ProductInfo>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const { data, error } = await client
    .from('inventory_products')
    .select('id, organization_id, name, base_unit')
    .eq('organization_id', organizationId)
    .in('id', unique)
  if (error) lookupFailed('No se pudieron consultar los insumos.')
  const byId = new Map<string, ProductInfo>()
  for (const row of rowsOf(data)) {
    if (asString(row.organization_id) !== organizationId) continue
    const id = asString(row.id)
    if (!id) continue
    byId.set(id, {
      name: asString(row.name) ?? 'Insumo',
      baseUnit: asString(row.base_unit),
    })
  }
  return byId
}

async function loadUnitCosts(
  client: SupabaseClient,
  locationId: string,
  productIds: string[],
): Promise<Map<string, number | null>> {
  const unique = [...new Set(productIds)]
  const costs = new Map<string, number | null>()
  if (unique.length === 0) return costs

  const { data: inventoryRows, error: inventoryError } = await client
    .from('location_inventory')
    .select('id, location_id, inventory_product_id')
    .eq('location_id', locationId)
    .in('inventory_product_id', unique)
  if (inventoryError) lookupFailed('No se pudieron consultar las existencias.')

  const inventoryIdByProduct = new Map<string, string>()
  const inventoryIds: string[] = []
  for (const row of rowsOf(inventoryRows)) {
    if (asString(row.location_id) !== locationId) continue
    const id = asString(row.id)
    const productId = asString(row.inventory_product_id)
    if (!id || !productId || inventoryIdByProduct.has(productId)) continue
    inventoryIdByProduct.set(productId, id)
    inventoryIds.push(id)
  }

  const costByInventoryId = new Map<string, number | null>()
  if (inventoryIds.length > 0) {
    // average_unit_cost: compatibilidad. Etapa A lo sincroniza con el último costo de compra.
    const { data: valuationRows, error: valuationError } = await client
      .from('inventory_valuations')
      .select('location_inventory_id, average_unit_cost')
      .in('location_inventory_id', inventoryIds)
    if (valuationError) lookupFailed('No se pudieron consultar los costos.')
    for (const row of rowsOf(valuationRows)) {
      const inventoryId = asString(row.location_inventory_id)
      if (!inventoryId || costByInventoryId.has(inventoryId)) continue
      costByInventoryId.set(inventoryId, parseRecipeNumber(row.average_unit_cost))
    }
  }

  for (const productId of unique) {
    const inventoryId = inventoryIdByProduct.get(productId)
    if (!inventoryId) {
      costs.set(productId, null)
      continue
    }
    costs.set(productId, costByInventoryId.has(inventoryId) ? costByInventoryId.get(inventoryId) ?? null : null)
  }
  return costs
}

function recipeHasInvalidQuantities(components: ComponentRow[]) {
  return components.some((component) => !(component.quantity > 0))
}

function costForComponents(
  recipe: RecipeRow,
  components: ComponentRow[],
  unitCostByProduct: Map<string, number | null>,
) {
  return estimateRecipeCost({
    yieldQuantity: recipe.yieldQuantity,
    lines: components.map((component) => ({
      quantity: component.quantity,
      unitCost: component.inventoryProductId
        ? unitCostByProduct.get(component.inventoryProductId) ?? null
        : null,
    })),
  })
}

function publicMapping(row: MappingRow): RecipeMapping {
  return {
    id: row.id,
    source: row.source,
    externalProductId: row.externalProductId,
    externalProductName: row.externalProductName,
    active: row.active,
  }
}

export const recipeQuery: RecipeQuery = {
  async listLocationRecipes(client, locationId) {
    const location = await loadAuthorizedLocation(client, locationId)

    const mappings = (await loadMappings(client, locationId)).filter((row) => row.active)
    const recipes = await loadRecipesById(
      client,
      location.organizationId,
      mappings.map((row) => row.recipeId),
    )
    const visibleIds = [...recipes.keys()]
    const components = await loadComponents(client, visibleIds)
    const componentsByRecipe = new Map<string, ComponentRow[]>()
    for (const component of components) {
      const list = componentsByRecipe.get(component.recipeId) ?? []
      list.push(component)
      componentsByRecipe.set(component.recipeId, list)
    }

    const productIds = components
      .map((component) => component.inventoryProductId)
      .filter((id): id is string => Boolean(id))
    const unitCosts = await loadUnitCosts(client, locationId, productIds)
    const pending = mappings.length > 0
      ? await loadPendingStatus(client, locationId)
      : new Map<string, string>()

    const items: RecipeListItem[] = []
    for (const mapping of mappings) {
      const recipe = recipes.get(mapping.recipeId)
      if (!recipe) continue
      const recipeComponents = componentsByRecipe.get(recipe.id) ?? []
      const cost = costForComponents(recipe, recipeComponents, unitCosts)
      items.push({
        id: recipe.id,
        name: recipe.name,
        recipeType: recipe.recipeType,
        active: recipe.active,
        yieldQuantity: recipe.yieldQuantity,
        yieldUnit: recipe.yieldUnit,
        consumptionMode: consumptionModeFromComponentCount(recipeComponents.length),
        componentCount: recipeComponents.length,
        mapping: publicMapping(mapping),
        pendingStatus: pending.get(`${mapping.source}::${mapping.externalProductId}`) ?? null,
        costPerYield: cost.costPerYield,
        costIncomplete: cost.costIncomplete,
        hasInvalidQuantities: recipeHasInvalidQuantities(recipeComponents),
      })
    }
    return items
  },

  async getRecipeDetail(client, recipeId, locationId) {
    const location = await loadAuthorizedLocation(client, locationId)

    const withCategory = 'id, organization_id, name, recipe_type, active, yield_quantity, yield_unit, category_id'
    const withoutCategory = 'id, organization_id, name, recipe_type, active, yield_quantity, yield_unit'
    const first = await client
      .from('recipes')
      .select(withCategory)
      .eq('id', recipeId)
      .eq('organization_id', location.organizationId)
      .maybeSingle()
    const result = first.error && isRecipeCategorySchemaMissing(first.error)
      ? await client
        .from('recipes')
        .select(withoutCategory)
        .eq('id', recipeId)
        .eq('organization_id', location.organizationId)
        .maybeSingle()
      : first
    if (result.error) lookupFailed()
    if (!isRecord(result.data)) {
      throw new RecipeQueryError('Receta no disponible.', 'NOT_FOUND', 404)
    }
    const recipe = mapRecipe(result.data, location.organizationId)
    if (!recipe || recipe.id !== recipeId) {
      throw new RecipeQueryError('Receta no disponible.', 'NOT_FOUND', 404)
    }

    const [mappings, allMappings, components] = await Promise.all([
      loadMappings(client, locationId, recipeId),
      (async () => {
        const { data: mappingRows, error: mappingError } = await client
          .from('sales_product_mappings')
          .select('id, recipe_id, location_id, active')
          .eq('recipe_id', recipeId)
        if (mappingError) lookupFailed()
        return rowsOf(mappingRows)
      })(),
      loadComponents(client, [recipeId]),
    ])

    const mapping = mappings.find((row) => row.active) ?? mappings[0] ?? null
    const productIds = components
      .map((component) => component.inventoryProductId)
      .filter((id): id is string => Boolean(id))
    const nestedRecipeIds = components
      .map((component) => component.componentRecipeId)
      .filter((id): id is string => Boolean(id))
    const [products, nestedRecipes, unitCosts, pending, categories] = await Promise.all([
      loadProducts(client, location.organizationId, productIds),
      loadRecipesById(client, location.organizationId, nestedRecipeIds),
      loadUnitCosts(client, locationId, productIds),
      mapping ? loadPendingStatus(client, locationId) : Promise.resolve(new Map<string, string>()),
      loadCategoriesById(
        client,
        location.organizationId,
        recipe.categoryId ? [recipe.categoryId] : [],
      ),
    ])

    const cost = costForComponents(recipe, components, unitCosts)
    const detailComponents: RecipeComponentDetail[] = components.map((component, index) => {
      const product = component.inventoryProductId
        ? products.get(component.inventoryProductId)
        : undefined
      const nested = component.componentRecipeId
        ? nestedRecipes.get(component.componentRecipeId)
        : undefined
      const unitCost = component.inventoryProductId
        ? unitCosts.get(component.inventoryProductId) ?? null
        : null
      const lineCost = cost.lineCosts[index] ?? null
      return {
        id: component.id,
        inventoryProductId: component.inventoryProductId,
        componentRecipeId: component.componentRecipeId,
        name: product?.name ?? nested?.name ?? (component.componentRecipeId ? 'Subreceta' : null),
        baseUnit: product?.baseUnit ?? null,
        quantity: component.quantity,
        unitCost,
        lineCost,
        costMissing: lineCost == null,
      }
    })

    return {
      id: recipe.id,
      organizationId: recipe.organizationId,
      locationId,
      name: recipe.name,
      recipeType: recipe.recipeType,
      active: recipe.active,
      yieldQuantity: recipe.yieldQuantity,
      yieldUnit: recipe.yieldUnit,
      consumptionMode: consumptionModeFromComponentCount(components.length),
      componentCount: components.length,
      mapping: mapping ? publicMapping(mapping) : null,
      pendingStatus: mapping
        ? pending.get(`${mapping.source}::${mapping.externalProductId}`) ?? null
        : null,
      sharedLocationCount: new Set(
        allMappings
          .filter((row) => row.active !== false)
          .map((row) => asString(row.location_id))
          .filter((id): id is string => Boolean(id)),
      ).size,
      category: recipe.categoryId ? categories.get(recipe.categoryId) ?? null : null,
      costPerYield: cost.costPerYield,
      costIncomplete: cost.costIncomplete,
      hasInvalidQuantities: recipeHasInvalidQuantities(components),
      components: detailComponents,
    }
  },

  async listOrganizationRecipes(client, organizationId, options = {}) {
    const visible = await loadAuthorizedOrganization(client, organizationId)
    if (!visible) return null

    const recipes = (await loadOrganizationRecipeRows(client, organizationId))
      .map((row) => mapRecipe(row, organizationId))
      .filter((row): row is RecipeRow => Boolean(row))
      .filter((row) => row.recipeType === 'sale_product')
      .filter((row) => options.includeInactive ? true : row.active)

    const term = options.search?.trim().toLocaleLowerCase('es')
    const filtered = term
      ? recipes.filter((row) => row.name.toLocaleLowerCase('es').includes(term))
      : recipes

    const components = await loadComponents(client, filtered.map((recipe) => recipe.id))
    const countByRecipe = new Map<string, number>()
    for (const component of components) {
      countByRecipe.set(component.recipeId, (countByRecipe.get(component.recipeId) ?? 0) + 1)
    }
    const categories = await loadCategoriesById(
      client,
      organizationId,
      filtered.map((recipe) => recipe.categoryId).filter((id): id is string => Boolean(id)),
    )

    return filtered
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, 'es'))
      .map((recipe) => {
        const componentCount = countByRecipe.get(recipe.id) ?? 0
        return {
          id: recipe.id,
          name: recipe.name,
          recipeType: recipe.recipeType,
          active: recipe.active,
          yieldQuantity: recipe.yieldQuantity,
          yieldUnit: recipe.yieldUnit,
          consumptionMode: consumptionModeFromComponentCount(componentCount),
          componentCount,
          category: recipe.categoryId ? categories.get(recipe.categoryId) ?? null : null,
        }
      })
  },

  async getRecipeUsage(client, organizationId, recipeId) {
    const visible = await loadAuthorizedOrganization(client, organizationId)
    if (!visible) return null

    const { data, error } = await client
      .from('recipes')
      .select('id, organization_id, name, active')
      .eq('id', recipeId)
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) lookupFailed()
    if (!isRecord(data) || asString(data.id) !== recipeId || asString(data.organization_id) !== organizationId) {
      throw new RecipeQueryError('Receta no disponible.', 'NOT_FOUND', 404)
    }

    const components = await client
      .from('recipe_components')
      .select('recipe_id, component_recipe_id')
      .eq('component_recipe_id', recipeId)
    if (components.error) lookupFailed('No se pudieron consultar las dependencias.')
    const parentIds = [...new Set(
      rowsOf(components.data)
        .map((row) => asString(row.recipe_id))
        .filter((id): id is string => Boolean(id)),
    )]

    let usedBy: RecipeUsedByItem[] = []
    if (parentIds.length > 0) {
      const parents = await client
        .from('recipes')
        .select('id, organization_id, name, active')
        .eq('organization_id', organizationId)
        .in('id', parentIds)
      if (parents.error) lookupFailed('No se pudieron consultar las dependencias.')
      usedBy = rowsOf(parents.data)
        .filter((row) => asString(row.organization_id) === organizationId && row.active === true)
        .map((row) => ({
          recipeId: asString(row.id) ?? '',
          name: asString(row.name) ?? 'Receta',
        }))
        .filter((row) => row.recipeId)
        .sort((left, right) => left.name.localeCompare(right.name, 'es'))
    }

    const mappings = await client
      .from('sales_product_mappings')
      .select('id, recipe_id, active')
      .eq('recipe_id', recipeId)
    if (mappings.error) lookupFailed()

    return {
      recipeId,
      active: data.active === true,
      usedBy,
      activeMappingCount: rowsOf(mappings.data)
        .filter((row) => asString(row.recipe_id) === recipeId && row.active !== false)
        .length,
    }
  },

  async listOrganizationRecipeCategories(client, organizationId) {
    const visible = await loadAuthorizedOrganization(client, organizationId)
    if (!visible) return null

    const { data, error } = await client
      .from('recipe_categories')
      .select('id, organization_id, name')
      .eq('organization_id', organizationId)
    if (error) {
      if (isRecipeCategorySchemaMissing(error)) return []
      lookupFailed('No se pudieron consultar las categorías.')
    }

    return rowsOf(data)
      .map((row) => mapCategory(row, organizationId))
      .filter((row): row is RecipeCategoryItem => Boolean(row))
      .sort((left, right) => left.name.localeCompare(right.name, 'es'))
  },
}

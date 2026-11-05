import type { SupabaseClient } from '@supabase/supabase-js'
import { parseRecipeNumber } from './recipeCost.js'
import { assertRecipeComponentQuantities } from './recipeIndivisible.js'
import { RecipeSaveError } from './recipeSaveError.js'

export const RECIPE_UPDATE_RPC_ENABLED = true

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const YIELD_UNITS = new Set(['unit', 'g', 'ml'])

export type RecipeCategoryRef = {
  id: string
  name: string
}

export type RecipeUpdateResult = {
  recipeId: string
  name: string
  yieldQuantity: number
  yieldUnit: string
  componentCount: number
  category: RecipeCategoryRef | null
  sharedLocationCount: number
}

export type RecipeUpdateInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  recipeId: string
  body: unknown
  logRpcError?: (entry: RecipeUpdateRpcLog) => void
  rpcEnabled?: boolean
}

export type RecipeUpdateRpcLog = {
  operation: 'senda_update_recipe'
  code: string | null
  message: string | null
  details: string | null
  hint: string | null
}

type RecipeSnapshot = {
  id: string
  name: string
  active: boolean
  yieldQuantity: number
  yieldUnit: string
  categoryId: string | null
}

type ComponentSnapshot = {
  inventoryProductId: string
  quantity: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function pickString(body: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(body[key])
    if (value) return value
  }
  return null
}

function clipRpcField(value: unknown, max = 500): string | null {
  if (value == null || value === '') return null
  let text = String(value)
  text = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  if (text.length > max) text = `${text.slice(0, max)}…`
  return text
}

export function toRecipeUpdateRpcLog(error: {
  code?: string
  message?: string
  details?: string
  hint?: string
}): RecipeUpdateRpcLog {
  return {
    operation: 'senda_update_recipe',
    code: clipRpcField(error.code, 64),
    message: clipRpcField(error.message),
    details: clipRpcField(error.details),
    hint: clipRpcField(error.hint),
  }
}

function reportRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string },
  log?: (entry: RecipeUpdateRpcLog) => void,
) {
  const entry = toRecipeUpdateRpcLog(error)
  if (log) {
    log(entry)
    return
  }
  console.error(JSON.stringify(entry))
}

function rpcBlob(error: { code?: string; message?: string; details?: string } | null): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
}

export function isUpdateRecipeRpcMissing(
  error: { code?: string; message?: string; details?: string } | null,
): boolean {
  const blob = rpcBlob(error)
  if (/\bPGRST202\b/i.test(blob)) return true
  if (/\b42883\b/.test(blob) && /senda_update_recipe/i.test(blob)) return true
  return /could not find the function/i.test(blob) && /senda_update_recipe/i.test(blob)
}

function rpcToken(error: { code?: string; message?: string; details?: string } | null): string {
  const match = rpcBlob(error).match(
    /\b(BACKEND_ROLE_REQUIRED|ACTOR_REQUIRED|NOT_A_MEMBER|ORGANIZATION_REQUIRED|ORGANIZATION_NOT_FOUND|RECIPE_REQUIRED|RECIPE_NOT_IN_ORG|RECIPE_INACTIVE|DUPLICATE_RECIPE_NAME|NAME_REQUIRED|INVALID_YIELD_UNIT|INVALID_YIELD|INVALID_QUANTITY|INDIVISIBLE_QUANTITY|INVALID_BOM|DUPLICATE_INGREDIENT|INGREDIENT_NOT_IN_ORG|CATEGORY_NOT_IN_ORG|CATEGORY_CONFLICT|CONCURRENT_UPDATE|EXPECTED_REQUIRED|INVALID_PAYLOAD)\b/,
  )
  return match?.[1] ?? ''
}

function mapRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
  log?: (entry: RecipeUpdateRpcLog) => void,
): never {
  if (isUpdateRecipeRpcMissing(error)) {
    throw new RecipeSaveError(
      'La edición de recetas todavía no está habilitada.',
      'RECIPE_UPDATE_RPC_MISSING',
      503,
    )
  }
  const token = rpcToken(error)
  switch (token) {
    case 'NOT_A_MEMBER':
      throw new RecipeSaveError(
        'No tenés autorización para editar recetas en esta organización.',
        'FORBIDDEN',
        403,
      )
    case 'ORGANIZATION_REQUIRED':
    case 'ORGANIZATION_NOT_FOUND':
      throw new RecipeSaveError('Organización no disponible.', 'NOT_FOUND', 404)
    case 'RECIPE_REQUIRED':
    case 'RECIPE_NOT_IN_ORG':
      throw new RecipeSaveError('Receta no disponible.', 'RECIPE_NOT_IN_ORG', 404)
    case 'RECIPE_INACTIVE':
      throw new RecipeSaveError('Esta receta no está activa.', 'RECIPE_INACTIVE', 409)
    case 'DUPLICATE_RECIPE_NAME':
      throw new RecipeSaveError('Ya existe una receta con ese nombre.', 'DUPLICATE_RECIPE_NAME', 409)
    case 'CONCURRENT_UPDATE':
      throw new RecipeSaveError(
        'La receta cambió desde que la abriste. Recargá e intentá de nuevo.',
        'CONCURRENT_UPDATE',
        409,
      )
    case 'INGREDIENT_NOT_IN_ORG':
      throw new RecipeSaveError('El insumo no está disponible.', 'INGREDIENT_NOT_IN_ORG', 422)
    case 'CATEGORY_NOT_IN_ORG':
      throw new RecipeSaveError('La categoría no está disponible.', 'CATEGORY_NOT_IN_ORG', 422)
    case 'CATEGORY_CONFLICT':
      throw new RecipeSaveError('La categoría indicada no coincide.', 'CATEGORY_CONFLICT', 422)
    case 'NAME_REQUIRED':
      throw new RecipeSaveError('Indicá el nombre de la receta.', 'NAME_REQUIRED', 422)
    case 'INVALID_YIELD':
      throw new RecipeSaveError('El rendimiento debe ser mayor a cero.', 'INVALID_YIELD', 422)
    case 'INVALID_YIELD_UNIT':
      throw new RecipeSaveError('La unidad de rendimiento no es válida.', 'INVALID_YIELD_UNIT', 422)
    case 'INVALID_QUANTITY':
      throw new RecipeSaveError('Cada ingrediente necesita una cantidad mayor a cero.', 'INVALID_QUANTITY', 422)
    case 'INDIVISIBLE_QUANTITY':
      throw new RecipeSaveError(
        'Este insumo no admite consumos parciales. Usá unidades completas.',
        'INDIVISIBLE_QUANTITY',
        422,
      )
    case 'INVALID_BOM':
      throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
    case 'DUPLICATE_INGREDIENT':
      throw new RecipeSaveError('Hay un ingrediente repetido.', 'DUPLICATE_INGREDIENT', 422)
    case 'EXPECTED_REQUIRED':
      throw new RecipeSaveError('Falta la huella de la receta original.', 'EXPECTED_REQUIRED', 400)
    case 'INVALID_PAYLOAD':
      throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
    default:
      reportRpcError(error ?? {}, log)
      throw new RecipeSaveError('No se pudo guardar la receta.', 'UPDATE_FAILED', 500)
  }
}

async function loadAuthorizedOrganization(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .maybeSingle()
  if (error) {
    throw new RecipeSaveError('No se pudo consultar la organización.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || asString(data.id) !== organizationId) {
    throw new RecipeSaveError('Organización no disponible.', 'NOT_FOUND', 404)
  }
}

function isCategorySchemaMissing(
  error: { code?: string; message?: string; details?: string } | null,
): boolean {
  const blob = rpcBlob(error)
  if (/\b(42703|PGRST204)\b/.test(blob) && /category_id/i.test(blob)) return true
  return false
}

async function loadAuthorizedRecipe(
  client: SupabaseClient,
  recipeId: string,
  organizationId: string,
): Promise<RecipeSnapshot> {
  const withCategory = 'id, organization_id, name, recipe_type, active, yield_quantity, yield_unit, category_id'
  const withoutCategory = 'id, organization_id, name, recipe_type, active, yield_quantity, yield_unit'
  const first = await client
    .from('recipes')
    .select(withCategory)
    .eq('id', recipeId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  const result = first.error && isCategorySchemaMissing(first.error)
    ? await client
      .from('recipes')
      .select(withoutCategory)
      .eq('id', recipeId)
      .eq('organization_id', organizationId)
      .maybeSingle()
    : first
  if (result.error) {
    throw new RecipeSaveError('No se pudo consultar la receta.', 'LOOKUP_FAILED', 500)
  }
  const row = isRecord(result.data) ? result.data as Record<string, unknown> : null
  if (!row || asString(row.id) !== recipeId) {
    throw new RecipeSaveError('Receta no disponible.', 'RECIPE_NOT_IN_ORG', 404)
  }
  if (asString(row.organization_id) !== organizationId) {
    throw new RecipeSaveError('Receta no disponible.', 'RECIPE_NOT_IN_ORG', 404)
  }
  const yieldQuantity = parseRecipeNumber(row.yield_quantity)
  if (yieldQuantity == null) {
    throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
  }
  return {
    id: recipeId,
    name: asString(row.name) ?? '',
    active: row.active !== false,
    yieldQuantity,
    yieldUnit: (asString(row.yield_unit) ?? '').toLowerCase(),
    categoryId: asString(row.category_id),
  }
}

async function loadRecipeComponents(
  client: SupabaseClient,
  recipeId: string,
): Promise<ComponentSnapshot[]> {
  const { data, error } = await client
    .from('recipe_components')
    .select('id, recipe_id, inventory_product_id, component_recipe_id, quantity')
    .eq('recipe_id', recipeId)
  if (error) {
    throw new RecipeSaveError('No se pudo consultar la receta.', 'LOOKUP_FAILED', 500)
  }
  const rows = (Array.isArray(data) ? data : []).filter(isRecord)
  const components: ComponentSnapshot[] = []
  for (const row of rows) {
    if (asString(row.recipe_id) !== recipeId) continue
    if (asString(row.component_recipe_id)) {
      throw new RecipeSaveError(
        'Esta receta tiene subrecetas y todavía no se puede editar.',
        'INVALID_BOM',
        422,
      )
    }
    const inventoryProductId = asString(row.inventory_product_id)
    const quantity = parseRecipeNumber(row.quantity)
    if (!inventoryProductId || quantity == null) {
      throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
    }
    components.push({ inventoryProductId, quantity })
  }
  return components
}

function parseComponents(raw: unknown): ComponentSnapshot[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) {
    throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
  }

  const seen = new Set<string>()
  const components: ComponentSnapshot[] = []
  for (const item of raw) {
    if (!isRecord(item)) {
      throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
    }
    if (asString(item.componentRecipeId) || asString(item.component_recipe_id)) {
      throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
    }
    const inventoryProductId = pickString(item, ['inventory_product_id', 'inventoryProductId'])
    if (!inventoryProductId || !UUID.test(inventoryProductId)) {
      throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
    }
    if (seen.has(inventoryProductId)) {
      throw new RecipeSaveError('Hay un ingrediente repetido.', 'DUPLICATE_INGREDIENT', 422)
    }
    seen.add(inventoryProductId)
    const quantity = parseRecipeNumber(item.quantity)
    if (quantity == null || !(quantity > 0)) {
      throw new RecipeSaveError('Cada ingrediente necesita una cantidad mayor a cero.', 'INVALID_QUANTITY', 422)
    }
    components.push({ inventoryProductId, quantity })
  }
  return components
}

function parseExpected(raw: unknown): {
  name: string
  yieldQuantity: number
  yieldUnit: string
  categoryId: string | null
  components: ComponentSnapshot[]
} {
  if (!isRecord(raw)) {
    throw new RecipeSaveError('Falta la huella de la receta original.', 'EXPECTED_REQUIRED', 400)
  }
  const name = pickString(raw, ['name'])
  if (!name) {
    throw new RecipeSaveError('Falta la huella de la receta original.', 'EXPECTED_REQUIRED', 400)
  }
  const yieldQuantity = parseRecipeNumber(raw.yield_quantity ?? raw.yieldQuantity)
  const yieldUnit = pickString(raw, ['yield_unit', 'yieldUnit'])?.toLowerCase() ?? null
  if (yieldQuantity == null || !yieldUnit || !YIELD_UNITS.has(yieldUnit)) {
    throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }
  const categoryIdRaw = pickString(raw, ['category_id', 'categoryId'])
  if (categoryIdRaw && !UUID.test(categoryIdRaw)) {
    throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }
  return {
    name,
    yieldQuantity,
    yieldUnit,
    categoryId: categoryIdRaw,
    components: parseComponents(raw.components),
  }
}

function sameComponents(left: ComponentSnapshot[], right: ComponentSnapshot[]) {
  if (left.length !== right.length) return false
  const rightById = new Map(right.map((item) => [item.inventoryProductId, item.quantity]))
  for (const item of left) {
    const quantity = rightById.get(item.inventoryProductId)
    if (quantity == null || quantity !== item.quantity) return false
  }
  return true
}

function assertExpectedMatches(
  recipe: RecipeSnapshot,
  components: ComponentSnapshot[],
  expected: ReturnType<typeof parseExpected>,
) {
  if (
    recipe.name !== expected.name
    || recipe.yieldQuantity !== expected.yieldQuantity
    || recipe.yieldUnit !== expected.yieldUnit
    || recipe.categoryId !== expected.categoryId
    || !sameComponents(components, expected.components)
  ) {
    throw new RecipeSaveError(
      'La receta cambió desde que la abriste. Recargá e intentá de nuevo.',
      'CONCURRENT_UPDATE',
      409,
    )
  }
}

function buildPayload(input: {
  userId: string
  organizationId: string
  recipeId: string
  body: Record<string, unknown>
}): Record<string, unknown> {
  const name = pickString(input.body, ['name'])
  if (!name) {
    throw new RecipeSaveError('Indicá el nombre de la receta.', 'NAME_REQUIRED', 422)
  }

  const yieldQuantity = parseRecipeNumber(input.body.yield_quantity ?? input.body.yieldQuantity)
  if (yieldQuantity == null || !(yieldQuantity > 0)) {
    throw new RecipeSaveError('El rendimiento debe ser mayor a cero.', 'INVALID_YIELD', 422)
  }

  const yieldUnitRaw = pickString(input.body, ['yield_unit', 'yieldUnit'])
  if (!yieldUnitRaw) {
    throw new RecipeSaveError('La unidad de rendimiento no es válida.', 'INVALID_YIELD_UNIT', 422)
  }
  const yieldUnit = yieldUnitRaw.toLowerCase()
  if (!YIELD_UNITS.has(yieldUnit)) {
    throw new RecipeSaveError('La unidad de rendimiento no es válida.', 'INVALID_YIELD_UNIT', 422)
  }

  const expected = parseExpected(input.body.expected)
  const payload: Record<string, unknown> = {
    actor_user_id: input.userId,
    organization_id: input.organizationId,
    recipe_id: input.recipeId,
    name,
    yield_quantity: yieldQuantity,
    yield_unit: yieldUnit,
    components: parseComponents(input.body.components).map((item) => ({
      inventory_product_id: item.inventoryProductId,
      quantity: item.quantity,
    })),
    expected: {
      name: expected.name,
      yield_quantity: expected.yieldQuantity,
      yield_unit: expected.yieldUnit,
      category_id: expected.categoryId,
      components: expected.components.map((item) => ({
        inventory_product_id: item.inventoryProductId,
        quantity: item.quantity,
      })),
    },
  }

  const categoryId = pickString(input.body, ['category_id', 'categoryId'])
  const categoryName = pickString(input.body, ['category_name', 'categoryName'])
  if (categoryId) {
    if (!UUID.test(categoryId)) {
      throw new RecipeSaveError('La categoría no está disponible.', 'CATEGORY_NOT_IN_ORG', 422)
    }
    payload.category_id = categoryId
  }
  if (categoryName) {
    payload.category_name = categoryName
  }

  return payload
}

function mapResult(data: unknown): RecipeUpdateResult {
  if (!isRecord(data)) {
    throw new RecipeSaveError('No se pudo guardar la receta.', 'UPDATE_FAILED', 500)
  }
  const recipeId = asString(data.recipe_id)
  const name = asString(data.name)
  const yieldQuantity = parseRecipeNumber(data.yield_quantity)
  const yieldUnit = asString(data.yield_unit)?.toLowerCase() ?? null
  const componentCount = parseRecipeNumber(data.component_count)
  const sharedLocationCount = parseRecipeNumber(data.shared_location_count)
  if (
    !recipeId
    || !name
    || yieldQuantity == null
    || !yieldUnit
    || !YIELD_UNITS.has(yieldUnit)
    || componentCount == null
    || componentCount < 0
    || sharedLocationCount == null
    || sharedLocationCount < 0
  ) {
    throw new RecipeSaveError('No se pudo guardar la receta.', 'UPDATE_FAILED', 500)
  }
  const categoryId = asString(data.category_id)
  const categoryName = asString(data.category_name)
  if (Boolean(categoryId) !== Boolean(categoryName)) {
    throw new RecipeSaveError('No se pudo guardar la receta.', 'UPDATE_FAILED', 500)
  }
  const category = categoryId && categoryName
    ? { id: categoryId, name: categoryName }
    : null

  return {
    recipeId,
    name,
    yieldQuantity,
    yieldUnit,
    componentCount,
    category,
    sharedLocationCount,
  }
}

export async function updateOrganizationRecipe(input: RecipeUpdateInput): Promise<RecipeUpdateResult> {
  if (!input.userId) {
    throw new RecipeSaveError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  if (!UUID.test(input.organizationId)) {
    throw new RecipeSaveError('Organización inválida.', 'INVALID_ORGANIZATION', 400)
  }
  if (!UUID.test(input.recipeId)) {
    throw new RecipeSaveError('Receta inválida.', 'INVALID_RECIPE', 400)
  }
  if (!isRecord(input.body)) {
    throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }

  await loadAuthorizedOrganization(input.userClient, input.organizationId)
  const payload = buildPayload({
    userId: input.userId,
    organizationId: input.organizationId,
    recipeId: input.recipeId,
    body: input.body,
  })
  const recipe = await loadAuthorizedRecipe(input.userClient, input.recipeId, input.organizationId)
  if (!recipe.active) {
    throw new RecipeSaveError('Esta receta no está activa.', 'RECIPE_INACTIVE', 409)
  }
  const components = await loadRecipeComponents(input.userClient, input.recipeId)
  assertExpectedMatches(recipe, components, parseExpected(input.body.expected))

  const rpcEnabled = input.rpcEnabled ?? RECIPE_UPDATE_RPC_ENABLED
  if (!rpcEnabled) {
    throw new RecipeSaveError(
      'La edición de recetas todavía no está habilitada.',
      'RECIPE_UPDATE_RPC_PENDING',
      503,
    )
  }

  const nextComponents = Array.isArray(payload.components)
    ? (payload.components as Array<{ inventory_product_id: string; quantity: number }>)
    : []
  if (nextComponents.length > 0) {
    const ids = nextComponents.map((row) => row.inventory_product_id)
    const { data: productRows } = await input.userClient
      .from('inventory_products')
      .select('id, base_unit, presentation_unit, conversion_factor, divisible, active')
      .eq('organization_id', input.organizationId)
      .in('id', ids)
    const check = assertRecipeComponentQuantities(
      (Array.isArray(productRows) ? productRows : []).map((row) => ({
        id: String((row as { id: string }).id),
        baseUnit: (row as { base_unit?: string | null }).base_unit ?? null,
        presentationUnit: (row as { presentation_unit?: string | null }).presentation_unit ?? null,
        conversionFactor: (row as { conversion_factor?: number | null }).conversion_factor ?? null,
        divisible: (row as { divisible?: boolean | null }).divisible ?? null,
        active: (row as { active?: boolean }).active !== false,
      })),
      nextComponents.map((row) => ({
        inventoryProductId: row.inventory_product_id,
        quantity: row.quantity,
      })),
    )
    if (!check.ok) {
      if (check.code === 'INDIVISIBLE_QUANTITY') {
        throw new RecipeSaveError(
          'Este insumo no admite consumos parciales. Usá unidades completas.',
          'INDIVISIBLE_QUANTITY',
          422,
        )
      }
      if (check.code === 'INGREDIENT_NOT_IN_ORG') {
        throw new RecipeSaveError('El insumo no está disponible.', 'INGREDIENT_NOT_IN_ORG', 422)
      }
      throw new RecipeSaveError('Cada ingrediente necesita una cantidad mayor a cero.', 'INVALID_QUANTITY', 422)
    }
  }

  const { data, error } = await input.adminClient.rpc('senda_update_recipe', { p: payload })
  if (error) {
    mapRpcError(error, input.logRpcError)
  }
  return mapResult(data)
}

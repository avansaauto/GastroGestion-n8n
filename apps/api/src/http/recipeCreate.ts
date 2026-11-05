import type { SupabaseClient } from '@supabase/supabase-js'
import { parseRecipeNumber } from './recipeCost.js'
import { assertRecipeComponentQuantities } from './recipeIndivisible.js'
import { RecipeSaveError } from './recipeSaveError.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const YIELD_UNITS = new Set(['unit', 'g', 'ml'])

export type RecipeCategoryRef = {
  id: string
  name: string
}

export type RecipeCreateResult = {
  recipeId: string
  name: string
  yieldQuantity: number
  yieldUnit: string
  componentCount: number
  category: RecipeCategoryRef | null
}

export type RecipeCreateInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  body: unknown
  logRpcError?: (entry: RecipeCreateRpcLog) => void
}

export type RecipeCreateRpcLog = {
  operation: 'senda_create_recipe'
  code: string | null
  message: string | null
  details: string | null
  hint: string | null
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

export function toRecipeCreateRpcLog(error: {
  code?: string
  message?: string
  details?: string
  hint?: string
}): RecipeCreateRpcLog {
  return {
    operation: 'senda_create_recipe',
    code: clipRpcField(error.code, 64),
    message: clipRpcField(error.message),
    details: clipRpcField(error.details),
    hint: clipRpcField(error.hint),
  }
}

function reportRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string },
  log?: (entry: RecipeCreateRpcLog) => void,
) {
  const entry = toRecipeCreateRpcLog(error)
  if (log) {
    log(entry)
    return
  }
  console.error(JSON.stringify(entry))
}

function rpcBlob(error: { code?: string; message?: string; details?: string } | null): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
}

export function isCreateRecipeRpcMissing(
  error: { code?: string; message?: string; details?: string } | null,
): boolean {
  const blob = rpcBlob(error)
  if (/\bPGRST202\b/i.test(blob)) return true
  if (/\b42883\b/.test(blob) && /senda_create_recipe/i.test(blob)) return true
  return /could not find the function/i.test(blob) && /senda_create_recipe/i.test(blob)
}

function rpcToken(error: { code?: string; message?: string; details?: string } | null): string {
  const match = rpcBlob(error).match(
    /\b(BACKEND_ROLE_REQUIRED|ACTOR_REQUIRED|NOT_A_MEMBER|ORGANIZATION_REQUIRED|ORGANIZATION_NOT_FOUND|DUPLICATE_RECIPE_NAME|NAME_REQUIRED|INVALID_YIELD_UNIT|INVALID_YIELD|INVALID_QUANTITY|INDIVISIBLE_QUANTITY|INVALID_BOM|DUPLICATE_INGREDIENT|INGREDIENT_NOT_IN_ORG|CATEGORY_NOT_IN_ORG|CATEGORY_CONFLICT|CONCURRENT_UPDATE|INVALID_PAYLOAD)\b/,
  )
  return match?.[1] ?? ''
}

function mapRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
  log?: (entry: RecipeCreateRpcLog) => void,
): never {
  if (isCreateRecipeRpcMissing(error)) {
    throw new RecipeSaveError(
      'El alta de recetas todavía no está habilitada.',
      'CREATE_RECIPE_RPC_MISSING',
      503,
    )
  }
  const token = rpcToken(error)
  switch (token) {
    case 'NOT_A_MEMBER':
      throw new RecipeSaveError(
        'No tenés autorización para crear recetas en esta organización.',
        'FORBIDDEN',
        403,
      )
    case 'ORGANIZATION_REQUIRED':
    case 'ORGANIZATION_NOT_FOUND':
      throw new RecipeSaveError('Organización no disponible.', 'NOT_FOUND', 404)
    case 'DUPLICATE_RECIPE_NAME':
      throw new RecipeSaveError('Ya existe una receta con ese nombre.', 'DUPLICATE_RECIPE_NAME', 409)
    case 'CONCURRENT_UPDATE':
      throw new RecipeSaveError('No se pudo guardar por un conflicto concurrente.', 'CONCURRENT_UPDATE', 409)
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
    case 'INVALID_PAYLOAD':
      throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
    default:
      reportRpcError(error ?? {}, log)
      throw new RecipeSaveError('No se pudo crear la receta.', 'CREATE_FAILED', 500)
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

function parseComponents(raw: unknown): Array<{
  inventory_product_id: string
  quantity: number
}> {
  if (raw == null) return []
  if (!Array.isArray(raw)) {
    throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
  }

  const seen = new Set<string>()
  const components: Array<{ inventory_product_id: string; quantity: number }> = []
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
    components.push({ inventory_product_id: inventoryProductId, quantity })
  }
  return components
}

function buildPayload(input: {
  userId: string
  organizationId: string
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

  const payload: Record<string, unknown> = {
    actor_user_id: input.userId,
    organization_id: input.organizationId,
    name,
    yield_quantity: yieldQuantity,
    yield_unit: yieldUnit,
    components: parseComponents(input.body.components),
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

function mapResult(data: unknown): RecipeCreateResult {
  if (!isRecord(data)) {
    throw new RecipeSaveError('No se pudo crear la receta.', 'CREATE_FAILED', 500)
  }
  const recipeId = asString(data.recipe_id)
  const name = asString(data.name)
  const yieldQuantity = parseRecipeNumber(data.yield_quantity)
  const yieldUnit = asString(data.yield_unit)?.toLowerCase() ?? null
  const componentCount = parseRecipeNumber(data.component_count)
  if (
    !recipeId
    || !name
    || yieldQuantity == null
    || !yieldUnit
    || !YIELD_UNITS.has(yieldUnit)
    || componentCount == null
    || componentCount < 0
  ) {
    throw new RecipeSaveError('No se pudo crear la receta.', 'CREATE_FAILED', 500)
  }
  const categoryId = asString(data.category_id)
  const categoryName = asString(data.category_name)
  if (Boolean(categoryId) !== Boolean(categoryName)) {
    throw new RecipeSaveError('No se pudo crear la receta.', 'CREATE_FAILED', 500)
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
  }
}

export async function createOrganizationRecipe(input: RecipeCreateInput): Promise<RecipeCreateResult> {
  if (!input.userId) {
    throw new RecipeSaveError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  if (!UUID.test(input.organizationId)) {
    throw new RecipeSaveError('Organización inválida.', 'INVALID_ORGANIZATION', 400)
  }
  if (!isRecord(input.body)) {
    throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }

  await loadAuthorizedOrganization(input.userClient, input.organizationId)
  const payload = buildPayload({
    userId: input.userId,
    organizationId: input.organizationId,
    body: input.body,
  })

  const components = Array.isArray(payload.components)
    ? (payload.components as Array<{ inventory_product_id: string; quantity: number }>)
    : []
  if (components.length > 0) {
    const ids = components.map((row) => row.inventory_product_id)
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
      components.map((row) => ({
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

  const { data, error } = await input.adminClient.rpc('senda_create_recipe', { p: payload })
  if (error) {
    mapRpcError(error, input.logRpcError)
  }
  return mapResult(data)
}

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseRecipeNumber } from './recipeCost.js'
import { RecipeSaveError } from './recipeSaveError.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const YIELD_UNITS = new Set(['unit', 'g', 'ml'])

export const FUDO_SAVE_PERSISTS_CATEGORY = true

export type RecipeSaveResult = {
  recipeId: string
  mappingId: string
  pendingId: string
  replay: boolean
}

export type RecipeSaveInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  locationId: string
  body: unknown
  logRpcError?: (entry: RecipeSaveRpcLog) => void
}

export type RecipeSaveRpcLog = {
  operation: 'senda_save_fudo_recipe'
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

export function toRecipeSaveRpcLog(error: {
  code?: string
  message?: string
  details?: string
  hint?: string
}): RecipeSaveRpcLog {
  return {
    operation: 'senda_save_fudo_recipe',
    code: clipRpcField(error.code, 64),
    message: clipRpcField(error.message),
    details: clipRpcField(error.details),
    hint: clipRpcField(error.hint),
  }
}

function reportRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string },
  log?: (entry: RecipeSaveRpcLog) => void,
) {
  const entry = toRecipeSaveRpcLog(error)
  if (log) {
    log(entry)
    return
  }
  console.error(JSON.stringify(entry))
}

function rpcToken(error: { code?: string; message?: string; details?: string } | null): string {
  const blob = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
  const match = blob.match(/\b(BACKEND_ROLE_REQUIRED|ACTOR_REQUIRED|NOT_A_MEMBER|LOCATION_REQUIRED|LOCATION_NOT_FOUND|INVALID_INTENT|SOURCE_REQUIRED|EXTERNAL_PRODUCT_ID_REQUIRED|PENDING_NOT_FOUND|MAPPING_INACTIVE|ALREADY_LINKED|DUPLICATE_RECIPE_NAME|RECIPE_NOT_IN_ORG|RECIPE_INACTIVE|NAME_REQUIRED|EXISTING_RECIPE_REQUIRED|INVALID_YIELD_UNIT|INVALID_YIELD|INVALID_QUANTITY|INVALID_BOM|DUPLICATE_INGREDIENT|INGREDIENT_NOT_IN_ORG|LINK_DOES_NOT_EDIT_BOM|CATEGORY_NOT_IN_ORG|CATEGORY_CONFLICT|CONCURRENT_UPDATE|INVALID_PAYLOAD)\b/)
  return match?.[1] ?? ''
}

function mapRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
  log?: (entry: RecipeSaveRpcLog) => void,
): never {
  const token = rpcToken(error)
  switch (token) {
    case 'NOT_A_MEMBER':
      throw new RecipeSaveError(
        'No tenés autorización para guardar recetas en este local.',
        'FORBIDDEN',
        403,
      )
    case 'LOCATION_REQUIRED':
    case 'LOCATION_NOT_FOUND':
      throw new RecipeSaveError('Local no disponible.', 'NOT_FOUND', 404)
    case 'PENDING_NOT_FOUND':
      throw new RecipeSaveError('Producto pendiente no disponible.', 'PENDING_NOT_FOUND', 404)
    case 'RECIPE_NOT_IN_ORG':
      throw new RecipeSaveError('Receta no disponible.', 'NOT_FOUND', 404)
    case 'RECIPE_INACTIVE':
      throw new RecipeSaveError('Esta receta no está activa.', 'RECIPE_INACTIVE', 409)
    case 'MAPPING_INACTIVE':
      throw new RecipeSaveError('Ese producto Fudo tiene un vínculo inactivo.', 'MAPPING_INACTIVE', 409)
    case 'ALREADY_LINKED':
      throw new RecipeSaveError('Ese producto Fudo ya está vinculado a otra receta.', 'ALREADY_LINKED', 409)
    case 'DUPLICATE_RECIPE_NAME':
      throw new RecipeSaveError('Ya existe una receta con ese nombre.', 'DUPLICATE_RECIPE_NAME', 409)
    case 'CONCURRENT_UPDATE':
      throw new RecipeSaveError('No se pudo guardar por un conflicto concurrente.', 'CONCURRENT_UPDATE', 409)
    case 'INGREDIENT_NOT_IN_ORG':
      throw new RecipeSaveError('El insumo no está disponible.', 'INGREDIENT_NOT_IN_ORG', 422)
    case 'INVALID_INTENT':
      throw new RecipeSaveError('Indicá si vas a crear o vincular una receta.', 'INVALID_INTENT', 422)
    case 'SOURCE_REQUIRED':
      throw new RecipeSaveError('Falta el origen del producto Fudo.', 'SOURCE_REQUIRED', 422)
    case 'EXTERNAL_PRODUCT_ID_REQUIRED':
      throw new RecipeSaveError('Falta el identificador externo Fudo.', 'EXTERNAL_PRODUCT_ID_REQUIRED', 422)
    case 'NAME_REQUIRED':
      throw new RecipeSaveError('Indicá el nombre de la receta.', 'NAME_REQUIRED', 422)
    case 'EXISTING_RECIPE_REQUIRED':
      throw new RecipeSaveError('Indicá la receta a vincular.', 'EXISTING_RECIPE_REQUIRED', 422)
    case 'INVALID_YIELD':
      throw new RecipeSaveError('El rendimiento debe ser mayor a cero.', 'INVALID_YIELD', 422)
    case 'INVALID_YIELD_UNIT':
      throw new RecipeSaveError('La unidad de rendimiento no es válida.', 'INVALID_YIELD_UNIT', 422)
    case 'INVALID_QUANTITY':
      throw new RecipeSaveError('Cada ingrediente necesita una cantidad mayor a cero.', 'INVALID_QUANTITY', 422)
    case 'INVALID_BOM':
      throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
    case 'DUPLICATE_INGREDIENT':
      throw new RecipeSaveError('Hay un ingrediente repetido.', 'DUPLICATE_INGREDIENT', 422)
    case 'LINK_DOES_NOT_EDIT_BOM':
      throw new RecipeSaveError('Vincular no modifica los ingredientes de la receta.', 'LINK_DOES_NOT_EDIT_BOM', 422)
    case 'CATEGORY_NOT_IN_ORG':
      throw new RecipeSaveError('La categoría no está disponible.', 'CATEGORY_NOT_IN_ORG', 422)
    case 'CATEGORY_CONFLICT':
      throw new RecipeSaveError('La categoría no coincide con el nombre indicado.', 'CATEGORY_CONFLICT', 422)
    case 'INVALID_PAYLOAD':
      throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
    default:
      reportRpcError(error ?? {}, log)
      throw new RecipeSaveError('No se pudo guardar la receta.', 'SAVE_FAILED', 500)
  }
}

async function loadAuthorizedLocation(client: SupabaseClient, locationId: string) {
  const { data, error } = await client
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) {
    throw new RecipeSaveError('No se pudo consultar el local.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || asString(data.id) !== locationId || !asString(data.organization_id)) {
    throw new RecipeSaveError('Local no disponible.', 'NOT_FOUND', 404)
  }
}

function parseComponents(raw: unknown, intent: 'create' | 'link'): Array<{
  inventory_product_id: string
  quantity: number
}> {
  if (raw == null) {
    if (intent === 'link') return []
    return []
  }
  if (!Array.isArray(raw)) {
    throw new RecipeSaveError('Los ingredientes de la receta no son válidos.', 'INVALID_BOM', 422)
  }
  if (intent === 'link' && raw.length > 0) {
    throw new RecipeSaveError(
      'Vincular no modifica los ingredientes de la receta.',
      'LINK_DOES_NOT_EDIT_BOM',
      422,
    )
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
  locationId: string
  body: Record<string, unknown>
}): Record<string, unknown> {
  const intentRaw = pickString(input.body, ['intent'])?.toLowerCase()
  if (intentRaw !== 'create' && intentRaw !== 'link') {
    throw new RecipeSaveError('Indicá si vas a crear o vincular una receta.', 'INVALID_INTENT', 422)
  }

  const source = pickString(input.body, ['source'])
  const externalProductId = pickString(input.body, ['external_product_id', 'externalProductId'])
  if (!source) {
    throw new RecipeSaveError('Falta el origen del producto Fudo.', 'SOURCE_REQUIRED', 422)
  }
  if (!externalProductId) {
    throw new RecipeSaveError('Falta el identificador externo Fudo.', 'EXTERNAL_PRODUCT_ID_REQUIRED', 422)
  }

  const components = parseComponents(input.body.components, intentRaw)
  const payload: Record<string, unknown> = {
    actor_user_id: input.userId,
    location_id: input.locationId,
    intent: intentRaw,
    source,
    external_product_id: externalProductId,
  }

  if (intentRaw === 'link') {
    const existingRecipeId = pickString(input.body, ['existing_recipe_id', 'existingRecipeId'])
    if (!existingRecipeId || !UUID.test(existingRecipeId)) {
      throw new RecipeSaveError('Indicá la receta a vincular.', 'EXISTING_RECIPE_REQUIRED', 422)
    }
    payload.existing_recipe_id = existingRecipeId
    return payload
  }

  if (pickString(input.body, ['existing_recipe_id', 'existingRecipeId'])) {
    throw new RecipeSaveError('Indicá si vas a crear o vincular una receta.', 'INVALID_INTENT', 422)
  }

  const name = pickString(input.body, ['name'])
  if (!name) {
    throw new RecipeSaveError('Indicá el nombre de la receta.', 'NAME_REQUIRED', 422)
  }
  payload.name = name
  payload.components = components

  const yieldRaw = input.body.yield_quantity ?? input.body.yieldQuantity
  if (yieldRaw != null && yieldRaw !== '') {
    const yieldQuantity = parseRecipeNumber(yieldRaw)
    if (yieldQuantity == null || !(yieldQuantity > 0)) {
      throw new RecipeSaveError('El rendimiento debe ser mayor a cero.', 'INVALID_YIELD', 422)
    }
    payload.yield_quantity = yieldQuantity
  }

  const yieldUnitRaw = pickString(input.body, ['yield_unit', 'yieldUnit'])
  if (yieldUnitRaw) {
    const yieldUnit = yieldUnitRaw.toLowerCase()
    if (!YIELD_UNITS.has(yieldUnit)) {
      throw new RecipeSaveError('La unidad de rendimiento no es válida.', 'INVALID_YIELD_UNIT', 422)
    }
    payload.yield_unit = yieldUnit
  }

  const categoryId = pickString(input.body, ['category_id', 'categoryId'])
  const categoryName = pickString(input.body, ['category_name', 'categoryName'])
  if (categoryId || categoryName) {
    if (!FUDO_SAVE_PERSISTS_CATEGORY) {
      throw new RecipeSaveError(
        'El alta Fudo atómica con categoría todavía no está habilitada.',
        'FUDO_CATEGORY_RPC_PENDING',
        503,
      )
    }
    if (categoryId) {
      if (!UUID.test(categoryId)) {
        throw new RecipeSaveError('La categoría no está disponible.', 'CATEGORY_NOT_IN_ORG', 422)
      }
      payload.category_id = categoryId
    }
    if (categoryName) payload.category_name = categoryName
  }

  return payload
}

function mapResult(data: unknown): RecipeSaveResult {
  if (!isRecord(data)) {
    throw new RecipeSaveError('No se pudo guardar la receta.', 'SAVE_FAILED', 500)
  }
  const recipeId = asString(data.recipe_id)
  const mappingId = asString(data.mapping_id)
  const pendingId = asString(data.pending_id)
  if (!recipeId || !mappingId || !pendingId) {
    throw new RecipeSaveError('No se pudo guardar la receta.', 'SAVE_FAILED', 500)
  }
  return {
    recipeId,
    mappingId,
    pendingId,
    replay: data.replay === true,
  }
}

export async function saveFudoRecipe(input: RecipeSaveInput): Promise<RecipeSaveResult> {
  if (!input.userId) {
    throw new RecipeSaveError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  if (!UUID.test(input.locationId)) {
    throw new RecipeSaveError('Local inválido.', 'INVALID_LOCATION', 400)
  }
  if (!isRecord(input.body)) {
    throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }

  await loadAuthorizedLocation(input.userClient, input.locationId)
  const payload = buildPayload({
    userId: input.userId,
    locationId: input.locationId,
    body: input.body,
  })

  const { data, error } = await input.adminClient.rpc('senda_save_fudo_recipe', { p: payload })
  if (error) {
    mapRpcError(error, input.logRpcError)
  }
  return mapResult(data)
}

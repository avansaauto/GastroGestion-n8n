import type { SupabaseClient } from '@supabase/supabase-js'
import { parseRecipeNumber } from './recipeCost.js'
import { RecipeSaveError } from './recipeSaveError.js'

export const RECIPE_PRICE_WRITE_ENABLED = true
export const SALE_PRICE_MAX = 9999999999.99

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type LocationRecipePriceSaveResult = {
  locationId: string
  recipeId: string
  salePrice: number
  version: number
  updatedAt: string | null
  replay: boolean
}

export type LocationRecipePriceSaveInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  locationId: string
  recipeId: string
  body: unknown
  logRpcError?: (entry: RecipePriceSaveRpcLog) => void
  rpcEnabled?: boolean
}

export type RecipePriceSaveRpcLog = {
  operation: 'senda_set_location_recipe_price'
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

function clipRpcField(value: unknown, max = 500): string | null {
  if (value == null || value === '') return null
  let text = String(value)
  text = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  if (text.length > max) text = `${text.slice(0, max)}…`
  return text
}

export function toRecipePriceSaveRpcLog(error: {
  code?: string
  message?: string
  details?: string
  hint?: string
}): RecipePriceSaveRpcLog {
  return {
    operation: 'senda_set_location_recipe_price',
    code: clipRpcField(error.code, 64),
    message: clipRpcField(error.message),
    details: clipRpcField(error.details),
    hint: clipRpcField(error.hint),
  }
}

function reportRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string },
  log?: (entry: RecipePriceSaveRpcLog) => void,
) {
  const entry = toRecipePriceSaveRpcLog(error)
  if (log) {
    log(entry)
    return
  }
  console.error(JSON.stringify(entry))
}

function rpcBlob(error: { code?: string; message?: string; details?: string } | null): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
}

export function isSetLocationRecipePriceRpcMissing(
  error: { code?: string; message?: string; details?: string } | null,
): boolean {
  const blob = rpcBlob(error)
  if (/\bPGRST202\b/i.test(blob)) return true
  if (/\b42883\b/.test(blob) && /senda_set_location_recipe_price/i.test(blob)) return true
  return /could not find the function/i.test(blob) && /senda_set_location_recipe_price/i.test(blob)
}

function rpcToken(error: { code?: string; message?: string; details?: string } | null): string {
  const match = rpcBlob(error).match(
    /\b(BACKEND_ROLE_REQUIRED|ACTOR_REQUIRED|NOT_A_MEMBER|ORGANIZATION_REQUIRED|ORGANIZATION_NOT_FOUND|LOCATION_REQUIRED|LOCATION_NOT_IN_ORG|RECIPE_REQUIRED|RECIPE_NOT_IN_ORG|RECIPE_INACTIVE|RECIPE_NOT_SALE_PRODUCT|CONCURRENT_UPDATE|EXPECTED_REQUIRED|INVALID_SALE_PRICE|INVALID_PAYLOAD)\b/,
  )
  return match?.[1] ?? ''
}

function mapRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
  log?: (entry: RecipePriceSaveRpcLog) => void,
): never {
  if (isSetLocationRecipePriceRpcMissing(error)) {
    throw new RecipeSaveError(
      'Todavía no se puede guardar el precio de venta.',
      'RECIPE_PRICE_RPC_PENDING',
      503,
    )
  }
  const token = rpcToken(error)
  switch (token) {
    case 'NOT_A_MEMBER':
      throw new RecipeSaveError(
        'No tenés autorización para cambiar precios en esta organización.',
        'NOT_A_MEMBER',
        403,
      )
    case 'ORGANIZATION_REQUIRED':
    case 'ORGANIZATION_NOT_FOUND':
      throw new RecipeSaveError('Organización no disponible.', 'ORGANIZATION_NOT_FOUND', 404)
    case 'LOCATION_REQUIRED':
    case 'LOCATION_NOT_IN_ORG':
      throw new RecipeSaveError('Local no disponible.', 'LOCATION_NOT_IN_ORG', 404)
    case 'RECIPE_REQUIRED':
    case 'RECIPE_NOT_IN_ORG':
      throw new RecipeSaveError('Receta no disponible.', 'RECIPE_NOT_IN_ORG', 404)
    case 'RECIPE_INACTIVE':
      throw new RecipeSaveError('Esta receta no está activa.', 'RECIPE_INACTIVE', 409)
    case 'RECIPE_NOT_SALE_PRODUCT':
      throw new RecipeSaveError('Solo se puede poner precio a un producto de venta.', 'RECIPE_NOT_SALE_PRODUCT', 409)
    case 'CONCURRENT_UPDATE':
      throw new RecipeSaveError(
        'El precio cambió desde que lo abriste. Recargá e intentá de nuevo.',
        'CONCURRENT_UPDATE',
        409,
      )
    case 'EXPECTED_REQUIRED':
      throw new RecipeSaveError('Falta la versión del precio.', 'EXPECTED_REQUIRED', 400)
    case 'INVALID_SALE_PRICE':
      throw new RecipeSaveError('Indicá un precio de venta válido.', 'INVALID_SALE_PRICE', 400)
    case 'INVALID_PAYLOAD':
      throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
    default:
      reportRpcError(error ?? {}, log)
      throw new RecipeSaveError('No se pudo guardar el precio de venta.', 'PRICE_SAVE_FAILED', 500)
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
    throw new RecipeSaveError('Organización no disponible.', 'ORGANIZATION_NOT_FOUND', 404)
  }
}

async function loadAuthorizedLocation(
  client: SupabaseClient,
  locationId: string,
  organizationId: string,
) {
  const { data, error } = await client
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) {
    throw new RecipeSaveError('No se pudo consultar el local.', 'LOOKUP_FAILED', 500)
  }
  if (
    !isRecord(data)
    || asString(data.id) !== locationId
    || asString(data.organization_id) !== organizationId
  ) {
    throw new RecipeSaveError('Local no disponible.', 'LOCATION_NOT_IN_ORG', 404)
  }
}

async function loadAuthorizedRecipe(
  client: SupabaseClient,
  recipeId: string,
  organizationId: string,
): Promise<{ id: string; active: boolean }> {
  const { data, error } = await client
    .from('recipes')
    .select('id, organization_id, active')
    .eq('id', recipeId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) {
    throw new RecipeSaveError('No se pudo consultar la receta.', 'LOOKUP_FAILED', 500)
  }
  const row = isRecord(data) ? data : null
  if (!row || asString(row.id) !== recipeId || asString(row.organization_id) !== organizationId) {
    throw new RecipeSaveError('Receta no disponible.', 'RECIPE_NOT_IN_ORG', 404)
  }
  return { id: recipeId, active: row.active === true }
}

export function normalizeSalePrice(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RecipeSaveError('Indicá un precio de venta válido.', 'INVALID_SALE_PRICE', 400)
  }
  const rounded = Math.round(value * 100) / 100
  if (!(rounded > 0) || rounded > SALE_PRICE_MAX) {
    throw new RecipeSaveError('Indicá un precio de venta válido.', 'INVALID_SALE_PRICE', 400)
  }
  return rounded
}

export function parseExpectedVersion(body: Record<string, unknown>): number | null {
  if (!('expectedVersion' in body) && !('expected_version' in body)) {
    throw new RecipeSaveError('Falta la versión del precio.', 'EXPECTED_REQUIRED', 400)
  }
  const raw = 'expectedVersion' in body ? body.expectedVersion : body.expected_version
  if (raw == null) return null
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }
  return raw
}

function parseBody(body: unknown): { salePrice: number; expectedVersion: number | null } {
  if (!isRecord(body)) {
    throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }
  const salePrice = normalizeSalePrice(body.salePrice ?? body.sale_price)
  const expectedVersion = parseExpectedVersion(body)
  return { salePrice, expectedVersion }
}

function mapResult(data: unknown, locationId: string, recipeId: string): LocationRecipePriceSaveResult {
  if (!isRecord(data)) {
    throw new RecipeSaveError('No se pudo guardar el precio de venta.', 'PRICE_SAVE_FAILED', 500)
  }
  const resultLocationId = asString(data.location_id)
  const resultRecipeId = asString(data.recipe_id)
  const salePrice = parseRecipeNumber(data.sale_price)
  const version = parseRecipeNumber(data.version)
  if (
    resultLocationId !== locationId
    || resultRecipeId !== recipeId
    || salePrice == null
    || !(salePrice > 0)
    || version == null
    || !Number.isInteger(version)
    || version <= 0
    || typeof data.replay !== 'boolean'
  ) {
    throw new RecipeSaveError('No se pudo guardar el precio de venta.', 'PRICE_SAVE_FAILED', 500)
  }
  const updatedAt = asString(data.updated_at)
  return {
    locationId: resultLocationId,
    recipeId: resultRecipeId,
    salePrice,
    version,
    updatedAt,
    replay: data.replay,
  }
}

export async function setLocationRecipePrice(
  input: LocationRecipePriceSaveInput,
): Promise<LocationRecipePriceSaveResult> {
  if (!input.userId) {
    throw new RecipeSaveError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  if (!UUID.test(input.organizationId)) {
    throw new RecipeSaveError('Organización inválida.', 'INVALID_ORGANIZATION', 400)
  }
  if (!UUID.test(input.locationId)) {
    throw new RecipeSaveError('Local inválido.', 'INVALID_LOCATION', 400)
  }
  if (!UUID.test(input.recipeId)) {
    throw new RecipeSaveError('Receta inválida.', 'INVALID_RECIPE', 400)
  }

  const parsed = parseBody(input.body)
  await loadAuthorizedOrganization(input.userClient, input.organizationId)
  await loadAuthorizedLocation(input.userClient, input.locationId, input.organizationId)
  const recipe = await loadAuthorizedRecipe(input.userClient, input.recipeId, input.organizationId)
  if (!recipe.active) {
    throw new RecipeSaveError('Esta receta no está activa.', 'RECIPE_INACTIVE', 409)
  }

  const rpcEnabled = input.rpcEnabled ?? RECIPE_PRICE_WRITE_ENABLED
  if (!rpcEnabled) {
    throw new RecipeSaveError(
      'Todavía no se puede guardar el precio de venta.',
      'RECIPE_PRICE_RPC_PENDING',
      503,
    )
  }

  const payload = {
    actor_user_id: input.userId,
    organization_id: input.organizationId,
    location_id: input.locationId,
    recipe_id: input.recipeId,
    sale_price: parsed.salePrice,
    expected_version: parsed.expectedVersion,
  }
  const { data, error } = await input.adminClient.rpc('senda_set_location_recipe_price', { p: payload })
  if (error) {
    mapRpcError(error, input.logRpcError)
  }
  return mapResult(data, input.locationId, input.recipeId)
}

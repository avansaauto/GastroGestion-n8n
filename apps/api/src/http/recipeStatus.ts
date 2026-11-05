import type { SupabaseClient } from '@supabase/supabase-js'
import { RecipeSaveError } from './recipeSaveError.js'

export const RECIPE_STATUS_RPC_ENABLED = true

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type RecipeUsedBy = {
  recipeId: string
  name: string
}

export class RecipeStatusError extends RecipeSaveError {
  constructor(
    message: string,
    code: string,
    status: number,
    public readonly usedBy: RecipeUsedBy[] = [],
  ) {
    super(message, code, status)
    this.name = 'RecipeStatusError'
  }
}

export type RecipeStatusResult = {
  recipeId: string
  active: boolean
  replay: boolean
  usedBy: RecipeUsedBy[]
  activeMappingCount: number
}

export type RecipeStatusInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  recipeId: string
  body: unknown
  logRpcError?: (entry: RecipeStatusRpcLog) => void
  rpcEnabled?: boolean
}

export type RecipeStatusRpcLog = {
  operation: 'senda_set_recipe_active'
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

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
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

export function toRecipeStatusRpcLog(error: {
  code?: string
  message?: string
  details?: string
  hint?: string
}): RecipeStatusRpcLog {
  return {
    operation: 'senda_set_recipe_active',
    code: clipRpcField(error.code, 64),
    message: clipRpcField(error.message),
    details: clipRpcField(error.details),
    hint: clipRpcField(error.hint),
  }
}

function reportRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string },
  log?: (entry: RecipeStatusRpcLog) => void,
) {
  const entry = toRecipeStatusRpcLog(error)
  if (log) {
    log(entry)
    return
  }
  console.error(JSON.stringify(entry))
}

function rpcBlob(error: { code?: string; message?: string; details?: string } | null): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
}

export function isSetRecipeActiveRpcMissing(
  error: { code?: string; message?: string; details?: string } | null,
): boolean {
  const blob = rpcBlob(error)
  if (/\bPGRST202\b/i.test(blob)) return true
  if (/\b42883\b/.test(blob) && /senda_set_recipe_active/i.test(blob)) return true
  return /could not find the function/i.test(blob) && /senda_set_recipe_active/i.test(blob)
}

function rpcToken(error: { code?: string; message?: string; details?: string } | null): string {
  const match = rpcBlob(error).match(
    /\b(BACKEND_ROLE_REQUIRED|ACTOR_REQUIRED|NOT_A_MEMBER|ORGANIZATION_REQUIRED|ORGANIZATION_NOT_FOUND|RECIPE_REQUIRED|RECIPE_NOT_IN_ORG|RECIPE_IN_USE|CONCURRENT_UPDATE|EXPECTED_REQUIRED|INVALID_PAYLOAD)\b/,
  )
  return match?.[1] ?? ''
}

function mapRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
  log?: (entry: RecipeStatusRpcLog) => void,
): never {
  if (isSetRecipeActiveRpcMissing(error)) {
    throw new RecipeSaveError(
      'El cambio de estado de recetas todavía no está habilitado.',
      'RECIPE_STATUS_RPC_MISSING',
      503,
    )
  }
  const token = rpcToken(error)
  switch (token) {
    case 'NOT_A_MEMBER':
      throw new RecipeSaveError(
        'No tenés autorización para cambiar el estado de recetas en esta organización.',
        'FORBIDDEN',
        403,
      )
    case 'ORGANIZATION_REQUIRED':
    case 'ORGANIZATION_NOT_FOUND':
      throw new RecipeSaveError('Organización no disponible.', 'NOT_FOUND', 404)
    case 'RECIPE_REQUIRED':
    case 'RECIPE_NOT_IN_ORG':
      throw new RecipeSaveError('Receta no disponible.', 'RECIPE_NOT_IN_ORG', 404)
    case 'RECIPE_IN_USE':
      throw new RecipeStatusError(
        'No se puede desactivar porque otras recetas activas la usan como subreceta.',
        'RECIPE_IN_USE',
        409,
      )
    case 'CONCURRENT_UPDATE':
      throw new RecipeSaveError(
        'La receta cambió desde que la abriste. Recargá e intentá de nuevo.',
        'CONCURRENT_UPDATE',
        409,
      )
    case 'EXPECTED_REQUIRED':
      throw new RecipeSaveError('Falta la huella de estado de la receta.', 'EXPECTED_REQUIRED', 400)
    case 'INVALID_PAYLOAD':
      throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
    default:
      reportRpcError(error ?? {}, log)
      throw new RecipeSaveError('No se pudo cambiar el estado de la receta.', 'STATUS_FAILED', 500)
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

export async function loadRecipeDependents(
  client: SupabaseClient,
  recipeId: string,
  organizationId: string,
): Promise<RecipeUsedBy[]> {
  const { data, error } = await client
    .from('recipe_components')
    .select('recipe_id, component_recipe_id')
    .eq('component_recipe_id', recipeId)
  if (error) {
    throw new RecipeSaveError('No se pudo consultar las dependencias.', 'LOOKUP_FAILED', 500)
  }
  const parentIds = [...new Set(
    (Array.isArray(data) ? data : [])
      .filter(isRecord)
      .map((row) => asString(row.recipe_id))
      .filter((id): id is string => Boolean(id)),
  )]
  if (parentIds.length === 0) return []

  const parents = await client
    .from('recipes')
    .select('id, organization_id, name, active')
    .eq('organization_id', organizationId)
    .in('id', parentIds)
  if (parents.error) {
    throw new RecipeSaveError('No se pudo consultar las dependencias.', 'LOOKUP_FAILED', 500)
  }
  return (Array.isArray(parents.data) ? parents.data : [])
    .filter(isRecord)
    .filter((row) => asString(row.organization_id) === organizationId && row.active === true)
    .map((row) => ({
      recipeId: asString(row.id) ?? '',
      name: asString(row.name) ?? 'Receta',
    }))
    .filter((row) => row.recipeId)
    .sort((left, right) => left.name.localeCompare(right.name, 'es'))
}

async function loadActiveMappingCount(client: SupabaseClient, recipeId: string) {
  const { data, error } = await client
    .from('sales_product_mappings')
    .select('id, recipe_id, active')
    .eq('recipe_id', recipeId)
  if (error) {
    throw new RecipeSaveError('No se pudo consultar los mappings.', 'LOOKUP_FAILED', 500)
  }
  return (Array.isArray(data) ? data : [])
    .filter(isRecord)
    .filter((row) => asString(row.recipe_id) === recipeId && row.active !== false)
    .length
}

function parseBody(body: unknown): { active: boolean; expectedActive: boolean } {
  if (!isRecord(body)) {
    throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }
  const active = asBoolean(body.active)
  if (active == null) {
    throw new RecipeSaveError('El pedido no es válido.', 'INVALID_PAYLOAD', 400)
  }
  const expectedActive = asBoolean(body.expectedActive ?? body.expected_active)
  if (expectedActive == null) {
    throw new RecipeSaveError('Falta la huella de estado de la receta.', 'EXPECTED_REQUIRED', 400)
  }
  return { active, expectedActive }
}

function mapResult(data: unknown): RecipeStatusResult {
  if (!isRecord(data)) {
    throw new RecipeSaveError('No se pudo cambiar el estado de la receta.', 'STATUS_FAILED', 500)
  }
  const recipeId = asString(data.recipe_id)
  const active = asBoolean(data.active)
  const replay = asBoolean(data.replay)
  const mappingCount = typeof data.active_mapping_count === 'number' ? data.active_mapping_count : null
  if (!recipeId || active == null || replay == null || mappingCount == null || mappingCount < 0) {
    throw new RecipeSaveError('No se pudo cambiar el estado de la receta.', 'STATUS_FAILED', 500)
  }
  const usedBy = (Array.isArray(data.used_by) ? data.used_by : [])
    .filter(isRecord)
    .map((row) => ({
      recipeId: asString(row.recipe_id) ?? '',
      name: asString(row.name) ?? 'Receta',
    }))
    .filter((row) => row.recipeId)
  return {
    recipeId,
    active,
    replay,
    usedBy,
    activeMappingCount: mappingCount,
  }
}

function dependencyMessage(usedBy: RecipeUsedBy[]) {
  const names = usedBy.map((item) => item.name).filter(Boolean)
  if (names.length === 0) {
    return 'No se puede desactivar porque otras recetas activas la usan como subreceta.'
  }
  return `No se puede desactivar porque estas recetas activas la usan como subreceta: ${names.join(', ')}.`
}

export async function setOrganizationRecipeActive(input: RecipeStatusInput): Promise<RecipeStatusResult> {
  if (!input.userId) {
    throw new RecipeSaveError('No autenticado.', 'UNAUTHENTICATED', 401)
  }
  if (!UUID.test(input.organizationId)) {
    throw new RecipeSaveError('Organización inválida.', 'INVALID_ORGANIZATION', 400)
  }
  if (!UUID.test(input.recipeId)) {
    throw new RecipeSaveError('Receta inválida.', 'INVALID_RECIPE', 400)
  }

  await loadAuthorizedOrganization(input.userClient, input.organizationId)
  const parsed = parseBody(input.body)
  const recipe = await loadAuthorizedRecipe(input.userClient, input.recipeId, input.organizationId)

  if (recipe.active === parsed.active) {
    return {
      recipeId: recipe.id,
      active: parsed.active,
      replay: true,
      usedBy: [],
      activeMappingCount: await loadActiveMappingCount(input.userClient, input.recipeId),
    }
  }

  if (recipe.active !== parsed.expectedActive) {
    throw new RecipeSaveError(
      'La receta cambió desde que la abriste. Recargá e intentá de nuevo.',
      'CONCURRENT_UPDATE',
      409,
    )
  }

  const usedBy = parsed.active
    ? []
    : await loadRecipeDependents(input.userClient, input.recipeId, input.organizationId)
  if (!parsed.active && usedBy.length > 0) {
    throw new RecipeStatusError(dependencyMessage(usedBy), 'RECIPE_IN_USE', 409, usedBy)
  }

  const rpcEnabled = input.rpcEnabled ?? RECIPE_STATUS_RPC_ENABLED
  if (!rpcEnabled) {
    throw new RecipeSaveError(
      'El cambio de estado de recetas todavía no está habilitado.',
      'RECIPE_STATUS_RPC_PENDING',
      503,
    )
  }

  const payload = {
    actor_user_id: input.userId,
    organization_id: input.organizationId,
    recipe_id: input.recipeId,
    active: parsed.active,
    expected_active: parsed.expectedActive,
  }
  const { data, error } = await input.adminClient.rpc('senda_set_recipe_active', { p: payload })
  if (error) {
    mapRpcError(error, input.logRpcError)
  }
  return mapResult(data)
}

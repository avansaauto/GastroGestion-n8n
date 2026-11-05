import type { SupabaseClient } from '@supabase/supabase-js'
import { RecipeSaveError } from './recipeSaveError.js'
import { RecipeStatusError, type RecipeUsedBy } from './recipeStatus.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type RecipeDeleteResult = {
  recipeId: string
  deleted: true
  removedMappingCount: number
  removedPriceCount: number
  removedComponentCount: number
}

export type RecipeDeleteInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  recipeId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function rpcBlob(error: { code?: string; message?: string; details?: string; hint?: string } | null): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''}`
}

export function isDeleteRecipeRpcMissing(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
): boolean {
  const blob = rpcBlob(error)
  if (/\bPGRST202\b/i.test(blob)) return true
  if (/\b42883\b/.test(blob) && /senda_delete_recipe/i.test(blob)) return true
  return /could not find the function/i.test(blob) && /senda_delete_recipe/i.test(blob)
}

function isPermissionDenied(error: { code?: string; message?: string; details?: string; hint?: string } | null) {
  const blob = rpcBlob(error)
  return /\b42501\b/.test(blob) || /permission denied/i.test(blob)
}

function dependentsMessage(usedBy: RecipeUsedBy[]) {
  const names = usedBy.map((item) => item.name).filter(Boolean)
  if (names.length === 0) {
    return 'No se puede eliminar porque otras recetas la usan como subreceta.'
  }
  return `No se puede eliminar porque estas recetas la usan como subreceta: ${names.join(', ')}.`
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
): Promise<{ id: string; active: boolean; name: string }> {
  const { data, error } = await client
    .from('recipes')
    .select('id, organization_id, active, name')
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
  return {
    id: recipeId,
    active: row.active === true,
    name: asString(row.name) ?? 'Receta',
  }
}

/** Dependientes como subreceta: activas o inactivas (bloqueo de hard delete). */
async function loadAllRecipeDependents(
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
    .select('id, organization_id, name')
    .eq('organization_id', organizationId)
    .in('id', parentIds)
  if (parents.error) {
    throw new RecipeSaveError('No se pudo consultar las dependencias.', 'LOOKUP_FAILED', 500)
  }
  return (Array.isArray(parents.data) ? parents.data : [])
    .filter(isRecord)
    .filter((row) => asString(row.organization_id) === organizationId)
    .map((row) => ({
      recipeId: asString(row.id) ?? '',
      name: asString(row.name) ?? 'Receta',
    }))
    .filter((row) => row.recipeId)
    .sort((left, right) => left.name.localeCompare(right.name, 'es'))
}

async function assertOrgManager(
  adminClient: SupabaseClient,
  organizationId: string,
  userId: string,
) {
  const { data, error } = await adminClient
    .from('organization_members')
    .select('role, status')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    throw new RecipeSaveError('No se pudo consultar la membresía.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || data.status !== 'active' || !['admin', 'operator'].includes(String(data.role))) {
    throw new RecipeSaveError(
      'No tenés autorización para eliminar recetas en esta organización.',
      'FORBIDDEN',
      403,
    )
  }
}

async function countByColumn(
  adminClient: SupabaseClient,
  table: string,
  column: string,
  recipeId: string,
): Promise<number> {
  const { data, error } = await adminClient
    .from(table)
    .select('id')
    .eq(column, recipeId)
  if (error) {
    throw new RecipeSaveError(
      table === 'location_recipe_prices'
        ? 'No se pudieron consultar los precios de la receta.'
        : 'No se pudieron consultar las dependencias de la receta.',
      'LOOKUP_FAILED',
      500,
    )
  }
  return (Array.isArray(data) ? data : [])
    .filter(isRecord)
    .map((row) => asString(row.id))
    .filter((id): id is string => Boolean(id))
    .length
}

async function countAndDelete(
  adminClient: SupabaseClient,
  table: string,
  column: string,
  recipeId: string,
): Promise<number> {
  const { data, error: selectError } = await adminClient
    .from(table)
    .select('id')
    .eq(column, recipeId)
  if (selectError) {
    throw new RecipeSaveError('No se pudieron consultar las dependencias de la receta.', 'LOOKUP_FAILED', 500)
  }
  const ids = (Array.isArray(data) ? data : [])
    .filter(isRecord)
    .map((row) => asString(row.id))
    .filter((id): id is string => Boolean(id))
  if (ids.length === 0) return 0
  const { error: deleteError } = await adminClient
    .from(table)
    .delete()
    .in('id', ids)
  if (deleteError) {
    if (table === 'location_recipe_prices' && isPermissionDenied(deleteError)) {
      throw new RecipeSaveError(
        'Esta receta tiene precio por local y la base no permite borrarlo con la API actual. Aplicá proposed-senda-delete-recipe.sql.',
        'RECIPE_PRICE_DELETE_DENIED',
        503,
      )
    }
    throw new RecipeSaveError(
      `No se pudo eliminar la receta (${table}).`,
      'DELETE_FAILED',
      500,
    )
  }
  return ids.length
}

function mapRpcResult(data: unknown, recipeId: string): RecipeDeleteResult {
  if (!isRecord(data) || data.deleted !== true) {
    throw new RecipeSaveError('La respuesta de eliminación está incompleta.', 'DELETE_FAILED', 500)
  }
  return {
    recipeId: asString(data.recipe_id) ?? recipeId,
    deleted: true,
    removedMappingCount: asNumber(data.removed_mapping_count) ?? 0,
    removedPriceCount: asNumber(data.removed_price_count) ?? 0,
    removedComponentCount: asNumber(data.removed_component_count) ?? 0,
  }
}

function mapRpcError(error: { code?: string; message?: string; details?: string; hint?: string } | null): never {
  const blob = rpcBlob(error)
  if (/RECIPE_STILL_ACTIVE/i.test(blob)) {
    throw new RecipeSaveError(
      'Retirá la receta antes de eliminarla definitivamente.',
      'RECIPE_STILL_ACTIVE',
      409,
    )
  }
  if (/RECIPE_IN_USE/i.test(blob)) {
    throw new RecipeStatusError(
      'No se puede eliminar porque otras recetas la usan como subreceta.',
      'RECIPE_IN_USE',
      409,
    )
  }
  if (/NOT_A_MEMBER/i.test(blob)) {
    throw new RecipeSaveError(
      'No tenés autorización para eliminar recetas en esta organización.',
      'FORBIDDEN',
      403,
    )
  }
  if (/RECIPE_NOT_IN_ORG/i.test(blob)) {
    throw new RecipeSaveError('Receta no disponible.', 'RECIPE_NOT_IN_ORG', 404)
  }
  throw new RecipeSaveError('No se pudo eliminar la receta.', 'DELETE_FAILED', 500)
}

async function deleteViaRpc(input: RecipeDeleteInput): Promise<RecipeDeleteResult | 'missing'> {
  const { data, error } = await input.adminClient.rpc('senda_delete_recipe', {
    p: {
      actor_user_id: input.userId,
      organization_id: input.organizationId,
      recipe_id: input.recipeId,
    },
  })
  if (error) {
    if (isDeleteRecipeRpcMissing(error)) return 'missing'
    mapRpcError(error)
  }
  return mapRpcResult(data, input.recipeId)
}

/**
 * Eliminación definitiva de una receta inactiva.
 * Preferencia: RPC DEFINER senda_delete_recipe (borra precios pese a revoke DELETE
 * de service_role sobre location_recipe_prices).
 * Fallback: borrado directo solo si no hay precios por local (o si DELETE está permitido).
 * Un mapping Fudo no es venta histórica.
 */
export async function deleteOrganizationRecipe(input: RecipeDeleteInput): Promise<RecipeDeleteResult> {
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
  await assertOrgManager(input.adminClient, input.organizationId, input.userId)
  const recipe = await loadAuthorizedRecipe(input.userClient, input.recipeId, input.organizationId)

  if (recipe.active) {
    throw new RecipeSaveError(
      'Retirá la receta antes de eliminarla definitivamente.',
      'RECIPE_STILL_ACTIVE',
      409,
    )
  }

  const usedBy = await loadAllRecipeDependents(input.adminClient, input.recipeId, input.organizationId)
  if (usedBy.length > 0) {
    throw new RecipeStatusError(dependentsMessage(usedBy), 'RECIPE_IN_USE', 409, usedBy)
  }

  const rpcResult = await deleteViaRpc(input)
  if (rpcResult !== 'missing') return rpcResult

  // Sin RPC: no mutar mappings si hay precios (service_role no tiene DELETE ahí).
  const priceCount = await countByColumn(
    input.adminClient,
    'location_recipe_prices',
    'recipe_id',
    input.recipeId,
  )
  if (priceCount > 0) {
    throw new RecipeSaveError(
      `Esta receta tiene ${priceCount} precio${priceCount === 1 ? '' : 's'} por local. ` +
        'La base no permite borrarlos sin senda_delete_recipe. Aplicá proposed-senda-delete-recipe.sql.',
      'RECIPE_PRICE_DELETE_DENIED',
      503,
    )
  }

  const removedMappingCount = await countAndDelete(
    input.adminClient,
    'sales_product_mappings',
    'recipe_id',
    input.recipeId,
  )
  const removedPriceCount = await countAndDelete(
    input.adminClient,
    'location_recipe_prices',
    'recipe_id',
    input.recipeId,
  )
  const removedComponentCount = await countAndDelete(
    input.adminClient,
    'recipe_components',
    'recipe_id',
    input.recipeId,
  )

  const { error: deleteRecipeError } = await input.adminClient
    .from('recipes')
    .delete()
    .eq('id', input.recipeId)
    .eq('organization_id', input.organizationId)
  if (deleteRecipeError) {
    throw new RecipeSaveError('No se pudo eliminar la receta.', 'DELETE_FAILED', 500)
  }

  return {
    recipeId: input.recipeId,
    deleted: true,
    removedMappingCount,
    removedPriceCount,
    removedComponentCount,
  }
}

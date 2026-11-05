import type { SupabaseClient } from '@supabase/supabase-js'
import { parseRecipeNumber } from './recipeCost.js'
import { RecipeQueryError } from './recipeQueryError.js'

export const RECIPE_PRICE_READ_ENABLED = true

export type LocationRecipePrice = {
  recipeId: string
  salePrice: number
  version: number
}

export type ListLocationRecipePricesOptions = {
  readEnabled?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function errorBlob(error: { code?: string; message?: string; details?: string } | null): string {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
}

export function isLocationRecipePriceTableMissing(
  error: { code?: string; message?: string; details?: string } | null,
): boolean {
  const blob = errorBlob(error)
  if (/\b(42P01|PGRST205)\b/.test(blob) && /location_recipe_prices/i.test(blob)) return true
  return /could not find the table/i.test(blob) && /location_recipe_prices/i.test(blob)
}

function lookupFailed(message = 'No se pudieron consultar los precios de venta.'): never {
  throw new RecipeQueryError(message, 'LOOKUP_FAILED', 500)
}

function tablePending(): never {
  throw new RecipeQueryError(
    'Todavía no se pueden consultar los precios de venta.',
    'RECIPE_PRICE_TABLE_PENDING',
    503,
  )
}

function mapPrice(
  row: Record<string, unknown>,
  organizationId: string,
  locationId: string,
): LocationRecipePrice | null {
  if (asString(row.location_id) !== locationId) return null
  if (asString(row.organization_id) !== organizationId) return null
  const recipeId = asString(row.recipe_id)
  const salePrice = parseRecipeNumber(row.sale_price)
  const version = parseRecipeNumber(row.version)
  if (!recipeId || salePrice == null || salePrice <= 0 || version == null || !Number.isInteger(version) || version <= 0) {
    return null
  }
  return { recipeId, salePrice, version }
}

export async function listLocationRecipePrices(
  client: SupabaseClient,
  organizationId: string,
  locationId: string,
  options: ListLocationRecipePricesOptions = {},
): Promise<LocationRecipePrice[]> {
  const enabled = options.readEnabled ?? RECIPE_PRICE_READ_ENABLED
  if (!enabled) tablePending()

  const organization = await client
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .maybeSingle()
  if (organization.error) lookupFailed()
  if (!isRecord(organization.data) || asString(organization.data.id) !== organizationId) {
    throw new RecipeQueryError('Organización no disponible.', 'NOT_FOUND', 404)
  }

  const location = await client
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (location.error) lookupFailed('No se pudo consultar el local.')
  if (
    !isRecord(location.data)
    || asString(location.data.id) !== locationId
    || asString(location.data.organization_id) !== organizationId
  ) {
    throw new RecipeQueryError('Local no disponible.', 'NOT_FOUND', 404)
  }

  const { data, error } = await client
    .from('location_recipe_prices')
    .select('recipe_id, sale_price, version, location_id, organization_id')
    .eq('location_id', locationId)
    .eq('organization_id', organizationId)

  if (error) {
    if (isLocationRecipePriceTableMissing(error)) tablePending()
    lookupFailed()
  }

  return (Array.isArray(data) ? data : [])
    .filter(isRecord)
    .map((row) => mapPrice(row, organizationId, locationId))
    .filter((row): row is LocationRecipePrice => Boolean(row))
}

import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { RecipeSaveError } from './recipeSaveError.js'
import {
  RECIPE_PRICE_WRITE_ENABLED,
  SALE_PRICE_MAX,
  isSetLocationRecipePriceRpcMissing,
  normalizeSalePrice,
  setLocationRecipePrice,
} from './recipePriceSave.js'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const OTHER_ORGANIZATION = '99999999-9999-4999-8999-999999999999'
const LOCATION = '22222222-2222-4222-8222-222222222222'
const OTHER_LOCATION = '33333333-3333-4333-8333-333333333333'
const RECIPE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function filterable(rows: Record<string, unknown>[], error: { message?: string } | null = null) {
  let filtered = [...rows]
  const builder: Record<string, unknown> = {}
  const self = () => builder
  builder.select = self
  builder.eq = (column: string, value: string) => {
    filtered = filtered.filter((row) => String(row[column] ?? '') === value)
    return builder
  }
  builder.maybeSingle = async () => ({
    data: error ? null : filtered[0] ?? null,
    error,
  })
  builder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => {
    resolve({ data: error ? null : filtered, error })
  }
  return builder
}

function clients(options: {
  organization?: Record<string, unknown> | null
  locations?: Record<string, unknown>[]
  recipes?: Record<string, unknown>[]
  rpcData?: Record<string, unknown> | null
  rpcError?: { code?: string; message?: string; details?: string } | null
} = {}) {
  const tables: string[] = []
  const from = vi.fn((table: string) => {
    tables.push(table)
    if (
      table === 'inventory_movements'
      || table === 'pending_product_mappings'
      || table === 'sales_product_mappings'
      || table === 'recipe_components'
      || table === 'location_recipe_prices'
    ) {
      throw new Error(`${table} no debe consultarse`)
    }
    if (table === 'organizations') {
      return filterable(
        options.organization === undefined
          ? [{ id: ORGANIZATION }]
          : options.organization
            ? [options.organization]
            : [],
      )
    }
    if (table === 'locations') {
      return filterable(
        options.locations ?? [{ id: LOCATION, organization_id: ORGANIZATION }],
      )
    }
    if (table === 'recipes') {
      return filterable(
        options.recipes ?? [{
          id: RECIPE,
          organization_id: ORGANIZATION,
          active: true,
        }],
      )
    }
    throw new Error(`tabla inesperada: ${table}`)
  })
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: options.rpcError ? null : (options.rpcData ?? {
      location_id: LOCATION,
      recipe_id: RECIPE,
      sale_price: 4500,
      version: 1,
      updated_at: '2026-10-17T00:00:00Z',
      replay: false,
    }),
    error: options.rpcError ?? null,
  }))
  return {
    from,
    rpc,
    tables,
    user: { from } as unknown as SupabaseClient,
    admin: { rpc } as unknown as SupabaseClient,
  }
}

async function savePrice(
  db: ReturnType<typeof clients>,
  overrides: Partial<{
    userId: string
    organizationId: string
    locationId: string
    recipeId: string
    body: unknown
    rpcEnabled: boolean
  }> = {},
) {
  return setLocationRecipePrice({
    userClient: db.user,
    adminClient: db.admin,
    userId: 'userId' in overrides ? overrides.userId ?? '' : USER,
    organizationId: overrides.organizationId ?? ORGANIZATION,
    locationId: overrides.locationId ?? LOCATION,
    recipeId: overrides.recipeId ?? RECIPE,
    body: 'body' in overrides ? overrides.body : { salePrice: 4500, expectedVersion: null },
    rpcEnabled: overrides.rpcEnabled,
  })
}

describe('setLocationRecipePrice', () => {
  it('llama senda_set_location_recipe_price y no escribe stock ni mappings', async () => {
    expect(RECIPE_PRICE_WRITE_ENABLED).toBe(true)
    const db = clients()
    const result = await savePrice(db)
    expect(result).toEqual({
      locationId: LOCATION,
      recipeId: RECIPE,
      salePrice: 4500,
      version: 1,
      updatedAt: '2026-10-17T00:00:00Z',
      replay: false,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_set_location_recipe_price', {
      p: {
        actor_user_id: USER,
        organization_id: ORGANIZATION,
        location_id: LOCATION,
        recipe_id: RECIPE,
        sale_price: 4500,
        expected_version: null,
      },
    })
    expect(db.rpc.mock.calls[0]?.[0]).not.toBe('senda_create_recipe')
    expect(db.rpc.mock.calls[0]?.[0]).not.toBe('senda_update_recipe')
    expect(db.rpc.mock.calls[0]?.[0]).not.toBe('senda_save_fudo_recipe')
    expect(db.tables).toEqual(['organizations', 'locations', 'recipes'])
  })

  it('actualiza con expected_version y trata un reintento idéntico como replay', async () => {
    const db = clients({
      rpcData: {
        location_id: LOCATION,
        recipe_id: RECIPE,
        sale_price: 4800,
        version: 2,
        updated_at: '2026-10-17T01:00:00Z',
        replay: true,
      },
    })
    const result = await savePrice(db, { body: { salePrice: 4800, expectedVersion: 1 } })
    expect(result.replay).toBe(true)
    expect(result.version).toBe(2)
    expect(db.rpc).toHaveBeenCalledWith('senda_set_location_recipe_price', {
      p: expect.objectContaining({
        sale_price: 4800,
        expected_version: 1,
      }),
    })
  })

  it('propaga CONCURRENT_UPDATE y no llama el RPC si está inactiva', async () => {
    const concurrent = clients({
      rpcError: { message: 'CONCURRENT_UPDATE' },
    })
    await expect(savePrice(concurrent, { body: { salePrice: 5000, expectedVersion: 1 } })).rejects.toMatchObject({
      code: 'CONCURRENT_UPDATE',
      status: 409,
    })

    const inactive = clients({
      recipes: [{ id: RECIPE, organization_id: ORGANIZATION, active: false }],
    })
    await expect(savePrice(inactive)).rejects.toMatchObject({
      code: 'RECIPE_INACTIVE',
      status: 409,
    })
    expect(inactive.rpc).not.toHaveBeenCalled()
  })

  it('rechaza cero, negativo, fuera de rango y expected ausente', async () => {
    expect(() => normalizeSalePrice(0)).toThrow(RecipeSaveError)
    expect(() => normalizeSalePrice(-10)).toThrow(RecipeSaveError)
    expect(() => normalizeSalePrice(SALE_PRICE_MAX + 0.01)).toThrow(RecipeSaveError)
    expect(() => normalizeSalePrice(0.004)).toThrow(RecipeSaveError)
    await expect(savePrice(clients(), { body: { salePrice: 0, expectedVersion: null } })).rejects.toMatchObject({
      code: 'INVALID_SALE_PRICE',
      status: 400,
    })
    await expect(savePrice(clients(), { body: { salePrice: 4500 } })).rejects.toMatchObject({
      code: 'EXPECTED_REQUIRED',
      status: 400,
    })
    const db = clients()
    await expect(savePrice(db, { body: { salePrice: 0.004, expectedVersion: null } })).rejects.toMatchObject({
      code: 'INVALID_SALE_PRICE',
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('no expone org o local ajenos y no llama el RPC', async () => {
    const otherOrg = clients({ organization: null })
    await expect(savePrice(otherOrg, { organizationId: OTHER_ORGANIZATION })).rejects.toMatchObject({
      code: 'ORGANIZATION_NOT_FOUND',
      status: 404,
    })
    expect(otherOrg.rpc).not.toHaveBeenCalled()

    const otherLoc = clients({
      locations: [{ id: OTHER_LOCATION, organization_id: OTHER_ORGANIZATION }],
    })
    await expect(savePrice(otherLoc, { locationId: OTHER_LOCATION })).rejects.toMatchObject({
      code: 'LOCATION_NOT_IN_ORG',
      status: 404,
    })
    expect(otherLoc.rpc).not.toHaveBeenCalled()
  })

  it('si falta el RPC responde 503 y admite apagar la escritura', async () => {
    expect(isSetLocationRecipePriceRpcMissing({
      code: 'PGRST202',
      message: 'Could not find the function senda_set_location_recipe_price',
    })).toBe(true)
    const missing = clients({
      rpcError: { code: 'PGRST202', message: 'Could not find the function senda_set_location_recipe_price' },
    })
    await expect(savePrice(missing)).rejects.toMatchObject({
      code: 'RECIPE_PRICE_RPC_PENDING',
      status: 503,
    })
    const off = clients()
    await expect(savePrice(off, { rpcEnabled: false })).rejects.toMatchObject({
      code: 'RECIPE_PRICE_RPC_PENDING',
      status: 503,
    })
    expect(off.rpc).not.toHaveBeenCalled()
  })
})

import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  RECIPE_PRICE_READ_ENABLED,
  isLocationRecipePriceTableMissing,
  listLocationRecipePrices,
} from './recipePrice.js'
import { RecipeQueryError } from './recipeQueryError.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const LOC = '22222222-2222-4222-8222-222222222222'
const OTHER_LOC = '33333333-3333-4333-8333-333333333333'
const RECIPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RECIPE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function filterable(
  rows: Record<string, unknown>[],
  error: { message?: string; code?: string } | null = null,
) {
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

function client(options: {
  organizations?: Record<string, unknown>[]
  organizationError?: { message?: string } | null
  locations?: Record<string, unknown>[]
  locationError?: { message?: string } | null
  prices?: Record<string, unknown>[]
  pricesError?: { message?: string; code?: string } | null
} = {}) {
  const tables: string[] = []
  const from = vi.fn((table: string) => {
    tables.push(table)
    if (table === 'inventory_movements' || table === 'sales_product_mappings' || table === 'recipes') {
      throw new Error(`${table} no debe consultarse`)
    }
    if (table === 'organizations') {
      return filterable(
        options.organizations ?? [{ id: ORG }],
        options.organizationError ?? null,
      )
    }
    if (table === 'locations') {
      return filterable(
        options.locations ?? [{ id: LOC, organization_id: ORG }],
        options.locationError ?? null,
      )
    }
    if (table === 'location_recipe_prices') {
      return filterable(options.prices ?? [], options.pricesError ?? null)
    }
    throw new Error(`tabla inesperada: ${table}`)
  })
  return { from, tables, client: { from } as unknown as SupabaseClient }
}

const priceRow = {
  recipe_id: RECIPE,
  sale_price: 4500,
  version: 1,
  location_id: LOC,
  organization_id: ORG,
}

describe('listLocationRecipePrices', () => {
  it('lee por defecto y no consulta si el flag se apaga', async () => {
    expect(RECIPE_PRICE_READ_ENABLED).toBe(true)
    const off = client({ prices: [priceRow] })
    await expect(
      listLocationRecipePrices(off.client, ORG, LOC, { readEnabled: false }),
    ).rejects.toMatchObject({
      name: 'RecipeQueryError',
      code: 'RECIPE_PRICE_TABLE_PENDING',
      status: 503,
    })
    expect(off.tables).toEqual([])
  })

  it('devuelve solo filas del local, sin inventar precios', async () => {
    const db = client({
      prices: [
        priceRow,
        {
          recipe_id: RECIPE_B,
          sale_price: 0,
          version: 1,
          location_id: LOC,
          organization_id: ORG,
        },
        {
          recipe_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          sale_price: 1200,
          version: 2,
          location_id: OTHER_LOC,
          organization_id: ORG,
        },
      ],
    })
    const items = await listLocationRecipePrices(db.client, ORG, LOC)
    expect(items).toEqual([{ recipeId: RECIPE, salePrice: 4500, version: 1 }])
    expect(items.find((row) => row.recipeId === RECIPE_B)).toBeUndefined()
    expect(db.tables).toEqual(['organizations', 'locations', 'location_recipe_prices'])
    expect(db.tables.filter((table) => table === 'location_recipe_prices')).toHaveLength(1)
    expect(db.tables).not.toContain('recipes')
    expect(db.tables).not.toContain('sales_product_mappings')
    expect(db.tables).not.toContain('inventory_movements')
  })

  it('rechaza organización o local ajenos sin leer precios', async () => {
    const otherOrg = client({
      organizations: [],
      prices: [priceRow],
    })
    await expect(
      listLocationRecipePrices(otherOrg.client, OTHER_ORG, LOC),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(otherOrg.tables).not.toContain('location_recipe_prices')

    const otherLoc = client({
      locations: [{ id: OTHER_LOC, organization_id: OTHER_ORG }],
      prices: [priceRow],
    })
    await expect(
      listLocationRecipePrices(otherLoc.client, ORG, OTHER_LOC),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(otherLoc.tables).not.toContain('location_recipe_prices')
  })

  it('si falta la tabla responde 503 y no escribe', async () => {
    const db = client({
      pricesError: { code: '42P01', message: 'relation location_recipe_prices does not exist' },
    })
    await expect(
      listLocationRecipePrices(db.client, ORG, LOC),
    ).rejects.toMatchObject({
      code: 'RECIPE_PRICE_TABLE_PENDING',
      status: 503,
    })
    expect(isLocationRecipePriceTableMissing({
      code: 'PGRST205',
      message: 'Could not find the table public.location_recipe_prices',
    })).toBe(true)
  })
})

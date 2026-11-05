import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { deleteOrganizationRecipe } from './recipeDelete.js'
import { RecipeSaveError } from './recipeSaveError.js'
import { RecipeStatusError } from './recipeStatus.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const RECIPE = '22222222-2222-4222-8222-222222222222'
const ACTOR = '33333333-3333-4333-8333-333333333333'
const PARENT = '44444444-4444-4444-8444-444444444444'

function client(tables: Record<string, unknown>) {
  return {
    from(table: string) {
      const rows = tables[table]
      const filters: Array<(row: Record<string, unknown>) => boolean> = []
      const builder = {
        select() { return builder },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value)
          return builder
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]))
          return builder
        },
        delete() { return builder },
        maybeSingle: async () => {
          const list = Array.isArray(rows)
            ? rows as Record<string, unknown>[]
            : rows && typeof rows === 'object' && !(rows instanceof Error)
              ? [rows as Record<string, unknown>]
              : []
          const matched = list.find((row) => filters.every((fn) => fn(row))) ?? null
          return { data: matched, error: rows instanceof Error ? { message: rows.message } : null }
        },
        then(resolve: (value: { data: unknown; error: { message: string } | null }) => void) {
          if (rows instanceof Error) {
            resolve({ data: null, error: { message: rows.message } })
            return
          }
          const list = Array.isArray(rows) ? rows as Record<string, unknown>[] : []
          const matched = list.filter((row) => filters.every((fn) => fn(row)))
          resolve({ data: matched, error: null })
        },
      }
      return builder
    },
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
  } as unknown as SupabaseClient
}

describe('deleteOrganizationRecipe', () => {
  it('bloquea recetas activas', async () => {
    const user = client({
      organizations: { id: ORG },
      recipes: { id: RECIPE, organization_id: ORG, active: true, name: 'IPA' },
    })
    const admin = client({
      organization_members: {
        organization_id: ORG,
        user_id: ACTOR,
        role: 'admin',
        status: 'active',
      },
    })
    await expect(deleteOrganizationRecipe({
      userClient: user,
      adminClient: admin,
      userId: ACTOR,
      organizationId: ORG,
      recipeId: RECIPE,
    })).rejects.toMatchObject({ code: 'RECIPE_STILL_ACTIVE' })
  })

  it('bloquea si otra receta la usa como subreceta', async () => {
    const user = client({
      organizations: { id: ORG },
      recipes: { id: RECIPE, organization_id: ORG, active: false, name: 'Pan' },
    })
    const admin = client({
      organization_members: {
        organization_id: ORG,
        user_id: ACTOR,
        role: 'admin',
        status: 'active',
      },
      recipe_components: [{ recipe_id: PARENT, component_recipe_id: RECIPE }],
      recipes: [{ id: PARENT, organization_id: ORG, name: 'Hamburguesa' }],
    })
    await expect(deleteOrganizationRecipe({
      userClient: user,
      adminClient: admin,
      userId: ACTOR,
      organizationId: ORG,
      recipeId: RECIPE,
    })).rejects.toBeInstanceOf(RecipeStatusError)
  })

  it('sin RPC, bloquea antes de mutar si hay precios por local', async () => {
    const deleted: string[] = []
    const admin = {
      from(table: string) {
        if (table === 'organization_members') {
          return {
            select() { return this },
            eq() { return this },
            maybeSingle: async () => ({
              data: { role: 'admin', status: 'active', organization_id: ORG, user_id: ACTOR },
              error: null,
            }),
          }
        }
        if (table === 'recipe_components') {
          return {
            select() { return this },
            eq() { return this },
            in() { return this },
            delete() {
              deleted.push(table)
              return this
            },
            then(resolve: (value: { data: unknown; error: null }) => void) {
              resolve({ data: [], error: null })
            },
          }
        }
        if (table === 'location_recipe_prices') {
          return {
            select() { return this },
            eq() { return this },
            in() { return this },
            delete() {
              deleted.push(table)
              return this
            },
            then(resolve: (value: { data: unknown; error: null }) => void) {
              resolve({ data: [{ id: 'price-1' }], error: null })
            },
          }
        }
        if (table === 'sales_product_mappings') {
          return {
            select() { return this },
            eq() { return this },
            in() { return this },
            delete() {
              deleted.push(table)
              return this
            },
            then(resolve: (value: { data: unknown; error: null }) => void) {
              resolve({ data: [{ id: 'map-1' }], error: null })
            },
          }
        }
        return {
          select() { return this },
          eq() { return this },
          then(resolve: (value: { data: unknown; error: null }) => void) {
            resolve({ data: [], error: null })
          },
        }
      },
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    } as unknown as SupabaseClient

    const user = client({
      organizations: { id: ORG },
      recipes: { id: RECIPE, organization_id: ORG, active: false, name: 'Apa' },
    })

    await expect(deleteOrganizationRecipe({
      userClient: user,
      adminClient: admin,
      userId: ACTOR,
      organizationId: ORG,
      recipeId: RECIPE,
    })).rejects.toMatchObject({ code: 'RECIPE_PRICE_DELETE_DENIED' })
    expect(deleted).toEqual([])
  })

  it('sin RPC ni precios, elimina mappings y componentes', async () => {
    const deleted: string[] = []
    const admin = {
      from(table: string) {
        if (table === 'organization_members') {
          return {
            select() { return this },
            eq() { return this },
            maybeSingle: async () => ({
              data: { role: 'admin', status: 'active', organization_id: ORG, user_id: ACTOR },
              error: null,
            }),
          }
        }
        if (table === 'recipe_components') {
          return {
            select() { return this },
            eq() { return this },
            in() { return this },
            delete() {
              deleted.push(table)
              return this
            },
            then(resolve: (value: { data: unknown; error: null }) => void) {
              resolve({ data: [{ id: 'comp-1' }], error: null })
            },
          }
        }
        if (table === 'location_recipe_prices') {
          return {
            select() { return this },
            eq() { return this },
            in() { return this },
            delete() {
              deleted.push(table)
              return this
            },
            then(resolve: (value: { data: unknown; error: null }) => void) {
              resolve({ data: [], error: null })
            },
          }
        }
        if (table === 'sales_product_mappings') {
          return {
            select() { return this },
            eq() { return this },
            in() { return this },
            delete() {
              deleted.push(table)
              return this
            },
            then(resolve: (value: { data: unknown; error: null }) => void) {
              resolve({ data: [{ id: 'map-1' }], error: null })
            },
          }
        }
        if (table === 'recipes') {
          return {
            select() { return this },
            eq() { return this },
            in() { return this },
            delete() {
              deleted.push(table)
              return this
            },
            then(resolve: (value: { data: unknown; error: null }) => void) {
              resolve({ data: [], error: null })
            },
          }
        }
        return {
          select() { return this },
          eq() { return this },
          then(resolve: (value: { data: unknown; error: null }) => void) {
            resolve({ data: [], error: null })
          },
        }
      },
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    } as unknown as SupabaseClient

    const user = client({
      organizations: { id: ORG },
      recipes: { id: RECIPE, organization_id: ORG, active: false, name: 'Apa' },
    })

    const result = await deleteOrganizationRecipe({
      userClient: user,
      adminClient: admin,
      userId: ACTOR,
      organizationId: ORG,
      recipeId: RECIPE,
    })
    expect(result).toEqual({
      recipeId: RECIPE,
      deleted: true,
      removedMappingCount: 1,
      removedPriceCount: 0,
      removedComponentCount: 1,
    })
    expect(deleted).toEqual(['sales_product_mappings', 'recipe_components', 'recipes'])
  })

  it('usa senda_delete_recipe cuando está instalado', async () => {
    const admin = {
      from(table: string) {
        if (table === 'organization_members') {
          return {
            select() { return this },
            eq() { return this },
            maybeSingle: async () => ({
              data: { role: 'admin', status: 'active' },
              error: null,
            }),
          }
        }
        if (table === 'recipe_components') {
          return {
            select() { return this },
            eq() { return this },
            then(resolve: (value: { data: unknown; error: null }) => void) {
              resolve({ data: [], error: null })
            },
          }
        }
        return {
          select() { return this },
          eq() { return this },
          then(resolve: (value: { data: unknown; error: null }) => void) {
            resolve({ data: [], error: null })
          },
        }
      },
      rpc: async () => ({
        data: {
          recipe_id: RECIPE,
          deleted: true,
          removed_mapping_count: 1,
          removed_price_count: 1,
          removed_component_count: 2,
        },
        error: null,
      }),
    } as unknown as SupabaseClient

    const user = client({
      organizations: { id: ORG },
      recipes: { id: RECIPE, organization_id: ORG, active: false, name: 'Apa' },
    })

    await expect(deleteOrganizationRecipe({
      userClient: user,
      adminClient: admin,
      userId: ACTOR,
      organizationId: ORG,
      recipeId: RECIPE,
    })).resolves.toEqual({
      recipeId: RECIPE,
      deleted: true,
      removedMappingCount: 1,
      removedPriceCount: 1,
      removedComponentCount: 2,
    })
  })

  it('exige autenticación', async () => {
    await expect(deleteOrganizationRecipe({
      userClient: client({}),
      adminClient: client({}),
      userId: '',
      organizationId: ORG,
      recipeId: RECIPE,
    })).rejects.toBeInstanceOf(RecipeSaveError)
  })
})

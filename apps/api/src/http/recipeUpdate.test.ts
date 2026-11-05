import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  RECIPE_UPDATE_RPC_ENABLED,
  isUpdateRecipeRpcMissing,
  updateOrganizationRecipe,
} from './recipeUpdate.js'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const OTHER_ORGANIZATION = '22222222-2222-4222-8222-222222222222'
const RECIPE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PRODUCT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PRODUCT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const FORGED = '99999999-9999-4999-8999-999999999999'
const CATEGORY = '12121212-1212-4121-8121-121212121212'
const NESTED = 'abababab-abab-4aba-8aba-abababababab'

function rpcResult(overrides: Record<string, unknown> = {}) {
  return {
    recipe_id: RECIPE,
    name: 'Salsa de la casa',
    yield_quantity: 1,
    yield_unit: 'unit',
    component_count: 1,
    category_id: CATEGORY,
    category_name: 'Tapeo',
    shared_location_count: 2,
    ...overrides,
  }
}

function clients(options: {
  organization?: Record<string, unknown> | null
  organizationError?: { message: string } | null
  recipe?: Record<string, unknown> | null
  recipeError?: { code?: string; message?: string } | null
  components?: Record<string, unknown>[]
  componentsError?: { message: string } | null
  rpcData?: Record<string, unknown> | null
  rpcError?: { code?: string; message?: string; details?: string } | null
} = {}) {
  const from = vi.fn((table: string) => {
    if (table === 'organizations') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: options.organization === undefined
                ? { id: ORGANIZATION }
                : options.organization,
              error: options.organizationError ?? null,
            }),
          }),
        }),
      }
    }
    if (table === 'recipes') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: options.recipe === undefined
                  ? {
                    id: RECIPE,
                    organization_id: ORGANIZATION,
                    name: 'Salsa de la casa',
                    recipe_type: 'sale_product',
                    active: true,
                    yield_quantity: 1,
                    yield_unit: 'unit',
                    category_id: CATEGORY,
                  }
                  : options.recipe,
                error: options.recipeError ?? null,
              }),
            }),
          }),
        }),
      }
    }
    if (table === 'recipe_components') {
      const rows = options.components ?? [{
        id: 'comp-1',
        recipe_id: RECIPE,
        inventory_product_id: PRODUCT,
        component_recipe_id: null,
        quantity: 80,
      }]
      return {
        select: () => ({
          eq: () => Promise.resolve({
            data: options.componentsError ? null : rows,
            error: options.componentsError ?? null,
          }),
        }),
      }
    }
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: { message: 'unexpected' } }),
        }),
      }),
    }
  })
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: options.rpcError ? null : (options.rpcData ?? rpcResult()),
    error: options.rpcError ?? null,
  }))
  return {
    from,
    rpc,
    user: { from } as unknown as SupabaseClient,
    admin: { rpc } as unknown as SupabaseClient,
  }
}

const VALID_BODY = {
  name: 'Salsa de la casa',
  yieldQuantity: 1,
  yieldUnit: 'unit',
  components: [{ inventoryProductId: PRODUCT, quantity: 80 }],
  categoryId: CATEGORY,
  expected: {
    name: 'Salsa de la casa',
    yieldQuantity: 1,
    yieldUnit: 'unit',
    categoryId: CATEGORY,
    components: [{ inventoryProductId: PRODUCT, quantity: 80 }],
  },
  actorUserId: FORGED,
  organizationId: OTHER_ORGANIZATION,
  recipeId: FORGED,
  source: 'fudo',
  externalProductId: 'fudo-salsa',
}

async function update(
  db: ReturnType<typeof clients>,
  overrides: Partial<{
    userId: string
    organizationId: string
    recipeId: string
    body: unknown
    rpcEnabled: boolean
  }> = {},
) {
  return updateOrganizationRecipe({
    userClient: db.user,
    adminClient: db.admin,
    userId: 'userId' in overrides ? overrides.userId ?? '' : USER,
    organizationId: overrides.organizationId ?? ORGANIZATION,
    recipeId: overrides.recipeId ?? RECIPE,
    body: 'body' in overrides ? overrides.body : VALID_BODY,
    rpcEnabled: overrides.rpcEnabled,
  })
}

describe('updateOrganizationRecipe', () => {
  it('llama senda_update_recipe por defecto y no escribe mappings ni stock', async () => {
    expect(RECIPE_UPDATE_RPC_ENABLED).toBe(true)
    const db = clients({})
    await update(db)
    expect(db.rpc).toHaveBeenCalledWith('senda_update_recipe', expect.objectContaining({
      p: expect.objectContaining({
        actor_user_id: USER,
        organization_id: ORGANIZATION,
        recipe_id: RECIPE,
      }),
    }))
    expect(db.from).not.toHaveBeenCalledWith('sales_product_mappings')
    expect(db.from).not.toHaveBeenCalledWith('inventory_movements')
  })

  it('si se desactiva el flag no llama el RPC', async () => {
    const db = clients({})
    await expect(update(db, { rpcEnabled: false })).rejects.toMatchObject({
      code: 'RECIPE_UPDATE_RPC_PENDING',
      status: 503,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('usa el actor de getUser y conserva mappings Fudo', async () => {
    const db = clients({})
    const result = await update(db)
    expect(result).toEqual({
      recipeId: RECIPE,
      name: 'Salsa de la casa',
      yieldQuantity: 1,
      yieldUnit: 'unit',
      componentCount: 1,
      category: { id: CATEGORY, name: 'Tapeo' },
      sharedLocationCount: 2,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_update_recipe', {
      p: {
        actor_user_id: USER,
        organization_id: ORGANIZATION,
        recipe_id: RECIPE,
        name: 'Salsa de la casa',
        yield_quantity: 1,
        yield_unit: 'unit',
        components: [{ inventory_product_id: PRODUCT, quantity: 80 }],
        category_id: CATEGORY,
        expected: {
          name: 'Salsa de la casa',
          yield_quantity: 1,
          yield_unit: 'unit',
          category_id: CATEGORY,
          components: [{ inventory_product_id: PRODUCT, quantity: 80 }],
        },
      },
    })
    const payload = db.rpc.mock.calls[0][1].p as Record<string, unknown>
    expect(payload.actor_user_id).not.toBe(FORGED)
    expect(payload.organization_id).not.toBe(OTHER_ORGANIZATION)
    expect(payload.recipe_id).not.toBe(FORGED)
    expect(payload).not.toHaveProperty('source')
    expect(payload).not.toHaveProperty('external_product_id')
    expect(payload).not.toHaveProperty('mapping_id')
    expect(db.rpc).not.toHaveBeenCalledWith('senda_create_recipe', expect.anything())
    expect(db.rpc).not.toHaveBeenCalledWith('senda_save_fudo_recipe', expect.anything())
  })

  it('categoría nueva se envía solo en el guardado confirmado', async () => {
    const db = clients({})
    await update(db, {
      rpcEnabled: true,
      body: {
        ...VALID_BODY,
        categoryId: undefined,
        categoryName: 'Brunch',
      },
    })
    expect(db.rpc.mock.calls[0][1].p).toMatchObject({ category_name: 'Brunch' })
    expect(db.rpc.mock.calls[0][1].p).not.toHaveProperty('category_id')
  })

  it('no expone una receta de otra organización y no llama el RPC', async () => {
    const db = clients({ recipe: null })
    await expect(update(db)).rejects.toMatchObject({
      code: 'RECIPE_NOT_IN_ORG',
      status: 404,
      message: 'Receta no disponible.',
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('no expone una organización ajena y no llama el RPC', async () => {
    const db = clients({ organization: null })
    await expect(update(db, { organizationId: OTHER_ORGANIZATION })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('rechaza una receta inactiva sin escribir', async () => {
    const db = clients({
      recipe: {
        id: RECIPE,
        organization_id: ORGANIZATION,
        name: 'Salsa de la casa',
        active: false,
        yield_quantity: 1,
        yield_unit: 'unit',
        category_id: CATEGORY,
      },
    })
    await expect(update(db)).rejects.toMatchObject({
      code: 'RECIPE_INACTIVE',
      status: 409,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('rechaza subrecetas en el BOM actual', async () => {
    const db = clients({
      components: [{
        id: 'comp-nested',
        recipe_id: RECIPE,
        inventory_product_id: null,
        component_recipe_id: NESTED,
        quantity: 1,
      }],
    })
    await expect(update(db)).rejects.toMatchObject({
      code: 'INVALID_BOM',
      status: 422,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('detecta un cambio concurrente contra la huella esperada', async () => {
    const db = clients({})
    await expect(update(db, {
      body: {
        ...VALID_BODY,
        name: 'Salsa nueva',
        expected: {
          ...VALID_BODY.expected,
          name: 'Otro nombre',
        },
      },
    })).rejects.toMatchObject({
      code: 'CONCURRENT_UPDATE',
      status: 409,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('exige la huella expected antes de cualquier escritura', async () => {
    const db = clients({})
    await expect(update(db, {
      body: {
        name: 'Salsa de la casa',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [],
      },
    })).rejects.toMatchObject({
      code: 'EXPECTED_REQUIRED',
      status: 400,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('rechaza cantidad inválida antes del RPC', async () => {
    const db = clients({})
    await expect(update(db, {
      body: {
        ...VALID_BODY,
        components: [{ inventoryProductId: PRODUCT, quantity: 0 }],
      },
    })).rejects.toMatchObject({ code: 'INVALID_QUANTITY', status: 422 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('propaga conflicto concurrente del RPC', async () => {
    const db = clients({ rpcError: { code: 'P0001', message: 'CONCURRENT_UPDATE' } })
    await expect(update(db, { rpcEnabled: true })).rejects.toMatchObject({
      code: 'CONCURRENT_UPDATE',
      status: 409,
    })
  })

  it('propaga receta inactiva del RPC', async () => {
    const db = clients({ rpcError: { message: 'RECIPE_INACTIVE' } })
    await expect(update(db, { rpcEnabled: true })).rejects.toMatchObject({
      code: 'RECIPE_INACTIVE',
      status: 409,
    })
  })

  it('si el RPC no existe responde 503', async () => {
    const db = clients({
      rpcError: {
        code: 'PGRST202',
        message: 'Could not find the function public.senda_update_recipe(p) in the schema cache',
      },
    })
    await expect(update(db, { rpcEnabled: true })).rejects.toMatchObject({
      code: 'RECIPE_UPDATE_RPC_MISSING',
      status: 503,
    })
  })

  it('no expone detalles internos si la RPC falla de forma inesperada', async () => {
    const logs: Array<{ message: string | null; details: string | null }> = []
    const db = clients({
      rpcError: { code: 'XX000', message: 'relation boom', details: 'service_role leaked' },
    })
    await expect(updateOrganizationRecipe({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      organizationId: ORGANIZATION,
      recipeId: RECIPE,
      body: VALID_BODY,
      rpcEnabled: true,
      logRpcError: (entry) => logs.push(entry),
    })).rejects.toMatchObject({
      code: 'UPDATE_FAILED',
      status: 500,
      message: 'No se pudo guardar la receta.',
    })
    expect(logs[0]?.details).toMatch(/service_role leaked/)
  })

  it('permite quitar ingredientes y no escribe stock', async () => {
    const db = clients({})
    await update(db, {
      rpcEnabled: true,
      body: {
        ...VALID_BODY,
        components: [],
      },
    })
    expect((db.rpc.mock.calls[0][1] as { p: { components: unknown } }).p.components).toEqual([])
    expect(db.from).not.toHaveBeenCalledWith('inventory_movements')
    expect(db.from).not.toHaveBeenCalledWith('location_inventory')
  })

  it('rechaza un ingrediente duplicado antes del RPC', async () => {
    const db = clients({})
    await expect(update(db, {
      body: {
        ...VALID_BODY,
        components: [
          { inventoryProductId: PRODUCT, quantity: 10 },
          { inventory_product_id: PRODUCT, quantity: 4 },
        ],
      },
    })).rejects.toMatchObject({ code: 'DUPLICATE_INGREDIENT', status: 422 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('admite cambiar rendimiento e insumo extra', async () => {
    const db = clients({
      rpcData: rpcResult({
        name: 'Salsa nueva',
        yield_quantity: 2,
        component_count: 2,
      }),
    })
    await update(db, {
      rpcEnabled: true,
      body: {
        ...VALID_BODY,
        name: 'Salsa nueva',
        yieldQuantity: 2,
        components: [
          { inventoryProductId: PRODUCT, quantity: 80 },
          { inventoryProductId: PRODUCT_B, quantity: 10 },
        ],
      },
    })
    expect(db.rpc.mock.calls[0][1].p).toMatchObject({
      name: 'Salsa nueva',
      yield_quantity: 2,
      components: [
        { inventory_product_id: PRODUCT, quantity: 80 },
        { inventory_product_id: PRODUCT_B, quantity: 10 },
      ],
    })
  })
})

describe('isUpdateRecipeRpcMissing', () => {
  it('detecta ausencia del RPC en el schema cache', () => {
    expect(isUpdateRecipeRpcMissing({
      code: 'PGRST202',
      message: 'Could not find the function public.senda_update_recipe(p) in the schema cache',
    })).toBe(true)
    expect(isUpdateRecipeRpcMissing({ code: 'P0001', message: 'CONCURRENT_UPDATE' })).toBe(false)
  })
})

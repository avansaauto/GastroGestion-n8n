import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createOrganizationRecipe, isCreateRecipeRpcMissing } from './recipeCreate.js'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const OTHER_ORGANIZATION = '22222222-2222-4222-8222-222222222222'
const RECIPE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PRODUCT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PRODUCT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const FORGED = '99999999-9999-4999-8999-999999999999'

const CATEGORY = '12121212-1212-4121-8121-121212121212'

function rpcResult(overrides: Record<string, unknown> = {}) {
  return {
    recipe_id: RECIPE,
    name: 'Salsa de la casa',
    yield_quantity: 1,
    yield_unit: 'unit',
    component_count: 1,
    category_id: null,
    category_name: null,
    ...overrides,
  }
}

function clients(options: {
  organization?: Record<string, unknown> | null
  organizationError?: { message: string } | null
  rpcData?: Record<string, unknown> | null
  rpcError?: { code?: string; message?: string; details?: string } | null
}) {
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
  actorUserId: FORGED,
  organizationId: OTHER_ORGANIZATION,
  source: 'fudo',
  externalProductId: 'fudo-salsa',
  locationId: '33333333-3333-4333-8333-333333333333',
}

async function create(
  db: ReturnType<typeof clients>,
  overrides: Partial<{
    userId: string
    organizationId: string
    body: unknown
  }> = {},
) {
  return createOrganizationRecipe({
    userClient: db.user,
    adminClient: db.admin,
    userId: 'userId' in overrides ? overrides.userId ?? '' : USER,
    organizationId: overrides.organizationId ?? ORGANIZATION,
    body: 'body' in overrides ? overrides.body : VALID_BODY,
  })
}

describe('createOrganizationRecipe', () => {
  it('alta válida llama el RPC con el actor de getUser y sin Fudo', async () => {
    const db = clients({})
    const result = await create(db)
    expect(result).toEqual({
      recipeId: RECIPE,
      name: 'Salsa de la casa',
      yieldQuantity: 1,
      yieldUnit: 'unit',
      componentCount: 1,
      category: null,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_create_recipe', {
      p: {
        actor_user_id: USER,
        organization_id: ORGANIZATION,
        name: 'Salsa de la casa',
        yield_quantity: 1,
        yield_unit: 'unit',
        components: [{ inventory_product_id: PRODUCT, quantity: 80 }],
      },
    })
    const payload = db.rpc.mock.calls[0][1].p as Record<string, unknown>
    expect(payload.actor_user_id).toBe(USER)
    expect(payload.actor_user_id).not.toBe(FORGED)
    expect(payload.organization_id).toBe(ORGANIZATION)
    expect(payload.organization_id).not.toBe(OTHER_ORGANIZATION)
    expect(payload).not.toHaveProperty('source')
    expect(payload).not.toHaveProperty('external_product_id')
    expect(payload).not.toHaveProperty('location_id')
    expect(payload).not.toHaveProperty('intent')
    expect(payload).not.toHaveProperty('existing_recipe_id')
    expect(payload).not.toHaveProperty('category_id')
    expect(payload).not.toHaveProperty('category_name')
    expect(result).not.toHaveProperty('mappingId')
    expect(result).not.toHaveProperty('pendingId')
  })

  it('alta con categoría nueva envía el nombre y no un POST aparte', async () => {
    const db = clients({
      rpcData: rpcResult({ category_id: CATEGORY, category_name: 'Tapeo' }),
    })
    const result = await create(db, {
      body: {
        name: 'Salsa de la casa',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [{ inventoryProductId: PRODUCT, quantity: 80 }],
        categoryName: 'Tapeo',
      },
    })
    expect(result.category).toEqual({ id: CATEGORY, name: 'Tapeo' })
    expect(db.rpc.mock.calls[0][1].p).toMatchObject({
      category_name: 'Tapeo',
    })
    expect(db.rpc.mock.calls[0][1].p).not.toHaveProperty('category_id')
  })

  it('alta con categoría existente reutiliza el id', async () => {
    const db = clients({
      rpcData: rpcResult({ category_id: CATEGORY, category_name: 'Tapeo' }),
    })
    await create(db, {
      body: {
        name: 'Salsa de la casa',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [{ inventoryProductId: PRODUCT, quantity: 80 }],
        categoryId: CATEGORY,
      },
    })
    expect(db.rpc.mock.calls[0][1].p).toMatchObject({ category_id: CATEGORY })
    expect(db.rpc.mock.calls[0][1].p).not.toHaveProperty('category_name')
  })

  it('reutiliza una categoría existente si el nombre nuevo solo cambia mayúsculas', async () => {
    const db = clients({
      rpcData: rpcResult({ category_id: CATEGORY, category_name: 'Tapeo' }),
    })
    const result = await create(db, {
      body: {
        name: 'Salsa de la casa',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        categoryName: '  TAPEO  ',
      },
    })
    expect(result.category).toEqual({ id: CATEGORY, name: 'Tapeo' })
    expect(db.rpc.mock.calls[0][1].p).toMatchObject({ category_name: 'TAPEO' })
  })

  it('categoría ajena no revela la organización', async () => {
    const db = clients({ rpcError: { message: 'CATEGORY_NOT_IN_ORG' } })
    await expect(create(db, {
      body: {
        name: 'Salsa de la casa',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        categoryId: CATEGORY,
      },
    })).rejects.toMatchObject({
      code: 'CATEGORY_NOT_IN_ORG',
      status: 422,
      message: 'La categoría no está disponible.',
    })
  })

  it('admite receta sin ingredientes', async () => {
    const db = clients({
      rpcData: rpcResult({ name: 'Agua', component_count: 0 }),
    })
    const result = await create(db, {
      body: {
        name: 'Agua',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [],
      },
    })
    const payload = db.rpc.mock.calls[0][1] as { p: { components: unknown } }
    expect(payload.p.components).toEqual([])
    expect(result.componentCount).toBe(0)
  })

  it('nombre duplicado es 409', async () => {
    const db = clients({ rpcError: { code: 'P0001', message: 'DUPLICATE_RECIPE_NAME' } })
    await expect(create(db)).rejects.toMatchObject({
      code: 'DUPLICATE_RECIPE_NAME',
      status: 409,
      message: 'Ya existe una receta con ese nombre.',
    })
  })

  it('ingrediente de otra org no revela la org ajena', async () => {
    const db = clients({ rpcError: { message: 'INGREDIENT_NOT_IN_ORG' } })
    await expect(create(db)).rejects.toMatchObject({
      code: 'INGREDIENT_NOT_IN_ORG',
      status: 422,
      message: 'El insumo no está disponible.',
    })
  })

  it('rechaza cantidad inválida antes del RPC', async () => {
    const db = clients({})
    await expect(create(db, {
      body: {
        name: 'Guiso',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [{ inventoryProductId: PRODUCT, quantity: 0 }],
      },
    })).rejects.toMatchObject({ code: 'INVALID_QUANTITY', status: 422 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('usuario sin rol de operador recibe 403 de la RPC', async () => {
    const db = clients({ rpcError: { code: 'P0001', message: 'NOT_A_MEMBER' } })
    await expect(create(db)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('no expone una organización ajena y no llama el RPC', async () => {
    const db = clients({ organization: null })
    await expect(create(db, { organizationId: OTHER_ORGANIZATION })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      message: 'Organización no disponible.',
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('si el RPC no existe responde 503 y no aparenta un alta operativa', async () => {
    const db = clients({
      rpcError: {
        code: 'PGRST202',
        message: 'Could not find the function public.senda_create_recipe(p) in the schema cache',
      },
    })
    await expect(create(db)).rejects.toMatchObject({
      code: 'CREATE_RECIPE_RPC_MISSING',
      status: 503,
      message: 'El alta de recetas todavía no está habilitada.',
    })
  })

  it('no expone detalles internos si la RPC falla de forma inesperada', async () => {
    const logs: Array<{ message: string | null; details: string | null }> = []
    const db = clients({
      rpcError: { code: 'XX000', message: 'relation boom', details: 'service_role leaked' },
    })
    await expect(createOrganizationRecipe({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      organizationId: ORGANIZATION,
      body: {
        name: 'Guiso',
        yieldQuantity: 4,
        yieldUnit: 'unit',
        components: [{ inventoryProductId: PRODUCT_B, quantity: 1 }],
      },
      logRpcError: (entry) => logs.push(entry),
    })).rejects.toMatchObject({
      code: 'CREATE_FAILED',
      status: 500,
      message: 'No se pudo crear la receta.',
    })
    expect(logs[0]?.details).toMatch(/service_role leaked/)
  })

  it('rechaza ingrediente duplicado antes del RPC', async () => {
    const db = clients({})
    await expect(create(db, {
      body: {
        name: 'Guiso',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [
          { inventory_product_id: PRODUCT, quantity: 10 },
          { inventoryProductId: PRODUCT, quantity: 4 },
        ],
      },
    })).rejects.toMatchObject({ code: 'DUPLICATE_INGREDIENT', status: 422 })
    expect(db.rpc).not.toHaveBeenCalled()
  })
})

describe('isCreateRecipeRpcMissing', () => {
  it('detecta ausencia del RPC en el schema cache', () => {
    expect(isCreateRecipeRpcMissing({
      code: 'PGRST202',
      message: 'Could not find the function public.senda_create_recipe(p) in the schema cache',
    })).toBe(true)
    expect(isCreateRecipeRpcMissing({ code: 'P0001', message: 'DUPLICATE_RECIPE_NAME' })).toBe(false)
  })
})

import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { FUDO_SAVE_PERSISTS_CATEGORY, saveFudoRecipe } from './recipeSave.js'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOCATION = '22222222-2222-4222-8222-222222222222'
const OTHER_LOCATION = '33333333-3333-4333-8333-333333333333'
const RECIPE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MAPPING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PENDING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PRODUCT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PRODUCT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const FORGED = '99999999-9999-4999-8999-999999999999'

function rpcResult(overrides: Record<string, unknown> = {}) {
  return {
    recipe_id: RECIPE,
    mapping_id: MAPPING,
    pending_id: PENDING,
    replay: false,
    ...overrides,
  }
}

function clients(options: {
  location?: Record<string, unknown> | null
  locationError?: { message: string } | null
  rpcData?: Record<string, unknown> | null
  rpcError?: { code?: string; message?: string; details?: string } | null
}) {
  const from = vi.fn((table: string) => {
    if (table === 'locations') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: options.location === undefined
                ? { id: LOCATION, organization_id: '11111111-1111-4111-8111-111111111111' }
                : options.location,
              error: options.locationError ?? null,
            }),
          }),
        }),
      }
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'unexpected' } }) }) }),
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

async function save(
  db: ReturnType<typeof clients>,
  overrides: Partial<{
    userId: string
    locationId: string
    body: unknown
  }> = {},
) {
  return saveFudoRecipe({
    userClient: db.user,
    adminClient: db.admin,
    userId: 'userId' in overrides ? overrides.userId ?? '' : USER,
    locationId: overrides.locationId ?? LOCATION,
    body: 'body' in overrides ? overrides.body : {
      intent: 'create',
      source: 'fudo',
      externalProductId: 'fudo-ipa',
      name: 'IPA de barril',
      yieldQuantity: 1,
      yieldUnit: 'unit',
      components: [{ inventoryProductId: PRODUCT, quantity: 12 }],
      actorUserId: FORGED,
      locationId: OTHER_LOCATION,
    },
  })
}

describe('saveFudoRecipe', () => {
  it('CREATE válido llama el RPC con el contrato instalado y el actor de getUser', async () => {
    const db = clients({})
    const result = await save(db)
    expect(result).toEqual({
      recipeId: RECIPE,
      mappingId: MAPPING,
      pendingId: PENDING,
      replay: false,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_save_fudo_recipe', {
      p: {
        actor_user_id: USER,
        location_id: LOCATION,
        intent: 'create',
        source: 'fudo',
        external_product_id: 'fudo-ipa',
        name: 'IPA de barril',
        yield_quantity: 1,
        yield_unit: 'unit',
        components: [{ inventory_product_id: PRODUCT, quantity: 12 }],
      },
    })
    const payload = db.rpc.mock.calls[0][1].p as Record<string, unknown>
    expect(payload.actor_user_id).toBe(USER)
    expect(payload.actor_user_id).not.toBe(FORGED)
    expect(payload.location_id).toBe(LOCATION)
    expect(payload.location_id).not.toBe(OTHER_LOCATION)
  })

  it('CREATE admite receta sin consumo', async () => {
    const db = clients({})
    await save(db, {
      body: {
        intent: 'create',
        source: 'fudo',
        external_product_id: 'fudo-agua',
        name: 'Agua',
        components: [],
      },
    })
    const payload = db.rpc.mock.calls[0][1] as { p: { components: unknown } }
    expect(payload.p.components).toEqual([])
  })

  it('LINK válido no envía componentes ni cambia el BOM', async () => {
    const db = clients({ rpcData: rpcResult({ replay: true }) })
    const result = await save(db, {
      body: {
        intent: 'link',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        existingRecipeId: RECIPE,
      },
    })
    expect(result.replay).toBe(true)
    expect(db.rpc).toHaveBeenCalledWith('senda_save_fudo_recipe', {
      p: {
        actor_user_id: USER,
        location_id: LOCATION,
        intent: 'link',
        source: 'fudo',
        external_product_id: 'fudo-ipa',
        existing_recipe_id: RECIPE,
      },
    })
    expect(db.rpc.mock.calls[0][1].p).not.toHaveProperty('components')
  })

  it('usuario sin rol de operador recibe 403 de la RPC', async () => {
    const db = clients({ rpcError: { code: 'P0001', message: 'NOT_A_MEMBER' } })
    await expect(save(db)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('no expone un local de otra organización y no llama el RPC', async () => {
    const db = clients({ location: null })
    await expect(save(db, { locationId: OTHER_LOCATION })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      message: 'Local no disponible.',
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('rechaza cantidad inválida antes del RPC', async () => {
    const db = clients({})
    await expect(save(db, {
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        name: 'IPA',
        components: [{ inventoryProductId: PRODUCT, quantity: 0 }],
      },
    })).rejects.toMatchObject({ code: 'INVALID_QUANTITY', status: 422 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('rechaza ingrediente duplicado antes del RPC', async () => {
    const db = clients({})
    await expect(save(db, {
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        name: 'IPA',
        components: [
          { inventory_product_id: PRODUCT, quantity: 10 },
          { inventoryProductId: PRODUCT, quantity: 4 },
        ],
      },
    })).rejects.toMatchObject({ code: 'DUPLICATE_INGREDIENT', status: 422 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('MAPPING_INACTIVE es 409 y no revela SQL interno', async () => {
    const db = clients({
      rpcError: { code: 'P0001', message: 'MAPPING_INACTIVE', details: 'service_role leaked' },
    })
    await expect(save(db)).rejects.toMatchObject({
      code: 'MAPPING_INACTIVE',
      status: 409,
      message: 'Ese producto Fudo tiene un vínculo inactivo.',
    })
  })

  it('ALREADY_LINKED es conflicto de vínculo', async () => {
    const db = clients({ rpcError: { message: 'ALREADY_LINKED' } })
    await expect(save(db)).rejects.toMatchObject({ code: 'ALREADY_LINKED', status: 409 })
  })

  it('conflicto concurrente de LINK es 409', async () => {
    const db = clients({ rpcError: { message: 'CONCURRENT_UPDATE' } })
    await expect(save(db, {
      body: {
        intent: 'link',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        existingRecipeId: RECIPE,
      },
    })).rejects.toMatchObject({
      code: 'CONCURRENT_UPDATE',
      status: 409,
    })
  })

  it('LINK a receta inactiva es 409 RECIPE_INACTIVE', async () => {
    const db = clients({ rpcError: { message: 'RECIPE_INACTIVE' } })
    await expect(save(db, {
      body: {
        intent: 'link',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        existingRecipeId: RECIPE,
      },
    })).rejects.toMatchObject({
      code: 'RECIPE_INACTIVE',
      status: 409,
      message: 'Esta receta no está activa.',
    })
  })

  it('LINK a receta activa llama el RPC sin componentes ni categoría', async () => {
    const db = clients({})
    const result = await save(db, {
      body: {
        intent: 'link',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        existingRecipeId: RECIPE,
      },
    })
    expect(result.replay).toBe(false)
    expect(db.rpc).toHaveBeenCalledWith('senda_save_fudo_recipe', {
      p: {
        actor_user_id: USER,
        location_id: LOCATION,
        intent: 'link',
        source: 'fudo',
        external_product_id: 'fudo-ipa',
        existing_recipe_id: RECIPE,
      },
    })
    expect(db.from).not.toHaveBeenCalledWith('inventory_movements')
    expect(db.from).not.toHaveBeenCalledWith('pending_product_mappings')
  })

  it('no expone detalles internos si la RPC falla de forma inesperada', async () => {
    const logs: Array<{ message: string | null; details: string | null }> = []
    const db = clients({
      rpcError: { code: 'XX000', message: 'relation boom', details: 'service_role leaked' },
    })
    await expect(saveFudoRecipe({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      locationId: LOCATION,
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        name: 'IPA',
        components: [{ inventoryProductId: PRODUCT_B, quantity: 1 }],
      },
      logRpcError: (entry) => logs.push(entry),
    })).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      status: 500,
      message: 'No se pudo guardar la receta.',
    })
    expect(logs[0]?.details).toMatch(/service_role leaked/)
  })

  it('CREATE envía categoría existente o nueva al RPC actualizado', async () => {
    expect(FUDO_SAVE_PERSISTS_CATEGORY).toBe(true)
    const existing = clients({})
    await save(existing, {
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        name: 'IPA',
        categoryId: RECIPE,
        components: [{ inventoryProductId: PRODUCT, quantity: 12 }],
      },
    })
    expect(existing.rpc).toHaveBeenCalledTimes(1)
    expect(existing.rpc.mock.calls[0][1].p).toMatchObject({
      intent: 'create',
      source: 'fudo',
      external_product_id: 'fudo-ipa',
      category_id: RECIPE,
    })
    expect(existing.rpc.mock.calls[0][1].p).not.toHaveProperty('category_name')

    const created = clients({})
    await save(created, {
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        name: 'IPA',
        categoryName: 'Brunch',
        components: [{ inventoryProductId: PRODUCT, quantity: 12 }],
      },
    })
    expect(created.rpc.mock.calls[0][1].p).toMatchObject({
      intent: 'create',
      category_name: 'Brunch',
    })
    expect(created.rpc.mock.calls[0][1].p).not.toHaveProperty('category_id')
  })

  it('LINK no envía categoría y un replay no crea otro mapping', async () => {
    const linked = clients({ rpcData: rpcResult({ replay: true }) })
    const result = await save(linked, {
      body: {
        intent: 'link',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        existingRecipeId: RECIPE,
        categoryName: 'Tapeo',
        categoryId: RECIPE,
      },
    })
    expect(result.replay).toBe(true)
    expect(linked.rpc).toHaveBeenCalledTimes(1)
    expect(linked.rpc.mock.calls[0][1].p).toEqual({
      actor_user_id: USER,
      location_id: LOCATION,
      intent: 'link',
      source: 'fudo',
      external_product_id: 'fudo-ipa',
      existing_recipe_id: RECIPE,
    })
    expect(linked.rpc.mock.calls[0][1].p).not.toHaveProperty('category_id')
    expect(linked.rpc.mock.calls[0][1].p).not.toHaveProperty('category_name')
    expect(linked.rpc.mock.calls[0][1].p).not.toHaveProperty('components')
  })

  it('CREATE idéntico con replay no duplica la receta', async () => {
    const db = clients({ rpcData: rpcResult({ replay: true }) })
    const result = await save(db, {
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        name: 'IPA de barril',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        categoryId: RECIPE,
        components: [{ inventoryProductId: PRODUCT, quantity: 12 }],
      },
    })
    expect(result.replay).toBe(true)
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(db.rpc.mock.calls[0][1].p).toMatchObject({
      intent: 'create',
      external_product_id: 'fudo-ipa',
      category_id: RECIPE,
    })
  })

  it('categoría de otra org no revela la org ajena', async () => {
    const db = clients({ rpcError: { message: 'CATEGORY_NOT_IN_ORG' } })
    await expect(save(db, {
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        name: 'IPA',
        categoryId: RECIPE,
        components: [{ inventoryProductId: PRODUCT, quantity: 12 }],
      },
    })).rejects.toMatchObject({
      code: 'CATEGORY_NOT_IN_ORG',
      status: 422,
      message: 'La categoría no está disponible.',
    })
  })

  it('conflicto de categoría es 422', async () => {
    const db = clients({ rpcError: { message: 'CATEGORY_CONFLICT' } })
    await expect(save(db, {
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        name: 'IPA',
        categoryId: RECIPE,
        categoryName: 'Brunch',
        components: [{ inventoryProductId: PRODUCT, quantity: 12 }],
      },
    })).rejects.toMatchObject({
      code: 'CATEGORY_CONFLICT',
      status: 422,
      message: 'La categoría no coincide con el nombre indicado.',
    })
  })

  it('ingrediente de otra org no revela la org ajena', async () => {
    const db = clients({ rpcError: { message: 'INGREDIENT_NOT_IN_ORG' } })
    await expect(save(db)).rejects.toMatchObject({
      code: 'INGREDIENT_NOT_IN_ORG',
      status: 422,
      message: 'El insumo no está disponible.',
    })
  })
})

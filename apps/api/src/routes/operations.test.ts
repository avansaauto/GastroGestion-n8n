import express, { type RequestHandler } from 'express'
import request from 'supertest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { InventoryError } from '../http/inventoryError.js'
import type { RecipeQuery } from '../http/recipeQuery.js'
import { RecipeQueryError } from '../http/recipeQueryError.js'
import { RecipeSaveError } from '../http/recipeSaveError.js'
import { RecipeStatusError } from '../http/recipeStatus.js'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import type { OperationsRepository } from '../services/operationsRepository.js'
import { createOperationsRouter, type OperationsRouterOptions } from './operations.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const LOCATION_ID = '22222222-2222-4222-8222-222222222222'

const authenticated: RequestHandler = (request, _response, next) => {
  const req = request as AuthenticatedRequest
  req.user = { id: 'test-user' } as AuthenticatedRequest['user']
  req.supabase = {} as SupabaseClient
  next()
}

function createRepository(overrides: Partial<OperationsRepository> = {}): OperationsRepository {
  return {
    listOrganizations: vi.fn().mockResolvedValue([]),
    listLocations: vi.fn().mockResolvedValue([]),
    listPendingProducts: vi.fn().mockResolvedValue([]),
    listFudoCatalogProducts: vi.fn().mockResolvedValue([]),
    listInventoryProducts: vi.fn().mockResolvedValue([]),
    createInventoryProduct: vi.fn().mockRejectedValue(new Error('not stubbed')),
    ...overrides,
  }
}

function createRecipes(overrides: Partial<RecipeQuery> = {}): RecipeQuery {
  return {
    listLocationRecipes: vi.fn().mockResolvedValue([]),
    getRecipeDetail: vi.fn().mockRejectedValue(new Error('not stubbed')),
    listOrganizationRecipes: vi.fn().mockResolvedValue([]),
    getRecipeUsage: vi.fn().mockResolvedValue(null),
    listOrganizationRecipeCategories: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function testApp(
  repository: OperationsRepository,
  recipes: RecipeQuery = createRecipes(),
  options: OperationsRouterOptions = {},
) {
  const app = express()
  app.use(express.json())
  app.use('/api', createOperationsRouter(authenticated, repository, recipes, {
    getAdmin: options.getAdmin ?? (() => ({}) as SupabaseClient),
    saveRecipe: options.saveRecipe,
    createRecipe: options.createRecipe,
    updateRecipe: options.updateRecipe,
    setRecipeActive: options.setRecipeActive,
    listLocationRecipePrices: options.listLocationRecipePrices,
    setLocationRecipePrice: options.setLocationRecipePrice,
    setInventoryPurchaseCost: options.setInventoryPurchaseCost,
    listSaleConsumptions: options.listSaleConsumptions,
  }))
  return app
}

describe('endpoints operativos con RLS', () => {
  it('un usuario sin membresías recibe una lista vacía', async () => {
    const response = await request(testApp(createRepository())).get('/api/organizations')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: [] })
  })

  it('no expone una organización no autorizada', async () => {
    const repository = createRepository({ listLocations: vi.fn().mockResolvedValue(null) })
    const response = await request(testApp(repository))
      .get(`/api/organizations/${ORGANIZATION_ID}/locations`)

    expect(response.status).toBe(404)
  })

  it('no expone un local no autorizado', async () => {
    const repository = createRepository({ listPendingProducts: vi.fn().mockResolvedValue(null) })
    const response = await request(testApp(repository))
      .get(`/api/locations/${LOCATION_ID}/pending-products?status=pending`)

    expect(response.status).toBe(404)
  })

  it('devuelve pendientes autorizados y pasa el filtro de estado', async () => {
    const pending = [{ id: 'pending-1', status: 'pending' }]
    const listPendingProducts = vi.fn().mockResolvedValue(pending)
    const repository = createRepository({ listPendingProducts })
    const response = await request(testApp(repository))
      .get(`/api/locations/${LOCATION_ID}/pending-products?status=pending`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: pending })
    expect(listPendingProducts).toHaveBeenCalledWith(expect.anything(), LOCATION_ID, 'pending')
  })

  it('devuelve resueltos con mapping persistido sin inventar recetas', async () => {
    const resolved = [{
      id: 'pending-2',
      status: 'resolved',
      source: 'fudo',
      external_product_id: '0125',
      mapping_id: 'map-1',
      mapping_active: false,
      recipe_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      recipe_name: 'Pinta IPA',
    }]
    const listPendingProducts = vi.fn().mockResolvedValue(resolved)
    const response = await request(testApp(createRepository({ listPendingProducts })))
      .get(`/api/locations/${LOCATION_ID}/pending-products?status=resolved`)

    expect(response.status).toBe(200)
    expect(response.body.data[0]).toMatchObject({
      status: 'resolved',
      external_product_id: '0125',
      mapping_active: false,
      recipe_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      recipe_name: 'Pinta IPA',
    })
    expect(listPendingProducts).toHaveBeenCalledWith(expect.anything(), LOCATION_ID, 'resolved')
  })

  it('rechaza filtros de estado no permitidos', async () => {
    const repository = createRepository()
    const response = await request(testApp(repository))
      .get(`/api/locations/${LOCATION_ID}/pending-products?status=otro`)

    expect(response.status).toBe(400)
    expect(repository.listPendingProducts).not.toHaveBeenCalled()
  })
})

const PRODUCT = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  organizationId: ORGANIZATION_ID,
  name: 'Golden Ale',
  baseUnit: 'l',
  active: true,
  onHand: 12,
}

describe('GET/POST insumos', () => {
  it('lista insumos reales de la organización autorizada', async () => {
    const listInventoryProducts = vi.fn().mockResolvedValue([PRODUCT])
    const response = await request(testApp(createRepository({ listInventoryProducts })))
      .get(`/api/organizations/${ORGANIZATION_ID}/inventory-products`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: [PRODUCT] })
    expect(listInventoryProducts).toHaveBeenCalledWith(expect.anything(), ORGANIZATION_ID, {
      search: undefined,
      locationId: undefined,
      activeOnly: true,
    })
  })

  it('devuelve catálogo vacío sin error de permisos', async () => {
    const response = await request(testApp(createRepository({
      listInventoryProducts: vi.fn().mockResolvedValue([]),
    }))).get(`/api/organizations/${ORGANIZATION_ID}/inventory-products`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: [] })
  })

  it('no lista insumos de una organización no autorizada', async () => {
    const response = await request(testApp(createRepository({
      listInventoryProducts: vi.fn().mockResolvedValue(null),
    }))).get(`/api/organizations/${ORGANIZATION_ID}/inventory-products`)
    expect(response.status).toBe(404)
  })

  it('no convierte un error de existencias en catálogo con saldo cero', async () => {
    const response = await request(testApp(createRepository({
      listInventoryProducts: vi.fn().mockRejectedValue(
        new InventoryError('No se pudieron consultar las existencias.', 'LOOKUP_FAILED', 500),
      ),
    }))).get(`/api/organizations/${ORGANIZATION_ID}/inventory-products?locationId=${LOCATION_ID}`)
    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      error: 'No se pudieron consultar las existencias.',
      code: 'LOOKUP_FAILED',
    })
    expect(response.body).not.toEqual({ data: expect.arrayContaining([expect.objectContaining({ onHand: 0 })]) })
  })

  it('crea un insumo con unidad base y no toca stock', async () => {
    const createInventoryProduct = vi.fn().mockResolvedValue(PRODUCT)
    const response = await request(testApp(createRepository({ createInventoryProduct })))
      .post(`/api/organizations/${ORGANIZATION_ID}/inventory-products`)
      .send({ name: 'Golden Ale', baseUnit: 'ml', organizationId: 'ajena' })

    expect(response.status).toBe(201)
    expect(response.body.data.name).toBe('Golden Ale')
    expect(createInventoryProduct).toHaveBeenCalledWith(expect.anything(), ORGANIZATION_ID, {
      name: 'Golden Ale',
      baseUnit: 'ml',
      category: undefined,
    })
    expect(JSON.stringify(response.body)).not.toMatch(/inventory_movements|Actualizar stock/)
  })

  it('rechaza un alta no autenticada', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createOperationsRouter())
    const response = await request(app)
      .post(`/api/organizations/${ORGANIZATION_ID}/inventory-products`)
      .send({ name: 'Tomate', baseUnit: 'g' })
    expect(response.status).toBe(401)
  })

  it('no crea en una organización no autorizada', async () => {
    const response = await request(testApp(createRepository({
      createInventoryProduct: vi.fn().mockRejectedValue(
        new InventoryError('Organización no disponible.', 'NOT_FOUND', 404),
      ),
    }))).post(`/api/organizations/${ORGANIZATION_ID}/inventory-products`).send({
      name: 'Tomate',
      baseUnit: 'g',
      organizationId: 'ajena',
    })
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('NOT_FOUND')
  })

  it('propaga duplicado y falta de permiso de alta', async () => {
    const duplicate = await request(testApp(createRepository({
      createInventoryProduct: vi.fn().mockRejectedValue(
        new InventoryError('Ya existe un insumo con ese nombre en la organización.', 'DUPLICATE_PRODUCT', 409),
      ),
    }))).post(`/api/organizations/${ORGANIZATION_ID}/inventory-products`).send({ name: 'Tomate', baseUnit: 'g' })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.code).toBe('DUPLICATE_PRODUCT')

    const forbidden = await request(testApp(createRepository({
      createInventoryProduct: vi.fn().mockRejectedValue(
        new InventoryError('El permiso actual no permite crear insumos.', 'CREATE_NOT_ALLOWED', 403),
      ),
    }))).post(`/api/organizations/${ORGANIZATION_ID}/inventory-products`).send({ name: 'Tomate', baseUnit: 'g' })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.code).toBe('CREATE_NOT_ALLOWED')
  })

  it('propaga validación, duplicado de Postgres y alta no confirmada', async () => {
    const invalid = await request(testApp(createRepository({
      createInventoryProduct: vi.fn().mockRejectedValue(
        new InventoryError('Los datos del insumo no cumplen las reglas del catálogo.', 'CREATE_INVALID', 422),
      ),
    }))).post(`/api/organizations/${ORGANIZATION_ID}/inventory-products`).send({ name: 'Harina', baseUnit: 'g' })
    expect(invalid.status).toBe(422)
    expect(invalid.body.code).toBe('CREATE_INVALID')

    const unconfirmed = await request(testApp(createRepository({
      createInventoryProduct: vi.fn().mockRejectedValue(
        new InventoryError('No se confirmó la creación del insumo. Recargá el catálogo.', 'CREATE_UNCONFIRMED', 500),
      ),
    }))).post(`/api/organizations/${ORGANIZATION_ID}/inventory-products`).send({ name: 'Harina', baseUnit: 'g' })
    expect(unconfirmed.status).toBe(500)
    expect(unconfirmed.body.code).toBe('CREATE_UNCONFIRMED')
  })
})

describe('POST costo de compra de inventario', () => {
  const PRODUCT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const path = `/api/organizations/${ORGANIZATION_ID}/locations/${LOCATION_ID}/inventory-products/${PRODUCT_ID}/purchase-cost`

  it('persiste el costo por unidad y conserva las existencias', async () => {
    const setInventoryPurchaseCost = vi.fn().mockResolvedValue({
      inventoryProductId: PRODUCT_ID,
      locationId: LOCATION_ID,
      purchaseQuantity: 100000,
      purchaseCost: 180000,
      averageUnitCost: 1.8,
      lastPurchaseUnitCost: 1.8,
      onHand: 100000,
      replay: false,
    })
    const response = await request(testApp(createRepository(), createRecipes(), {
      setInventoryPurchaseCost,
    })).post(path).send({ purchaseQuantity: 100000, purchaseCost: 180000 })

    expect(response.status).toBe(200)
    expect(response.body.data.averageUnitCost).toBe(1.8)
    expect(response.body.data.onHand).toBe(100000)
    expect(setInventoryPurchaseCost).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORGANIZATION_ID,
      locationId: LOCATION_ID,
      inventoryProductId: PRODUCT_ID,
      body: { purchaseQuantity: 100000, purchaseCost: 180000 },
    }))
    expect(JSON.stringify(response.body)).not.toMatch(/inventory_movements/)
  })

  it('responde 503 si el RPC todavía no está instalado', async () => {
    const response = await request(testApp(createRepository(), createRecipes(), {
      setInventoryPurchaseCost: vi.fn().mockRejectedValue(
        new InventoryError(
          'Todavía no se puede guardar el costo de compra del inventario.',
          'INVENTORY_COST_RPC_PENDING',
          503,
        ),
      ),
    })).post(path).send({ purchaseQuantity: 100000, purchaseCost: 180000 })
    expect(response.status).toBe(503)
    expect(response.body.code).toBe('INVENTORY_COST_RPC_PENDING')
  })
})

const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const RECIPE_LIST_ITEM = {
  id: RECIPE_ID,
  name: 'IPA de barril',
  recipeType: 'sale_product',
  active: true,
  yieldQuantity: 1,
  yieldUnit: 'unit',
  consumptionMode: 'direct',
  componentCount: 1,
  mapping: {
    id: '12121212-1212-4121-8121-121212121212',
    source: 'fudo',
    externalProductId: 'fudo-ipa',
    externalProductName: 'IPA',
    active: true,
  },
  pendingStatus: 'resolved',
  costPerYield: 660,
  costIncomplete: false,
  hasInvalidQuantities: false,
}

describe('GET precios de receta por local', () => {
  const PRICE_PATH = `/api/organizations/${ORGANIZATION_ID}/locations/${LOCATION_ID}/recipe-prices`

  it('propaga 503 si la tabla de precios no está disponible', async () => {
    const listLocationRecipePrices = vi.fn().mockRejectedValue(
      new RecipeQueryError(
        'Todavía no se pueden consultar los precios de venta.',
        'RECIPE_PRICE_TABLE_PENDING',
        503,
      ),
    )
    const response = await request(testApp(createRepository(), createRecipes(), {
      listLocationRecipePrices,
    })).get(PRICE_PATH)

    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      error: 'Todavía no se pueden consultar los precios de venta.',
      code: 'RECIPE_PRICE_TABLE_PENDING',
    })
    expect(listLocationRecipePrices).toHaveBeenCalledWith(expect.anything(), ORGANIZATION_ID, LOCATION_ID)
  })

  it('lista vacío si no hay precio', async () => {
    const listLocationRecipePrices = vi.fn().mockResolvedValue([])
    const response = await request(testApp(createRepository(), createRecipes(), {
      listLocationRecipePrices,
    })).get(PRICE_PATH)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: [] })
  })

  it('lista precios del local autorizado y no inventa filas', async () => {
    const listLocationRecipePrices = vi.fn().mockResolvedValue([
      { recipeId: RECIPE_ID, salePrice: 4500, version: 1 },
    ])
    const response = await request(testApp(createRepository(), createRecipes(), {
      listLocationRecipePrices,
    })).get(PRICE_PATH)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      data: [{ recipeId: RECIPE_ID, salePrice: 4500, version: 1 }],
    })
    expect(listLocationRecipePrices).toHaveBeenCalledWith(expect.anything(), ORGANIZATION_ID, LOCATION_ID)
  })

  it('no expone precios de otra organización o local', async () => {
    const listLocationRecipePrices = vi.fn().mockRejectedValue(
      new RecipeQueryError('Local no disponible.', 'NOT_FOUND', 404),
    )
    const otherOrg = await request(testApp(createRepository(), createRecipes(), {
      listLocationRecipePrices,
    })).get(`/api/organizations/99999999-9999-4999-8999-999999999999/locations/${LOCATION_ID}/recipe-prices`)
    expect(otherOrg.status).toBe(404)
    expect(otherOrg.body.code).toBe('NOT_FOUND')

    const otherLoc = await request(testApp(createRepository(), createRecipes(), {
      listLocationRecipePrices,
    })).get(`/api/organizations/${ORGANIZATION_ID}/locations/33333333-3333-4333-8333-333333333333/recipe-prices`)
    expect(otherLoc.status).toBe(404)
  })

  it('rechaza identificadores inválidos y exige autenticación', async () => {
    const listLocationRecipePrices = vi.fn()
    const badOrg = await request(testApp(createRepository(), createRecipes(), {
      listLocationRecipePrices,
    })).get(`/api/organizations/no-es-uuid/locations/${LOCATION_ID}/recipe-prices`)
    expect(badOrg.status).toBe(400)
    expect(listLocationRecipePrices).not.toHaveBeenCalled()

    const app = express()
    app.use(express.json())
    app.use('/api', createOperationsRouter())
    const anonymous = await request(app).get(PRICE_PATH)
    expect(anonymous.status).toBe(401)
  })
})

describe('PATCH precios de receta por local', () => {
  const PRICE_ITEM_PATH = `/api/organizations/${ORGANIZATION_ID}/locations/${LOCATION_ID}/recipe-prices/${RECIPE_ID}`

  it('guarda el primer precio y un update con expectedVersion', async () => {
    const created = {
      locationId: LOCATION_ID,
      recipeId: RECIPE_ID,
      salePrice: 4500,
      version: 1,
      updatedAt: '2026-10-17T00:00:00Z',
      replay: false,
    }
    const setLocationRecipePrice = vi.fn().mockResolvedValue(created)
    const first = await request(testApp(createRepository(), createRecipes(), {
      setLocationRecipePrice,
    })).patch(PRICE_ITEM_PATH).send({ salePrice: 4500, expectedVersion: null })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ data: created })
    expect(setLocationRecipePrice).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORGANIZATION_ID,
      locationId: LOCATION_ID,
      recipeId: RECIPE_ID,
      body: { salePrice: 4500, expectedVersion: null },
    }))

    setLocationRecipePrice.mockResolvedValue({ ...created, salePrice: 4800, version: 2, replay: true })
    const replay = await request(testApp(createRepository(), createRecipes(), {
      setLocationRecipePrice,
    })).patch(PRICE_ITEM_PATH).send({ salePrice: 4800, expectedVersion: 1 })
    expect(replay.status).toBe(200)
    expect(replay.body.data.replay).toBe(true)
    expect(replay.body.data.version).toBe(2)
  })

  it('propaga conflicto, receta inactiva y precio inválido', async () => {
    const conflict = await request(testApp(createRepository(), createRecipes(), {
      setLocationRecipePrice: vi.fn().mockRejectedValue(
        new RecipeSaveError('El precio cambió desde que lo abriste. Recargá e intentá de nuevo.', 'CONCURRENT_UPDATE', 409),
      ),
    })).patch(PRICE_ITEM_PATH).send({ salePrice: 5000, expectedVersion: 1 })
    expect(conflict.status).toBe(409)
    expect(conflict.body.code).toBe('CONCURRENT_UPDATE')

    const inactive = await request(testApp(createRepository(), createRecipes(), {
      setLocationRecipePrice: vi.fn().mockRejectedValue(
        new RecipeSaveError('Esta receta no está activa.', 'RECIPE_INACTIVE', 409),
      ),
    })).patch(PRICE_ITEM_PATH).send({ salePrice: 4500, expectedVersion: null })
    expect(inactive.status).toBe(409)
    expect(inactive.body.code).toBe('RECIPE_INACTIVE')

    const invalid = await request(testApp(createRepository(), createRecipes(), {
      setLocationRecipePrice: vi.fn().mockRejectedValue(
        new RecipeSaveError('Indicá un precio de venta válido.', 'INVALID_SALE_PRICE', 400),
      ),
    })).patch(PRICE_ITEM_PATH).send({ salePrice: 0, expectedVersion: null })
    expect(invalid.status).toBe(400)
    expect(invalid.body.code).toBe('INVALID_SALE_PRICE')
  })

  it('no expone org o local ajenos y no borra precios', async () => {
    const setLocationRecipePrice = vi.fn().mockRejectedValue(
      new RecipeSaveError('Local no disponible.', 'LOCATION_NOT_IN_ORG', 404),
    )
    const other = await request(testApp(createRepository(), createRecipes(), {
      setLocationRecipePrice,
    })).patch(`/api/organizations/${ORGANIZATION_ID}/locations/33333333-3333-4333-8333-333333333333/recipe-prices/${RECIPE_ID}`)
      .send({ salePrice: 4500, expectedVersion: null })
    expect(other.status).toBe(404)

    const foreignOrg = await request(testApp(createRepository(), createRecipes(), {
      setLocationRecipePrice: vi.fn().mockRejectedValue(
        new RecipeSaveError('Organización no disponible.', 'ORGANIZATION_NOT_FOUND', 404),
      ),
    })).patch(`/api/organizations/99999999-9999-4999-8999-999999999999/locations/${LOCATION_ID}/recipe-prices/${RECIPE_ID}`)
      .send({ salePrice: 4500, expectedVersion: null })
    expect(foreignOrg.status).toBe(404)
    expect(foreignOrg.body.code).toBe('ORGANIZATION_NOT_FOUND')

    const removed = await request(testApp(createRepository())).delete(PRICE_ITEM_PATH)
    expect(removed.status).toBe(404)
    expect(setLocationRecipePrice).toHaveBeenCalledTimes(1)
  })

  it('exige autenticación y service_role', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createOperationsRouter())
    const anonymous = await request(app).patch(PRICE_ITEM_PATH).send({ salePrice: 4500, expectedVersion: null })
    expect(anonymous.status).toBe(401)

    const missingAdmin = await request(testApp(
      createRepository(),
      createRecipes(),
      { getAdmin: () => null },
    )).patch(PRICE_ITEM_PATH).send({ salePrice: 4500, expectedVersion: null })
    expect(missingAdmin.status).toBe(503)
    expect(missingAdmin.body.code).toBe('SERVICE_ROLE_MISSING')
  })
})

describe('GET recetas', () => {
  it('lista recetas del local autorizado', async () => {
    const listLocationRecipes = vi.fn().mockResolvedValue([RECIPE_LIST_ITEM])
    const response = await request(testApp(createRepository(), createRecipes({ listLocationRecipes })))
      .get(`/api/locations/${LOCATION_ID}/recipes`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: [RECIPE_LIST_ITEM] })
    expect(listLocationRecipes).toHaveBeenCalledWith(expect.anything(), LOCATION_ID)
    expect(JSON.stringify(response.body)).not.toMatch(/salePrice/)
  })

  it('no expone recetas de un local no autorizado', async () => {
    const response = await request(testApp(createRepository(), createRecipes({
      listLocationRecipes: vi.fn().mockRejectedValue(
        new RecipeQueryError('Local no disponible.', 'NOT_FOUND', 404),
      ),
    }))).get(`/api/locations/${LOCATION_ID}/recipes`)
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Local no disponible.', code: 'NOT_FOUND' })
  })

  it('rechaza un local inválido', async () => {
    const recipes = createRecipes()
    const response = await request(testApp(createRepository(), recipes)).get('/api/locations/no-es-uuid/recipes')
    expect(response.status).toBe(400)
    expect(recipes.listLocationRecipes).not.toHaveBeenCalled()
  })

  it('exige locationId para el detalle y no inventa costos faltantes', async () => {
    const missing = await request(testApp(createRepository())).get(`/api/recipes/${RECIPE_ID}`)
    expect(missing.status).toBe(400)
    expect(missing.body.code).toBe('LOCATION_REQUIRED')

    const getRecipeDetail = vi.fn().mockResolvedValue({
      ...RECIPE_LIST_ITEM,
      organizationId: ORGANIZATION_ID,
      locationId: LOCATION_ID,
      sharedLocationCount: 1,
      category: null,
      costPerYield: null,
      costIncomplete: true,
      components: [{
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        inventoryProductId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        componentRecipeId: null,
        name: 'Malta',
        baseUnit: 'g',
        quantity: 100,
        unitCost: null,
        lineCost: null,
        costMissing: true,
      }],
    })
    const response = await request(testApp(createRepository(), createRecipes({ getRecipeDetail })))
      .get(`/api/recipes/${RECIPE_ID}?locationId=${LOCATION_ID}`)

    expect(response.status).toBe(200)
    expect(response.body.data.costPerYield).toBeNull()
    expect(response.body.data.costIncomplete).toBe(true)
    expect(response.body.data.components[0].costMissing).toBe(true)
    expect(getRecipeDetail).toHaveBeenCalledWith(expect.anything(), RECIPE_ID, LOCATION_ID)
  })

  it('no expone una receta de otra organización', async () => {
    const response = await request(testApp(createRepository(), createRecipes({
      getRecipeDetail: vi.fn().mockRejectedValue(
        new RecipeQueryError('Receta no disponible.', 'NOT_FOUND', 404),
      ),
    }))).get(`/api/recipes/${RECIPE_ID}?locationId=${LOCATION_ID}`)
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('NOT_FOUND')
  })

  it('rechaza detalle no autenticado', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createOperationsRouter())
    const response = await request(app).get(`/api/recipes/${RECIPE_ID}?locationId=${LOCATION_ID}`)
    expect(response.status).toBe(401)
  })

  it('lista recetas de la organización autorizada sin exigir mapping', async () => {
    const catalog = [{
      id: RECIPE_ID,
      name: 'Pinta IPA',
      recipeType: 'sale_product',
      active: true,
      yieldQuantity: 1,
      yieldUnit: 'unit',
      consumptionMode: 'direct',
      componentCount: 1,
      category: null,
    }]
    const listOrganizationRecipes = vi.fn().mockResolvedValue(catalog)
    const response = await request(testApp(createRepository(), createRecipes({ listOrganizationRecipes })))
      .get(`/api/organizations/${ORGANIZATION_ID}/recipes?q=pinta`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: catalog })
    expect(listOrganizationRecipes).toHaveBeenCalledWith(expect.anything(), ORGANIZATION_ID, {
      search: 'pinta',
      includeInactive: false,
    })
    expect(JSON.stringify(response.body)).not.toMatch(/salePrice/)
  })

  it('pide recetas inactivas solo con includeInactive=true', async () => {
    const listOrganizationRecipes = vi.fn().mockResolvedValue([])
    const response = await request(testApp(createRepository(), createRecipes({ listOrganizationRecipes })))
      .get(`/api/organizations/${ORGANIZATION_ID}/recipes?includeInactive=true`)
    expect(response.status).toBe(200)
    expect(listOrganizationRecipes).toHaveBeenCalledWith(expect.anything(), ORGANIZATION_ID, {
      search: undefined,
      includeInactive: true,
    })
  })

  it('consulta el uso de una receta autorizada', async () => {
    const usage = {
      recipeId: RECIPE_ID,
      active: true,
      usedBy: [{ recipeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Milanesa' }],
      activeMappingCount: 2,
    }
    const getRecipeUsage = vi.fn().mockResolvedValue(usage)
    const response = await request(testApp(createRepository(), createRecipes({ getRecipeUsage })))
      .get(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}/usage`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: usage })
    expect(getRecipeUsage).toHaveBeenCalledWith(expect.anything(), ORGANIZATION_ID, RECIPE_ID)
  })

  it('no expone el uso de una organización no autorizada', async () => {
    const response = await request(testApp(createRepository(), createRecipes({
      getRecipeUsage: vi.fn().mockResolvedValue(null),
    }))).get(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}/usage`)
    expect(response.status).toBe(404)
  })

  it('no expone recetas de una organización no autorizada', async () => {
    const response = await request(testApp(createRepository(), createRecipes({
      listOrganizationRecipes: vi.fn().mockResolvedValue(null),
    }))).get(`/api/organizations/${ORGANIZATION_ID}/recipes`)
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Organización no disponible.', code: 'NOT_FOUND' })
  })

  it('rechaza una organización inválida al listar recetas', async () => {
    const recipes = createRecipes()
    const response = await request(testApp(createRepository(), recipes)).get('/api/organizations/no-es-uuid/recipes')
    expect(response.status).toBe(400)
    expect(recipes.listOrganizationRecipes).not.toHaveBeenCalled()
  })

  it('lista categorías reales de la organización', async () => {
    const categories = [{ id: '15151515-1515-4151-8151-151515151515', name: 'Tapeo' }]
    const listOrganizationRecipeCategories = vi.fn().mockResolvedValue(categories)
    const response = await request(testApp(
      createRepository(),
      createRecipes({ listOrganizationRecipeCategories }),
    )).get(`/api/organizations/${ORGANIZATION_ID}/recipe-categories`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: categories })
    expect(JSON.stringify(response.body)).not.toMatch(/Entradas|Platos principales/)
  })

  it('organización sin categorías responde lista vacía', async () => {
    const response = await request(testApp(createRepository(), createRecipes({
      listOrganizationRecipeCategories: vi.fn().mockResolvedValue([]),
    }))).get(`/api/organizations/${ORGANIZATION_ID}/recipe-categories`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: [] })
  })

  it('no expone categorías de una organización no autorizada', async () => {
    const response = await request(testApp(createRepository(), createRecipes({
      listOrganizationRecipeCategories: vi.fn().mockResolvedValue(null),
    }))).get(`/api/organizations/${ORGANIZATION_ID}/recipe-categories`)
    expect(response.status).toBe(404)
  })
})

describe('POST recetas de organización', () => {
  const CREATE_BODY = {
    name: 'Salsa de la casa',
    yieldQuantity: 1,
    yieldUnit: 'unit',
    components: [{ inventoryProductId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', quantity: 80 }],
  }

  const CREATED = {
    recipeId: RECIPE_ID,
    name: 'Salsa de la casa',
    yieldQuantity: 1,
    yieldUnit: 'unit',
    componentCount: 1,
    category: null,
  }

  it('alta válida responde 201 sin mapping ni pendiente', async () => {
    const createRecipe = vi.fn().mockResolvedValue(CREATED)
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send(CREATE_BODY)

    expect(response.status).toBe(201)
    expect(response.body.data).toEqual(CREATED)
    expect(response.body.data).not.toHaveProperty('mappingId')
    expect(response.body.data).not.toHaveProperty('pendingId')
    expect(createRecipe).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      organizationId: ORGANIZATION_ID,
      body: CREATE_BODY,
    }))
    expect(createRecipe.mock.calls[0][0].body).not.toHaveProperty('actor_user_id')
  })

  it('alta con categoría nueva responde 201 y no crea un mapping Fudo', async () => {
    const createRecipe = vi.fn().mockResolvedValue({
      ...CREATED,
      category: { id: '15151515-1515-4151-8151-151515151515', name: 'Tapeo' },
    })
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send({ ...CREATE_BODY, categoryName: 'Tapeo' })
    expect(response.status).toBe(201)
    expect(response.body.data.category).toEqual({
      id: '15151515-1515-4151-8151-151515151515',
      name: 'Tapeo',
    })
    expect(response.body.data).not.toHaveProperty('mappingId')
    expect(createRecipe.mock.calls[0][0].body.categoryName).toBe('Tapeo')
  })

  it('propaga categoría ajena como 422', async () => {
    const createRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError('La categoría no está disponible.', 'CATEGORY_NOT_IN_ORG', 422),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send({ ...CREATE_BODY, categoryId: '15151515-1515-4151-8151-151515151515' })
    expect(response.status).toBe(422)
    expect(response.body.code).toBe('CATEGORY_NOT_IN_ORG')
  })

  it('alta sin ingredientes responde 201', async () => {
    const createRecipe = vi.fn().mockResolvedValue({ ...CREATED, name: 'Agua', componentCount: 0 })
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send({ name: 'Agua', yieldQuantity: 1, yieldUnit: 'unit', components: [] })
    expect(response.status).toBe(201)
    expect(response.body.data.componentCount).toBe(0)
  })

  it('rechaza POST no autenticado', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createOperationsRouter())
    const response = await request(app)
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(401)
  })

  it('rechaza una organización inválida', async () => {
    const createRecipe = vi.fn()
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post('/api/organizations/no-es-uuid/recipes')
      .send(CREATE_BODY)
    expect(response.status).toBe(400)
    expect(createRecipe).not.toHaveBeenCalled()
  })

  it('propaga organización ajena como 404', async () => {
    const createRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError('Organización no disponible.', 'NOT_FOUND', 404),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Organización no disponible.', code: 'NOT_FOUND' })
  })

  it('propaga usuario sin permisos como 403', async () => {
    const createRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError(
        'No tenés autorización para crear recetas en esta organización.',
        'FORBIDDEN',
        403,
      ),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('FORBIDDEN')
  })

  it('propaga nombre duplicado como 409', async () => {
    const createRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError('Ya existe una receta con ese nombre.', 'DUPLICATE_RECIPE_NAME', 409),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('DUPLICATE_RECIPE_NAME')
  })

  it('propaga ingrediente ajeno como 422', async () => {
    const createRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError('El insumo no está disponible.', 'INGREDIENT_NOT_IN_ORG', 422),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(422)
    expect(response.body.code).toBe('INGREDIENT_NOT_IN_ORG')
  })

  it('propaga cantidad inválida como 422', async () => {
    const createRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError(
        'Cada ingrediente necesita una cantidad mayor a cero.',
        'INVALID_QUANTITY',
        422,
      ),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(422)
    expect(response.body.code).toBe('INVALID_QUANTITY')
  })

  it('si el RPC no existe responde 503', async () => {
    const createRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError(
        'El alta de recetas todavía no está habilitada.',
        'CREATE_RECIPE_RPC_MISSING',
        503,
      ),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      error: 'El alta de recetas todavía no está habilitada.',
      code: 'CREATE_RECIPE_RPC_MISSING',
    })
  })

  it('propaga un error inesperado del RPC como 500', async () => {
    const createRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError('No se pudo crear la receta.', 'CREATE_FAILED', 500),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { createRecipe }))
      .post(`/api/organizations/${ORGANIZATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(500)
    expect(response.body.code).toBe('CREATE_FAILED')
  })
})

describe('PATCH recetas de organización', () => {
  const UPDATE_BODY = {
    name: 'Salsa de la casa',
    yieldQuantity: 1,
    yieldUnit: 'unit',
    components: [{ inventoryProductId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', quantity: 80 }],
    categoryId: '15151515-1515-4151-8151-151515151515',
    expected: {
      name: 'Salsa de la casa',
      yieldQuantity: 1,
      yieldUnit: 'unit',
      categoryId: '15151515-1515-4151-8151-151515151515',
      components: [{ inventoryProductId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', quantity: 80 }],
    },
  }

  const UPDATED = {
    recipeId: RECIPE_ID,
    name: 'Salsa de la casa',
    yieldQuantity: 1,
    yieldUnit: 'unit',
    componentCount: 1,
    category: { id: '15151515-1515-4151-8151-151515151515', name: 'Tapeo' },
    sharedLocationCount: 2,
  }

  it('guarda válido responde 200 y no modifica mappings Fudo', async () => {
    const updateRecipe = vi.fn().mockResolvedValue(UPDATED)
    const createRecipe = vi.fn()
    const saveRecipe = vi.fn()
    const response = await request(testApp(createRepository(), createRecipes(), {
      updateRecipe,
      createRecipe,
      saveRecipe,
    }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}`)
      .send(UPDATE_BODY)

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual(UPDATED)
    expect(response.body.data).not.toHaveProperty('mappingId')
    expect(updateRecipe).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      organizationId: ORGANIZATION_ID,
      recipeId: RECIPE_ID,
      body: UPDATE_BODY,
    }))
    expect(updateRecipe.mock.calls[0][0].body).not.toHaveProperty('actor_user_id')
    expect(createRecipe).not.toHaveBeenCalled()
    expect(saveRecipe).not.toHaveBeenCalled()
  })

  it('propaga 503 del handler y no llama CREATE', async () => {
    const updateRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError(
        'La edición de recetas todavía no está habilitada.',
        'RECIPE_UPDATE_RPC_PENDING',
        503,
      ),
    )
    const createRecipe = vi.fn()
    const response = await request(testApp(createRepository(), createRecipes(), {
      updateRecipe,
      createRecipe,
    }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}`)
      .send(UPDATE_BODY)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      error: 'La edición de recetas todavía no está habilitada.',
      code: 'RECIPE_UPDATE_RPC_PENDING',
    })
    expect(createRecipe).not.toHaveBeenCalled()
  })

  it('propaga receta ajena como 404', async () => {
    const updateRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError('Receta no disponible.', 'RECIPE_NOT_IN_ORG', 404),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { updateRecipe }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}`)
      .send(UPDATE_BODY)
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('RECIPE_NOT_IN_ORG')
  })

  it('propaga receta inactiva como 409', async () => {
    const updateRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError('Esta receta no está activa.', 'RECIPE_INACTIVE', 409),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { updateRecipe }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}`)
      .send(UPDATE_BODY)
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('RECIPE_INACTIVE')
  })

  it('propaga conflicto concurrente como 409', async () => {
    const updateRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError(
        'La receta cambió desde que la abriste. Recargá e intentá de nuevo.',
        'CONCURRENT_UPDATE',
        409,
      ),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { updateRecipe }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}`)
      .send(UPDATE_BODY)
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('CONCURRENT_UPDATE')
  })

  it('rechaza una receta inválida', async () => {
    const updateRecipe = vi.fn()
    const response = await request(testApp(createRepository(), createRecipes(), { updateRecipe }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/no-es-uuid`)
      .send(UPDATE_BODY)
    expect(response.status).toBe(400)
    expect(updateRecipe).not.toHaveBeenCalled()
  })

  it('rechaza PATCH no autenticado', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createOperationsRouter())
    const response = await request(app)
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}`)
      .send(UPDATE_BODY)
    expect(response.status).toBe(401)
  })
})

describe('PATCH estado de receta', () => {
  const STATUS_BODY = { active: false, expectedActive: true }
  const STATUS_RESULT = {
    recipeId: RECIPE_ID,
    active: false,
    replay: false,
    usedBy: [],
    activeMappingCount: 1,
  }

  it('responde 200 y no llama CREATE, UPDATE ni Fudo', async () => {
    const setRecipeActive = vi.fn().mockResolvedValue(STATUS_RESULT)
    const createRecipe = vi.fn()
    const updateRecipe = vi.fn()
    const saveRecipe = vi.fn()
    const response = await request(testApp(createRepository(), createRecipes(), {
      setRecipeActive,
      createRecipe,
      updateRecipe,
      saveRecipe,
    }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}/status`)
      .send(STATUS_BODY)

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual(STATUS_RESULT)
    expect(setRecipeActive).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      organizationId: ORGANIZATION_ID,
      recipeId: RECIPE_ID,
      body: STATUS_BODY,
    }))
    expect(createRecipe).not.toHaveBeenCalled()
    expect(updateRecipe).not.toHaveBeenCalled()
    expect(saveRecipe).not.toHaveBeenCalled()
  })

  it('propaga 503 pendiente y no llama otros RPCs', async () => {
    const setRecipeActive = vi.fn().mockRejectedValue(
      new RecipeSaveError(
        'El cambio de estado de recetas todavía no está habilitado.',
        'RECIPE_STATUS_RPC_PENDING',
        503,
      ),
    )
    const createRecipe = vi.fn()
    const response = await request(testApp(createRepository(), createRecipes(), {
      setRecipeActive,
      createRecipe,
    }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}/status`)
      .send(STATUS_BODY)
    expect(response.status).toBe(503)
    expect(response.body.code).toBe('RECIPE_STATUS_RPC_PENDING')
    expect(createRecipe).not.toHaveBeenCalled()
  })

  it('propaga dependencias con usedBy', async () => {
    const usedBy = [{ recipeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Milanesa' }]
    const setRecipeActive = vi.fn().mockRejectedValue(
      new RecipeStatusError(
        'No se puede desactivar porque estas recetas activas la usan como subreceta: Milanesa.',
        'RECIPE_IN_USE',
        409,
        usedBy,
      ),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { setRecipeActive }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}/status`)
      .send(STATUS_BODY)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'No se puede desactivar porque estas recetas activas la usan como subreceta: Milanesa.',
      code: 'RECIPE_IN_USE',
      usedBy,
    })
  })

  it('propaga receta ajena como 404', async () => {
    const setRecipeActive = vi.fn().mockRejectedValue(
      new RecipeSaveError('Receta no disponible.', 'RECIPE_NOT_IN_ORG', 404),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { setRecipeActive }))
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}/status`)
      .send(STATUS_BODY)
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('RECIPE_NOT_IN_ORG')
  })

  it('rechaza PATCH de estado no autenticado', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createOperationsRouter())
    const response = await request(app)
      .patch(`/api/organizations/${ORGANIZATION_ID}/recipes/${RECIPE_ID}/status`)
      .send(STATUS_BODY)
    expect(response.status).toBe(401)
  })
})

describe('POST recetas Fudo', () => {
  const CREATE_BODY = {
    intent: 'create',
    source: 'fudo',
    externalProductId: 'fudo-ipa',
    name: 'IPA de barril',
    yieldQuantity: 1,
    yieldUnit: 'unit',
    components: [{ inventoryProductId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', quantity: 12 }],
  }

  it('CREATE válido responde 201', async () => {
    const saveRecipe = vi.fn().mockResolvedValue({
      recipeId: RECIPE_ID,
      mappingId: '12121212-1212-4121-8121-121212121212',
      pendingId: '13131313-1313-4131-8131-131313131313',
      replay: false,
    })
    const response = await request(testApp(createRepository(), createRecipes(), { saveRecipe }))
      .post(`/api/locations/${LOCATION_ID}/recipes`)
      .send(CREATE_BODY)

    expect(response.status).toBe(201)
    expect(response.body.data.recipeId).toBe(RECIPE_ID)
    expect(saveRecipe).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      locationId: LOCATION_ID,
      body: CREATE_BODY,
    }))
    expect(saveRecipe.mock.calls[0][0].body).not.toHaveProperty('actor_user_id')
  })

  it('CREATE con categoría existente o nueva llega al guardado atómico', async () => {
    const saveRecipe = vi.fn().mockResolvedValue({
      recipeId: RECIPE_ID,
      mappingId: '12121212-1212-4121-8121-121212121212',
      pendingId: '13131313-1313-4131-8131-131313131313',
      replay: false,
    })
    const categoryId = '15151515-1515-4151-8151-151515151515'
    const existing = await request(testApp(createRepository(), createRecipes(), { saveRecipe }))
      .post(`/api/locations/${LOCATION_ID}/recipes`)
      .send({ ...CREATE_BODY, categoryId })
    expect(existing.status).toBe(201)
    expect(saveRecipe.mock.calls[0][0].body).toMatchObject({
      intent: 'create',
      categoryId,
      source: 'fudo',
      externalProductId: 'fudo-ipa',
    })

    const created = await request(testApp(createRepository(), createRecipes(), { saveRecipe }))
      .post(`/api/locations/${LOCATION_ID}/recipes`)
      .send({ ...CREATE_BODY, categoryName: 'Brunch' })
    expect(created.status).toBe(201)
    expect(saveRecipe.mock.calls[1][0].body).toMatchObject({
      intent: 'create',
      categoryName: 'Brunch',
    })
  })

  it('replay de CREATE responde 200 sin un segundo mapping', async () => {
    const saveRecipe = vi.fn().mockResolvedValue({
      recipeId: RECIPE_ID,
      mappingId: '12121212-1212-4121-8121-121212121212',
      pendingId: '13131313-1313-4131-8131-131313131313',
      replay: true,
    })
    const response = await request(testApp(createRepository(), createRecipes(), { saveRecipe }))
      .post(`/api/locations/${LOCATION_ID}/recipes`)
      .send({ ...CREATE_BODY, categoryName: 'Tapeo' })
    expect(response.status).toBe(200)
    expect(response.body.data.replay).toBe(true)
    expect(saveRecipe).toHaveBeenCalledTimes(1)
  })

  it('rechaza POST no autenticado', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createOperationsRouter())
    const response = await request(app)
      .post(`/api/locations/${LOCATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(401)
  })

  it('rechaza un local inválido', async () => {
    const saveRecipe = vi.fn()
    const response = await request(testApp(createRepository(), createRecipes(), { saveRecipe }))
      .post('/api/locations/no-es-uuid/recipes')
      .send(CREATE_BODY)
    expect(response.status).toBe(400)
    expect(saveRecipe).not.toHaveBeenCalled()
  })

  it('propaga mapping inactivo como 409', async () => {
    const saveRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError('Ese producto Fudo tiene un vínculo inactivo.', 'MAPPING_INACTIVE', 409),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { saveRecipe }))
      .post(`/api/locations/${LOCATION_ID}/recipes`)
      .send(CREATE_BODY)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'Ese producto Fudo tiene un vínculo inactivo.',
      code: 'MAPPING_INACTIVE',
    })
  })

  it('propaga receta inactiva en LINK como 409', async () => {
    const saveRecipe = vi.fn().mockRejectedValue(
      new RecipeSaveError('Esta receta no está activa.', 'RECIPE_INACTIVE', 409),
    )
    const response = await request(testApp(createRepository(), createRecipes(), { saveRecipe }))
      .post(`/api/locations/${LOCATION_ID}/recipes`)
      .send({
        intent: 'link',
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        existingRecipeId: RECIPE_ID,
      })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'Esta receta no está activa.',
      code: 'RECIPE_INACTIVE',
    })
  })
})

describe('consulta de consumos de venta', () => {
  it('devuelve los consumos de la sucursal sin registrar uno nuevo', async () => {
    const listSaleConsumptions = vi.fn().mockResolvedValue([{
      sourceType: 'fudo',
      sourceId: '884211',
      occurredAt: '2026-10-31T18:00:00.000Z',
      status: 'registered',
      lines: [],
    }])
    const response = await request(testApp(createRepository(), createRecipes(), { listSaleConsumptions }))
      .get(`/api/organizations/${ORGANIZATION_ID}/locations/${LOCATION_ID}/sale-consumptions`)
    expect(response.status).toBe(200)
    expect(response.body.data[0].sourceId).toBe('884211')
    expect(listSaleConsumptions).toHaveBeenCalledTimes(1)
  })

  it('no entrega consumos de otra organización', async () => {
    const listSaleConsumptions = vi.fn().mockResolvedValue(null)
    const response = await request(testApp(createRepository(), createRecipes(), { listSaleConsumptions }))
      .get(`/api/organizations/${ORGANIZATION_ID}/locations/${LOCATION_ID}/sale-consumptions`)
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('NOT_FOUND')
  })
})



import { Router, type RequestHandler } from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { InventoryError } from '../http/inventoryError.js'
import {
  createOrganizationRecipe,
  type RecipeCreateInput,
  type RecipeCreateResult,
} from '../http/recipeCreate.js'
import {
  updateOrganizationRecipe,
  type RecipeUpdateInput,
  type RecipeUpdateResult,
} from '../http/recipeUpdate.js'
import {
  setOrganizationRecipeActive,
  RecipeStatusError,
  type RecipeStatusInput,
  type RecipeStatusResult,
} from '../http/recipeStatus.js'
import { recipeQuery, type RecipeQuery } from '../http/recipeQuery.js'
import { RecipeQueryError } from '../http/recipeQueryError.js'
import {
  listLocationRecipePrices as listLocationRecipePricesDefault,
  type LocationRecipePrice,
} from '../http/recipePrice.js'
import {
  setLocationRecipePrice,
  type LocationRecipePriceSaveInput,
  type LocationRecipePriceSaveResult,
} from '../http/recipePriceSave.js'
import { saveFudoRecipe, type RecipeSaveInput, type RecipeSaveResult } from '../http/recipeSave.js'
import { RecipeSaveError } from '../http/recipeSaveError.js'
import {
  setInventoryPurchaseCost,
  type InventoryPurchaseCostInput,
  type InventoryPurchaseCostResult,
} from '../http/inventoryPurchaseCost.js'
import { prepareInventoryAdjustment } from '../http/inventoryMovementKind.js'
import {
  listLocationInventoryMovements,
  parseInventoryHistoryPage,
  INVENTORY_HISTORY_PAGE_SIZE,
} from '../http/inventoryMovements.js'
import { listSaleConsumptions, type SaleConsumptionGroup } from '../http/saleConsumptions.js'
import { deleteOrganizationRecipe } from '../http/recipeDelete.js'
import {
  adjustInventoryQuantity,
  deleteInventoryProduct,
  reactivateInventoryProduct,
  updateInventoryProduct,
} from '../http/inventoryProductManage.js'
import {
  listOrganizationSuppliers,
  resolvePreferredSupplierId,
} from '../http/organizationSuppliers.js'
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '../lib/supabase.js'
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js'
import {
  operationsRepository,
  type OperationsRepository,
  type PendingStatus,
} from '../services/operationsRepository.js'

export type RecipeSaveHandler = (input: RecipeSaveInput) => Promise<RecipeSaveResult>
export type RecipeCreateHandler = (input: RecipeCreateInput) => Promise<RecipeCreateResult>
export type RecipeUpdateHandler = (input: RecipeUpdateInput) => Promise<RecipeUpdateResult>
export type RecipeStatusHandler = (input: RecipeStatusInput) => Promise<RecipeStatusResult>

export type LocationRecipePricesHandler = (
  client: SupabaseClient,
  organizationId: string,
  locationId: string,
) => Promise<LocationRecipePrice[]>
export type LocationRecipePriceSaveHandler = (
  input: LocationRecipePriceSaveInput,
) => Promise<LocationRecipePriceSaveResult>
export type InventoryPurchaseCostHandler = (
  input: InventoryPurchaseCostInput,
) => Promise<InventoryPurchaseCostResult>

export type OperationsRouterOptions = {
  getAdmin?: () => SupabaseClient | null
  saveRecipe?: RecipeSaveHandler
  createRecipe?: RecipeCreateHandler
  updateRecipe?: RecipeUpdateHandler
  setRecipeActive?: RecipeStatusHandler
  listLocationRecipePrices?: LocationRecipePricesHandler
  setLocationRecipePrice?: LocationRecipePriceSaveHandler
  setInventoryPurchaseCost?: InventoryPurchaseCostHandler
  listSaleConsumptions?: (
    client: SupabaseClient,
    organizationId: string,
    locationId: string,
    options?: { readClient?: SupabaseClient },
  ) => Promise<SaleConsumptionGroup[] | null>
  deleteRecipe?: typeof deleteOrganizationRecipe
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validUuid(value: string) {
  return UUID.test(value)
}

export function createOperationsRouter(
  authMiddleware: RequestHandler = requireAuth,
  repository: OperationsRepository = operationsRepository,
  recipes: RecipeQuery = recipeQuery,
  options: OperationsRouterOptions = {},
) {
  const saveRecipe = options.saveRecipe ?? saveFudoRecipe
  const createRecipe = options.createRecipe ?? createOrganizationRecipe
  const updateRecipe = options.updateRecipe ?? updateOrganizationRecipe
  const setRecipeActive = options.setRecipeActive ?? setOrganizationRecipeActive
  const listLocationRecipePrices = options.listLocationRecipePrices ?? listLocationRecipePricesDefault
  const saveLocationRecipePrice = options.setLocationRecipePrice ?? setLocationRecipePrice
  const saveInventoryPurchaseCost = options.setInventoryPurchaseCost ?? setInventoryPurchaseCost
  const readSaleConsumptions = options.listSaleConsumptions ?? listSaleConsumptions
  const deleteRecipe = options.deleteRecipe ?? deleteOrganizationRecipe
  const resolveAdmin = (): SupabaseClient | null => {
    if (options.getAdmin) return options.getAdmin()
    if (!isSupabaseAdminConfigured()) return null
    return getSupabaseAdmin()
  }

  const router = Router()
  router.use(authMiddleware)

  router.get('/organizations', async (request, response) => {
    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      response.json({ data: await repository.listOrganizations(supabase) })
    } catch {
      response.status(500).json({ error: 'No se pudieron consultar las organizaciones.' })
    }
  })

  router.get('/organizations/:organizationId/locations', async (request, response) => {
    const { organizationId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.' })
      return
    }

    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      const locations = await repository.listLocations(supabase, organizationId)
      if (!locations) {
        response.status(404).json({ error: 'Organización no disponible.' })
        return
      }
      response.json({ data: locations })
    } catch {
      response.status(500).json({ error: 'No se pudieron consultar los locales.' })
    }
  })

  router.get('/locations/:locationId/pending-products', async (request, response) => {
    const { locationId } = request.params
    const rawStatus = typeof request.query.status === 'string' ? request.query.status : undefined

    if (!validUuid(locationId)) {
      response.status(400).json({ error: 'Local inválido.' })
      return
    }
    if (rawStatus && rawStatus !== 'pending' && rawStatus !== 'resolved') {
      response.status(400).json({ error: 'Estado inválido.' })
      return
    }

    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      const pending = await repository.listPendingProducts(
        supabase,
        locationId,
        rawStatus as PendingStatus | undefined,
      )
      if (!pending) {
        response.status(404).json({ error: 'Local no disponible.' })
        return
      }
      response.json({ data: pending })
    } catch {
      response.status(500).json({ error: 'No se pudieron consultar los productos pendientes.' })
    }
  })

  router.get('/locations/:locationId/fudo-catalog', async (request, response) => {
    const { locationId } = request.params
    if (!validUuid(locationId)) {
      response.status(400).json({ error: 'Local inválido.' })
      return
    }
    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      const catalog = await repository.listFudoCatalogProducts(supabase, locationId)
      if (!catalog) {
        response.status(404).json({ error: 'Local no disponible.' })
        return
      }
      response.json({ data: catalog })
    } catch {
      response.status(500).json({ error: 'No se pudo consultar el catálogo Fudo.' })
    }
  })

  router.get('/organizations/:organizationId/inventory-products', async (request, response) => {
    const { organizationId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    const search = typeof request.query.q === 'string' ? request.query.q : undefined
    const locationId = typeof request.query.locationId === 'string' ? request.query.locationId : undefined
    const includeInactive = request.query.includeInactive === 'true'
    if (locationId && !validUuid(locationId)) {
      response.status(400).json({ error: 'Local inválido.', code: 'INVALID_LOCATION' })
      return
    }

    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      const products = await repository.listInventoryProducts(supabase, organizationId, {
        search,
        locationId,
        activeOnly: !includeInactive,
      })
      if (!products) {
        response.status(404).json({ error: 'Organización no disponible.', code: 'NOT_FOUND' })
        return
      }
      response.json({ data: products })
    } catch (error) {
      if (error instanceof InventoryError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudieron consultar los insumos.', code: 'LOOKUP_FAILED' })
    }
  })

  router.get('/organizations/:organizationId/suppliers', async (request, response) => {
    const { organizationId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      const suppliers = await listOrganizationSuppliers(supabase, organizationId)
      response.json({ data: suppliers })
    } catch (error) {
      if (error instanceof InventoryError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudieron consultar los proveedores.', code: 'LOOKUP_FAILED' })
    }
  })

  router.post('/organizations/:organizationId/inventory-products', async (request, response) => {
    const { organizationId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const locationId = typeof body.locationId === 'string' ? body.locationId : ''
    const category = body.category === null
      ? null
      : typeof body.category === 'string' ? body.category : undefined
    const hasMinimum = Object.prototype.hasOwnProperty.call(body, 'minimumStock')
    const minimumStock = !hasMinimum
      ? undefined
      : body.minimumStock == null
        ? null
        : Number(body.minimumStock)
    const presentationUnit = body.presentationUnit == null
      ? null
      : typeof body.presentationUnit === 'string' ? body.presentationUnit : null
    const hasConversion = Object.prototype.hasOwnProperty.call(body, 'conversionFactor')
    const conversionFactor = !hasConversion
      ? undefined
      : body.conversionFactor == null
        ? null
        : Number(body.conversionFactor)
    const divisible = !Object.prototype.hasOwnProperty.call(body, 'divisible')
      ? undefined
      : body.divisible == null
        ? null
        : Boolean(body.divisible)
    try {
      const authenticated = request as unknown as AuthenticatedRequest
      const userId = authenticated.user?.id
      const adminClient = resolveAdmin()

      let preferredSupplierId: string | null = null
      if (userId && (
        typeof body.preferredSupplierId === 'string'
        || typeof body.preferredSupplierName === 'string'
      )) {
        preferredSupplierId = await resolvePreferredSupplierId({
          userClient: authenticated.supabase,
          adminClient,
          userId,
          organizationId,
          preferredSupplierId: typeof body.preferredSupplierId === 'string'
            ? body.preferredSupplierId
            : null,
          preferredSupplierName: typeof body.preferredSupplierName === 'string'
            ? body.preferredSupplierName
            : null,
        })
      }

      const product = await repository.createInventoryProduct(authenticated.supabase, organizationId, {
        name: typeof body.name === 'string' ? body.name : '',
        baseUnit: typeof body.baseUnit === 'string' ? body.baseUnit : '',
        category,
        presentationUnit,
        conversionFactor: conversionFactor === undefined
          ? undefined
          : conversionFactor != null && Number.isFinite(conversionFactor)
            ? conversionFactor
            : null,
        divisible,
        preferredSupplierId,
      })

      const needsMetaPatch = Boolean(
        locationId
        && validUuid(locationId)
        && userId
        && adminClient
        && (
          category !== undefined
          || minimumStock !== undefined
          || presentationUnit != null
          || conversionFactor !== undefined
          || divisible !== undefined
          || preferredSupplierId != null
        ),
      )

      if (needsMetaPatch && userId && adminClient) {
        try {
          await updateInventoryProduct({
            userClient: authenticated.supabase,
            adminClient,
            userId,
            organizationId,
            locationId,
            inventoryProductId: product.id,
            category,
            minimumStock: minimumStock !== undefined && Number.isFinite(minimumStock)
              ? minimumStock
              : minimumStock === null ? null : undefined,
            presentationUnit,
            conversionFactor: conversionFactor === undefined
              ? undefined
              : conversionFactor != null && Number.isFinite(conversionFactor)
                ? conversionFactor
                : null,
            divisible,
            preferredSupplierId,
          })
          if (category !== undefined) product.category = category
          if (minimumStock !== undefined && (minimumStock === null || Number.isFinite(minimumStock))) {
            product.minimumStock = minimumStock
          }
          if (presentationUnit != null) product.presentationUnit = presentationUnit
          if (conversionFactor !== undefined) {
            product.conversionFactor = conversionFactor != null && Number.isFinite(conversionFactor)
              ? conversionFactor
              : null
          }
          if (divisible !== undefined) product.divisible = divisible
          if (preferredSupplierId != null) product.preferredSupplierId = preferredSupplierId
        } catch {
          // Producto ya creado; presentación/proveedor se pueden completar en edición.
        }
      }

      response.status(201).json({ data: product })
    } catch (error) {
      if (error instanceof InventoryError) {
        response.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
        })
        return
      }
      response.status(500).json({ error: 'No se pudo crear el insumo.', code: 'CREATE_FAILED' })
    }
  })

  router.post(
    '/organizations/:organizationId/inventory-products/:productId/reactivate',
    async (request, response) => {
      const { organizationId, productId } = request.params
      if (!validUuid(organizationId) || !validUuid(productId)) {
        response.status(400).json({ error: 'Parámetros inválidos.', code: 'INVALID_PARAMS' })
        return
      }
      const authenticated = request as unknown as AuthenticatedRequest
      const userId = authenticated.user?.id
      if (!userId) {
        response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
        return
      }
      const adminClient = resolveAdmin()
      if (!adminClient) {
        response.status(503).json({
          error: 'Falta la clave de servicio para reactivar insumos.',
          code: 'SERVICE_ROLE_MISSING',
        })
        return
      }
      const body = (request.body ?? {}) as Record<string, unknown>
      const locationId = typeof body.locationId === 'string' && validUuid(body.locationId)
        ? body.locationId
        : undefined
      try {
        const data = await reactivateInventoryProduct({
          userClient: authenticated.supabase,
          adminClient,
          userId,
          organizationId,
          locationId,
          inventoryProductId: productId,
          category: body.category === null
            ? null
            : typeof body.category === 'string' ? body.category : undefined,
          minimumStock: !Object.prototype.hasOwnProperty.call(body, 'minimumStock')
            ? undefined
            : body.minimumStock == null
              ? null
              : Number(body.minimumStock),
        })
        response.json({ data })
      } catch (error) {
        if (error instanceof InventoryError) {
          response.status(error.status).json({ error: error.message, code: error.code })
          return
        }
        response.status(500).json({ error: 'No se pudo reactivar el insumo.', code: 'REACTIVATE_FAILED' })
      }
    },
  )

  router.post(
    '/organizations/:organizationId/locations/:locationId/inventory-products/:productId/purchase-cost',
    async (request, response) => {
      const { organizationId, locationId, productId } = request.params
      if (!validUuid(organizationId)) {
        response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
        return
      }
      if (!validUuid(locationId)) {
        response.status(400).json({ error: 'Local inválido.', code: 'INVALID_LOCATION' })
        return
      }
      if (!validUuid(productId)) {
        response.status(400).json({ error: 'Insumo inválido.', code: 'INVALID_PRODUCT' })
        return
      }

      const authenticated = request as unknown as AuthenticatedRequest
      const userId = authenticated.user?.id
      if (!userId) {
        response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
        return
      }

      const adminClient = resolveAdmin()
      if (!adminClient) {
        response.status(503).json({
          error: 'Falta la clave de servicio para guardar el costo de compra.',
          code: 'SERVICE_ROLE_MISSING',
        })
        return
      }

      try {
        const data = await saveInventoryPurchaseCost({
          userClient: authenticated.supabase,
          adminClient,
          userId,
          organizationId,
          locationId,
          inventoryProductId: productId,
          body: request.body,
        })
        response.json({ data })
      } catch (error) {
        if (error instanceof InventoryError) {
          response.status(error.status).json({ error: error.message, code: error.code })
          return
        }
        response.status(500).json({ error: 'No se pudo guardar el costo de compra.', code: 'COST_SAVE_FAILED' })
      }
    },
  )

  router.patch(
    '/organizations/:organizationId/locations/:locationId/inventory-products/:productId',
    async (request, response) => {
      const { organizationId, locationId, productId } = request.params
      if (!validUuid(organizationId) || !validUuid(locationId) || !validUuid(productId)) {
        response.status(400).json({ error: 'Parámetros inválidos.', code: 'INVALID_PARAMS' })
        return
      }
      const authenticated = request as unknown as AuthenticatedRequest
      const userId = authenticated.user?.id
      if (!userId) {
        response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
        return
      }
      const adminClient = resolveAdmin()
      if (!adminClient) {
        response.status(503).json({
          error: 'Falta la clave de servicio para editar insumos.',
          code: 'SERVICE_ROLE_MISSING',
        })
        return
      }
      const body = (request.body ?? {}) as Record<string, unknown>
      try {
        let preferredSupplierId: string | null | undefined
        if (Object.prototype.hasOwnProperty.call(body, 'preferredSupplierId')
          || Object.prototype.hasOwnProperty.call(body, 'preferredSupplierName')) {
          preferredSupplierId = await resolvePreferredSupplierId({
            userClient: authenticated.supabase,
            adminClient,
            userId,
            organizationId,
            preferredSupplierId: typeof body.preferredSupplierId === 'string'
              ? body.preferredSupplierId
              : body.preferredSupplierId === null ? null : null,
            preferredSupplierName: typeof body.preferredSupplierName === 'string'
              ? body.preferredSupplierName
              : null,
          })
          if (
            body.preferredSupplierId === null
            && body.preferredSupplierName == null
          ) {
            preferredSupplierId = null
          }
        }
        const data = await updateInventoryProduct({
          userClient: authenticated.supabase,
          adminClient,
          userId,
          organizationId,
          locationId,
          inventoryProductId: productId,
          name: typeof body.name === 'string' ? body.name : undefined,
          category: body.category === null
            ? null
            : typeof body.category === 'string' ? body.category : undefined,
          minimumStock: !Object.prototype.hasOwnProperty.call(body, 'minimumStock')
            ? undefined
            : body.minimumStock == null
              ? null
              : Number(body.minimumStock),
          presentationUnit: !Object.prototype.hasOwnProperty.call(body, 'presentationUnit')
            ? undefined
            : body.presentationUnit == null
              ? null
              : typeof body.presentationUnit === 'string' ? body.presentationUnit : undefined,
          conversionFactor: !Object.prototype.hasOwnProperty.call(body, 'conversionFactor')
            ? undefined
            : body.conversionFactor == null
              ? null
              : Number(body.conversionFactor),
          divisible: !Object.prototype.hasOwnProperty.call(body, 'divisible')
            ? undefined
            : body.divisible == null
              ? null
              : Boolean(body.divisible),
          preferredSupplierId,
        })
        response.json({ data })
      } catch (error) {
        if (error instanceof InventoryError) {
          response.status(error.status).json({ error: error.message, code: error.code })
          return
        }
        response.status(500).json({ error: 'No se pudo editar el insumo.', code: 'UPDATE_FAILED' })
      }
    },
  )

  router.get(
    '/organizations/:organizationId/locations/:locationId/inventory-movements',
    async (request, response) => {
      const { organizationId, locationId } = request.params
      if (!validUuid(organizationId) || !validUuid(locationId)) {
        response.status(400).json({ error: 'Parámetros inválidos.', code: 'INVALID_PARAMS' })
        return
      }
      const adminClient = resolveAdmin()
      if (!adminClient) {
        response.status(503).json({
          error: 'Falta la clave de servicio para leer el historial de inventario.',
          code: 'SERVICE_ROLE_MISSING',
        })
        return
      }
      try {
        const { supabase } = request as unknown as AuthenticatedRequest
        const page = parseInventoryHistoryPage(request.query.page)
        const movements = await listLocationInventoryMovements(supabase, organizationId, locationId, {
          readClient: adminClient,
          page,
          pageSize: INVENTORY_HISTORY_PAGE_SIZE,
        })
        if (!movements) {
          response.status(404).json({ error: 'Sucursal no disponible.', code: 'NOT_FOUND' })
          return
        }
        response.json({ data: movements })
      } catch (error) {
        if (error instanceof InventoryError) {
          response.status(error.status).json({ error: error.message, code: error.code })
          return
        }
        response.status(500).json({ error: 'No se pudo leer el historial de esta sucursal.', code: 'LOOKUP_FAILED' })
      }
    },
  )

  router.get(
    '/organizations/:organizationId/locations/:locationId/sale-consumptions',
    async (request, response) => {
      const { organizationId, locationId } = request.params
      if (!validUuid(organizationId) || !validUuid(locationId)) {
        response.status(400).json({ error: 'Parámetros inválidos.', code: 'INVALID_PARAMS' })
        return
      }
      const adminClient = resolveAdmin()
      if (!adminClient) {
        response.status(503).json({
          error: 'Falta la clave de servicio para leer los consumos de venta.',
          code: 'SERVICE_ROLE_MISSING',
        })
        return
      }
      try {
        const { supabase } = request as unknown as AuthenticatedRequest
        const consumptions = await readSaleConsumptions(supabase, organizationId, locationId, {
          readClient: adminClient,
        })
        if (!consumptions) {
          response.status(404).json({ error: 'Sucursal no disponible.', code: 'NOT_FOUND' })
          return
        }
        response.json({ data: consumptions })
      } catch (error) {
        if (error instanceof InventoryError) {
          response.status(error.status).json({ error: error.message, code: error.code })
          return
        }
        response.status(500).json({ error: 'No se pudieron leer los consumos de esta sucursal.', code: 'LOOKUP_FAILED' })
      }
    },
  )

  router.post(
    '/organizations/:organizationId/locations/:locationId/inventory-products/:productId/adjust',
    async (request, response) => {
      const { organizationId, locationId, productId } = request.params
      if (!validUuid(organizationId) || !validUuid(locationId) || !validUuid(productId)) {
        response.status(400).json({ error: 'Parámetros inválidos.', code: 'INVALID_PARAMS' })
        return
      }
      const authenticated = request as unknown as AuthenticatedRequest
      const userId = authenticated.user?.id
      if (!userId) {
        response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
        return
      }
      const adminClient = resolveAdmin()
      if (!adminClient) {
        response.status(503).json({
          error: 'Falta la clave de servicio para ajustar stock.',
          code: 'SERVICE_ROLE_MISSING',
        })
        return
      }
      const body = (request.body ?? {}) as Record<string, unknown>
      const quantityDelta = Number(body.quantityDelta)
      const reason = typeof body.reason === 'string' ? body.reason : ''
      const kind = typeof body.kind === 'string' ? body.kind : 'correction'
      const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : ''
      const prepared = prepareInventoryAdjustment({ quantityDelta, reason, kind })
      if ('error' in prepared) {
        response.status(422).json({ error: prepared.error, code: prepared.code })
        return
      }
      if (!validUuid(idempotencyKey)) {
        response.status(422).json({ error: 'Falta la clave de idempotencia.', code: 'IDEMPOTENCY_KEY_REQUIRED' })
        return
      }
      try {
        const data = await adjustInventoryQuantity({
          userClient: authenticated.supabase,
          adminClient,
          userId,
          organizationId,
          locationId,
          inventoryProductId: productId,
          quantityDelta: prepared.quantity,
          reason: prepared.reason,
          idempotencyKey,
        })
        response.json({ data })
      } catch (error) {
        if (error instanceof InventoryError) {
          response.status(error.status).json({ error: error.message, code: error.code })
          return
        }
        response.status(500).json({ error: 'No se pudo ajustar el stock.', code: 'ADJUST_FAILED' })
      }
    },
  )

  router.delete(
    '/organizations/:organizationId/inventory-products/:productId',
    async (request, response) => {
      const { organizationId, productId } = request.params
      if (!validUuid(organizationId) || !validUuid(productId)) {
        response.status(400).json({ error: 'Parámetros inválidos.', code: 'INVALID_PARAMS' })
        return
      }
      const authenticated = request as unknown as AuthenticatedRequest
      const userId = authenticated.user?.id
      if (!userId) {
        response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
        return
      }
      const adminClient = resolveAdmin()
      if (!adminClient) {
        response.status(503).json({
          error: 'Falta la clave de servicio para eliminar insumos.',
          code: 'SERVICE_ROLE_MISSING',
        })
        return
      }
      try {
        const data = await deleteInventoryProduct({
          userClient: authenticated.supabase,
          adminClient,
          userId,
          organizationId,
          inventoryProductId: productId,
        })
        response.json({ data })
      } catch (error) {
        if (error instanceof InventoryError) {
          response.status(error.status).json({ error: error.message, code: error.code })
          return
        }
        response.status(500).json({ error: 'No se pudo eliminar el insumo.', code: 'DELETE_FAILED' })
      }
    },
  )

  router.post('/locations/:locationId/recipes', async (request, response) => {
    const { locationId } = request.params
    if (!validUuid(locationId)) {
      response.status(400).json({ error: 'Local inválido.', code: 'INVALID_LOCATION' })
      return
    }

    const authenticated = request as unknown as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
      return
    }

    const adminClient = resolveAdmin()
    if (!adminClient) {
      response.status(503).json({
        error: 'Falta la clave de servicio para guardar recetas.',
        code: 'SERVICE_ROLE_MISSING',
      })
      return
    }

    try {
      const data = await saveRecipe({
        userClient: authenticated.supabase,
        adminClient,
        userId,
        locationId,
        body: request.body,
      })
      response.status(data.replay ? 200 : 201).json({ data })
    } catch (error) {
      if (error instanceof RecipeSaveError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudo guardar la receta.', code: 'SAVE_FAILED' })
    }
  })

  router.get('/organizations/:organizationId/recipes', async (request, response) => {
    const { organizationId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    const search = typeof request.query.q === 'string' ? request.query.q : undefined
    const includeInactive = request.query.includeInactive === 'true'

    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      const catalog = await recipes.listOrganizationRecipes(supabase, organizationId, {
        search,
        includeInactive,
      })
      if (!catalog) {
        response.status(404).json({ error: 'Organización no disponible.', code: 'NOT_FOUND' })
        return
      }
      response.json({ data: catalog })
    } catch (error) {
      if (error instanceof RecipeQueryError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudieron consultar las recetas.', code: 'LOOKUP_FAILED' })
    }
  })

  router.get('/organizations/:organizationId/recipes/:recipeId/usage', async (request, response) => {
    const { organizationId, recipeId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    if (!validUuid(recipeId)) {
      response.status(400).json({ error: 'Receta inválida.', code: 'INVALID_RECIPE' })
      return
    }

    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      const usage = await recipes.getRecipeUsage(supabase, organizationId, recipeId)
      if (!usage) {
        response.status(404).json({ error: 'Organización no disponible.', code: 'NOT_FOUND' })
        return
      }
      response.json({ data: usage })
    } catch (error) {
      if (error instanceof RecipeQueryError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudo consultar el uso de la receta.', code: 'LOOKUP_FAILED' })
    }
  })

  router.get('/organizations/:organizationId/recipe-categories', async (request, response) => {
    const { organizationId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }

    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      const categories = await recipes.listOrganizationRecipeCategories(supabase, organizationId)
      if (!categories) {
        response.status(404).json({ error: 'Organización no disponible.', code: 'NOT_FOUND' })
        return
      }
      response.json({ data: categories })
    } catch (error) {
      if (error instanceof RecipeQueryError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudieron consultar las categorías.', code: 'LOOKUP_FAILED' })
    }
  })

  router.post('/organizations/:organizationId/recipes', async (request, response) => {
    const { organizationId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }

    const authenticated = request as unknown as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
      return
    }

    const adminClient = resolveAdmin()
    if (!adminClient) {
      response.status(503).json({
        error: 'Falta la clave de servicio para crear recetas.',
        code: 'SERVICE_ROLE_MISSING',
      })
      return
    }

    try {
      const data = await createRecipe({
        userClient: authenticated.supabase,
        adminClient,
        userId,
        organizationId,
        body: request.body,
      })
      response.status(201).json({ data })
    } catch (error) {
      if (error instanceof RecipeSaveError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudo crear la receta.', code: 'CREATE_FAILED' })
    }
  })

  router.patch('/organizations/:organizationId/recipes/:recipeId', async (request, response) => {
    const { organizationId, recipeId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    if (!validUuid(recipeId)) {
      response.status(400).json({ error: 'Receta inválida.', code: 'INVALID_RECIPE' })
      return
    }

    const authenticated = request as unknown as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
      return
    }

    const adminClient = resolveAdmin()
    if (!adminClient) {
      response.status(503).json({
        error: 'Falta la clave de servicio para editar recetas.',
        code: 'SERVICE_ROLE_MISSING',
      })
      return
    }

    try {
      const data = await updateRecipe({
        userClient: authenticated.supabase,
        adminClient,
        userId,
        organizationId,
        recipeId,
        body: request.body,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof RecipeSaveError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudo guardar la receta.', code: 'UPDATE_FAILED' })
    }
  })

  router.patch('/organizations/:organizationId/recipes/:recipeId/status', async (request, response) => {
    const { organizationId, recipeId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    if (!validUuid(recipeId)) {
      response.status(400).json({ error: 'Receta inválida.', code: 'INVALID_RECIPE' })
      return
    }

    const authenticated = request as unknown as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
      return
    }

    const adminClient = resolveAdmin()
    if (!adminClient) {
      response.status(503).json({
        error: 'Falta la clave de servicio para cambiar el estado de recetas.',
        code: 'SERVICE_ROLE_MISSING',
      })
      return
    }

    try {
      const data = await setRecipeActive({
        userClient: authenticated.supabase,
        adminClient,
        userId,
        organizationId,
        recipeId,
        body: request.body,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof RecipeStatusError) {
        response.status(error.status).json({
          error: error.message,
          code: error.code,
          usedBy: error.usedBy,
        })
        return
      }
      if (error instanceof RecipeSaveError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudo cambiar el estado de la receta.', code: 'STATUS_FAILED' })
    }
  })

  router.delete('/organizations/:organizationId/recipes/:recipeId', async (request, response) => {
    const { organizationId, recipeId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    if (!validUuid(recipeId)) {
      response.status(400).json({ error: 'Receta inválida.', code: 'INVALID_RECIPE' })
      return
    }

    const authenticated = request as unknown as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
      return
    }

    const adminClient = resolveAdmin()
    if (!adminClient) {
      response.status(503).json({
        error: 'Falta la clave de servicio para eliminar recetas.',
        code: 'SERVICE_ROLE_MISSING',
      })
      return
    }

    try {
      const data = await deleteRecipe({
        userClient: authenticated.supabase,
        adminClient,
        userId,
        organizationId,
        recipeId,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof RecipeStatusError) {
        response.status(error.status).json({
          error: error.message,
          code: error.code,
          usedBy: error.usedBy,
        })
        return
      }
      if (error instanceof RecipeSaveError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudo eliminar la receta.', code: 'DELETE_FAILED' })
    }
  })

  router.get('/organizations/:organizationId/locations/:locationId/recipe-prices', async (request, response) => {
    const { organizationId, locationId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    if (!validUuid(locationId)) {
      response.status(400).json({ error: 'Local inválido.', code: 'INVALID_LOCATION' })
      return
    }

    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      response.json({ data: await listLocationRecipePrices(supabase, organizationId, locationId) })
    } catch (error) {
      if (error instanceof RecipeQueryError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudieron consultar los precios de venta.', code: 'LOOKUP_FAILED' })
    }
  })

  router.patch('/organizations/:organizationId/locations/:locationId/recipe-prices/:recipeId', async (request, response) => {
    const { organizationId, locationId, recipeId } = request.params
    if (!validUuid(organizationId)) {
      response.status(400).json({ error: 'Organización inválida.', code: 'INVALID_ORGANIZATION' })
      return
    }
    if (!validUuid(locationId)) {
      response.status(400).json({ error: 'Local inválido.', code: 'INVALID_LOCATION' })
      return
    }
    if (!validUuid(recipeId)) {
      response.status(400).json({ error: 'Receta inválida.', code: 'INVALID_RECIPE' })
      return
    }

    const authenticated = request as unknown as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
      return
    }

    const adminClient = resolveAdmin()
    if (!adminClient) {
      response.status(503).json({
        error: 'Falta la clave de servicio para guardar precios.',
        code: 'SERVICE_ROLE_MISSING',
      })
      return
    }

    try {
      const data = await saveLocationRecipePrice({
        userClient: authenticated.supabase,
        adminClient,
        userId,
        organizationId,
        locationId,
        recipeId,
        body: request.body,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof RecipeSaveError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudo guardar el precio de venta.', code: 'PRICE_SAVE_FAILED' })
    }
  })

  router.get('/locations/:locationId/recipes', async (request, response) => {
    const { locationId } = request.params
    if (!validUuid(locationId)) {
      response.status(400).json({ error: 'Local inválido.', code: 'INVALID_LOCATION' })
      return
    }

    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      response.json({ data: await recipes.listLocationRecipes(supabase, locationId) })
    } catch (error) {
      if (error instanceof RecipeQueryError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudieron consultar las recetas.', code: 'LOOKUP_FAILED' })
    }
  })

  router.get('/recipes/:recipeId', async (request, response) => {
    const { recipeId } = request.params
    const locationId = typeof request.query.locationId === 'string' ? request.query.locationId : ''
    if (!validUuid(recipeId)) {
      response.status(400).json({ error: 'Receta inválida.', code: 'INVALID_RECIPE' })
      return
    }
    if (!locationId) {
      response.status(400).json({ error: 'Indicá el local.', code: 'LOCATION_REQUIRED' })
      return
    }
    if (!validUuid(locationId)) {
      response.status(400).json({ error: 'Local inválido.', code: 'INVALID_LOCATION' })
      return
    }

    try {
      const { supabase } = request as unknown as AuthenticatedRequest
      response.json({ data: await recipes.getRecipeDetail(supabase, recipeId, locationId) })
    } catch (error) {
      if (error instanceof RecipeQueryError) {
        response.status(error.status).json({ error: error.message, code: error.code })
        return
      }
      response.status(500).json({ error: 'No se pudo consultar la receta.', code: 'LOOKUP_FAILED' })
    }
  })

  return router
}

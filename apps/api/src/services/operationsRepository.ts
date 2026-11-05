import type { SupabaseClient } from '@supabase/supabase-js'
import { attachPendingProductRelations } from '../http/pendingProductRelations.js'
import { InventoryError } from '../http/inventoryError.js'
import {
  classifyInventoryWriteError,
  logInventoryWriteFailure,
} from '../http/inventoryWriteError.js'
import {
  normalizeInventoryName,
  parseInventoryBaseUnit,
} from '../http/inventoryUnits.js'
import { assertPresentationCoherence } from '../http/presentationCoherence.js'

export type PendingStatus = 'pending' | 'resolved'

export type InventoryProductRecord = {
  id: string
  organizationId: string
  name: string
  baseUnit: string | null
  active: boolean
  onHand: number | null
  averageUnitCost: number | null
  minimumStock: number | null
  category: string | null
  supplierName: string | null
  preferredSupplierId: string | null
  presentationUnit: string | null
  conversionFactor: number | null
  divisible: boolean | null
}

export type CreateInventoryProductInput = {
  name: string
  baseUnit: string
  category?: string | null
  presentationUnit?: string | null
  conversionFactor?: number | null
  divisible?: boolean | null
  preferredSupplierId?: string | null
}

export interface OperationsRepository {
  listOrganizations(client: SupabaseClient): Promise<Record<string, unknown>[]>
  listLocations(
    client: SupabaseClient,
    organizationId: string,
  ): Promise<Record<string, unknown>[] | null>
  listPendingProducts(
    client: SupabaseClient,
    locationId: string,
    status?: PendingStatus,
  ): Promise<Record<string, unknown>[] | null>
  listFudoCatalogProducts(
    client: SupabaseClient,
    locationId: string,
  ): Promise<Record<string, unknown>[] | null>
  listInventoryProducts(
    client: SupabaseClient,
    organizationId: string,
    options?: { search?: string; locationId?: string; activeOnly?: boolean },
  ): Promise<InventoryProductRecord[] | null>
  createInventoryProduct(
    client: SupabaseClient,
    organizationId: string,
    input: CreateInventoryProductInput,
  ): Promise<InventoryProductRecord>
}

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function mapInventoryRow(
  row: Record<string, unknown>,
  facts: {
    onHand?: number | null
    averageUnitCost?: number | null
    minimumStock?: number | null
    supplierName?: string | null
  } = {},
): InventoryProductRecord {
  const preferred = isRecord(row.preferred_supplier)
    ? asString(row.preferred_supplier.name)
    : null
  return {
    id: String(row.id),
    organizationId: String(row.organization_id ?? ''),
    name: asString(row.name) ?? 'Insumo',
    baseUnit: asString(row.base_unit),
    active: row.active !== false,
    onHand: facts.onHand ?? null,
    averageUnitCost: facts.averageUnitCost ?? null,
    minimumStock: facts.minimumStock ?? null,
    category: asString(row.category) ?? asString(row.category_name),
    preferredSupplierId: asString(row.preferred_supplier_id),
    presentationUnit: asString(row.presentation_unit),
    conversionFactor: asNumber(row.conversion_factor),
    divisible: typeof row.divisible === 'boolean' ? row.divisible : null,
    // Preferencia explícita del alta > último issuer de factura.
    supplierName: preferred ?? facts.supplierName ?? null,
  }
}

function stockLookupFailed(): never {
  throw new InventoryError('No se pudieron consultar las existencias.', 'LOOKUP_FAILED', 500)
}

type LocationInventoryFacts = {
  onHand: number
  averageUnitCost: number | null
  minimumStock: number | null
  supplierName: string | null
}

async function loadSupplierByProduct(
  client: SupabaseClient,
  locationId: string,
  productIds: string[],
): Promise<Map<string, string>> {
  const suppliers = new Map<string, string>()
  if (productIds.length === 0) return suppliers

  const { data: receiptRows, error: receiptError } = await client
    .from('purchase_document_receipts')
    .select('inventory_product_id, purchase_document_id, created_at')
    .eq('location_id', locationId)
    .in('inventory_product_id', productIds)
    .order('created_at', { ascending: false })
  if (receiptError) return suppliers

  const latestDocumentByProduct = new Map<string, string>()
  const documentIds: string[] = []
  for (const row of Array.isArray(receiptRows) ? receiptRows as unknown[] : []) {
    if (!isRecord(row)) continue
    const productId = asString(row.inventory_product_id)
    const documentId = asString(row.purchase_document_id)
    if (!productId || !documentId || latestDocumentByProduct.has(productId)) continue
    latestDocumentByProduct.set(productId, documentId)
    documentIds.push(documentId)
  }
  if (documentIds.length === 0) return suppliers

  const { data: documents, error: documentError } = await client
    .from('purchase_documents')
    .select('id, issuer_name')
    .in('id', [...new Set(documentIds)])
    .is('deleted_at', null)
  if (documentError) return suppliers

  const issuerByDocument = new Map<string, string>()
  for (const row of Array.isArray(documents) ? documents as unknown[] : []) {
    if (!isRecord(row)) continue
    const id = asString(row.id)
    const issuer = asString(row.issuer_name)
    if (!id || !issuer) continue
    issuerByDocument.set(id, issuer)
  }

  for (const [productId, documentId] of latestDocumentByProduct) {
    const issuer = issuerByDocument.get(documentId)
    if (issuer) suppliers.set(productId, issuer)
  }
  return suppliers
}

async function loadOnHandByProduct(
  client: SupabaseClient,
  organizationId: string,
  locationId: string,
): Promise<Map<string, LocationInventoryFacts>> {
  const { data: location, error: locationError } = await client
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (locationError) stockLookupFailed()
  if (!isRecord(location) || String(location.organization_id ?? '') !== organizationId) {
    throw new InventoryError('Local no disponible.', 'NOT_FOUND', 404)
  }

  const { data: inventoryRows, error: inventoryError } = await client
    .from('location_inventory')
    .select('id, location_id, inventory_product_id, minimum_stock')
    .eq('location_id', locationId)
  if (inventoryError) stockLookupFailed()

  const productByLocationInventory = new Map<string, string>()
  const minimumByProduct = new Map<string, number | null>()
  const locationInventoryIds: string[] = []
  for (const row of Array.isArray(inventoryRows) ? inventoryRows as unknown[] : []) {
    if (!isRecord(row)) continue
    if (String(row.location_id ?? '') !== locationId) continue
    const id = asString(row.id)
    const productId = asString(row.inventory_product_id)
    if (!id || !productId || productByLocationInventory.has(id)) continue
    productByLocationInventory.set(id, productId)
    minimumByProduct.set(productId, asNumber(row.minimum_stock))
    locationInventoryIds.push(id)
  }

  const onHandByProduct = new Map<string, LocationInventoryFacts>()
  const productIds = [...new Set(productByLocationInventory.values())]
  const suppliers = await loadSupplierByProduct(client, locationId, productIds)

  if (locationInventoryIds.length === 0) {
    for (const productId of productIds) {
      onHandByProduct.set(productId, {
        onHand: 0,
        averageUnitCost: null,
        minimumStock: minimumByProduct.get(productId) ?? null,
        supplierName: suppliers.get(productId) ?? null,
      })
    }
    return onHandByProduct
  }

  const { data: valuationRows, error: valuationError } = await client
    .from('inventory_valuations')
    .select('location_inventory_id, quantity_on_hand, average_unit_cost')
    .in('location_inventory_id', locationInventoryIds)
  if (valuationError) stockLookupFailed()

  const seenValuation = new Set<string>()
  for (const row of Array.isArray(valuationRows) ? valuationRows as unknown[] : []) {
    if (!isRecord(row)) continue
    const locationInventoryId = asString(row.location_inventory_id)
    if (!locationInventoryId || seenValuation.has(locationInventoryId)) continue
    seenValuation.add(locationInventoryId)
    const productId = productByLocationInventory.get(locationInventoryId)
    if (!productId || onHandByProduct.has(productId)) continue
    onHandByProduct.set(productId, {
      onHand: asNumber(row.quantity_on_hand) ?? 0,
      averageUnitCost: asNumber(row.average_unit_cost),
      minimumStock: minimumByProduct.get(productId) ?? null,
      supplierName: suppliers.get(productId) ?? null,
    })
  }

  for (const productId of productIds) {
    if (onHandByProduct.has(productId)) continue
    onHandByProduct.set(productId, {
      onHand: 0,
      averageUnitCost: null,
      minimumStock: minimumByProduct.get(productId) ?? null,
      supplierName: suppliers.get(productId) ?? null,
    })
  }
  return onHandByProduct
}

export const operationsRepository: OperationsRepository = {
  async listOrganizations(client) {
    const { data, error } = await client.from('organizations').select('*')
    throwIfError(error)
    return data ?? []
  },

  async listLocations(client, organizationId) {
    const { data: organization, error: organizationError } = await client
      .from('organizations')
      .select('id')
      .eq('id', organizationId)
      .maybeSingle()
    throwIfError(organizationError)
    if (!organization) return null

    const { data, error } = await client
      .from('locations')
      .select('*')
      .eq('organization_id', organizationId)
    throwIfError(error)
    return data ?? []
  },

  async listPendingProducts(client, locationId, status) {
    const { data: location, error: locationError } = await client
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .maybeSingle()
    throwIfError(locationError)
    if (!location) return null

    let query = client
      .from('pending_product_mappings')
      .select('*')
      .eq('location_id', locationId)
      .order('last_seen_at', { ascending: false })

    if (status) query = query.eq('status', status)

    const { data, error } = await query
    throwIfError(error)
    const products = Array.isArray(data) ? data as Record<string, unknown>[] : []

    const { data: mappingRows, error: mappingError } = await client
      .from('sales_product_mappings')
      .select('id, location_id, source, external_product_id, recipe_id, active')
      .eq('location_id', locationId)
    throwIfError(mappingError)
    const mappings = Array.isArray(mappingRows) ? mappingRows as Record<string, unknown>[] : []

    const recipeIds = [...new Set(
      mappings
        .map((row) => typeof row.recipe_id === 'string' ? row.recipe_id : '')
        .filter(Boolean),
    )]
    let recipes: Record<string, unknown>[] = []
    if (recipeIds.length > 0) {
      const { data: recipeRows, error: recipeError } = await client
        .from('recipes')
        .select('id, name')
        .in('id', recipeIds)
      throwIfError(recipeError)
      recipes = Array.isArray(recipeRows) ? recipeRows as Record<string, unknown>[] : []
    }

    return attachPendingProductRelations(products, mappings, recipes, locationId)
  },

  async listFudoCatalogProducts(client, locationId) {
    const { data: location, error: locationError } = await client
      .from('locations')
      .select('id, organization_id')
      .eq('id', locationId)
      .maybeSingle()
    throwIfError(locationError)
    if (!location) return null

    const { data, error } = await client
      .from('fudo_product_catalog')
      .select('id, location_id, organization_id, source, external_product_id, name, active, last_synced_at')
      .eq('location_id', locationId)
      .eq('source', 'fudo')
      .order('name', { ascending: true })
    if (error) {
      const message = error.message ?? ''
      if (/fudo_product_catalog|schema cache|does not exist/i.test(message)) return []
      throw new Error(message)
    }

    const rows = Array.isArray(data) ? data as Record<string, unknown>[] : []
    const { data: mappingRows, error: mappingError } = await client
      .from('sales_product_mappings')
      .select('id, location_id, source, external_product_id, recipe_id, active')
      .eq('location_id', locationId)
      .eq('source', 'fudo')
    throwIfError(mappingError)
    const mappings = Array.isArray(mappingRows) ? mappingRows as Record<string, unknown>[] : []

    return rows.map((row) => {
      const externalId = typeof row.external_product_id === 'string' ? row.external_product_id : ''
      const mapping = mappings.find((item) => item.external_product_id === externalId) ?? null
      const mappingActive = mapping ? mapping.active !== false : false
      return {
        id: row.id,
        location_id: row.location_id,
        organization_id: row.organization_id,
        source: 'fudo',
        external_product_id: externalId,
        product_name: row.name,
        external_product_name: row.name,
        catalog_active: row.active === true,
        last_synced_at: row.last_synced_at ?? null,
        status: mappingActive ? 'linked' : 'catalog',
        mapping_id: mappingActive && typeof mapping?.id === 'string' ? mapping.id : null,
        mapping_active: mapping ? mapping.active !== false : null,
        recipe_id: mappingActive && typeof mapping?.recipe_id === 'string' ? mapping.recipe_id : null,
      }
    })
  },

  async listInventoryProducts(client, organizationId, options = {}) {
    const { data: organization, error: organizationError } = await client
      .from('organizations')
      .select('id')
      .eq('id', organizationId)
      .maybeSingle()
    throwIfError(organizationError)
    if (!organization) return null

    const selectFull =
      'id, organization_id, name, base_unit, active, category, presentation_unit, conversion_factor, divisible, preferred_supplier_id, preferred_supplier:suppliers!preferred_supplier_id(id, name)'
    const selectCategory =
      'id, organization_id, name, base_unit, active, category'
    const selectBase = 'id, organization_id, name, base_unit, active'

    let query = client
      .from('inventory_products')
      .select(selectFull)
      .eq('organization_id', organizationId)
      .order('name', { ascending: true })

    const term = options.search?.trim()
    if (term) query = query.ilike('name', `%${term}%`)

    const { data, error } = await query
    // Columnas nuevas / categoría pueden no existir aún.
    let productRows: unknown = data
    if (error && /presentation_unit|conversion_factor|preferred_supplier|suppliers/i.test(error.message ?? '')) {
      const mid = await client
        .from('inventory_products')
        .select(selectCategory)
        .eq('organization_id', organizationId)
        .order('name', { ascending: true })
      if (mid.error && /category/i.test(mid.error.message ?? '')) {
        const fallback = await client
          .from('inventory_products')
          .select(selectBase)
          .eq('organization_id', organizationId)
          .order('name', { ascending: true })
        throwIfError(fallback.error)
        productRows = fallback.data
      } else {
        throwIfError(mid.error)
        productRows = mid.data
      }
    } else if (error && /category/i.test(error.message ?? '')) {
      const fallback = await client
        .from('inventory_products')
        .select(selectBase)
        .eq('organization_id', organizationId)
        .order('name', { ascending: true })
      throwIfError(fallback.error)
      productRows = fallback.data
    } else {
      throwIfError(error)
    }

    let rows = (Array.isArray(productRows) ? productRows as unknown[] : [])
      .filter(isRecord)
      .map((row) => mapInventoryRow(row))
      .filter((row) => row.organizationId === organizationId)

    if (options.activeOnly !== false) {
      rows = rows.filter((row) => row.active)
    }

    if (options.locationId) {
      const onHandByProduct = await loadOnHandByProduct(client, organizationId, options.locationId)
      rows = rows.map((row) => {
        const facts = onHandByProduct.get(row.id)
        return {
          ...row,
          onHand: facts?.onHand ?? 0,
          averageUnitCost: facts?.averageUnitCost ?? null,
          minimumStock: facts?.minimumStock ?? null,
          supplierName: facts?.supplierName ?? null,
        }
      })
    }

    return rows
  },

  async createInventoryProduct(client, organizationId, input) {
    const { data: organization, error: organizationError } = await client
      .from('organizations')
      .select('id')
      .eq('id', organizationId)
      .maybeSingle()
    if (organizationError) {
      logInventoryWriteFailure({
        operation: 'inventory_products.create.organization_lookup',
        organizationId,
        baseUnit: '',
        hasRow: false,
        recovered: false,
        diagnosis: classifyInventoryWriteError(organizationError, organization),
      })
      throw new InventoryError('No se pudo crear el insumo.', 'CREATE_FAILED', 500)
    }
    if (!organization) {
      throw new InventoryError('Organización no disponible.', 'NOT_FOUND', 404)
    }

    const name = input.name.trim()
    if (name.length < 2) {
      throw new InventoryError('Indicá un nombre de insumo.', 'INVALID_NAME', 422)
    }

    let baseUnit
    try {
      baseUnit = parseInventoryBaseUnit(input.baseUnit)
    } catch {
      throw new InventoryError(
        'La unidad base debe ser gramos, mililitros o unidades.',
        'INVALID_BASE_UNIT',
        422,
      )
    }

    const existing = await this.listInventoryProducts(client, organizationId, { activeOnly: false })
    const normalized = normalizeInventoryName(name)
    const duplicate = (existing ?? []).find(
      (row) => row.active && normalizeInventoryName(row.name) === normalized,
    )
    if (duplicate) {
      throw new InventoryError(
        'Ya existe un insumo con ese nombre en la organización.',
        'DUPLICATE_PRODUCT',
        409,
      )
    }

    const category = input.category == null
      ? null
      : (typeof input.category === 'string' ? input.category.trim() || null : null)

    const presentationUnit = input.presentationUnit == null
      ? null
      : (typeof input.presentationUnit === 'string'
        ? (input.presentationUnit.trim().toLowerCase() === 'unit' ? 'u' : input.presentationUnit.trim().toLowerCase()) || null
        : null)
    const conversionFactor = input.conversionFactor == null
      ? null
      : Number(input.conversionFactor)
    if (conversionFactor != null && (!(conversionFactor > 0) || !Number.isFinite(conversionFactor))) {
      throw new InventoryError('El contenido por unidad no es válido.', 'INVALID_CONVERSION_FACTOR', 422)
    }
    const preferredSupplierId = input.preferredSupplierId?.trim() || null
    const divisible = input.divisible === undefined ? null : input.divisible

    const coherence = assertPresentationCoherence({
      baseUnit,
      presentationUnit,
      conversionFactor,
      divisible,
    })
    if (!coherence.ok) {
      throw new InventoryError(
        coherence.code === 'INVALID_CONVERSION_FACTOR'
          ? 'El contenido por unidad no es válido.'
          : 'La presentación comercial no es coherente con la unidad base.',
        coherence.code,
        422,
      )
    }

    const insertPayload: Record<string, unknown> = {
      organization_id: organizationId,
      name,
      base_unit: baseUnit,
      active: true,
    }
    if (category !== null) insertPayload.category = category
    if (presentationUnit) insertPayload.presentation_unit = presentationUnit
    if (conversionFactor != null) insertPayload.conversion_factor = conversionFactor
    if (divisible != null) insertPayload.divisible = divisible
    if (preferredSupplierId) insertPayload.preferred_supplier_id = preferredSupplierId

    const selectCreated =
      'id, organization_id, name, base_unit, active, category, presentation_unit, conversion_factor, divisible, preferred_supplier_id'

    const inserted = await client
      .from('inventory_products')
      .insert(insertPayload)
      .select(selectCreated)
      .maybeSingle()
    let data: unknown = inserted.data
    let error = inserted.error

    // Nuevas columnas / category pueden no existir aún: degradar el insert.
    if (error && /presentation_unit|conversion_factor|preferred_supplier|divisible/i.test(error.message ?? '')) {
      const stripped = {
        organization_id: organizationId,
        name,
        base_unit: baseUnit,
        active: true,
        ...(category !== null ? { category } : {}),
      }
      const retry = await client
        .from('inventory_products')
        .insert(stripped)
        .select('id, organization_id, name, base_unit, active, category')
        .maybeSingle()
      data = retry.data
      error = retry.error
    }
    if (error && /category/i.test(error.message ?? '') && category !== null) {
      const retry = await client
        .from('inventory_products')
        .insert({
          organization_id: organizationId,
          name,
          base_unit: baseUnit,
          active: true,
        })
        .select('id, organization_id, name, base_unit, active')
        .maybeSingle()
      data = retry.data
      error = retry.error
    }

    const diagnosis = classifyInventoryWriteError(error, data)
    if (isRecord(data) && data.id) {
      if (error) {
        logInventoryWriteFailure({
          organizationId,
          baseUnit,
          hasRow: true,
          recovered: false,
          diagnosis,
        })
      }
      return mapInventoryRow({
        ...data,
        category,
        presentation_unit: asString(data.presentation_unit) ?? presentationUnit,
        conversion_factor: asNumber(data.conversion_factor) ?? conversionFactor,
        divisible: typeof data.divisible === 'boolean' ? data.divisible : divisible,
        preferred_supplier_id: asString(data.preferred_supplier_id) ?? preferredSupplierId,
      })
    }

    let recovered: InventoryProductRecord | null = null
    if (diagnosis.kind === 'empty_representation' || diagnosis.kind === 'failed') {
      try {
        recovered = (await this.listInventoryProducts(client, organizationId, { activeOnly: false }) ?? [])
          .find((row) => row.active && normalizeInventoryName(row.name) === normalized) ?? null
      } catch {
        recovered = null
      }
    }

    logInventoryWriteFailure({
      organizationId,
      baseUnit,
      hasRow: false,
      recovered: Boolean(recovered),
      diagnosis,
    })

    if (recovered) return recovered

    if (diagnosis.kind === 'denied') {
      throw new InventoryError(
        'El permiso actual no permite crear insumos.',
        'CREATE_NOT_ALLOWED',
        403,
      )
    }
    if (diagnosis.kind === 'duplicate') {
      throw new InventoryError(
        'Ya existe un insumo con ese nombre en la organización.',
        'DUPLICATE_PRODUCT',
        409,
      )
    }
    if (diagnosis.kind === 'invalid') {
      throw new InventoryError(
        'Los datos del insumo no cumplen las reglas del catálogo.',
        'CREATE_INVALID',
        422,
      )
    }
    if (diagnosis.kind === 'empty_representation') {
      throw new InventoryError(
        'No se confirmó la creación del insumo. Recargá el catálogo.',
        'CREATE_UNCONFIRMED',
        500,
      )
    }
    throw new InventoryError('No se pudo crear el insumo.', 'CREATE_FAILED', 500)
  },
}

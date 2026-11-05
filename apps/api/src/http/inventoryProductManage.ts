import type { SupabaseClient } from '@supabase/supabase-js'
import { InventoryError } from './inventoryError.js'

export type InventoryProductUpdateInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  locationId: string
  inventoryProductId: string
  name?: string
  category?: string | null
  minimumStock?: number | null
  presentationUnit?: string | null
  conversionFactor?: number | null
  divisible?: boolean | null
  preferredSupplierId?: string | null
}

export type InventoryProductPresentationInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  locationId: string
  inventoryProductId: string
  presentationUnit: string | null
  conversionFactor: number | null
  divisible?: boolean | null
  reason: string
  confirmChange: boolean
}

export type InventoryProductDeleteInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  inventoryProductId: string
}

export type InventoryAdjustInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  locationId: string
  inventoryProductId: string
  quantityDelta: number
  reason: string
  idempotencyKey: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function mapRpcError(operation: string, error: { code?: string; message?: string; details?: string } | null): never {
  const blob = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
  if (/NOT_A_MEMBER|FORBIDDEN/i.test(blob)) {
    throw new InventoryError('No tenés autorización para modificar este insumo.', 'FORBIDDEN', 403)
  }
  if (/PRODUCT_NOT_FOUND|NOT_FOUND/i.test(blob)) {
    throw new InventoryError('No se encontró el insumo.', 'NOT_FOUND', 404)
  }
  if (/PRODUCT_IN_USE/i.test(blob)) {
    throw new InventoryError(
      'Este insumo está en recetas activas. Solo se puede dar de baja lógica, no borrarlo.',
      'PRODUCT_IN_USE',
      422,
    )
  }
  if (/PRODUCT_HAS_HISTORY|HAS_RECEIPTS|HAS_MOVEMENTS/i.test(blob)) {
    throw new InventoryError(
      'Este insumo tiene historial de compras o movimientos. Se da de baja sin borrar el historial.',
      'PRODUCT_HAS_HISTORY',
      422,
    )
  }
  if (/ADJUSTMENT_EXCEEDS_ON_HAND/i.test(blob)) {
    throw new InventoryError(
      'El ajuste dejaría el stock en negativo.',
      'ADJUSTMENT_EXCEEDS_ON_HAND',
      422,
    )
  }
  if (/IDEMPOTENCY_CONFLICT/i.test(blob)) {
    throw new InventoryError(
      'Esa operación ya se registró con otra cantidad. No se volvió a aplicar.',
      'IDEMPOTENCY_CONFLICT',
      409,
    )
  }
  if (/PRESENTATION_LOCKED/i.test(blob)) {
    throw new InventoryError(
      'La presentación tiene historial. Usá el cambio controlado de presentación (confirmación + motivo).',
      'PRESENTATION_LOCKED',
      409,
    )
  }
  if (/ORG_LOCATION_MISMATCH/i.test(blob)) {
    throw new InventoryError(
      'La ubicación no pertenece a esta organización.',
      'ORG_LOCATION_MISMATCH',
      422,
    )
  }
  if (/INVALID_PRESENTATION|INVALID_CONVERSION_FACTOR/i.test(blob)) {
    throw new InventoryError(
      'La presentación comercial no es coherente con la unidad base.',
      'INVALID_PRESENTATION',
      422,
    )
  }
  if (/CONFIRM_REQUIRED|REASON_REQUIRED/i.test(blob)) {
    throw new InventoryError(
      'El cambio de presentación requiere confirmación y un motivo.',
      'CONFIRM_REQUIRED',
      422,
    )
  }
  if (/function .* does not exist|PGRST202|404/i.test(blob)) {
    throw new InventoryError(
      'Esta operación todavía no está habilitada en la base. Falta aplicar el SQL propuesto.',
      'RPC_UNAVAILABLE',
      503,
    )
  }
  console.error(JSON.stringify({
    operation,
    code: error?.code ?? 'UNHANDLED',
    message: error?.message ?? null,
    details: error?.details ?? null,
  }))
  throw new InventoryError('No se pudo completar la operación de inventario.', 'INVENTORY_WRITE_FAILED', 500)
}

async function assertVisibleProduct(
  userClient: SupabaseClient,
  organizationId: string,
  inventoryProductId: string,
) {
  const { data, error } = await userClient
    .from('inventory_products')
    .select('id, organization_id, active, name')
    .eq('id', inventoryProductId)
    .maybeSingle()
  if (error) {
    throw new InventoryError('No se pudieron consultar los insumos.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || String(data.organization_id ?? '') !== organizationId) {
    throw new InventoryError('No se encontró el insumo.', 'NOT_FOUND', 404)
  }
  return {
    id: String(data.id),
    active: data.active !== false,
    name: asString(data.name) ?? 'Insumo',
  }
}

export async function updateInventoryProduct(input: InventoryProductUpdateInput) {
  if (!input.userId) throw new InventoryError('No autenticado.', 'UNAUTHENTICATED', 401)
  await assertVisibleProduct(input.userClient, input.organizationId, input.inventoryProductId)

  const payload: Record<string, unknown> = {
    actor_user_id: input.userId,
    organization_id: input.organizationId,
    location_id: input.locationId,
    inventory_product_id: input.inventoryProductId,
  }
  if (input.name != null) payload.name = input.name
  if (input.category !== undefined) payload.category = input.category
  if (input.minimumStock !== undefined) payload.minimum_stock = input.minimumStock
  if (input.presentationUnit !== undefined) payload.presentation_unit = input.presentationUnit
  if (input.conversionFactor !== undefined) payload.conversion_factor = input.conversionFactor
  if (input.divisible !== undefined) payload.divisible = input.divisible
  if (input.preferredSupplierId !== undefined) {
    payload.preferred_supplier_id = input.preferredSupplierId
  }

  const { data, error } = await input.adminClient.rpc('senda_update_inventory_product', {
    p: payload,
  })
  if (error) mapRpcError('senda_update_inventory_product', error)
  return data
}

/** Cambio controlado de presentación: no reinterpreta stock ni movimientos. */
export async function setInventoryProductPresentation(input: InventoryProductPresentationInput) {
  if (!input.userId) throw new InventoryError('No autenticado.', 'UNAUTHENTICATED', 401)
  await assertVisibleProduct(input.userClient, input.organizationId, input.inventoryProductId)

  const { data, error } = await input.adminClient.rpc('senda_set_inventory_product_presentation', {
    p: {
      actor_user_id: input.userId,
      organization_id: input.organizationId,
      location_id: input.locationId,
      inventory_product_id: input.inventoryProductId,
      presentation_unit: input.presentationUnit,
      conversion_factor: input.conversionFactor,
      divisible: input.divisible ?? null,
      reason: input.reason,
      confirm_change: input.confirmChange,
    },
  })
  if (error) mapRpcError('senda_set_inventory_product_presentation', error)
  return data
}

export async function deleteInventoryProduct(input: InventoryProductDeleteInput) {
  if (!input.userId) throw new InventoryError('No autenticado.', 'UNAUTHENTICATED', 401)
  const visible = await assertVisibleProduct(
    input.userClient,
    input.organizationId,
    input.inventoryProductId,
  )

  const { data: hard, error: hardError } = await input.adminClient.rpc('senda_delete_inventory_product', {
    p: {
      actor_user_id: input.userId,
      organization_id: input.organizationId,
      inventory_product_id: input.inventoryProductId,
    },
  })
  if (!hardError) {
    return { mode: 'hard' as const, data: hard }
  }

  const hardBlob = `${hardError.code ?? ''} ${hardError.message ?? ''} ${hardError.details ?? ''}`
  if (/PRODUCT_HAS_HISTORY|HAS_RECEIPTS|HAS_MOVEMENTS|PRODUCT_IN_USE/i.test(hardBlob)) {
    const { data: soft, error: softError } = await input.adminClient.rpc('senda_set_inventory_product_active', {
      p: {
        actor_user_id: input.userId,
        organization_id: input.organizationId,
        inventory_product_id: input.inventoryProductId,
        active: false,
        expected_active: visible.active,
      },
    })
    if (softError) mapRpcError('senda_set_inventory_product_active', softError)
    return { mode: 'soft' as const, data: soft }
  }

  mapRpcError('senda_delete_inventory_product', hardError)
}

export async function adjustInventoryQuantity(input: InventoryAdjustInput) {
  if (!input.userId) throw new InventoryError('No autenticado.', 'UNAUTHENTICATED', 401)
  await assertVisibleProduct(input.userClient, input.organizationId, input.inventoryProductId)

  const { data, error } = await input.adminClient.rpc('senda_adjust_inventory_quantity', {
    p: {
      actor_user_id: input.userId,
      organization_id: input.organizationId,
      location_id: input.locationId,
      inventory_product_id: input.inventoryProductId,
      quantity: input.quantityDelta,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
    },
  })
  if (error) mapRpcError('senda_adjust_inventory_quantity', error)
  return data
}

export type InventoryReactivateInput = {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  locationId?: string
  inventoryProductId: string
  category?: string | null
  minimumStock?: number | null
}

/** Reactiva un insumo dado de baja vía senda_set_inventory_product_active. */
export async function reactivateInventoryProduct(input: InventoryReactivateInput) {
  if (!input.userId) throw new InventoryError('No autenticado.', 'UNAUTHENTICATED', 401)
  const visible = await assertVisibleProduct(
    input.userClient,
    input.organizationId,
    input.inventoryProductId,
  )
  if (visible.active) {
    return {
      inventory_product_id: visible.id,
      active: true,
      replay: true,
      name: visible.name,
    }
  }

  const { data, error } = await input.adminClient.rpc('senda_set_inventory_product_active', {
    p: {
      actor_user_id: input.userId,
      organization_id: input.organizationId,
      inventory_product_id: input.inventoryProductId,
      active: true,
      expected_active: false,
    },
  })
  if (error) mapRpcError('senda_set_inventory_product_active', error)

  if (input.locationId && (input.category !== undefined || input.minimumStock !== undefined)) {
    await updateInventoryProduct({
      userClient: input.userClient,
      adminClient: input.adminClient,
      userId: input.userId,
      organizationId: input.organizationId,
      locationId: input.locationId,
      inventoryProductId: input.inventoryProductId,
      category: input.category,
      minimumStock: input.minimumStock,
    })
  }

  return isRecord(data)
    ? { ...data, name: visible.name }
    : {
        inventory_product_id: visible.id,
        active: true,
        replay: false,
        name: visible.name,
      }
}

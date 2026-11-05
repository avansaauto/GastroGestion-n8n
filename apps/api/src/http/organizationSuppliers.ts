import type { SupabaseClient } from '@supabase/supabase-js'
import { InventoryError } from './inventoryError.js'

export type OrganizationSupplier = {
  id: string
  organizationId: string
  name: string
  taxId: string | null
  source: 'suppliers' | 'invoice_issuer'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeSupplierName(name: string) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lista proveedores de la org + issuers de facturas aún no materializados en `suppliers`. */
export async function listOrganizationSuppliers(
  client: SupabaseClient,
  organizationId: string,
): Promise<OrganizationSupplier[]> {
  const { data: org, error: orgError } = await client
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .maybeSingle()
  if (orgError) {
    throw new InventoryError('No se pudieron consultar los proveedores.', 'LOOKUP_FAILED', 500)
  }
  if (!org) {
    throw new InventoryError('Organización no disponible.', 'NOT_FOUND', 404)
  }

  const byNorm = new Map<string, OrganizationSupplier>()

  const { data: supplierRows, error: supplierError } = await client
    .from('suppliers')
    .select('id, organization_id, name, tax_id, active')
    .eq('organization_id', organizationId)
    .order('name', { ascending: true })

  if (!supplierError && Array.isArray(supplierRows)) {
    for (const row of supplierRows) {
      if (!isRecord(row) || row.active === false) continue
      const name = asString(row.name)
      const id = asString(row.id)
      if (!name || !id) continue
      byNorm.set(normalizeSupplierName(name), {
        id,
        organizationId,
        name,
        taxId: asString(row.tax_id),
        source: 'suppliers',
      })
    }
  }

  const { data: locations } = await client
    .from('locations')
    .select('id')
    .eq('organization_id', organizationId)
  const locationIds = (Array.isArray(locations) ? locations : [])
    .map((row) => (isRecord(row) ? asString(row.id) : null))
    .filter((id): id is string => Boolean(id))

  if (locationIds.length > 0) {
    const { data: docs } = await client
      .from('purchase_documents')
      .select('issuer_name, issuer_tax_id_normalized, supplier_id')
      .in('location_id', locationIds)
      .is('deleted_at', null)

    for (const row of Array.isArray(docs) ? docs : []) {
      if (!isRecord(row)) continue
      const name = asString(row.issuer_name)
      if (!name) continue
      const norm = normalizeSupplierName(name)
      if (byNorm.has(norm)) continue
      const linkedId = asString(row.supplier_id)
      byNorm.set(norm, {
        id: linkedId ?? `issuer:${norm}`,
        organizationId,
        name,
        taxId: asString(row.issuer_tax_id_normalized),
        source: linkedId ? 'suppliers' : 'invoice_issuer',
      })
    }
  }

  return [...byNorm.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

/**
 * Asegura fila en `suppliers` (RPC propuesto) o insert JWT+RLS.
 * Acepta id real o issuer sintético `issuer:…` / nombre.
 */
export async function resolvePreferredSupplierId(input: {
  userClient: SupabaseClient
  adminClient: SupabaseClient | null
  userId: string
  organizationId: string
  preferredSupplierId?: string | null
  preferredSupplierName?: string | null
}): Promise<string | null> {
  const explicitId = input.preferredSupplierId?.trim() || null
  const name = input.preferredSupplierName?.trim() || null

  if (explicitId && !explicitId.startsWith('issuer:')) {
    const { data, error } = await input.userClient
      .from('suppliers')
      .select('id, organization_id, active')
      .eq('id', explicitId)
      .maybeSingle()
    if (error) {
      throw new InventoryError('No se pudo validar el proveedor.', 'LOOKUP_FAILED', 500)
    }
    if (!isRecord(data) || String(data.organization_id) !== input.organizationId || data.active === false) {
      throw new InventoryError('El proveedor no está disponible.', 'SUPPLIER_NOT_FOUND', 422)
    }
    return String(data.id)
  }

  let resolveName = name
  let taxId: string | null = null
  if (!resolveName && explicitId?.startsWith('issuer:')) {
    const listed = await listOrganizationSuppliers(input.userClient, input.organizationId)
    const match = listed.find((row) => row.id === explicitId)
    resolveName = match?.name ?? null
    taxId = match?.taxId ?? null
  }
  if (!resolveName) return null

  if (input.adminClient) {
    const { data, error } = await input.adminClient.rpc('senda_ensure_supplier_from_issuer', {
      p: {
        actor_user_id: input.userId,
        organization_id: input.organizationId,
        name: resolveName,
        tax_id: taxId,
      },
    })
    if (!error && isRecord(data) && asString(data.supplier_id)) {
      return String(data.supplier_id)
    }
    // RPC aún no aplicado: caer a insert JWT.
  }

  const { data: existing } = await input.userClient
    .from('suppliers')
    .select('id, name')
    .eq('organization_id', input.organizationId)
  const norm = normalizeSupplierName(resolveName)
  const found = (Array.isArray(existing) ? existing : [])
    .filter(isRecord)
    .find((row) => normalizeSupplierName(asString(row.name) ?? '') === norm)
  if (found?.id) return String(found.id)

  const { data: inserted, error: insertError } = await input.userClient
    .from('suppliers')
    .insert({
      organization_id: input.organizationId,
      name: resolveName,
      tax_id: taxId,
      active: true,
    })
    .select('id')
    .maybeSingle()
  if (insertError || !isRecord(inserted) || !inserted.id) {
    throw new InventoryError(
      'No se pudo registrar el proveedor. Aplicá el SQL propuesto o verificá permisos de suppliers.',
      'SUPPLIER_WRITE_FAILED',
      503,
    )
  }
  return String(inserted.id)
}

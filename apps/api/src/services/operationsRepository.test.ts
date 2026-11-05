import { describe, expect, it, vi } from 'vitest'
import { InventoryError } from '../http/inventoryError.js'
import { operationsRepository } from './operationsRepository.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const PRODUCT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_PRODUCT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LI_A = '11111111-aaaa-4111-8111-111111111111'
const LI_B = '22222222-bbbb-4222-8222-222222222222'

function thenable(result: { data: unknown; error: unknown }) {
  return {
    then(resolve: (value: { data: unknown; error: unknown }) => void) {
      resolve(result)
    },
  }
}

function filterable(
  rows: Record<string, unknown>[],
  error: { message?: string } | null = null,
) {
  let filtered = [...rows]
  const builder: Record<string, unknown> = {}
  const self = () => builder
  builder.select = self
  builder.order = self
  builder.eq = (column: string, value: string) => {
    filtered = filtered.filter((row) => String(row[column] ?? '') === value)
    return builder
  }
  builder.is = (column: string, value: null) => {
    filtered = filtered.filter((row) => (row[column] ?? null) === value)
    return builder
  }
  builder.in = (column: string, values: string[]) => {
    const allowed = new Set(values)
    filtered = filtered.filter((row) => allowed.has(String(row[column] ?? '')))
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
  organization?: Record<string, unknown> | null
  products?: Record<string, unknown>[]
  productsAfterInsert?: Record<string, unknown>[]
  insert?: Record<string, unknown> | null
  insertError?: { code?: string; message?: string; details?: string; hint?: string } | null
  locations?: Record<string, unknown>[]
  locationError?: { message?: string } | null
  locationInventory?: Record<string, unknown>[]
  locationInventoryError?: { message?: string } | null
  valuations?: Record<string, unknown>[]
  valuationsError?: { message?: string } | null
} = {}) {
  const tables: string[] = []
  const inserts: Record<string, unknown>[] = []
  let productListCalls = 0
  const from = vi.fn((table: string) => {
    tables.push(table)
    if (table === 'organizations') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: options.organization === undefined ? { id: ORG } : options.organization,
              error: null,
            }),
          }),
        }),
      }
    }
    if (table === 'inventory_products') {
      const builder: Record<string, unknown> = {}
      const self = () => builder
      builder.select = self
      builder.eq = self
      builder.order = self
      builder.ilike = self
      builder.insert = (payload: Record<string, unknown>) => {
        inserts.push(payload)
        return builder
      }
      builder.maybeSingle = async () => ({
        data: options.insert ?? null,
        error: options.insertError ?? null,
      })
      builder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => {
        productListCalls += 1
        const rows = productListCalls > 1 && options.productsAfterInsert
          ? options.productsAfterInsert
          : options.products ?? []
        resolve({ data: rows, error: null })
      }
      return builder
    }
    if (table === 'locations') {
      return filterable(
        options.locations ?? [{ id: LOC_A, organization_id: ORG }],
        options.locationError ?? null,
      )
    }
    if (table === 'location_inventory') {
      return filterable(options.locationInventory ?? [], options.locationInventoryError ?? null)
    }
    if (table === 'inventory_valuations') {
      return filterable(options.valuations ?? [], options.valuationsError ?? null)
    }
    if (table === 'inventory_movements') {
      throw new Error('inventory_movements no debe consultarse')
    }
    if (table === 'purchase_document_receipts' || table === 'purchase_documents') {
      return filterable([])
    }
    return {
      select: () => ({ eq: () => thenable({ data: null, error: { message: 'unexpected' } }) }),
    }
  })
  return { from, tables, inserts, client: { from } as never }
}

const pilsen = {
  id: PRODUCT,
  organization_id: ORG,
  name: 'Cerveza Pilsen',
  base_unit: 'ml',
  active: true,
}

describe('catálogo de insumos', () => {
  it('lista insumos de la organización e incluye active null', async () => {
    const db = client({
      products: [
        { id: PRODUCT, organization_id: ORG, name: 'Golden Ale', base_unit: 'l', active: null },
        { id: 'inactive', organization_id: ORG, name: 'Viejo', base_unit: 'kg', active: false },
        { id: 'foreign', organization_id: OTHER_ORG, name: 'Ajeno', base_unit: 'u', active: true },
      ],
    })
    const rows = await operationsRepository.listInventoryProducts(db.client, ORG)
    expect(rows).toEqual([
      {
        id: PRODUCT,
        organizationId: ORG,
        name: 'Golden Ale',
        baseUnit: 'l',
        active: true,
        onHand: null,
        averageUnitCost: null,
        minimumStock: null,
        category: null,
        supplierName: null,
      },
    ])
    expect(db.tables).not.toContain('inventory_movements')
  })

  it('no lista insumos si RLS oculta la organización', async () => {
    const db = client({ organization: null, products: [{ id: PRODUCT, organization_id: ORG, name: 'X' }] })
    await expect(operationsRepository.listInventoryProducts(db.client, ORG)).resolves.toBeNull()
    expect(db.from).not.toHaveBeenCalledWith('inventory_products')
  })

  it('crea un insumo con unidad base y rechaza duplicados evidentes', async () => {
    const existing = client({
      products: [{ id: PRODUCT, organization_id: ORG, name: 'Tomate', base_unit: 'kg', active: true }],
    })
    await expect(operationsRepository.createInventoryProduct(existing.client, ORG, {
      name: 'tomate',
      baseUnit: 'g',
    })).rejects.toMatchObject({ code: 'DUPLICATE_PRODUCT', status: 409 })
    expect(existing.inserts).toHaveLength(0)

    const created = client({
      products: [],
      insert: { id: PRODUCT, organization_id: ORG, name: 'Huevos', base_unit: 'unit', active: true },
    })
    const row = await operationsRepository.createInventoryProduct(created.client, ORG, {
      name: 'Huevos',
      baseUnit: 'unidades',
    })
    expect(row).toMatchObject({ name: 'Huevos', baseUnit: 'unit', active: true })
    expect(created.inserts[0]).toEqual({
      organization_id: ORG,
      name: 'Huevos',
      base_unit: 'unit',
      active: true,
    })
    expect(JSON.stringify(created.inserts)).not.toMatch(/inventory_movements|location_inventory/)
  })

  it('crea un insumo activo nuevo si el anterior está inactivo y no lo modifica', async () => {
    const createdId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const inactive = client({
      products: [{
        id: PRODUCT,
        organization_id: ORG,
        name: 'Carne picada',
        base_unit: 'g',
        active: false,
        category: 'Carnes',
      }],
      insert: {
        id: createdId,
        organization_id: ORG,
        name: 'carne picada',
        base_unit: 'g',
        active: true,
      },
    })
    const row = await operationsRepository.createInventoryProduct(inactive.client, ORG, {
      name: 'carne picada',
      baseUnit: 'g',
    })
    expect(row).toMatchObject({ id: createdId, active: true, name: 'carne picada' })
    expect(inactive.inserts).toEqual([{
      organization_id: ORG,
      name: 'carne picada',
      base_unit: 'g',
      active: true,
    }])
    expect(JSON.stringify(inactive.inserts)).not.toContain(PRODUCT)
  })

  it('trata como duplicado activo el mismo nombre con otra mayúscula, tilde o espacio', async () => {
    const existing = client({
      products: [{ id: PRODUCT, organization_id: ORG, name: 'Azúcar', base_unit: 'g', active: true }],
    })
    await expect(operationsRepository.createInventoryProduct(existing.client, ORG, {
      name: '  azucar  ',
      baseUnit: 'g',
    })).rejects.toMatchObject({ code: 'DUPLICATE_PRODUCT', status: 409 })
    expect(existing.inserts).toHaveLength(0)
  })

  it('inserta exactamente g, ml o unit y rechaza unidades incompatibles', async () => {
    const cases = [
      { input: 'g', stored: 'g', name: 'Azucar' },
      { input: 'ml', stored: 'ml', name: 'Leche' },
      { input: 'u', stored: 'unit', name: 'Huevos' },
    ] as const
    for (const item of cases) {
      const db = client({
        products: [],
        insert: {
          id: PRODUCT,
          organization_id: ORG,
          name: item.name,
          base_unit: item.stored,
          active: true,
        },
      })
      await operationsRepository.createInventoryProduct(db.client, ORG, {
        name: item.name,
        baseUnit: item.input,
      })
      expect(db.inserts[0].base_unit).toBe(item.stored)
      expect(['g', 'ml', 'unit']).toContain(db.inserts[0].base_unit)
    }

    await expect(operationsRepository.createInventoryProduct(client({ products: [] }).client, ORG, {
      name: 'Harina',
      baseUnit: 'kg',
    })).rejects.toMatchObject({ code: 'INVALID_BASE_UNIT', status: 422 })
  })

  it('no inserta si RLS oculta la organización', async () => {
    const db = client({ organization: null, products: [] })
    await expect(operationsRepository.createInventoryProduct(db.client, OTHER_ORG, {
      name: 'Harina',
      baseUnit: 'g',
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(db.inserts).toHaveLength(0)
  })

  it('no crea por service_role si GRANT o RLS bloquean el INSERT', async () => {
    const grant = client({
      products: [],
      insertError: { code: '42501', message: 'permission denied for table inventory_products' },
    })
    await expect(operationsRepository.createInventoryProduct(grant.client, ORG, {
      name: 'Harina',
      baseUnit: 'g',
    })).rejects.toBeInstanceOf(InventoryError)
    await expect(operationsRepository.createInventoryProduct(grant.client, ORG, {
      name: 'Harina',
      baseUnit: 'g',
    })).rejects.toMatchObject({ code: 'CREATE_NOT_ALLOWED', status: 403 })
    expect(grant.inserts[0]).toMatchObject({ organization_id: ORG })

    const rls = client({
      products: [],
      insertError: {
        code: '42501',
        message: 'new row violates row-level security policy for table "inventory_products"',
      },
    })
    await expect(operationsRepository.createInventoryProduct(rls.client, ORG, {
      name: 'Harina',
      baseUnit: 'g',
    })).rejects.toMatchObject({ code: 'CREATE_NOT_ALLOWED', status: 403 })
    expect(JSON.stringify(rls.inserts)).not.toMatch(/inventory_movements|service_role/)
  })

  it('lee quantity_on_hand del local y no suma filas duplicadas', async () => {
    const db = client({
      products: [
        pilsen,
        { id: OTHER_PRODUCT, organization_id: ORG, name: 'Harina', base_unit: 'g', active: true },
      ],
      locations: [
        { id: LOC_A, organization_id: ORG },
        { id: LOC_B, organization_id: ORG },
      ],
      locationInventory: [
        { id: LI_A, location_id: LOC_A, inventory_product_id: PRODUCT },
        { id: LI_B, location_id: LOC_B, inventory_product_id: PRODUCT },
      ],
      valuations: [
        { location_inventory_id: LI_A, quantity_on_hand: 50000, average_unit_cost: 1.65 },
        { location_inventory_id: LI_A, quantity_on_hand: 50000, average_unit_cost: 99 },
        { location_inventory_id: LI_B, quantity_on_hand: 8000, average_unit_cost: 2 },
      ],
    })
    const rows = await operationsRepository.listInventoryProducts(db.client, ORG, { locationId: LOC_A })
    expect(rows).toEqual([
      {
        id: PRODUCT,
        organizationId: ORG,
        name: 'Cerveza Pilsen',
        baseUnit: 'ml',
        active: true,
        onHand: 50000,
        averageUnitCost: 1.65,
        minimumStock: null,
        category: null,
        supplierName: null,
      },
      {
        id: OTHER_PRODUCT,
        organizationId: ORG,
        name: 'Harina',
        baseUnit: 'g',
        active: true,
        onHand: 0,
        averageUnitCost: null,
        minimumStock: null,
        category: null,
        supplierName: null,
      },
    ])
    expect(db.from.mock.calls.filter((call) => call[0] === 'location_inventory')).toHaveLength(1)
    expect(db.from.mock.calls.filter((call) => call[0] === 'inventory_valuations')).toHaveLength(1)
    expect(db.tables).not.toContain('inventory_movements')
  })

  it('mantiene existencias independientes por local', async () => {
    const shared = {
      products: [pilsen],
      locations: [
        { id: LOC_A, organization_id: ORG },
        { id: LOC_B, organization_id: ORG },
      ],
      locationInventory: [
        { id: LI_A, location_id: LOC_A, inventory_product_id: PRODUCT },
        { id: LI_B, location_id: LOC_B, inventory_product_id: PRODUCT },
      ],
      valuations: [
        { location_inventory_id: LI_A, quantity_on_hand: 50000 },
        { location_inventory_id: LI_B, quantity_on_hand: 12000 },
      ],
    }
    const localA = await operationsRepository.listInventoryProducts(client(shared).client, ORG, {
      locationId: LOC_A,
    })
    const localB = await operationsRepository.listInventoryProducts(client(shared).client, ORG, {
      locationId: LOC_B,
    })
    expect(localA?.[0]?.onHand).toBe(50000)
    expect(localB?.[0]?.onHand).toBe(12000)
    expect(localA?.[0]?.averageUnitCost).toBeNull()
    expect(localB?.[0]?.averageUnitCost).toBeNull()
  })

  it('no convierte un error de existencias en cero', async () => {
    const failed = client({
      products: [pilsen],
      locations: [{ id: LOC_A, organization_id: ORG }],
      locationInventory: [{ id: LI_A, location_id: LOC_A, inventory_product_id: PRODUCT }],
      valuationsError: { message: 'permission denied for table inventory_valuations' },
    })
    await expect(operationsRepository.listInventoryProducts(failed.client, ORG, {
      locationId: LOC_A,
    })).rejects.toMatchObject({ code: 'LOOKUP_FAILED', status: 500 })

    const missingLocation = client({
      products: [pilsen],
      locations: [],
    })
    await expect(operationsRepository.listInventoryProducts(missingLocation.client, ORG, {
      locationId: LOC_A,
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('recupera el insumo si INSERT persistió y .select() no devolvió fila', async () => {
    const created = {
      id: PRODUCT,
      organization_id: ORG,
      name: 'Harina',
      base_unit: 'kg',
      active: true,
    }
    const db = client({
      products: [],
      productsAfterInsert: [created],
      insertError: { code: 'PGRST116', message: 'The result contains 0 rows' },
    })
    const row = await operationsRepository.createInventoryProduct(db.client, ORG, {
      name: 'Harina',
      baseUnit: 'g',
    })
    expect(row).toMatchObject({ id: PRODUCT, name: 'Harina', baseUnit: 'kg' })
    expect(db.inserts).toHaveLength(1)
  })

  it('distingue validación, duplicado de Postgres y representación vacía sin fila', async () => {
    const invalid = client({
      products: [],
      insertError: { code: '23514', message: 'new row for relation "inventory_products" violates check constraint' },
    })
    await expect(operationsRepository.createInventoryProduct(invalid.client, ORG, {
      name: 'Harina',
      baseUnit: 'g',
    })).rejects.toMatchObject({ code: 'CREATE_INVALID', status: 422 })

    const duplicate = client({
      products: [],
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })
    await expect(operationsRepository.createInventoryProduct(duplicate.client, ORG, {
      name: 'Harina',
      baseUnit: 'g',
    })).rejects.toMatchObject({ code: 'DUPLICATE_PRODUCT', status: 409 })

    const empty = client({
      products: [],
      productsAfterInsert: [],
      insertError: { code: 'PGRST116', message: 'The result contains 0 rows' },
    })
    await expect(operationsRepository.createInventoryProduct(empty.client, ORG, {
      name: 'Harina',
      baseUnit: 'g',
    })).rejects.toMatchObject({ code: 'CREATE_UNCONFIRMED', status: 500 })
  })
})

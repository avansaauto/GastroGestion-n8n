import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { listCatalogMappingMemories, listCatalogProducts, listInvoiceProducts, mapInvoiceLine } from './invoiceMap.js'

const DOC = 'fe8b3702-dea1-4e89-b86c-76ae42d700fc'
const LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_LINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PRODUCT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FOREIGN_PRODUCT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const USER = 'user-map-1'

const inventoriableLine = {
  id: LINE,
  purchase_document_id: DOC,
  source_line_id: 'line-1',
  original_quantity: 10,
  original_unit: 'L',
  original_amount: 500,
  reviewed_quantity: 10,
  reviewed_unit: 'L',
  reviewed_amount: 500,
  classification: 'stock',
  inventory_eligibility: 'eligible',
  mapping_status: 'unmapped',
  quantity_kind: 'inventory',
}

function thenable(result: { data: unknown; error: unknown }) {
  return {
    then(resolve: (value: { data: unknown; error: unknown }) => void) {
      resolve(result)
    },
  }
}

function clients(options: {
  invoice?: Record<string, unknown> | null
  location?: Record<string, unknown> | null
  line?: Record<string, unknown> | null
  product?: Record<string, unknown> | null
  products?: Record<string, unknown>[]
  documents?: Record<string, unknown>[]
  mappedLines?: Record<string, unknown>[]
  unmapped?: Record<string, unknown>[]
  rpcError?: { code?: string; message?: string; details?: string } | null
}) {
  const filters: Array<{ table: string; op: string; args: unknown[] }> = []
  const from = vi.fn((table: string) => {
    if (table === 'locations') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: options.location ?? null, error: null }),
          }),
        }),
      }
    }
    if (table === 'purchase_documents') {
      const docChain: Record<string, unknown> = {}
      docChain.select = () => docChain
      docChain.eq = (...args: unknown[]) => {
        filters.push({ table: 'purchase_documents', op: 'eq', args })
        return docChain
      }
      docChain.is = () => docChain
      docChain.neq = () => thenable({ data: options.documents ?? [], error: null })
      docChain.maybeSingle = async () => ({ data: options.invoice ?? null, error: null })
      return docChain
    }
    if (table === 'purchase_document_lines') {
      return {
        select: () => ({
          eq: (column: string) => {
            if (column === 'purchase_document_id') {
              return {
                eq: () => thenable({ data: options.unmapped ?? [], error: null }),
              }
            }
            if (column === 'mapping_status') {
              return {
                in: () => thenable({ data: options.mappedLines ?? [], error: null }),
              }
            }
            return {
              maybeSingle: async () => ({ data: options.line ?? null, error: null }),
            }
          },
        }),
      }
    }
    if (table === 'inventory_products') {
      const result = options.products
        ? { data: options.products, error: null }
        : { data: options.product ?? null, error: null }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                ilike: () => thenable(result),
                then: thenable(result).then,
              }),
              maybeSingle: async () => result,
            }),
            maybeSingle: async () => result,
            order: () => thenable(result),
            ilike: () => thenable(result),
            then: thenable(result).then,
          }),
        }),
      }
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'unexpected' } }) }) }),
    }
  })
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: null,
    error: options.rpcError ?? null,
  }))
  return {
    from,
    rpc,
    filters,
    user: { from } as unknown as SupabaseClient,
    admin: { rpc } as unknown as SupabaseClient,
  }
}

const invoice = {
  id: DOC,
  status: 'reviewed',
  location_id: 'loc-1',
  organization_id: 'org-1',
}

const product = {
  id: PRODUCT,
  organization_id: 'org-1',
  name: 'Cerveza Pilsen',
  base_unit: 'L',
  active: true,
}

describe('listInvoiceProducts', () => {
  it('no lista productos si RLS oculta la factura de otra organización', async () => {
    const db = clients({ invoice: null, products: [product] })
    await expect(listInvoiceProducts({
      userClient: db.user,
      documentId: DOC,
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(db.from).not.toHaveBeenCalledWith('inventory_products')
  })

  it('lista productos activos de la organización de la factura', async () => {
    const db = clients({
      invoice,
      products: [
        product,
        { ...product, id: FOREIGN_PRODUCT, organization_id: 'org-2' },
        { ...product, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Tomate', base_unit: 'kg', active: null },
        { ...product, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Inactivo', active: false },
      ],
    })
    const items = await listInvoiceProducts({ userClient: db.user, documentId: DOC })
    expect(items).toEqual([
      {
        id: PRODUCT,
        name: 'Cerveza Pilsen',
        baseUnit: 'L',
        organizationId: 'org-1',
        active: true,
      },
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        name: 'Tomate',
        baseUnit: 'kg',
        organizationId: 'org-1',
        active: true,
      },
    ])
  })

  it('devuelve catálogo vacío cuando no hay insumos de la organización', async () => {
    const db = clients({ invoice, products: [] })
    await expect(listInvoiceProducts({ userClient: db.user, documentId: DOC })).resolves.toEqual([])
  })
})

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const location = { id: LOC, organization_id: 'org-1' }

describe('listCatalogProducts', () => {
  it('no lista insumos si RLS oculta el local de otra organización', async () => {
    const db = clients({ location: null, products: [product] })
    await expect(listCatalogProducts({
      userClient: db.user,
      locationId: LOC,
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(db.from).not.toHaveBeenCalledWith('inventory_products')
  })

  it('lista productos activos de la organización del local', async () => {
    const db = clients({
      location,
      products: [
        product,
        { ...product, id: FOREIGN_PRODUCT, organization_id: 'org-2' },
        { ...product, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Inactivo', active: false },
      ],
    })
    const items = await listCatalogProducts({ userClient: db.user, locationId: LOC })
    expect(items.map((item) => item.id)).toEqual([PRODUCT])
    expect(items[0]?.organizationId).toBe('org-1')
    expect(db.admin.rpc).not.toHaveBeenCalled()
  })
})

describe('listCatalogMappingMemories', () => {
  it('normaliza el CUIT y no usa service_role', async () => {
    const db = clients({
      location,
      documents: [],
    })
    await expect(listCatalogMappingMemories({
      userClient: db.user,
      locationId: LOC,
      issuerTaxId: '30-71234567-9',
    })).resolves.toEqual([])
    expect(db.admin.rpc).not.toHaveBeenCalled()
    expect(db.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['organization_id', 'org-1'],
    })
    expect(db.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['issuer_tax_id_normalized', '30712345679'],
    })
  })

  it('no lee memorias si RLS oculta el local de otra organización', async () => {
    const db = clients({ location: null, documents: [] })
    await expect(listCatalogMappingMemories({
      userClient: db.user,
      locationId: LOC,
      issuerTaxId: '30712345679',
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(db.from).not.toHaveBeenCalledWith('purchase_documents')
    expect(db.admin.rpc).not.toHaveBeenCalled()
  })
})

describe('mapInvoiceLine', () => {
  it('vincula mercadería vía RPC con el actor del JWT y no mueve stock', async () => {
    const db = clients({
      invoice,
      line: inventoriableLine,
      product,
      unmapped: [{ id: 'other-unmapped' }],
    })
    const result = await mapInvoiceLine({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })
    expect(result).toMatchObject({
      id: LINE,
      mappingStatus: 'mapped',
      inventoryProductId: PRODUCT,
      inventoryPhysicalQuantity: 10,
      unmappedLineCount: 1,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_map_purchase_document_line', {
      p_line_id: LINE,
      p_inventory_product_id: PRODUCT,
      p_inventory_physical_quantity: 10,
      p_actor_user_id: USER,
    })
    expect(JSON.stringify(db.rpc.mock.calls[0][1])).not.toMatch(/inventory_movements|organizationId|org-2/)
  })

  it('rechaza una línea que no pertenece a la factura', async () => {
    const db = clients({
      invoice,
      line: { ...inventoriableLine, id: OTHER_LINE, purchase_document_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      product,
    })
    await expect(mapInvoiceLine({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      lineId: OTHER_LINE,
      inventoryProductId: PRODUCT,
    })).rejects.toMatchObject({ code: 'LINE_NOT_FOUND', status: 404 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('rechaza un producto inexistente o de otra organización', async () => {
    const missing = clients({ invoice, line: inventoriableLine, product: null })
    await expect(mapInvoiceLine({
      userClient: missing.user,
      adminClient: missing.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', status: 422 })

    const foreign = clients({
      invoice,
      line: inventoriableLine,
      product: { ...product, organization_id: 'org-2' },
    })
    await expect(mapInvoiceLine({
      userClient: foreign.user,
      adminClient: foreign.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: FOREIGN_PRODUCT,
    })).rejects.toMatchObject({ code: 'PRODUCT_OUT_OF_SCOPE', status: 422 })
    expect(missing.rpc).not.toHaveBeenCalled()
    expect(foreign.rpc).not.toHaveBeenCalled()
  })

  it('excluye líneas fiscales y descuentos negativos', async () => {
    const fiscal = clients({
      invoice,
      line: { ...inventoriableLine, classification: 'fiscal', inventory_eligibility: 'ineligible', mapping_status: 'not_applicable' },
      product,
    })
    await expect(mapInvoiceLine({
      userClient: fiscal.user,
      adminClient: fiscal.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })).rejects.toMatchObject({ code: 'LINE_NOT_INVENTORIABLE', status: 422 })

    const discount = clients({
      invoice,
      line: { ...inventoriableLine, original_amount: -82500, reviewed_amount: -82500 },
      product,
    })
    await expect(mapInvoiceLine({
      userClient: discount.user,
      adminClient: discount.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })).rejects.toMatchObject({ code: 'LINE_NOT_INVENTORIABLE', status: 422 })
    expect(fiscal.rpc).not.toHaveBeenCalled()
    expect(discount.rpc).not.toHaveBeenCalled()
  })

  it('rechaza cantidad o conversión inválida', async () => {
    const noQty = clients({
      invoice,
      line: { ...inventoriableLine, original_quantity: null, reviewed_quantity: null },
      product,
    })
    await expect(mapInvoiceLine({
      userClient: noQty.user,
      adminClient: noQty.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })).rejects.toMatchObject({ code: 'INVALID_QUANTITY', status: 422 })

    const boxes = clients({
      invoice,
      line: { ...inventoriableLine, original_unit: 'caja', reviewed_unit: 'caja' },
      product,
    })
    await expect(mapInvoiceLine({
      userClient: boxes.user,
      adminClient: boxes.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })).rejects.toMatchObject({ code: 'EQUIVALENCE_REQUIRED', status: 422 })
    expect(noQty.rpc).not.toHaveBeenCalled()
    expect(boxes.rpc).not.toHaveBeenCalled()
  })

  it('convierte litros a mililitros sin factor del cliente', async () => {
    const db = clients({
      invoice,
      line: { ...inventoriableLine, original_quantity: 50, reviewed_quantity: 50 },
      product: { ...product, base_unit: 'ml' },
      unmapped: [],
    })
    const result = await mapInvoiceLine({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })
    expect(result.inventoryPhysicalQuantity).toBe(50000)
    expect(db.rpc.mock.calls[0][1]).toMatchObject({
      p_inventory_physical_quantity: 50000,
      p_actor_user_id: USER,
    })
  })

  it('convierte kilogramos a gramos y cantidades decimales', async () => {
    const kg = clients({
      invoice,
      line: {
        ...inventoriableLine,
        original_quantity: 8,
        reviewed_quantity: 8,
        original_unit: 'kg',
        reviewed_unit: 'kg',
      },
      product: { ...product, name: 'Harina', base_unit: 'g' },
      unmapped: [],
    })
    await expect(mapInvoiceLine({
      userClient: kg.user,
      adminClient: kg.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })).resolves.toMatchObject({ inventoryPhysicalQuantity: 8000 })

    const decimalLiters = clients({
      invoice,
      line: { ...inventoriableLine, original_quantity: 1.5, reviewed_quantity: 1.5 },
      product: { ...product, base_unit: 'ml' },
      unmapped: [],
    })
    await expect(mapInvoiceLine({
      userClient: decimalLiters.user,
      adminClient: decimalLiters.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })).resolves.toMatchObject({ inventoryPhysicalQuantity: 1500 })
  })

  it('rechaza un factor SI incorrecto y acepta factor manual de empaque', async () => {
    const liters = clients({
      invoice,
      line: inventoriableLine,
      product: { ...product, base_unit: 'ml' },
    })
    await expect(mapInvoiceLine({
      userClient: liters.user,
      adminClient: liters.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
      conversionFactor: 1,
    })).rejects.toMatchObject({ code: 'INVALID_CONVERSION', status: 422 })
    expect(liters.rpc).not.toHaveBeenCalled()

    const boxes = clients({
      invoice,
      line: {
        ...inventoriableLine,
        original_unit: 'caja',
        reviewed_unit: 'caja',
        original_quantity: 2,
        reviewed_quantity: 2,
      },
      product: { ...product, name: 'Tomate', base_unit: 'g' },
      unmapped: [],
    })
    await expect(mapInvoiceLine({
      userClient: boxes.user,
      adminClient: boxes.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
      conversionFactor: 8000,
    })).resolves.toMatchObject({ inventoryPhysicalQuantity: 16000 })
    expect(boxes.rpc).toHaveBeenCalled()
  })

  it('no convierte unidades incompatibles', async () => {
    const db = clients({
      invoice,
      line: inventoriableLine,
      product: { ...product, name: 'Harina', base_unit: 'g' },
    })
    await expect(mapInvoiceLine({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })).rejects.toMatchObject({ code: 'INCOMPATIBLE_UNITS', status: 422 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('no reescribe una línea ya recibida', async () => {
    const db = clients({
      invoice,
      line: { ...inventoriableLine, mapping_status: 'mapped' },
      product: { ...product, base_unit: 'ml' },
      rpcError: { message: 'LINE_HAS_RECEIPTS' },
    })
    await expect(mapInvoiceLine({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      lineId: LINE,
      inventoryProductId: PRODUCT,
    })).rejects.toMatchObject({ code: 'LINE_HAS_RECEIPTS', status: 422 })
  })
})

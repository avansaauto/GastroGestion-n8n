import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  assertInvoiceDocumentId,
  getSavedInvoice,
  getSavedInvoiceFile,
  isPurchaseDocumentsDeletedAtMissing,
  listPendingReceptions,
  listSavedInvoices,
  lookupDuplicateInvoice,
} from './invoiceQuery.js'
import { InvoiceQueryError } from './invoiceQueryError.js'

const OWN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOREIGN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NOW = new Date('2026-10-14T18:00:00.000Z')

const reviewedAnalysis = {
  document: {
    amounts: { total: 1500.5 },
    header: { currency: 'ARS' },
  },
  metadata: {
    fileSha256: 'abc',
    integrityToken: 'secret-token',
    snapshotSha256: 'snap',
    integrityExpiresAt: '2099-01-01T00:00:00.000Z',
  },
}

const originalAnalysis = {
  document: {
    amounts: { total: 1490 },
    header: { type: 'Factura A', currency: 'ARS' },
  },
  metadata: {
    integrityToken: 'original-token',
  },
}

function chain(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {}
  const self = () => builder
  builder.select = self
  builder.eq = self
  builder.neq = self
  builder.is = self
  builder.in = self
  builder.order = self
  builder.maybeSingle = async () => {
    const rows = Array.isArray(result.data) ? result.data : result.data
    if (Array.isArray(rows)) {
      return { data: rows[0] ?? null, error: result.error }
    }
    return { data: rows ?? null, error: result.error }
  }
  builder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => resolve(result)
  return builder
}

function userClient(options: {
  list?: Record<string, unknown>[]
  document?: Record<string, unknown> | null
  lines?: Record<string, unknown>[]
  products?: Record<string, unknown>[]
  receipts?: Record<string, unknown>[]
  receiptsError?: unknown
  linesError?: unknown
  listError?: unknown
  documentError?: unknown
  location?: Record<string, unknown> | null
  locationError?: unknown
}) {
  const eqs: Array<{ table: string; column: string; value: unknown }> = []
  function tracked(table: string, builder: Record<string, unknown>) {
    const originalEq = builder.eq as () => typeof builder
    builder.eq = (column: string, value: unknown) => {
      eqs.push({ table, column, value })
      return originalEq()
    }
    return builder
  }
  const from = vi.fn((table: string) => {
    if (table === 'inventory_movements' || table === 'inventory_valuations') {
      throw new Error(`${table} no debe consultarse`)
    }
    if (table === 'locations') {
      return tracked(table, chain({
        data: Object.prototype.hasOwnProperty.call(options, 'location')
          ? options.location
          : { id: LOC_ID, organization_id: 'org-1' },
        error: options.locationError ?? null,
      }))
    }
    if (table === 'purchase_documents') {
      if (options.list || options.listError) {
        return tracked(table, chain({ data: options.list ?? [], error: options.listError ?? null }))
      }
      return tracked(table, chain({ data: options.document ?? null, error: options.documentError ?? null }))
    }
    if (table === 'purchase_document_lines') {
      return tracked(table, chain({ data: options.lines ?? [], error: options.linesError ?? null }))
    }
    if (table === 'purchase_document_receipts') {
      return tracked(table, chain({ data: options.receipts ?? [], error: options.receiptsError ?? null }))
    }
    if (table === 'inventory_products') {
      return tracked(table, chain({
        data: options.products ?? [],
        error: null,
      }))
    }
    return tracked(table, chain({ data: null, error: { message: 'unexpected table' } }))
  })
  return { from, eqs, client: { from } as unknown as SupabaseClient }
}

function adminClient(signedUrl = 'https://storage.example/sign/invoice-documents/path.pdf?token=short') {
  const createSignedUrl = vi.fn(async () => ({ data: { signedUrl }, error: null }))
  return {
    createSignedUrl,
    client: {
      storage: { from: () => ({ createSignedUrl }) },
    } as unknown as SupabaseClient,
  }
}

describe('consulta de facturas guardadas', () => {
  it('lista solo filas visibles por el cliente JWT y extrae el total revisado', async () => {
    const user = userClient({
      list: [{
        id: OWN_ID,
        issuer_name: 'LUPULO SRL',
        document_date: '2026-10-01',
        document_number: '0001-00006046',
        document_type: 'invoice',
        status: 'reviewed',
        currency: 'ARS',
        location_id: LOC_ID,
        organization_id: 'org-1',
        reviewed_analysis: reviewedAnalysis,
      }],
    })
    const items = await listSavedInvoices({ userClient: user.client, locationId: LOC_ID })
    expect(items).toEqual([{
      id: OWN_ID,
      supplierName: 'LUPULO SRL',
      documentDate: '2026-10-01',
      documentNumber: '0001-00006046',
      documentType: 'invoice',
      status: 'reviewed',
      currency: 'ARS',
      total: 1500.5,
      locationId: LOC_ID,
      organizationId: 'org-1',
      pendingConfiguration: false,
      pendingReceive: false,
      hasReceipts: false,
    }])
    expect(user.from).toHaveBeenCalledWith('locations')
    expect(user.from).toHaveBeenCalledWith('purchase_documents')
    expect(user.from).toHaveBeenCalledWith('purchase_document_lines')
    expect(user.from).toHaveBeenCalledWith('purchase_document_receipts')
    expect(user.from.mock.calls.filter((call) => call[0] === 'purchase_document_lines')).toHaveLength(1)
    expect(user.from.mock.calls.filter((call) => call[0] === 'purchase_document_receipts')).toHaveLength(1)
    expect(user.from).not.toHaveBeenCalledWith('inventory_movements')
  })

  it('exige un local visible y filtra el listado por location_id', async () => {
    const user = userClient({ list: [] })
    await expect(listSavedInvoices({ userClient: user.client, locationId: LOC_ID })).resolves.toEqual([])
    expect(user.from).toHaveBeenCalledWith('locations')
    expect(user.from).toHaveBeenCalledWith('purchase_documents')
    expect(user.eqs).toContainEqual({ table: 'locations', column: 'id', value: LOC_ID })
    expect(user.eqs).toContainEqual({ table: 'purchase_documents', column: 'location_id', value: LOC_ID })
  })

  it('reintenta el listado sin deleted_at si la columna aún no existe', async () => {
    let documentCalls = 0
    const eqs: Array<{ table: string; column: string; value: unknown }> = []
    const listRow = {
      id: OWN_ID,
      issuer_name: 'LUPULO SRL',
      document_date: '2026-10-01',
      document_number: '0001-00006046',
      document_type: 'invoice',
      status: 'reviewed',
      currency: 'ARS',
      location_id: LOC_ID,
      organization_id: 'org-1',
      reviewed_analysis: reviewedAnalysis,
    }
    const from = vi.fn((table: string) => {
      if (table === 'locations') {
        return chain({ data: { id: LOC_ID, organization_id: 'org-1' }, error: null })
      }
      if (table === 'purchase_documents') {
        documentCalls += 1
        const builder = chain(
          documentCalls === 1
            ? {
              data: null,
              error: {
                code: 'PGRST204',
                message: "Could not find the 'deleted_at' column of 'purchase_documents' in the schema cache",
              },
            }
            : {
              data: [listRow],
              error: null,
            },
        )
        const originalEq = builder.eq as (column: string, value: unknown) => typeof builder
        builder.eq = (column: string, value: unknown) => {
          eqs.push({ table, column, value })
          return originalEq(column, value)
        }
        return builder
      }
      if (table === 'purchase_document_lines') {
        return chain({ data: [], error: null })
      }
      if (table === 'purchase_document_receipts') {
        return chain({ data: [], error: null })
      }
      return chain({ data: null, error: { message: 'unexpected' } })
    })
    const items = await listSavedInvoices({
      userClient: { from } as unknown as SupabaseClient,
      locationId: LOC_ID,
    })
    expect(documentCalls).toBe(2)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(OWN_ID)
    expect(eqs).toContainEqual({ table: 'purchase_documents', column: 'location_id', value: LOC_ID })
  })

  it('no oculta errores de listado distintos a deleted_at ausente', async () => {
    const user = userClient({
      listError: { code: '42501', message: 'permission denied for table purchase_documents' },
    })
    await expect(listSavedInvoices({ userClient: user.client, locationId: LOC_ID })).rejects.toMatchObject({
      code: 'LOOKUP_FAILED',
      status: 500,
    })
  })

  it('detecta errores de esquema por deleted_at ausente', () => {
    expect(isPurchaseDocumentsDeletedAtMissing({
      code: 'PGRST204',
      message: "Could not find the 'deleted_at' column of 'purchase_documents'",
    })).toBe(true)
    expect(isPurchaseDocumentsDeletedAtMissing({
      code: '42703',
      message: 'column purchase_documents.deleted_at does not exist',
    })).toBe(true)
    expect(isPurchaseDocumentsDeletedAtMissing({
      code: '42501',
      message: 'permission denied for table purchase_documents',
    })).toBe(false)
  })

  it('rechaza un locationId inválido antes de consultar facturas', async () => {
    const user = userClient({ list: [{ id: OWN_ID }] })
    await expect(listSavedInvoices({
      userClient: user.client,
      locationId: 'loc-1',
    })).rejects.toMatchObject({ code: 'LOCATION_ID_INVALID', status: 400 })
    expect(user.from).not.toHaveBeenCalled()
  })

  it('no lista facturas si el local no es visible por JWT', async () => {
    const user = userClient({ list: [{ id: OWN_ID, location_id: LOC_ID }], location: null })
    await expect(listSavedInvoices({
      userClient: user.client,
      locationId: LOC_ID,
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(user.from).toHaveBeenCalledWith('locations')
    expect(user.from).not.toHaveBeenCalledWith('purchase_documents')
  })

  it('devuelve 404 y no firma URL si RLS oculta el documento de otra organización', async () => {
    const user = userClient({ document: null })
    const admin = adminClient()
    await expect(getSavedInvoice({
      userClient: user.client,
      adminClient: admin.client,
      id: FOREIGN_ID,
      now: NOW,
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(admin.createSignedUrl).not.toHaveBeenCalled()
  })

  it('separa análisis original y revisado, y firma el PDF solo después de ver la fila', async () => {
    const user = userClient({
      document: {
        id: OWN_ID,
        status: 'reviewed',
        location_id: 'loc-1',
        organization_id: 'org-1',
        currency: 'ARS',
        issuer_name: 'LUPULO SRL',
        issuer_tax_id_normalized: '30712345679',
        document_number: '0001-00006046',
        document_date: '2026-10-01',
        document_type: 'invoice',
        classification: 'gastronomic_merchandise',
        eligible_line_count: 8,
        unmapped_line_count: 8,
        original_analysis: originalAnalysis,
        reviewed_analysis: reviewedAnalysis,
        corrections: { header: { number: '0001-00006046' } },
        commercial_decisions: [{ relationId: 'relation-1', decision: 'confirm' }],
        fiscal_difference_accepted: false,
        storage_object_path: 'org-1/invoices/abc.pdf',
        file_sha256: 'abc',
      },
      lines: [{
        source_line_id: 'line-1',
        source_index: 0,
        original_description: 'PILSEN',
        original_quantity: 50,
        original_unit: 'L',
        original_unit_price: 10,
        original_amount: 500,
        reviewed_description: 'PILSEN',
        reviewed_quantity: 50,
        reviewed_unit: 'L',
        reviewed_unit_price: 10,
        reviewed_amount: 500,
        classification: 'stock',
        inventory_eligibility: 'eligible',
        mapping_status: 'unmapped',
        quantity_kind: 'inventory',
      }],
    })
    const admin = adminClient()
    const detail = await getSavedInvoice({
      userClient: user.client,
      adminClient: admin.client,
      id: OWN_ID,
      now: NOW,
    })

    expect(detail.originalAnalysis).toMatchObject({
      document: { amounts: { total: 1490 } },
    })
    expect(detail.reviewedAnalysis).toMatchObject({
      document: { amounts: { total: 1500.5 } },
    })
    expect(JSON.stringify(detail)).not.toMatch(/secret-token|original-token|integrityToken/)
    expect(detail.lines[0].original.description).toBe('PILSEN')
    expect(detail.lines[0].reviewed.description).toBe('PILSEN')
    expect(detail.file).toEqual({
      url: 'https://storage.example/sign/invoice-documents/path.pdf?token=short',
      expiresAt: '2026-10-14T18:02:00.000Z',
      expiresInSeconds: 120,
      contentType: 'application/pdf',
    })
    expect(JSON.stringify(detail)).not.toMatch(/storage_object_path|service_role|org-1\/invoices\/abc/)
    expect(admin.createSignedUrl).toHaveBeenCalledWith('org-1/invoices/abc.pdf', 120)
  })

  it('no firma el archivo de otra organización', async () => {
    const user = userClient({ document: null })
    const admin = adminClient()
    await expect(getSavedInvoiceFile({
      userClient: user.client,
      adminClient: admin.client,
      id: FOREIGN_ID,
      now: NOW,
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(admin.createSignedUrl).not.toHaveBeenCalled()
  })

  it('rechaza un id que no es UUID', () => {
    expect(() => assertInvoiceDocumentId('nueva')).toThrow(InvoiceQueryError)
    expect(() => assertInvoiceDocumentId('nueva')).toThrow(/identificador/i)
  })

  it('recupera la vinculación persistida al volver a abrir la factura', async () => {
    const user = userClient({
      document: {
        id: OWN_ID,
        status: 'reviewed',
        location_id: 'loc-1',
        organization_id: 'org-1',
        currency: 'ARS',
        issuer_name: 'LUPULO SRL',
        unmapped_line_count: 7,
        original_analysis: originalAnalysis,
        reviewed_analysis: reviewedAnalysis,
        storage_object_path: 'org-1/invoices/abc.pdf',
      },
      lines: [{
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        source_line_id: 'line-1',
        original_description: 'PILSEN',
        original_quantity: 50,
        original_unit: 'L',
        original_amount: 500,
        reviewed_description: 'PILSEN',
        reviewed_quantity: 50,
        reviewed_unit: 'L',
        reviewed_amount: 500,
        classification: 'stock',
        inventory_eligibility: 'eligible',
        mapping_status: 'mapped',
        quantity_kind: 'inventory',
        inventory_physical_quantity: 50,
        inventory_product_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      }],
      products: [{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        name: 'Cerveza Pilsen',
        base_unit: 'L',
      }],
    })
    const detail = await getSavedInvoice({
      userClient: user.client,
      adminClient: adminClient().client,
      id: OWN_ID,
      now: NOW,
    })
    expect(detail.lines[0]).toMatchObject({
      mappingStatus: 'mapped',
      inventoryProductId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      inventoryPhysicalQuantity: 50,
      inventoryProduct: { name: 'Cerveza Pilsen', baseUnit: 'L' },
    })
    expect(detail.unmappedLineCount).toBe(7)
  })

  it('propone una coincidencia exacta confirmada del mismo CUIT y no consulta movimientos', async () => {
    const PRODUCT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    let documentCalls = 0
    let lineCalls = 0
    const from = vi.fn((table: string) => {
      if (table === 'inventory_movements' || table === 'location_inventory' || table === 'inventory_valuations') {
        throw new Error(`${table} no debe consultarse`)
      }
      if (table === 'purchase_document_receipts') {
        return chain({ data: [], error: null })
      }
      if (table === 'purchase_documents') {
        documentCalls += 1
        if (documentCalls === 1) {
          return chain({
            data: {
              id: OWN_ID,
              status: 'reviewed',
              location_id: 'loc-1',
              organization_id: 'org-1',
              issuer_name: 'LUPULO SRL',
              issuer_tax_id_normalized: '30712345679',
              original_analysis: originalAnalysis,
              reviewed_analysis: reviewedAnalysis,
            },
            error: null,
          })
        }
        return chain({ data: [{ id: OWN_ID }, { id: FOREIGN_ID }], error: null })
      }
      if (table === 'purchase_document_lines') {
        lineCalls += 1
        if (lineCalls === 1) {
          return chain({
            data: [{
              id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              source_line_id: 'line-1',
              original_description: 'PILSEN',
              reviewed_description: 'PILSEN',
              original_quantity: 50,
              reviewed_quantity: 50,
              original_unit: 'L',
              reviewed_unit: 'L',
              original_amount: 500,
              reviewed_amount: 500,
              classification: 'stock',
              inventory_eligibility: 'eligible',
              mapping_status: 'unmapped',
              quantity_kind: 'inventory',
              inventory_physical_quantity: 0,
              inventory_product_id: null,
            }],
            error: null,
          })
        }
        return chain({
          data: [{
            mapping_status: 'mapped',
            original_description: 'PILSEN',
            reviewed_description: 'PILSEN',
            original_quantity: 50,
            reviewed_quantity: 50,
            inventory_physical_quantity: 50,
            inventory_product_id: PRODUCT,
          }],
          error: null,
        })
      }
      if (table === 'inventory_products') {
        return chain({
          data: [{ id: PRODUCT, name: 'Cerveza Pilsen', base_unit: 'l' }],
          error: null,
        })
      }
      return chain({ data: null, error: { message: 'unexpected table' } })
    })

    const detail = await getSavedInvoice({
      userClient: { from } as unknown as SupabaseClient,
      adminClient: null,
      id: OWN_ID,
      now: NOW,
    })
    expect(detail.lines[0].mappingSuggestion).toMatchObject({
      kind: 'exact',
      inventoryProductId: PRODUCT,
      inventoryProduct: { name: 'Cerveza Pilsen', baseUnit: 'l' },
      source: 'confirmed_mapping',
    })
    expect(detail.lines[0].mappingStatus).toBe('unmapped')
    expect(from).not.toHaveBeenCalledWith('inventory_movements')
  })

  it('no propone memoria si el CUIT no está validado', async () => {
    const user = userClient({
      document: {
        id: OWN_ID,
        status: 'reviewed',
        location_id: 'loc-1',
        organization_id: 'org-1',
        issuer_tax_id_normalized: null,
        original_analysis: originalAnalysis,
        reviewed_analysis: reviewedAnalysis,
      },
      lines: [{
        original_description: 'PILSEN',
        reviewed_description: 'PILSEN',
        classification: 'stock',
        inventory_eligibility: 'eligible',
        mapping_status: 'unmapped',
      }],
    })
    const detail = await getSavedInvoice({
      userClient: user.client,
      adminClient: null,
      id: OWN_ID,
      now: NOW,
    })
    expect(detail.lines[0].mappingSuggestion).toBeNull()
  })

  const STOCK_LINE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const PRODUCT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  function detailDocument() {
    return {
      id: OWN_ID,
      status: 'reviewed',
      location_id: 'loc-1',
      organization_id: 'org-1',
      currency: 'ARS',
      issuer_name: 'LUPULO SRL',
      issuer_tax_id_normalized: null,
      original_analysis: originalAnalysis,
      reviewed_analysis: reviewedAnalysis,
      unmapped_line_count: 0,
    }
  }

  function mappedStockLine(overrides: Record<string, unknown> = {}) {
    return {
      id: STOCK_LINE,
      source_line_id: 'line-1',
      original_description: 'PILSEN',
      original_quantity: 50,
      original_unit: 'L',
      original_amount: 500,
      reviewed_description: 'PILSEN',
      reviewed_quantity: 50,
      reviewed_unit: 'L',
      reviewed_amount: 500,
      classification: 'stock',
      inventory_eligibility: 'eligible',
      mapping_status: 'mapped',
      quantity_kind: 'inventory',
      inventory_physical_quantity: 100000,
      inventory_product_id: PRODUCT,
      ...overrides,
    }
  }

  it('devuelve recibida cero y pendiente igual a la física si no hay recepciones', async () => {
    const user = userClient({
      document: detailDocument(),
      lines: [mappedStockLine()],
      products: [{ id: PRODUCT, name: 'Cerveza Pilsen', base_unit: 'ml' }],
      receipts: [],
    })
    const detail = await getSavedInvoice({
      userClient: user.client,
      adminClient: null,
      id: OWN_ID,
      now: NOW,
    })
    expect(detail.lines[0]).toMatchObject({
      mappingStatus: 'mapped',
      inventoryPhysicalQuantity: 100000,
      invoicedQuantity: 100000,
      receivedQuantity: 0,
      remainingQuantity: 100000,
      configurationStatus: null,
    })
    expect(user.from).toHaveBeenCalledWith('purchase_document_receipts')
    expect(user.from).not.toHaveBeenCalledWith('inventory_movements')
  })

  it('calcula el pendiente de una recepción parcial', async () => {
    const user = userClient({
      document: detailDocument(),
      lines: [mappedStockLine()],
      products: [{ id: PRODUCT, name: 'Cerveza Pilsen', base_unit: 'ml' }],
      receipts: [{ purchase_document_line_id: STOCK_LINE, quantity: 40000 }],
    })
    const detail = await getSavedInvoice({
      userClient: user.client,
      adminClient: null,
      id: OWN_ID,
      now: NOW,
    })
    expect(detail.lines[0]).toMatchObject({
      invoicedQuantity: 100000,
      receivedQuantity: 40000,
      remainingQuantity: 60000,
      configurationStatus: null,
    })
  })

  it('suma varias recepciones de la misma línea', async () => {
    const user = userClient({
      document: detailDocument(),
      lines: [mappedStockLine()],
      products: [{ id: PRODUCT, name: 'Cerveza Pilsen', base_unit: 'ml' }],
      receipts: [
        { purchase_document_line_id: STOCK_LINE, quantity: 25000 },
        { purchase_document_line_id: STOCK_LINE, quantity: 15000 },
      ],
    })
    const detail = await getSavedInvoice({
      userClient: user.client,
      adminClient: null,
      id: OWN_ID,
      now: NOW,
    })
    expect(detail.lines[0].receivedQuantity).toBe(40000)
    expect(detail.lines[0].remainingQuantity).toBe(60000)
  })

  it('marca una línea inventariable sin mapear como configuración pendiente', async () => {
    const user = userClient({
      document: { ...detailDocument(), unmapped_line_count: 1 },
      lines: [mappedStockLine({
        mapping_status: 'unmapped',
        inventory_physical_quantity: 0,
        inventory_product_id: null,
      })],
      receipts: [],
    })
    const detail = await getSavedInvoice({
      userClient: user.client,
      adminClient: null,
      id: OWN_ID,
      now: NOW,
    })
    expect(detail.lines[0]).toMatchObject({
      mappingStatus: 'unmapped',
      inventoryPhysicalQuantity: 0,
      invoicedQuantity: 0,
      receivedQuantity: 0,
      remainingQuantity: null,
      configurationStatus: 'pending_configuration',
    })
    expect(detail.lines[0].remainingQuantity).not.toBe(0)
  })

  it('excluye conceptos fiscales del cálculo de recepción', async () => {
    const user = userClient({
      document: detailDocument(),
      lines: [
        mappedStockLine(),
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          source_line_id: 'line-iva',
          original_description: 'IVA',
          original_amount: 105,
          reviewed_amount: 105,
          classification: 'fiscal',
          inventory_eligibility: 'ineligible',
          mapping_status: 'not_applicable',
          quantity_kind: 'none',
          inventory_physical_quantity: 0,
          inventory_product_id: null,
        },
      ],
      products: [{ id: PRODUCT, name: 'Cerveza Pilsen', base_unit: 'ml' }],
      receipts: [{ purchase_document_line_id: STOCK_LINE, quantity: 10000 }],
    })
    const detail = await getSavedInvoice({
      userClient: user.client,
      adminClient: null,
      id: OWN_ID,
      now: NOW,
    })
    expect(detail.lines[0]).toMatchObject({
      receivedQuantity: 10000,
      remainingQuantity: 90000,
    })
    expect(detail.lines[1]).toMatchObject({
      classification: 'fiscal',
      invoicedQuantity: null,
      receivedQuantity: null,
      remainingQuantity: null,
      configurationStatus: null,
    })
  })

  it('no inventa ceros si falla la consulta de recibos', async () => {
    const user = userClient({
      document: detailDocument(),
      lines: [mappedStockLine()],
      receiptsError: { message: 'permission denied for table purchase_document_receipts' },
    })
    await expect(getSavedInvoice({
      userClient: user.client,
      adminClient: null,
      id: OWN_ID,
      now: NOW,
    })).rejects.toMatchObject({
      code: 'LOOKUP_FAILED',
      status: 500,
      message: 'No se pudieron consultar las recepciones.',
    })
  })

  it('conserva los campos existentes del GET al agregar recepción', async () => {
    const user = userClient({
      document: {
        ...detailDocument(),
        document_number: '0001-00006046',
        document_date: '2026-10-01',
        document_type: 'invoice',
        classification: 'gastronomic_merchandise',
        eligible_line_count: 1,
        unmapped_line_count: 0,
        corrections: { header: { number: '0001-00006046' } },
        commercial_decisions: [{ relationId: 'relation-1', decision: 'confirm' }],
        fiscal_difference_accepted: false,
      },
      lines: [mappedStockLine()],
      products: [{ id: PRODUCT, name: 'Cerveza Pilsen', base_unit: 'ml' }],
    })
    const detail = await getSavedInvoice({
      userClient: user.client,
      adminClient: null,
      id: OWN_ID,
      now: NOW,
    })
    expect(detail).toMatchObject({
      id: OWN_ID,
      status: 'reviewed',
      locationId: 'loc-1',
      organizationId: 'org-1',
      supplierName: 'LUPULO SRL',
      documentNumber: '0001-00006046',
      eligibleLineCount: 1,
      unmappedLineCount: 0,
    })
    expect(detail.lines[0]).toMatchObject({
      sourceLineId: 'line-1',
      mappingStatus: 'mapped',
      inventoryPhysicalQuantity: 100000,
      inventoryProductId: PRODUCT,
      original: { description: 'PILSEN', quantity: 50, amount: 500 },
      reviewed: { description: 'PILSEN', quantity: 50, amount: 500 },
    })
  })
})

describe('resumen de listado para filtros de recepción', () => {
  const SECOND_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const UNMAPPED_LINE = '11111111-1111-4111-8111-111111111111'
  const MAPPED_LINE = '22222222-2222-4222-8222-222222222222'
  const FISCAL_LINE = '33333333-3333-4333-8333-333333333333'
  const PRODUCT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  function listDoc(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      issuer_name: 'LUPULO SRL',
      document_date: '2026-10-01',
      document_number: '0001-00006046',
      document_type: 'invoice',
      status: 'reviewed',
      currency: 'ARS',
      location_id: LOC_ID,
      organization_id: 'org-1',
      reviewed_analysis: reviewedAnalysis,
      ...overrides,
    }
  }

  function stockLine(overrides: Record<string, unknown> = {}) {
    return {
      id: MAPPED_LINE,
      purchase_document_id: OWN_ID,
      classification: 'stock',
      inventory_eligibility: 'eligible',
      mapping_status: 'mapped',
      quantity_kind: 'inventory',
      inventory_physical_quantity: 100000,
      inventory_product_id: PRODUCT,
      original_amount: 500,
      reviewed_amount: 500,
      ...overrides,
    }
  }

  it('no consulta líneas ni recepciones si no hay facturas visibles', async () => {
    const user = userClient({ list: [] })
    await expect(listSavedInvoices({ userClient: user.client, locationId: LOC_ID })).resolves.toEqual([])
    expect(user.from).toHaveBeenCalledWith('purchase_documents')
    expect(user.from).not.toHaveBeenCalledWith('purchase_document_lines')
    expect(user.from).not.toHaveBeenCalledWith('purchase_document_receipts')
  })

  it('marca una factura completamente sin mapear como pendiente de configuración, no de recepción', async () => {
    const user = userClient({
      list: [listDoc(OWN_ID)],
      lines: [stockLine({
        id: UNMAPPED_LINE,
        mapping_status: 'unmapped',
        inventory_physical_quantity: 0,
        inventory_product_id: null,
      })],
      receipts: [],
    })
    const [item] = await listSavedInvoices({ userClient: user.client, locationId: LOC_ID })
    expect(item).toMatchObject({
      status: 'reviewed',
      pendingConfiguration: true,
      pendingReceive: false,
      hasReceipts: false,
    })
  })

  it('marca una factura mapeada sin recepciones como pendiente de recibir', async () => {
    const user = userClient({
      list: [listDoc(OWN_ID)],
      lines: [stockLine()],
      receipts: [],
    })
    const [item] = await listSavedInvoices({ userClient: user.client, locationId: LOC_ID })
    expect(item).toMatchObject({
      status: 'reviewed',
      pendingConfiguration: false,
      pendingReceive: true,
      hasReceipts: false,
    })
  })

  it('marca una recepción parcial como pendiente de recibir', async () => {
    const user = userClient({
      list: [listDoc(OWN_ID)],
      lines: [stockLine()],
      receipts: [{ purchase_document_line_id: MAPPED_LINE, quantity: 40000 }],
    })
    const [item] = await listSavedInvoices({ userClient: user.client, locationId: LOC_ID })
    expect(item).toMatchObject({
      pendingConfiguration: false,
      pendingReceive: true,
      hasReceipts: true,
    })
  })

  it('permite pendientes de vinculación y recepción a la vez', async () => {
    const user = userClient({
      list: [listDoc(OWN_ID)],
      lines: [
        stockLine(),
        stockLine({
          id: UNMAPPED_LINE,
          mapping_status: 'unmapped',
          inventory_physical_quantity: 0,
          inventory_product_id: null,
        }),
      ],
      receipts: [{ purchase_document_line_id: MAPPED_LINE, quantity: 10000 }],
    })
    const [item] = await listSavedInvoices({ userClient: user.client, locationId: LOC_ID })
    expect(item).toMatchObject({
      pendingConfiguration: true,
      pendingReceive: true,
    })
  })

  it('marca una factura received completa sin pendientes de recepción', async () => {
    const user = userClient({
      list: [listDoc(OWN_ID, { status: 'received' })],
      lines: [stockLine()],
      receipts: [{ purchase_document_line_id: MAPPED_LINE, quantity: 100000 }],
    })
    const [item] = await listSavedInvoices({ userClient: user.client, locationId: LOC_ID })
    expect(item).toMatchObject({
      status: 'received',
      pendingConfiguration: false,
      pendingReceive: false,
      hasReceipts: true,
    })
  })

  it('no trata reviewed como pendiente de recibir si no hay saldo mapeado', async () => {
    const user = userClient({
      list: [listDoc(OWN_ID, { status: 'reviewed' })],
      lines: [stockLine({
        mapping_status: 'unmapped',
        inventory_physical_quantity: 0,
        inventory_product_id: null,
      })],
      receipts: [],
    })
    const [item] = await listSavedInvoices({ userClient: user.client, locationId: LOC_ID })
    expect(item?.status).toBe('reviewed')
    expect(item?.pendingReceive).toBe(false)
    expect(item?.pendingConfiguration).toBe(true)
  })

  it('excluye conceptos fiscales del resumen', async () => {
    const user = userClient({
      list: [listDoc(OWN_ID)],
      lines: [
        stockLine(),
        stockLine({
          id: FISCAL_LINE,
          classification: 'fiscal',
          inventory_eligibility: 'ineligible',
          mapping_status: 'not_applicable',
          quantity_kind: 'none',
          inventory_physical_quantity: 0,
          inventory_product_id: null,
          original_amount: 105,
          reviewed_amount: 105,
        }),
      ],
      receipts: [{ purchase_document_line_id: MAPPED_LINE, quantity: 100000 }],
    })
    const [item] = await listSavedInvoices({ userClient: user.client, locationId: LOC_ID })
    expect(item).toMatchObject({
      pendingConfiguration: false,
      pendingReceive: false,
    })
  })

  it('no inventa ceros si falla la consulta de recepciones del listado', async () => {
    const user = userClient({
      list: [listDoc(OWN_ID)],
      lines: [stockLine()],
      receiptsError: { message: 'permission denied for table purchase_document_receipts' },
    })
    await expect(listSavedInvoices({ userClient: user.client, locationId: LOC_ID })).rejects.toMatchObject({
      code: 'LOOKUP_FAILED',
      status: 500,
      message: 'No se pudieron consultar las recepciones.',
    })
  })

  it('consulta líneas y recepciones en lote, no por factura', async () => {
    const user = userClient({
      list: [listDoc(OWN_ID), listDoc(SECOND_ID, { document_number: '0001-00006047' })],
      lines: [
        stockLine({ purchase_document_id: OWN_ID }),
        stockLine({
          id: UNMAPPED_LINE,
          purchase_document_id: SECOND_ID,
          mapping_status: 'unmapped',
          inventory_physical_quantity: 0,
          inventory_product_id: null,
        }),
      ],
      receipts: [{ purchase_document_line_id: MAPPED_LINE, quantity: 0 }],
    })
    const items = await listSavedInvoices({ userClient: user.client, locationId: LOC_ID })
    expect(items).toHaveLength(2)
    expect(user.from.mock.calls.filter((call) => call[0] === 'purchase_document_lines')).toHaveLength(1)
    expect(user.from.mock.calls.filter((call) => call[0] === 'purchase_document_receipts')).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: OWN_ID, pendingReceive: true, pendingConfiguration: false })
    expect(items[1]).toMatchObject({ id: SECOND_ID, pendingConfiguration: true, pendingReceive: false })
  })
})

const ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const FILE_HASH = 'ab'.repeat(32)

function lookupClient(options: {
  location?: { id: string; organization_id: string } | null
  locationError?: unknown
  document?: Record<string, unknown> | null
  documentError?: unknown
  deletedDocument?: Record<string, unknown> | null
}) {
  const filters: Array<{ table: string; op: string; args: unknown[] }> = []
  const from = vi.fn((table: string) => {
    if (table === 'inventory_movements' || table === 'inventory_valuations' || table === 'purchase_document_lines') {
      throw new Error(`${table} no debe consultarse`)
    }
    const result = table === 'locations'
      ? { data: options.location === undefined
        ? { id: LOC_ID, organization_id: ORG_ID }
        : options.location, error: options.locationError ?? null }
      : { data: options.document ?? null, error: options.documentError ?? null }
    const builder: Record<string, unknown> = {}
    const rec = (op: string) => (...args: unknown[]) => {
      filters.push({ table, op, args })
      return builder
    }
    builder.select = rec('select')
    builder.eq = rec('eq')
    builder.neq = rec('neq')
    builder.is = rec('is')
    builder.order = rec('order')
    builder.limit = rec('limit')
    let deletedQuery = false
    builder.not = (...args: unknown[]) => {
      filters.push({ table, op: 'not', args })
      deletedQuery = true
      return builder
    }
    builder.maybeSingle = async () => {
      if (table === 'purchase_documents' && deletedQuery && options.deletedDocument !== undefined) {
        return { data: options.deletedDocument, error: null }
      }
      return result
    }
    return builder
  })
  return { from, filters, client: { from } as unknown as SupabaseClient }
}

function duplicateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OWN_ID,
    issuer_name: 'LUPULO SRL',
    document_number: '00007-00006046',
    document_date: '2026-10-01',
    status: 'reviewed',
    location_id: LOC_ID,
    organization_id: ORG_ID,
    file_sha256: FILE_HASH,
    storage_object_path: 'org/invoices/secret.pdf',
    original_analysis: { metadata: { integrityToken: 'secret' } },
    ...overrides,
  }
}

describe('lookupDuplicateInvoice', () => {
  it('encuentra por hash y responde el payload mínimo', async () => {
    const user = lookupClient({ document: duplicateRow() })
    const match = await lookupDuplicateInvoice({
      userClient: user.client,
      locationId: LOC_ID,
      fileSha256: FILE_HASH.toUpperCase(),
    })
    expect(match).toEqual({
      id: OWN_ID,
      supplierName: 'LUPULO SRL',
      documentNumber: '00007-00006046',
      documentDate: '2026-10-01',
      status: 'reviewed',
      locationId: LOC_ID,
    })
    expect(Object.keys(match ?? {})).toEqual([
      'id',
      'supplierName',
      'documentNumber',
      'documentDate',
      'status',
      'locationId',
    ])
    expect(JSON.stringify(match)).not.toMatch(/file_sha256|storage_object_path|integrityToken|organizationId|original_analysis/i)
    expect(user.from).toHaveBeenCalledWith('locations')
    expect(user.from).toHaveBeenCalledWith('purchase_documents')
    expect(user.from).not.toHaveBeenCalledWith('purchase_document_lines')
    expect(user.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['organization_id', ORG_ID],
    })
    expect(user.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['file_sha256', FILE_HASH],
    })
    expect(user.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'neq',
      args: ['status', 'cancelled'],
    })
    expect(user.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'is',
      args: ['deleted_at', null],
    })
    const selected = user.filters.find((filter) => filter.table === 'purchase_documents' && filter.op === 'select')
    expect(String(selected?.args[0])).not.toMatch(/file_sha256|storage_object_path|original_analysis|reviewed_analysis/)
  })

  it('informa una factura eliminada sin tratarla como comprobante activo', async () => {
    const user = lookupClient({
      document: null,
      deletedDocument: duplicateRow({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'reviewed' }),
    })
    const match = await lookupDuplicateInvoice({
      userClient: user.client,
      locationId: LOC_ID,
      fileSha256: FILE_HASH,
    })
    expect(match).toMatchObject({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      disposition: 'deleted',
    })
    expect(user.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'not',
      args: ['deleted_at', 'is', null],
    })
  })

  it('encuentra por identidad fiscal completa', async () => {
    const user = lookupClient({ document: duplicateRow() })
    const match = await lookupDuplicateInvoice({
      userClient: user.client,
      locationId: LOC_ID,
      issuerTaxId: '30-71432940-1',
      voucherType: 'Factura A',
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })
    expect(match?.id).toBe(OWN_ID)
    expect(user.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['issuer_tax_id_normalized', '30714329401'],
    })
    expect(user.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['voucher_type', 'A'],
    })
    expect(user.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['point_of_sale', '00007'],
    })
    expect(user.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['voucher_number', '00006046'],
    })
  })

  it('distingue punto de venta de cuatro y cinco dígitos', async () => {
    const four = lookupClient({ document: duplicateRow({ document_number: '0007-00006046' }) })
    await lookupDuplicateInvoice({
      userClient: four.client,
      locationId: LOC_ID,
      issuerTaxId: '30714329401',
      voucherType: 'A',
      pointOfSale: '0007',
      voucherNumber: '00006046',
    })
    expect(four.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['point_of_sale', '0007'],
    })
    expect(four.filters).not.toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['point_of_sale', '00007'],
    })

    const five = lookupClient({ document: null })
    const missing = await lookupDuplicateInvoice({
      userClient: five.client,
      locationId: LOC_ID,
      issuerTaxId: '30714329401',
      voucherType: 'A',
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })
    expect(five.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'eq',
      args: ['point_of_sale', '00007'],
    })
    expect(missing).toBeNull()
  })

  it('devuelve null si el documento no es visible', async () => {
    const user = lookupClient({ document: null })
    await expect(lookupDuplicateInvoice({
      userClient: user.client,
      locationId: LOC_ID,
      fileSha256: FILE_HASH,
    })).resolves.toBeNull()
  })

  it('excluye documentos cancelados', async () => {
    const hidden = lookupClient({ document: null })
    await expect(lookupDuplicateInvoice({
      userClient: hidden.client,
      locationId: LOC_ID,
      fileSha256: FILE_HASH,
    })).resolves.toBeNull()
    expect(hidden.filters).toContainEqual({
      table: 'purchase_documents',
      op: 'neq',
      args: ['status', 'cancelled'],
    })

    const leaked = lookupClient({ document: duplicateRow({ status: 'cancelled' }) })
    await expect(lookupDuplicateInvoice({
      userClient: leaked.client,
      locationId: LOC_ID,
      fileSha256: FILE_HASH,
    })).resolves.toBeNull()
  })

  it('rechaza un hash inválido sin consultar documentos', async () => {
    const user = lookupClient({})
    await expect(lookupDuplicateInvoice({
      userClient: user.client,
      locationId: LOC_ID,
      fileSha256: 'abc',
    })).rejects.toMatchObject({ code: 'HASH_INVALID', status: 400 })
    expect(user.from).not.toHaveBeenCalled()
  })

  it('rechaza una identidad fiscal incompleta', async () => {
    const user = lookupClient({})
    await expect(lookupDuplicateInvoice({
      userClient: user.client,
      locationId: LOC_ID,
      issuerTaxId: '30-71432940-1',
      voucherType: 'A',
    })).rejects.toMatchObject({ code: 'IDENTITY_INCOMPLETE', status: 400 })
    expect(user.from).not.toHaveBeenCalled()
  })

  it('rechaza un local no autorizado antes de buscar el documento', async () => {
    const user = lookupClient({ location: null })
    await expect(lookupDuplicateInvoice({
      userClient: user.client,
      locationId: LOC_ID,
      fileSha256: FILE_HASH,
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(user.from).toHaveBeenCalledWith('locations')
    expect(user.from).not.toHaveBeenCalledWith('purchase_documents')
  })

  it('no revela un documento de otra organización', async () => {
    const hidden = lookupClient({ document: null })
    await expect(lookupDuplicateInvoice({
      userClient: hidden.client,
      locationId: LOC_ID,
      fileSha256: FILE_HASH,
    })).resolves.toBeNull()

    const leaked = lookupClient({
      document: duplicateRow({ organization_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
    })
    await expect(lookupDuplicateInvoice({
      userClient: leaked.client,
      locationId: LOC_ID,
      fileSha256: FILE_HASH,
    })).resolves.toBeNull()
  })
})

const PENDING_LINE_A = '11111111-1111-4111-8111-111111111111'
const PENDING_LINE_B = '22222222-2222-4222-8222-222222222222'
const PENDING_LINE_C = '33333333-3333-4333-8333-333333333333'
const PENDING_PRODUCT = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const OTHER_LOCATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function pendingLine(overrides: Record<string, unknown> = {}) {
  return {
    id: PENDING_LINE_A,
    purchase_document_id: OWN_ID,
    classification: 'stock',
    inventory_eligibility: 'eligible',
    mapping_status: 'mapped',
    quantity_kind: 'inventory',
    inventory_physical_quantity: 100000,
    inventory_product_id: PENDING_PRODUCT,
    original_amount: 82500,
    reviewed_amount: 82500,
    purchase_documents: {
      id: OWN_ID,
      location_id: LOC_ID,
      status: 'reviewed',
      issuer_name: 'LUPULO SRL',
      document_number: '0001-00006046',
      document_date: '2026-10-01',
    },
    ...overrides,
  }
}

function pendingReceptionClient(options: {
  location?: { id: string; organization_id: string } | null
  lines?: Record<string, unknown>[]
  receipts?: Record<string, unknown>[]
  products?: Record<string, unknown>[]
}) {
  const from = vi.fn((table: string) => {
    if (table === 'inventory_movements' || table === 'inventory_valuations' || table === 'purchase_documents') {
      throw new Error(`${table} no debe consultarse`)
    }
    const filters: Array<{ op: string; args: unknown[] }> = []
    const builder: Record<string, unknown> = {}
    const rec = (op: string) => (...args: unknown[]) => {
      filters.push({ op, args })
      return builder
    }
    builder.select = rec('select')
    builder.eq = rec('eq')
    builder.neq = rec('neq')
    builder.is = rec('is')
    builder.gt = rec('gt')
    builder.in = rec('in')
    builder.not = rec('not')
    builder.order = rec('order')
    builder.limit = rec('limit')
    builder.maybeSingle = async () => ({
      data: options.location === undefined
        ? { id: LOC_ID, organization_id: ORG_ID }
        : options.location,
      error: null,
    })
    builder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => {
      if (table === 'purchase_document_receipts') {
        resolve({ data: options.receipts ?? [], error: null })
        return
      }
      if (table === 'inventory_products') {
        resolve({
          data: options.products ?? [{
            id: PENDING_PRODUCT,
            name: 'Cerveza Pilsen',
            base_unit: 'ml',
          }],
          error: null,
        })
        return
      }
      let rows = [...(options.lines ?? [])]
      for (const filter of filters) {
        if (filter.op === 'eq' && filter.args[0] === 'purchase_documents.location_id') {
          rows = rows.filter((row) => {
            const document = row.purchase_documents as { location_id?: string } | undefined
            return document?.location_id === filter.args[1]
          })
        }
        if (filter.op === 'neq' && filter.args[0] === 'purchase_documents.status') {
          rows = rows.filter((row) => {
            const document = row.purchase_documents as { status?: string } | undefined
            return document?.status !== filter.args[1]
          })
        }
        if (filter.op === 'is' && filter.args[0] === 'purchase_documents.deleted_at') {
          rows = rows.filter((row) => {
            const document = row.purchase_documents as { deleted_at?: string | null } | undefined
            return document?.deleted_at == null
          })
        }
        if (filter.op === 'eq' && filter.args[0] === 'mapping_status') {
          rows = rows.filter((row) => row.mapping_status === filter.args[1])
        }
        if (filter.op === 'gt' && filter.args[0] === 'id') {
          rows = rows.filter((row) => String(row.id) > String(filter.args[1]))
        }
      }
      rows.sort((left, right) => String(left.id).localeCompare(String(right.id)))
      const limit = filters.find((filter) => filter.op === 'limit')
      if (limit) rows = rows.slice(0, Number(limit.args[0]))
      resolve({ data: rows, error: null })
    }
    return builder
  })
  return { from, client: { from } as unknown as SupabaseClient }
}

describe('GET pending-receptions (consulta)', () => {
  it('rechaza un local no autorizado sin leer líneas ni recepciones', async () => {
    const user = pendingReceptionClient({ location: null })
    await expect(listPendingReceptions({
      userClient: user.client,
      locationId: LOC_ID,
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(user.from).toHaveBeenCalledWith('locations')
    expect(user.from).not.toHaveBeenCalledWith('purchase_document_lines')
    expect(user.from).not.toHaveBeenCalledWith('purchase_document_receipts')
  })

  it('calcula 50.000 ml pendientes con recepciones parciales acumuladas', async () => {
    const user = pendingReceptionClient({
      lines: [pendingLine()],
      receipts: [
        { purchase_document_line_id: PENDING_LINE_A, quantity: 30000 },
        { purchase_document_line_id: PENDING_LINE_A, quantity: 20000 },
      ],
    })
    const page = await listPendingReceptions({
      userClient: user.client,
      locationId: LOC_ID,
    })
    expect(page.items).toEqual([{
      invoiceId: OWN_ID,
      lineId: PENDING_LINE_A,
      supplierName: 'LUPULO SRL',
      documentNumber: '0001-00006046',
      documentDate: '2026-10-01',
      locationId: LOC_ID,
      ingredientId: PENDING_PRODUCT,
      ingredientName: 'Cerveza Pilsen',
      baseUnit: 'ml',
      invoicedQuantity: 100000,
      receivedQuantity: 50000,
      remainingQuantity: 50000,
    }])
    expect(user.from).toHaveBeenCalledWith('purchase_document_lines')
    expect(user.from).toHaveBeenCalledWith('purchase_document_receipts')
    expect(user.from).not.toHaveBeenCalledWith('purchase_documents')
    expect(user.from).not.toHaveBeenCalledWith('inventory_movements')
  })

  it('excluye canceladas, ajustes, impuestos, sin insumo y recepción completa', async () => {
    const user = pendingReceptionClient({
      lines: [
        pendingLine({
          id: PENDING_LINE_A,
          purchase_documents: {
            id: OWN_ID,
            location_id: LOC_ID,
            status: 'cancelled',
            issuer_name: 'LUPULO SRL',
            document_number: '0001-00006046',
            document_date: '2026-10-01',
          },
        }),
        pendingLine({
          id: PENDING_LINE_B,
          classification: 'fiscal',
          inventory_eligibility: 'ineligible',
          mapping_status: 'not_applicable',
          inventory_physical_quantity: 0,
          inventory_product_id: null,
          reviewed_amount: 210,
        }),
        pendingLine({
          id: '44444444-4444-4444-8444-444444444444',
          reviewed_amount: -82500,
          original_amount: -82500,
          inventory_physical_quantity: 0,
          inventory_product_id: null,
          mapping_status: 'unmapped',
        }),
        pendingLine({
          id: PENDING_LINE_C,
          mapping_status: 'unmapped',
          inventory_product_id: null,
          inventory_physical_quantity: 0,
        }),
        pendingLine({
          id: '55555555-5555-4555-8555-555555555555',
          inventory_physical_quantity: 100000,
        }),
      ],
      receipts: [{ purchase_document_line_id: '55555555-5555-4555-8555-555555555555', quantity: 100000 }],
    })
    const page = await listPendingReceptions({
      userClient: user.client,
      locationId: LOC_ID,
    })
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('aísla locales y no mezcla reviewed_quantity con recepciones físicas', async () => {
    const user = pendingReceptionClient({
      lines: [
        pendingLine({
          id: PENDING_LINE_A,
          reviewed_quantity: 50,
          reviewed_unit: 'L',
          inventory_physical_quantity: 100000,
        }),
        pendingLine({
          id: PENDING_LINE_B,
          purchase_documents: {
            id: FOREIGN_ID,
            location_id: OTHER_LOCATION,
            status: 'reviewed',
            issuer_name: 'OTRO',
            document_number: '0002-00000001',
            document_date: '2026-10-02',
          },
        }),
      ],
      receipts: [{ purchase_document_line_id: PENDING_LINE_A, quantity: 50000 }],
    })
    const page = await listPendingReceptions({
      userClient: user.client,
      locationId: LOC_ID,
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      lineId: PENDING_LINE_A,
      locationId: LOC_ID,
      invoicedQuantity: 100000,
      receivedQuantity: 50000,
      remainingQuantity: 50000,
    })
    expect(JSON.stringify(page)).not.toContain(OTHER_LOCATION)
    expect(JSON.stringify(page)).not.toContain(FOREIGN_ID)
  })

  it('pagina líneas pendientes sin duplicar ni omitir', async () => {
    const user = pendingReceptionClient({
      lines: [
        pendingLine({ id: PENDING_LINE_A }),
        pendingLine({
          id: PENDING_LINE_B,
          inventory_physical_quantity: 100000,
        }),
        pendingLine({ id: PENDING_LINE_C }),
      ],
      receipts: [{ purchase_document_line_id: PENDING_LINE_B, quantity: 100000 }],
    })
    const first = await listPendingReceptions({
      userClient: user.client,
      locationId: LOC_ID,
      limit: 1,
    })
    expect(first.items.map((item) => item.lineId)).toEqual([PENDING_LINE_A])
    expect(first.nextCursor).toBe(PENDING_LINE_A)

    const second = await listPendingReceptions({
      userClient: user.client,
      locationId: LOC_ID,
      limit: 1,
      cursor: first.nextCursor,
    })
    expect(second.items.map((item) => item.lineId)).toEqual([PENDING_LINE_C])
    expect(second.nextCursor).toBe(PENDING_LINE_C)

    const third = await listPendingReceptions({
      userClient: user.client,
      locationId: LOC_ID,
      limit: 1,
      cursor: second.nextCursor,
    })
    expect(third.items).toEqual([])
    expect(third.nextCursor).toBeNull()
  })
})



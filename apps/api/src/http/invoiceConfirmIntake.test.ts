import { describe, expect, it, vi } from 'vitest'
import { confirmPurchaseInvoiceIntake } from './invoiceConfirmIntake.js'
import { InvoiceQueryError } from './invoiceQueryError.js'

const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LOC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LINE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LINE2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PRODUCT = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const KEY = '11111111-1111-4111-8111-111111111111'
const RKEY = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

function inventoriableLine(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE,
    inventory_product_id: null,
    mapping_status: 'unmapped',
    inventory_eligibility: 'eligible',
    classification: 'stock',
    quantity_kind: 'inventory',
    reviewed_quantity: 2,
    original_quantity: 2,
    reviewed_unit: 'L',
    original_unit: 'L',
    reviewed_amount: 100,
    original_amount: 100,
    inventory_product: null,
    ...overrides,
  }
}

function clients(input: {
  invoice?: Record<string, unknown>
  lines?: Record<string, unknown>[]
  product?: Record<string, unknown> | null
  catalog?: Record<string, unknown>[]
  attempt?: Record<string, unknown> | null
  rpcData?: unknown
  rpcError?: { code?: string; message?: string; details?: string } | null
}) {
  const rpc = vi.fn().mockResolvedValue({
    data: input.rpcData ?? {
      purchase_document_id: DOC,
      document_status: 'received',
      idempotent: false,
      unmapped_line_count: 0,
      lines: [],
    },
    error: input.rpcError ?? null,
  })
  const user = {
    from: vi.fn((table: string) => {
      if (table === 'purchase_documents') {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.is = () => chain
        chain.maybeSingle = async () => ({
          data: input.invoice ?? {
            id: DOC,
            status: 'reviewed',
            location_id: LOC,
            organization_id: ORG,
          },
          error: null,
        })
        return chain
      }
      if (table === 'purchase_document_lines') {
        return {
          select: () => ({
            eq: async () => ({
              data: input.lines ?? [inventoriableLine()],
              error: null,
            }),
          }),
        }
      }
      if (table === 'inventory_products') {
        const listed = Promise.resolve({
          data: input.catalog ?? [],
          error: null,
        })
        return {
          select: () => ({
            eq: () => Object.assign(listed, {
              maybeSingle: async () => ({
                data: input.product === undefined
                  ? { id: PRODUCT, base_unit: 'ml', active: true, organization_id: ORG }
                  : input.product,
                error: null,
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  const admin = {
    rpc,
    ...(input.attempt !== undefined
      ? {
          from: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: input.attempt, error: null }),
              }),
            }),
          }),
        }
      : {}),
  }
  return { user: user as never, admin: admin as never, rpc }
}

describe('confirmPurchaseInvoiceIntake', () => {
  it('valida conversiones y llama una sola vez al RPC con cantidades físicas', async () => {
    const db = clients({})
    await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'link_existing',
        inventoryProductId: PRODUCT,
        receiveQuantity: 1500,
        receiveIdempotencyKey: RKEY,
      }],
    })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(db.rpc).toHaveBeenCalledWith('senda_confirm_purchase_invoice_intake', {
      p: expect.objectContaining({
        purchase_document_id: DOC,
        confirm_idempotency_key: KEY,
        lines: [
          expect.objectContaining({
            action: 'link_existing',
            inventory_physical_quantity: 2000,
            receive_quantity: 1500,
            receive_idempotency_key: RKEY,
          }),
        ],
      }),
    })
  })

  it('acepta recepción parcial y líneas pending sin stock', async () => {
    const db = clients({
      lines: [
        inventoriableLine(),
        inventoriableLine({
          id: LINE2,
          reviewed_unit: 'kg',
          original_unit: 'kg',
          reviewed_quantity: 1,
          original_quantity: 1,
        }),
      ],
    })
    await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [
        {
          purchaseDocumentLineId: LINE,
          action: 'link_existing',
          inventoryProductId: PRODUCT,
          receiveQuantity: 500,
          receiveIdempotencyKey: RKEY,
        },
        {
          purchaseDocumentLineId: LINE2,
          action: 'pending',
        },
      ],
    })
    const payload = db.rpc.mock.calls[0][1].p
    expect(payload.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'pending', purchase_document_line_id: LINE2 }),
      expect.objectContaining({
        action: 'link_existing',
        inventory_physical_quantity: 2000,
        receive_quantity: 500,
      }),
    ]))
  })

  it('rechaza líneas omitidas, ajenas o duplicadas', async () => {
    const db = clients({
      lines: [inventoriableLine(), inventoriableLine({ id: LINE2 })],
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{ purchaseDocumentLineId: LINE, action: 'pending' }],
    })).rejects.toMatchObject({ code: 'LINES_MISMATCH' })

    await expect(confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [
        { purchaseDocumentLineId: LINE, action: 'pending' },
        { purchaseDocumentLineId: LINE, action: 'pending' },
      ],
    })).rejects.toMatchObject({ code: 'DUPLICATE_LINE' })
  })

  it('arma create y reactivate sin encadenar HTTP de inventario', async () => {
    const db = clients({})
    await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Cerveza', baseUnit: 'ml', category: 'Barril', minimumStock: 1000 },
        receiveQuantity: 2000,
        receiveIdempotencyKey: RKEY,
      }],
    })
    expect(db.rpc.mock.calls[0][1].p.lines[0]).toMatchObject({
      action: 'create',
      create: { name: 'Cerveza', base_unit: 'ml', category: 'Barril', minimum_stock: 1000 },
      inventory_physical_quantity: 2000,
    })
  })

  it('mapea errores de rollback/idempotencia del RPC', async () => {
    const conflict = clients({
      rpcError: { message: 'CONFIRM_IDEMPOTENCY_CONFLICT' },
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: conflict.user,
      adminClient: conflict.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{ purchaseDocumentLineId: LINE, action: 'pending' }],
    })).rejects.toBeInstanceOf(InvoiceQueryError)

    const inactive = clients({
      rpcError: { message: 'INACTIVE_PRODUCT_EXISTS' },
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: inactive.user,
      adminClient: inactive.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Viejo', baseUnit: 'ml' },
      }],
    })).rejects.toMatchObject({ code: 'INACTIVE_PRODUCT_EXISTS' })
  })

  it('exige factor de empaque y no inventa peso', async () => {
    const db = clients({
      lines: [inventoriableLine({ reviewed_unit: 'caja', original_unit: 'caja' })],
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'link_existing',
        inventoryProductId: PRODUCT,
      }],
    })).rejects.toMatchObject({ code: 'EQUIVALENCE_REQUIRED' })

    await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'link_existing',
        inventoryProductId: PRODUCT,
        conversionFactor: 8000,
      }],
    })
    expect(db.rpc.mock.calls.at(-1)?.[1].p.lines[0].inventory_physical_quantity).toBe(16000)
  })

  it('reutiliza un insumo activo compatible y no crea otro', async () => {
    const db = clients({
      catalog: [{
        id: PRODUCT,
        name: 'Queso Mozzarella La Paulina',
        base_unit: 'g',
        active: true,
        organization_id: ORG,
      }],
      lines: [inventoriableLine({
        reviewed_unit: 'barra',
        original_unit: 'barra',
        reviewed_quantity: 2,
        original_quantity: 2,
      })],
    })
    await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Queso Mozzarella La Paulina', baseUnit: 'g' },
        conversionFactor: 3500,
        receiveQuantity: 7000,
        receiveIdempotencyKey: RKEY,
      }],
    })
    expect(db.rpc.mock.calls[0][1].p.lines[0]).toMatchObject({
      action: 'link_existing',
      inventory_product_id: PRODUCT,
      inventory_physical_quantity: 7000,
      receive_quantity: 7000,
    })
    expect(db.rpc.mock.calls[0][1].p.lines[0].create).toBeUndefined()
  })

  it('crea un insumo nuevo si el único homónimo está inactivo', async () => {
    const db = clients({
      catalog: [{
        id: PRODUCT,
        name: 'Queso Mozzarella La Paulina',
        base_unit: 'g',
        active: false,
        organization_id: ORG,
      }],
      lines: [inventoriableLine({
        reviewed_unit: 'barra',
        original_unit: 'barra',
        reviewed_quantity: 2,
        original_quantity: 2,
      })],
    })
    await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Queso Mozzarella La Paulina', baseUnit: 'g' },
        conversionFactor: 3500,
        receiveQuantity: 7000,
        receiveIdempotencyKey: RKEY,
      }],
    })
    const sent = db.rpc.mock.calls[0][1].p.lines[0]
    expect(sent.action).toBe('create')
    expect(sent.inventory_product_id).toBeUndefined()
    expect(sent.create).toMatchObject({ name: 'Queso Mozzarella La Paulina', base_unit: 'g' })
    expect(JSON.stringify(sent)).not.toContain(PRODUCT)
  })

  it('reutiliza el activo equivalente y no el homónimo inactivo', async () => {
    const activeId = '99999999-9999-4999-8999-999999999999'
    const db = clients({
      catalog: [
        {
          id: PRODUCT,
          name: 'Azúcar',
          base_unit: 'g',
          active: false,
          organization_id: ORG,
        },
        {
          id: activeId,
          name: 'azucar',
          base_unit: 'g',
          active: true,
          organization_id: ORG,
        },
      ],
      lines: [inventoriableLine({
        reviewed_unit: 'kg',
        original_unit: 'kg',
        reviewed_quantity: 2,
        original_quantity: 2,
      })],
    })
    await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: '  AZÚCAR ', baseUnit: 'g' },
        conversionFactor: 1000,
        receiveQuantity: 2000,
        receiveIdempotencyKey: RKEY,
      }],
    })
    const sent = db.rpc.mock.calls[0][1].p.lines[0]
    expect(sent).toMatchObject({
      action: 'link_existing',
      inventory_product_id: activeId,
    })
    expect(sent.action).not.toBe('reactivate')
    expect(JSON.stringify(sent)).not.toContain(PRODUCT)
  })

  it('no reutiliza un insumo de otra organización, otro nombre ambiguo ni otra unidad', async () => {
    const foreign = clients({
      catalog: [{
        id: PRODUCT,
        name: 'Queso Mozzarella La Paulina',
        base_unit: 'g',
        active: true,
        organization_id: '99999999-9999-4999-8999-999999999999',
      }],
      lines: [inventoriableLine({ reviewed_unit: 'barra', original_unit: 'barra' })],
    })
    await confirmPurchaseInvoiceIntake({
      userClient: foreign.user,
      adminClient: foreign.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Queso Mozzarella La Paulina', baseUnit: 'g' },
        conversionFactor: 3500,
      }],
    })
    expect(foreign.rpc.mock.calls[0][1].p.lines[0].action).toBe('create')

    const ambiguous = clients({
      catalog: [
        { id: PRODUCT, name: 'Pan rallado', base_unit: 'g', active: true, organization_id: ORG },
        { id: LINE2, name: 'Pan Rallado', base_unit: 'g', active: true, organization_id: ORG },
      ],
      lines: [inventoriableLine({ reviewed_unit: 'bolsa', original_unit: 'bolsa', reviewed_quantity: 2, original_quantity: 2 })],
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: ambiguous.user,
      adminClient: ambiguous.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Pan rallado', baseUnit: 'g' },
        conversionFactor: 5000,
      }],
    })).rejects.toMatchObject({ code: 'PRODUCT_AMBIGUOUS' })
    expect(ambiguous.rpc).not.toHaveBeenCalled()

    const mismatch = clients({
      catalog: [{ id: PRODUCT, name: 'Pan rallado', base_unit: 'unit', active: true, organization_id: ORG }],
      lines: [inventoriableLine({ reviewed_unit: 'bolsa', original_unit: 'bolsa', reviewed_quantity: 2, original_quantity: 2 })],
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: mismatch.user,
      adminClient: mismatch.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Pan rallado', baseUnit: 'g' },
        conversionFactor: 5000,
      }],
    })).rejects.toMatchObject({ code: 'PRODUCT_UNIT_MISMATCH' })
    expect(mismatch.rpc).not.toHaveBeenCalled()
  })

  it('reintenta una confirmación ya exitosa sin volver a llamar al RPC', async () => {
    const db = clients({
      attempt: {
        purchase_document_id: DOC,
        status: 'succeeded',
        result: {
          purchase_document_id: DOC,
          document_status: 'reviewed',
          idempotent: false,
          unmapped_line_count: 0,
          lines: [{
            purchase_document_line_id: LINE,
            action: 'create',
            inventory_product_id: PRODUCT,
            created: true,
            mapped: true,
            inventory_physical_quantity: 7000,
            receive: { quantity: 7000 },
          }],
        },
      },
    })
    const result = await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Queso', baseUnit: 'g' },
        conversionFactor: 3500,
        receiveQuantity: 7000,
        receiveIdempotencyKey: RKEY,
      }],
    })
    expect(db.rpc).not.toHaveBeenCalled()
    expect(result.idempotent).toBe(true)
    expect(result.lines[0]).toMatchObject({
      inventoryProductId: PRODUCT,
      inventoryPhysicalQuantity: 7000,
    })
  })

  it('acepta presentación sin unidad extraída solo con equivalencia explícita', async () => {
    const db = clients({
      lines: [inventoriableLine({
        reviewed_unit: null,
        original_unit: null,
        reviewed_quantity: 2,
        original_quantity: 2,
      })],
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Sin contenido', baseUnit: 'g' },
      }],
    })).rejects.toMatchObject({ code: 'EQUIVALENCE_REQUIRED' })

    await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'create',
        create: { name: 'Queso La Paulina', baseUnit: 'g' },
        conversionFactor: 3500,
        receiveQuantity: 7000,
        receiveIdempotencyKey: RKEY,
      }],
    })
    expect(db.rpc.mock.calls.at(-1)?.[1].p.lines[0]).toMatchObject({
      action: 'create',
      inventory_physical_quantity: 7000,
      receive_quantity: 7000,
    })
  })

  it('rechaza organización, sucursal o factura fuera del alcance antes del RPC', async () => {
    const otherOrg = '99999999-9999-4999-8999-999999999999'
    const foreignOrg = clients({
      invoice: {
        id: DOC,
        status: 'reviewed',
        location_id: LOC,
        organization_id: otherOrg,
      },
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: foreignOrg.user,
      adminClient: foreignOrg.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'link_existing',
        inventoryProductId: PRODUCT,
      }],
    })).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(foreignOrg.rpc).not.toHaveBeenCalled()

    const foreignLocation = clients({
      invoice: {
        id: DOC,
        status: 'reviewed',
        location_id: otherOrg,
        organization_id: ORG,
      },
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: foreignLocation.user,
      adminClient: foreignLocation.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'link_existing',
        inventoryProductId: PRODUCT,
      }],
    })).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(foreignLocation.rpc).not.toHaveBeenCalled()

    const hidden = clients({ invoice: { id: '' } })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: hidden.user,
      adminClient: hidden.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: LINE,
        action: 'pending',
      }],
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(hidden.rpc).not.toHaveBeenCalled()
  })

  it('recupera la factura guardada, reutiliza La Paulina y no recibe Doña Aurora', async () => {
    const paulina = '3a16835d-ec6b-427f-82d3-db8a434c9499'
    const ids = {
      paulina: '83e668cb-479a-4dc8-bcdb-db152dce375c',
      aurora: '22c728e4-109d-4433-8635-ddde3ee72cbf',
      azucar: 'af365ebc-bc92-403f-a68f-6c0d2470cde4',
      leche: '2882cfea-a315-42cd-a3da-e9e981a4a808',
      pan: '6c49340b-9999-4488-8871-577be955a559',
      pimienta: '0a90c736-fef1-4aba-a443-ae6292055d5e',
    }
    const sources = {
      paulina: 'line-sob5kx-1',
      aurora: 'line-17udio7-1',
      azucar: 'line-gm4ga0-1',
      leche: 'line-lo3irm-1',
      pan: 'line-1o41r6h-1',
      pimienta: 'line-1o9xkao-1',
    }
    function analysisLine(input: Record<string, unknown>): Record<string, unknown> {
      return {
        unit: null,
        contentPerUnit: 1,
        contentUnit: 'kg',
        inventoryPhysicalQuantity: 1,
        ...input,
      }
    }
    const originalLines = [
      analysisLine({
        id: sources.paulina,
        originalDescription: 'Queso Mozzarella P/Fetea r La Paulina Barra x 3,5 Kg',
        quantity: 2,
        contentPerUnit: 3.5,
        inventoryPhysicalQuantity: 7000,
      }),
      analysisLine({
        id: sources.aurora,
        originalDescription: 'Queso Mozzarella Doña Aurora Plancha x 8,8 kg Aproxs',
        quantity: 1,
        contentPerUnit: 8.8,
        billedWeight: 8.88,
        billedWeightUnit: 'kg',
        inventoryPhysicalQuantity: 8880,
      }),
      analysisLine({
        id: sources.azucar,
        unit: 'pack',
        quantity: 1,
        contentPerUnit: 1,
        inventoryPhysicalQuantity: 10000,
      }),
      analysisLine({
        id: sources.leche,
        unit: 'pack',
        quantity: 1,
        contentUnit: 'lt',
        contentPerUnit: 1,
        inventoryPhysicalQuantity: 12000,
      }),
      analysisLine({
        id: sources.pan,
        originalDescription: 'Pan Rallado Exclusivo Bolsa x 5 Kg',
        quantity: 2,
        contentPerUnit: 5,
        inventoryPhysicalQuantity: 10000,
      }),
      analysisLine({
        id: sources.pimienta,
        originalDescription: 'Pimienta Negra Molida Marfeli Bolsa x 1Kg',
        quantity: 1,
        contentPerUnit: 1,
        inventoryPhysicalQuantity: 1000,
      }),
    ]
    const interpretation = (status: string, lineId: string) => ({ lineId, status })
    const invoice = {
      id: DOC,
      status: 'reviewed',
      location_id: LOC,
      organization_id: ORG,
      original_analysis: {
        document: { lines: originalLines },
        interpretation: {
          lines: [
            interpretation('confirmed', sources.paulina),
            interpretation('requires_review', sources.aurora),
            interpretation('confirmed', sources.azucar),
            interpretation('confirmed', sources.leche),
            interpretation('confirmed', sources.pan),
            interpretation('confirmed', sources.pimienta),
          ],
        },
      },
      reviewed_analysis: {
        document: {
          lines: originalLines.map((line) => line.id === sources.aurora
            ? { ...line, billedWeight: null, inventoryPhysicalQuantity: 8800 }
            : line),
        },
        interpretation: {
          lines: [
            interpretation('confirmed', sources.paulina),
            interpretation('requires_review', sources.aurora),
            interpretation('confirmed', sources.azucar),
            interpretation('confirmed', sources.leche),
            interpretation('confirmed', sources.pan),
            interpretation('confirmed', sources.pimienta),
          ],
        },
      },
    }
    function stored(id: string, source: string, quantity: number, unit: string | null) {
      return inventoriableLine({
        id,
        source_line_id: source,
        reviewed_quantity: quantity,
        original_quantity: quantity,
        reviewed_unit: unit,
        original_unit: unit,
      })
    }
    const db = clients({
      invoice,
      lines: [
        stored(ids.paulina, sources.paulina, 2, null),
        stored(ids.aurora, sources.aurora, 1, null),
        stored(ids.azucar, sources.azucar, 1, 'pack'),
        stored(ids.leche, sources.leche, 1, 'pack'),
        stored(ids.pan, sources.pan, 2, null),
        stored(ids.pimienta, sources.pimienta, 1, null),
      ],
      catalog: [
        {
          id: paulina,
          name: 'Queso Mozzarella P/Fetea r La Paulina Barra',
          base_unit: 'g',
          active: true,
          organization_id: ORG,
        },
        {
          id: PRODUCT,
          name: 'Queso Mozzarella P/Fetea r La Paulina Barra',
          base_unit: 'g',
          active: true,
          organization_id: '99999999-9999-4999-8999-999999999999',
        },
      ],
    })
    const names = {
      paulina: 'Queso Mozzarella P/Fetea r La Paulina Barra',
      aurora: 'Queso Mozzarella Doña Aurora Plancha',
      azucar: 'Azucar Blanca Ledesma Pack',
      leche: 'Leche Entera Larga Vida Tregar Pack',
      pan: 'Pan Rallado Exclusivo Bolsa',
      pimienta: 'Pimienta Negra Molida Marfeli Bolsa',
    }
    const receive = (suffix: string) => `44444444-4444-4444-8444-44444444444${suffix}`
    await confirmPurchaseInvoiceIntake({
      userClient: db.user,
      adminClient: db.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [
        {
          purchaseDocumentLineId: ids.paulina,
          action: 'create',
          create: { name: names.paulina, baseUnit: 'g' },
          conversionFactor: 3500,
          receiveQuantity: 7000,
          receiveIdempotencyKey: receive('1'),
        },
        {
          purchaseDocumentLineId: ids.aurora,
          action: 'create',
          create: { name: names.aurora, baseUnit: 'g' },
          conversionFactor: 8880,
          receiveQuantity: 8880,
          receiveIdempotencyKey: receive('2'),
        },
        {
          purchaseDocumentLineId: ids.azucar,
          action: 'create',
          create: { name: names.azucar, baseUnit: 'g' },
          conversionFactor: 10000,
          receiveQuantity: 10000,
          receiveIdempotencyKey: receive('3'),
        },
        {
          purchaseDocumentLineId: ids.leche,
          action: 'create',
          create: { name: names.leche, baseUnit: 'ml' },
          conversionFactor: 12000,
          receiveQuantity: 12000,
          receiveIdempotencyKey: receive('4'),
        },
        {
          purchaseDocumentLineId: ids.pan,
          action: 'create',
          create: { name: names.pan, baseUnit: 'g' },
          conversionFactor: 5000,
          receiveQuantity: 10000,
          receiveIdempotencyKey: receive('5'),
        },
        {
          purchaseDocumentLineId: ids.pimienta,
          action: 'create',
          create: { name: names.pimienta, baseUnit: 'g' },
          conversionFactor: 1000,
          receiveQuantity: 1000,
          receiveIdempotencyKey: receive('6'),
        },
      ],
    })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    const sent = db.rpc.mock.calls[0][1].p.lines as Array<Record<string, unknown>>
    expect(sent).toHaveLength(6)
    expect(sent[0]).toMatchObject({
      purchase_document_line_id: ids.paulina,
      action: 'link_existing',
      inventory_product_id: paulina,
      inventory_physical_quantity: 7000,
      receive_quantity: 7000,
    })
    expect(sent[0].create).toBeUndefined()
    expect(sent[1]).toMatchObject({
      purchase_document_line_id: ids.aurora,
      action: 'create',
      inventory_physical_quantity: 8880,
    })
    expect(sent[1].receive_quantity).toBeUndefined()
    expect(sent[1].create).toMatchObject({ name: names.aurora, base_unit: 'g' })
    expect(sent[2]).toMatchObject({ action: 'create', inventory_physical_quantity: 10000, receive_quantity: 10000 })
    expect(sent[3]).toMatchObject({ action: 'create', inventory_physical_quantity: 12000, receive_quantity: 12000 })
    expect(sent[3].create).toMatchObject({ base_unit: 'ml' })
    expect(sent[4]).toMatchObject({ action: 'create', inventory_physical_quantity: 10000, receive_quantity: 10000 })
    expect(sent[5]).toMatchObject({ action: 'create', inventory_physical_quantity: 1000, receive_quantity: 1000 })

    const drifted = clients({
      invoice,
      lines: [stored(ids.aurora, sources.aurora, 1, null)],
    })
    await expect(confirmPurchaseInvoiceIntake({
      userClient: drifted.user,
      adminClient: drifted.admin,
      userId: USER,
      documentId: DOC,
      organizationId: ORG,
      locationId: LOC,
      confirmIdempotencyKey: KEY,
      lines: [{
        purchaseDocumentLineId: ids.aurora,
        action: 'create',
        create: { name: names.aurora, baseUnit: 'g' },
        conversionFactor: 8800,
      }],
    })).rejects.toMatchObject({ code: 'INVALID_CONVERSION' })
    expect(drifted.rpc).not.toHaveBeenCalled()
  })
})

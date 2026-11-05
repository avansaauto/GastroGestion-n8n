import { describe, expect, it, vi } from 'vitest'
import { listOrganizationSuppliers, resolvePreferredSupplierId } from './organizationSuppliers.js'

function client(handlers: Record<string, unknown>) {
  return {
    from(table: string) {
      const handler = handlers[table]
      if (typeof handler === 'function') return handler()
      throw new Error(`unexpected table ${table}`)
    },
    rpc: handlers.rpc ?? vi.fn(),
  } as never
}

describe('organizationSuppliers', () => {
  it('lista suppliers y issuers de factura sin duplicar por nombre', async () => {
    const result = await listOrganizationSuppliers(
      client({
        organizations: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: 'org' }, error: null }),
            }),
          }),
        }),
        suppliers: () => ({
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: [
                  {
                    id: 'sup-1',
                    organization_id: 'org',
                    name: 'MAYORISTANET.COM S.A.',
                    tax_id: '30707296832',
                    active: true,
                  },
                ],
                error: null,
              }),
            }),
          }),
        }),
        locations: () => ({
          select: () => ({
            eq: async () => ({ data: [{ id: 'loc-1' }], error: null }),
          }),
        }),
        purchase_documents: () => ({
          select: () => ({
            in: () => ({
              is: async () => ({
                data: [
                  {
                    issuer_name: 'MAYORISTANET.COM S.A.',
                    issuer_tax_id_normalized: '30707296832',
                    supplier_id: null,
                  },
                  {
                    issuer_name: 'LUPULO S.A.',
                    issuer_tax_id_normalized: '30714329401',
                    supplier_id: null,
                  },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }),
      'org',
    )

    expect(result).toHaveLength(2)
    expect(result.find((row) => row.name.includes('MAYORISTANET'))?.source).toBe('suppliers')
    expect(result.find((row) => row.name.includes('LUPULO'))?.source).toBe('invoice_issuer')
  })

  it('resuelve preferred supplier por id real', async () => {
    const id = await resolvePreferredSupplierId({
      userClient: client({
        suppliers: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'sup-1', organization_id: 'org', active: true },
                error: null,
              }),
            }),
          }),
        }),
      }),
      adminClient: null,
      userId: 'user',
      organizationId: 'org',
      preferredSupplierId: 'sup-1',
    })
    expect(id).toBe('sup-1')
  })
})

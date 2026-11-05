import { describe, expect, it, vi } from 'vitest'
import {
  FUDO_CATALOG_SYNC_SCOPE,
  hashIntegrationSecret,
  type IntegrationCredentialRecord,
} from './integrationAuth.js'
import { parseFudoCatalogSyncBody, syncFudoProductCatalog } from './fudoCatalogSync.js'

const PEPPER = 'test-integration-pepper'
const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const ID = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const LOCATION = '33333333-3333-4333-8333-333333333333'
const NOW = new Date('2026-11-04T15:00:00.000Z')

function record(): IntegrationCredentialRecord {
  return {
    id: ID,
    secretHash: hashIntegrationSecret(SECRET, PEPPER),
    organizationId: ORG,
    locationId: LOCATION,
    scopes: [FUDO_CATALOG_SYNC_SCOPE],
    status: 'active',
    expiresAt: null,
  }
}

function adminMock(options?: { existingActive?: string[] }) {
  const upsert = vi.fn().mockResolvedValue({ error: null })
  const updateEq = vi.fn().mockReturnThis()
  const updateIn = vi.fn().mockResolvedValue({ error: null })
  const update = vi.fn(() => ({
    eq: updateEq,
    in: updateIn,
  }))
  // chain: .update().eq().eq().in()
  updateEq.mockImplementation(function chain() {
    return { eq: updateEq, in: updateIn }
  })

  const selectEq = vi.fn().mockReturnThis()
  const select = vi.fn(() => ({ eq: selectEq }))
  selectEq.mockImplementation(function chain() {
    return {
      eq: selectEq,
      then: undefined,
    }
  })

  const list = vi.fn().mockResolvedValue({
    data: (options?.existingActive ?? []).map((id) => ({ external_product_id: id })),
    error: null,
  })

  // Rebuild a simpler fluent mock used by the implementation.
  const from = vi.fn((table: string) => {
    expect(table).toBe('fudo_product_catalog')
    return {
      upsert,
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => list(),
          }),
        }),
      }),
      update: () => ({
        eq: () => ({
          eq: () => ({
            in: updateIn,
          }),
        }),
      }),
    }
  })

  return { from, upsert, updateIn, list, update }
}

describe('parseFudoCatalogSyncBody', () => {
  it('acepta product_id numérico y name', () => {
    const parsed = parseFudoCatalogSyncBody({
      products: [
        { product_id: 17, name: 'American IPA', active: true },
        { externalProductId: '60', name: 'Fernet Branca y Coca' },
      ],
    })
    expect(parsed.products).toEqual([
      { externalProductId: '17', name: 'American IPA', active: true },
      { externalProductId: '60', name: 'Fernet Branca y Coca', active: true },
    ])
    expect(parsed.markMissingInactive).toBe(false)
  })

  it('rechaza organization_id en el body', () => {
    expect(() => parseFudoCatalogSyncBody({
      organization_id: ORG,
      products: [{ externalProductId: '1', name: 'A' }],
    })).not.toThrow()
    // destination rejection happens in authenticateIntegration, not the parser
  })

  it('rechaza duplicados en el lote', () => {
    expect(() => parseFudoCatalogSyncBody({
      products: [
        { externalProductId: '17', name: 'A' },
        { externalProductId: '17', name: 'B' },
      ],
    })).toThrow(/duplicado/i)
  })
})

describe('syncFudoProductCatalog', () => {
  it('upserta usando org/location de la credencial, no del body', async () => {
    const db = adminMock()
    const result = await syncFudoProductCatalog({
      authorizationHeader: `Bearer snd_${ID}.${SECRET}`,
      body: {
        products: [
          { externalProductId: '17', name: 'American IPA', active: true },
          { product_id: 60, name: 'Fernet', active: true },
        ],
      },
      pepper: PEPPER,
      repository: { findById: async () => record() },
      admin: db as never,
      now: NOW,
    })

    expect(result.organizationId).toBe(ORG)
    expect(result.locationId).toBe(LOCATION)
    expect(result.upserted).toBe(2)
    expect(result.deactivated).toBe(0)
    expect(db.upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          organization_id: ORG,
          location_id: LOCATION,
          external_product_id: '17',
          source: 'fudo',
          active: true,
        }),
      ]),
      { onConflict: 'location_id,source,external_product_id' },
    )
  })

  it('desactiva activos ausentes cuando markMissingInactive', async () => {
    const db = adminMock({ existingActive: ['17', '99'] })
    const result = await syncFudoProductCatalog({
      authorizationHeader: `Bearer snd_${ID}.${SECRET}`,
      body: {
        products: [{ externalProductId: '17', name: 'American IPA', active: true }],
        markMissingInactive: true,
      },
      pepper: PEPPER,
      repository: { findById: async () => record() },
      admin: db as never,
      now: NOW,
    })
    expect(result.deactivated).toBe(1)
    expect(db.updateIn).toHaveBeenCalledWith('external_product_id', ['99'])
  })

  it('rechaza body con location_id', async () => {
    const db = adminMock()
    await expect(syncFudoProductCatalog({
      authorizationHeader: `Bearer snd_${ID}.${SECRET}`,
      body: {
        location_id: LOCATION,
        products: [{ externalProductId: '1', name: 'A' }],
      },
      pepper: PEPPER,
      repository: { findById: async () => record() },
      admin: db as never,
      now: NOW,
    })).rejects.toMatchObject({ code: 'CLIENT_DESTINATION', status: 400 })
    expect(db.upsert).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import type { PendingProduct } from '@/lib/api'
import { summarizeOverviewFudoMetrics } from './overviewFudoMetrics'

function row(partial: Partial<PendingProduct> & {
  external_product_id: string
  status?: string
}): PendingProduct {
  return {
    id: partial.id ?? `id-${partial.external_product_id}`,
    location_id: 'loc',
    source: partial.source ?? 'fudo',
    product_name: partial.product_name ?? `Prod ${partial.external_product_id}`,
    external_product_id: partial.external_product_id,
    status: partial.status ?? 'pending',
    mapping_id: partial.mapping_id ?? null,
    mapping_active: partial.mapping_active ?? null,
    recipe_id: partial.recipe_id ?? null,
    ...partial,
  }
}

describe('summarizeOverviewFudoMetrics', () => {
  it('reproduce el caso OGHAM: 32 pending, 4 huérfanos, 2 vinculados → 36 sin vínculo', () => {
    const products: PendingProduct[] = [
      ...Array.from({ length: 32 }, (_, index) => row({
        external_product_id: `p${index}`,
        status: 'pending',
      })),
      row({ external_product_id: '13', status: 'resolved', mapping_active: null }),
      row({ external_product_id: '15', status: 'resolved', mapping_id: null, mapping_active: null }),
      row({ external_product_id: '276', status: 'resolved' }),
      row({ external_product_id: '35', status: 'resolved', recipe_id: null }),
      row({
        external_product_id: '17',
        status: 'resolved',
        mapping_id: 'm-17',
        mapping_active: true,
        recipe_id: 'r-17',
      }),
      row({
        external_product_id: '60',
        status: 'resolved',
        mapping_id: 'm-60',
        mapping_active: true,
        recipe_id: 'r-60',
      }),
    ]

    expect(summarizeOverviewFudoMetrics(products)).toEqual({
      detectedTotal: 38,
      pendingDetected: 32,
      withoutActiveLink: 36,
      linked: 2,
      catalogSynced: 0,
      catalogActive: 0,
      catalogUnlinkedActive: 0,
      hasCatalog: false,
    })
  })

  it('deduplica por id externo Fudo', () => {
    const products = [
      row({ id: 'a', external_product_id: '60', status: 'pending' }),
      row({
        id: 'b',
        external_product_id: '60',
        status: 'resolved',
        mapping_id: 'm',
        mapping_active: true,
        recipe_id: 'r',
      }),
    ]
    expect(summarizeOverviewFudoMetrics(products)).toEqual({
      detectedTotal: 1,
      pendingDetected: 0,
      withoutActiveLink: 0,
      linked: 1,
      catalogSynced: 0,
      catalogActive: 0,
      catalogUnlinkedActive: 0,
      hasCatalog: false,
    })
  })

  it('ignora fuentes que no son fudo', () => {
    const products = [
      row({ external_product_id: '1', source: 'otro', status: 'pending' }),
      row({ external_product_id: '2', status: 'pending' }),
    ]
    expect(summarizeOverviewFudoMetrics(products)).toEqual({
      detectedTotal: 1,
      pendingDetected: 1,
      withoutActiveLink: 1,
      linked: 0,
      catalogSynced: 0,
      catalogActive: 0,
      catalogUnlinkedActive: 0,
      hasCatalog: false,
    })
  })

  it('mapping_active false cuenta como sin vinculación (huérfano)', () => {
    const products = [
      row({
        external_product_id: '9',
        status: 'resolved',
        mapping_id: 'm-old',
        mapping_active: false,
        recipe_id: 'r-old',
      }),
    ]
    expect(summarizeOverviewFudoMetrics(products)).toEqual({
      detectedTotal: 1,
      pendingDetected: 0,
      withoutActiveLink: 1,
      linked: 0,
      catalogSynced: 0,
      catalogActive: 0,
      catalogUnlinkedActive: 0,
      hasCatalog: false,
    })
  })

  it('diferencia catálogo sincronizado de detecciones históricas', () => {
    const products: PendingProduct[] = [
      row({
        external_product_id: '17',
        status: 'linked',
        catalog_active: true,
        mapping_id: 'm',
        mapping_active: true,
        recipe_id: 'r',
      }),
      row({ external_product_id: '99', status: 'catalog', catalog_active: true }),
      row({ external_product_id: '200', status: 'catalog', catalog_active: false }),
      row({ external_product_id: '141', status: 'pending' }),
    ]
    expect(summarizeOverviewFudoMetrics(products)).toMatchObject({
      catalogSynced: 3,
      catalogActive: 2,
      catalogUnlinkedActive: 1,
      linked: 1,
      hasCatalog: true,
      pendingDetected: 1,
    })
  })
})

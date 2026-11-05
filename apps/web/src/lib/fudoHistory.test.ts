import { describe, expect, it } from 'vitest'
import type { PendingProduct } from './api'
import {
  buildFudoHistory,
  filterFudoHistory,
  fudoHistoryCanCreate,
  fudoLinkedRecipeLabel,
  fudoMappingStatusLabel,
  fudoRecordsForMappings,
  indexFudoDetections,
  pendingCreateRedirectPath,
  pendingListRedirectPath,
  recipePagePath,
  parseFudoHistoryFilter,
  parseRecipePageView,
} from './fudoHistory'
import { FUDO_CREATE_CATEGORY_RPC_ENABLED } from './fudoRecipeCreate'

function pending(overrides: Partial<PendingProduct> = {}): PendingProduct {
  return {
    id: 'pend-1',
    location_id: 'loc',
    product_name: 'Pinta Fudo',
    source: 'fudo',
    external_product_id: '0125',
    status: 'pending',
    first_seen_at: '2026-03-01T12:00:00.000Z',
    last_seen_at: '2026-03-02T15:30:00.000Z',
    ...overrides,
  }
}

describe('historial Fudo', () => {
  it('redirige /pendientes al listado de recetas sin abrir historial Fudo', () => {
    expect(pendingListRedirectPath(new URLSearchParams())).toBe('/recetas')
    expect(pendingListRedirectPath(new URLSearchParams('status=resolved'))).toBe('/recetas')
    expect(pendingCreateRedirectPath(new URLSearchParams('source=fudo&externalProductId=0125'))).toBe(
      '/recetas/crear?source=fudo&externalProductId=0125',
    )
    expect(parseRecipePageView(new URLSearchParams('vista=historial'))).toBe('historial')
    expect(parseFudoHistoryFilter(new URLSearchParams('fudo=pending'))).toBe('pending')
    expect(recipePagePath('recetas')).toBe('/recetas')
  })

  it('no asigna receta a un resuelto sin mapping aunque el nombre coincida', () => {
    const history = buildFudoHistory([
      pending({
        id: 'done',
        status: 'resolved',
        product_name: 'Pinta IPA',
        external_product_id: '999',
      }),
    ])
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      name: 'Pinta IPA',
      externalProductId: '999',
      recipeId: null,
      recipeName: null,
      mappingActive: null,
    })
    expect(fudoLinkedRecipeLabel(history[0]!)).toBe('—')
    expect(fudoMappingStatusLabel(history[0]!.mappingActive)).toBe('—')
  })

  it('usa el recipe_id persistido para resueltos con mapping activo o inactivo', () => {
    const history = buildFudoHistory([
      pending({
        id: 'active',
        status: 'resolved',
        external_product_id: '125',
        recipe_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        recipe_name: 'Pinta IPA',
        mapping_active: true,
      }),
      pending({
        id: 'inactive',
        status: 'resolved',
        external_product_id: 'sku-ipa',
        recipe_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        recipe_name: 'Vieja IPA',
        mapping_active: false,
      }),
    ])
    expect(history[0]).toMatchObject({
      externalProductId: '125',
      recipeName: 'Pinta IPA',
      mappingActive: true,
    })
    expect(history[1]).toMatchObject({
      externalProductId: 'sku-ipa',
      recipeName: 'Vieja IPA',
      mappingActive: false,
    })
    expect(fudoMappingStatusLabel(false)).toBe('Inactivo')
    expect(fudoHistoryCanCreate(history[0]!)).toBe(false)
    expect(fudoHistoryCanCreate(history[1]!)).toBe(false)
  })

  it('permite crear solo pendientes sin mapping activo y no inventa fechas', () => {
    const open = buildFudoHistory([pending({ first_seen_at: null, last_seen_at: undefined })])[0]!
    expect(fudoHistoryCanCreate(open)).toBe(true)
    expect(open.firstSeenAt).toBeNull()
    expect(open.lastSeenAt).toBeNull()
    expect(filterFudoHistory(
      buildFudoHistory([pending(), pending({ id: 'done', status: 'resolved', external_product_id: '88' })]),
      '',
      'resolved',
    ).map((item) => item.externalProductId)).toEqual(['88'])
  })

  it('asocia detecciones a mappings activos por identidad, no por nombre', () => {
    const detections = indexFudoDetections([
      pending({ product_name: 'Otro nombre', external_product_id: '0125' }),
      pending({
        id: 'other',
        product_name: 'IPA',
        external_product_id: '999',
        first_seen_at: '2020-01-01T00:00:00.000Z',
      }),
    ])
    const records = fudoRecordsForMappings([
      {
        id: 'm1',
        source: 'fudo',
        externalProductId: '0125',
        externalProductName: 'IPA',
        active: true,
      },
      {
        id: 'm2',
        source: 'fudo',
        externalProductId: 'old',
        externalProductName: 'IPA',
        active: false,
      },
    ], detections)
    expect(records).toEqual([{
      source: 'fudo',
      externalProductId: '0125',
      externalProductName: 'IPA',
      firstSeenAt: '2026-03-01T12:00:00.000Z',
      lastSeenAt: '2026-03-02T15:30:00.000Z',
      pendingStatus: 'pending',
      mappingActive: true,
    }])
    expect(FUDO_CREATE_CATEGORY_RPC_ENABLED).toBe(true)
  })
})

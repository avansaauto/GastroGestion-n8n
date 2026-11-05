import { describe, expect, it } from 'vitest'
import { attachPendingProductRelations } from './pendingProductRelations.js'

const LOCATION = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const RECIPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_RECIPE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('attachPendingProductRelations', () => {
  it('une por identidad Fudo persistida y no por nombre', () => {
    const products = [
      {
        id: 'pend-1',
        location_id: LOCATION,
        source: 'fudo',
        external_product_id: '0125',
        product_name: 'Pinta IPA',
        status: 'resolved',
      },
      {
        id: 'pend-2',
        location_id: LOCATION,
        source: 'fudo',
        external_product_id: '999',
        product_name: 'Pinta IPA',
        status: 'resolved',
      },
    ]
    const mappings = [{
      id: 'map-1',
      location_id: LOCATION,
      source: 'fudo',
      external_product_id: '0125',
      recipe_id: RECIPE,
      active: true,
    }]
    const recipes = [{ id: RECIPE, name: 'Pinta de barril' }]
    const rows = attachPendingProductRelations(products, mappings, recipes, LOCATION)
    expect(rows[0]).toMatchObject({
      mapping_id: 'map-1',
      mapping_active: true,
      recipe_id: RECIPE,
      recipe_name: 'Pinta de barril',
    })
    expect(rows[1]).toMatchObject({
      mapping_id: null,
      mapping_active: null,
      recipe_id: null,
      recipe_name: null,
    })
  })

  it('conserva un mapping inactivo y no usa mappings de otro local', () => {
    const products = [{
      id: 'pend-1',
      source: 'fudo',
      external_product_id: 'sku-ipa',
      status: 'resolved',
    }]
    const rows = attachPendingProductRelations(
      products,
      [
        {
          id: 'inactive',
          location_id: LOCATION,
          source: 'fudo',
          external_product_id: 'sku-ipa',
          recipe_id: RECIPE,
          active: false,
        },
        {
          id: 'other',
          location_id: OTHER,
          source: 'fudo',
          external_product_id: 'sku-ipa',
          recipe_id: OTHER_RECIPE,
          active: true,
        },
      ],
      [{ id: RECIPE, name: 'Vieja IPA' }, { id: OTHER_RECIPE, name: 'Ajena' }],
      LOCATION,
    )
    expect(rows[0]).toMatchObject({
      mapping_id: 'inactive',
      mapping_active: false,
      recipe_id: RECIPE,
      recipe_name: 'Vieja IPA',
    })
    expect(rows[0]?.recipe_name).not.toBe('Ajena')
  })

  it('prefiere el mapping activo si hay dos identidades iguales', () => {
    const rows = attachPendingProductRelations(
      [{ id: 'pend-1', source: 'fudo', external_product_id: '125', status: 'resolved' }],
      [
        {
          id: 'old',
          location_id: LOCATION,
          source: 'fudo',
          external_product_id: '125',
          recipe_id: OTHER_RECIPE,
          active: false,
        },
        {
          id: 'live',
          location_id: LOCATION,
          source: 'fudo',
          external_product_id: '125',
          recipe_id: RECIPE,
          active: true,
        },
      ],
      [{ id: RECIPE, name: 'Actual' }],
      LOCATION,
    )
    expect(rows[0]).toMatchObject({
      mapping_id: 'live',
      mapping_active: true,
      recipe_id: RECIPE,
      recipe_name: 'Actual',
    })
  })

  it('no inventa receta si el mapping no trae nombre visible', () => {
    const rows = attachPendingProductRelations(
      [{ id: 'pend-1', source: 'fudo', external_product_id: '125', status: 'pending' }],
      [{
        id: 'map-1',
        location_id: LOCATION,
        source: 'fudo',
        external_product_id: '125',
        recipe_id: RECIPE,
        active: true,
      }],
      [],
      LOCATION,
    )
    expect(rows[0]).toMatchObject({
      recipe_id: RECIPE,
      recipe_name: null,
    })
  })
})

import { describe, expect, it } from 'vitest'
import type { PendingProduct } from './api'
import {
  FUDO_PRODUCT_FIELD_LABEL,
  filterFudoProductsByName,
  fudoProductAlreadyLinked,
  fudoProductDisplayName,
  fudoProductMatchesIdentity,
  linkableFudoProducts,
  mergeFudoPickerProducts,
} from './fudoProductPicker'

function pending(overrides: Partial<PendingProduct> = {}): PendingProduct {
  return {
    id: 'pend-1',
    location_id: 'loc',
    product_name: 'Americana',
    source: 'fudo',
    external_product_id: 'fudo-americana-99',
    status: 'pending',
    ...overrides,
  }
}

describe('picker opcional de Fudo', () => {
  it('busca por nombre o por id externo', () => {
    const products = [
      pending(),
      pending({
        id: 'pend-2',
        product_name: 'Sprite',
        external_product_id: 'sku-sprite',
      }),
      pending({
        id: 'pend-3',
        product_name: 'fernet branca y coca',
        external_product_id: '60',
      }),
    ]
    expect(filterFudoProductsByName(products, 'sprite').map((row) => row.product_name)).toEqual(['Sprite'])
    expect(filterFudoProductsByName(products, 'fernet').map((row) => row.external_product_id)).toEqual(['60'])
    expect(filterFudoProductsByName(products, '60').map((row) => row.product_name)).toEqual([
      'fernet branca y coca',
    ])
    expect(filterFudoProductsByName(products, 'fudo-americana-99').map((row) => row.product_name)).toEqual([
      'Americana',
    ])
    expect(FUDO_PRODUCT_FIELD_LABEL).toBe('Producto de Fudo (opcional)')
  })

  it('incluye resolved huérfanos y excluye los ya vinculados', () => {
    const products = [
      pending(),
      pending({
        id: 'orphan-60',
        product_name: 'fernet branca y coca',
        external_product_id: '60',
        status: 'resolved',
        mapping_id: null,
        recipe_id: null,
        mapping_active: null,
      }),
      pending({
        id: 'linked',
        product_name: 'Golden Ale',
        external_product_id: '10',
        status: 'resolved',
        mapping_id: 'map-1',
        recipe_id: 'recipe-1',
        mapping_active: true,
      }),
      pending({
        id: 'blank',
        product_name: '',
        external_product_id: 'only-id',
      }),
    ]
    expect(linkableFudoProducts(products).map((row) => row.external_product_id)).toEqual([
      'fudo-americana-99',
      '60',
    ])
    expect(fudoProductAlreadyLinked(products[2]!)).toBe(true)
    expect(fudoProductAlreadyLinked(products[1]!)).toBe(false)
    expect(fudoProductDisplayName(products[3]!)).toBeNull()
    expect(fudoProductMatchesIdentity(products[0]!, 'fudo', 'fudo-americana-99')).toBe(true)
    expect(fudoProductMatchesIdentity(products[0]!, 'fudo', 'otra')).toBe(false)
  })

  it('une catálogo activo con históricos ausentes y oculta inactivos', () => {
    const catalog = [
      pending({
        id: 'cat-17',
        product_name: 'American IPA',
        external_product_id: '17',
        status: 'linked',
        mapping_id: 'map-17',
        mapping_active: true,
        recipe_id: 'recipe-17',
        catalog_active: true,
      }),
      pending({
        id: 'cat-99',
        product_name: 'Nuevo sin venta',
        external_product_id: '99',
        status: 'catalog',
        catalog_active: true,
      }),
      pending({
        id: 'cat-off',
        product_name: 'Retirado',
        external_product_id: '200',
        status: 'catalog',
        catalog_active: false,
      }),
    ]
    const historical = [
      pending({
        id: 'hist-60',
        product_name: 'fernet branca y coca',
        external_product_id: '60',
        status: 'resolved',
        mapping_id: 'map-60',
        mapping_active: true,
        recipe_id: 'recipe-60',
      }),
      pending({
        id: 'hist-only',
        product_name: 'Solo ventas',
        external_product_id: '141',
        status: 'pending',
      }),
    ]
    const merged = mergeFudoPickerProducts(catalog, historical)
    expect(merged.map((row) => row.external_product_id)).toEqual(['17', '99', '200', '60', '141'])
    expect(linkableFudoProducts(merged).map((row) => row.external_product_id)).toEqual(['99', '141'])
  })
})

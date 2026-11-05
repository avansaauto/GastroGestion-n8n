import type { PendingProduct } from './api'
import { pendingProductIdentity, pendingProductName } from './pendingRecipe'

export const FUDO_PRODUCT_FIELD_LABEL = 'Producto de Fudo (opcional)'
export const FUDO_PRODUCT_LOCKED_NOTE = 'La vinculación Fudo existente no se modifica.'
export const FUDO_PRODUCT_EMPTY = 'No hay productos Fudo disponibles para vincular en este local.'
export const FUDO_PRODUCT_HINT =
  'Podés guardar la receta sin vincular. Buscá por nombre o por id de producto Fudo.'

/** Tiene mapping activo → ya vinculado; no debe ofrecerse de nuevo. */
export function fudoProductAlreadyLinked(product: PendingProduct) {
  if (product.mapping_active === false) return false
  if (product.mapping_active === true) return true
  if (typeof product.mapping_id === 'string' && product.mapping_id.trim()) return true
  if (typeof product.recipe_id === 'string' && product.recipe_id.trim()) return true
  return false
}

export function fudoProductDisplayName(product: PendingProduct) {
  const name = pendingProductName(product)
  return name === '—' ? null : name
}

/**
 * Vinculables: identidad + nombre, sin mapping activo.
 * Incluye `resolved` huérfanos (marcados resolved sin sales_product_mappings).
 */
/** Catálogo sincronizado marcado inactive: no se ofrece para nuevas vinculaciones. */
export function fudoProductCatalogInactive(product: PendingProduct) {
  return product.catalog_active === false
}

export function linkableFudoProducts(products: PendingProduct[]) {
  return products.filter((product) => {
    if (fudoProductAlreadyLinked(product)) return false
    if (fudoProductCatalogInactive(product)) return false
    return Boolean(pendingProductIdentity(product) && fudoProductDisplayName(product))
  })
}

/**
 * Selector de Crear receta:
 * - catálogo activo sin mapping
 * - históricos de pending que todavía no están en el catálogo
 * - inactivos del catálogo quedan fuera
 */
export function mergeFudoPickerProducts(
  catalog: PendingProduct[],
  historical: PendingProduct[],
) {
  const catalogIds = new Set(
    catalog
      .map((product) => pendingProductIdentity(product)?.externalProductId)
      .filter((id): id is string => Boolean(id)),
  )
  const extras = historical.filter((product) => {
    const id = pendingProductIdentity(product)?.externalProductId
    if (!id || catalogIds.has(id)) return false
    return product.source === 'fudo' || pendingProductIdentity(product)?.source === 'fudo'
  })
  return [...catalog, ...extras]
}

export function filterFudoProductsByName(products: PendingProduct[], search: string) {
  const term = search.trim().toLocaleLowerCase('es')
  const list = linkableFudoProducts(products)
  if (!term) return list
  return list.filter((product) => {
    const name = fudoProductDisplayName(product)
    const identity = pendingProductIdentity(product)
    const id = identity?.externalProductId?.toLocaleLowerCase('es') ?? ''
    return Boolean(
      (name && name.toLocaleLowerCase('es').includes(term))
      || (id && id.includes(term)),
    )
  })
}

export function fudoProductMatchesIdentity(
  product: PendingProduct,
  source: string,
  externalProductId: string,
) {
  const identity = pendingProductIdentity(product)
  return identity?.source === source && identity.externalProductId === externalProductId
}

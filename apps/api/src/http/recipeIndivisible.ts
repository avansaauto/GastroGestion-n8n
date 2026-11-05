/** Validación backend de consumos sobre insumos indivisibles (espejo SQL). */

export type RecipeIndivisibleProduct = {
  id: string
  baseUnit: string | null
  presentationUnit?: string | null
  conversionFactor?: number | null
  divisible?: boolean | null
  active?: boolean
}

export type RecipeComponentQuantity = {
  inventoryProductId: string
  quantity: number
}

function normalizePresentationUnit(unit: string | null | undefined): 'u' | null {
  const key = (unit ?? '').trim().toLowerCase()
  if (!key) return null
  if (['u', 'unit', 'unidad', 'unidades', 'un', 'unid'].includes(key)) return 'u'
  return null
}

/**
 * Cantidades de BOM están en unidad base.
 * Indivisible + presentación u + factor → quantity debe ser múltiplo del factor ≥ 1 u.
 */
export function assertRecipeComponentQuantities(
  organizationProducts: RecipeIndivisibleProduct[],
  components: RecipeComponentQuantity[],
): { ok: true } | { ok: false; code: 'INGREDIENT_NOT_IN_ORG' | 'INDIVISIBLE_QUANTITY' | 'INVALID_QUANTITY' } {
  const byId = new Map(organizationProducts.map((row) => [row.id, row]))

  for (const component of components) {
    if (!(component.quantity > 0) || !Number.isFinite(component.quantity)) {
      return { ok: false, code: 'INVALID_QUANTITY' }
    }
    const product = byId.get(component.inventoryProductId)
    if (!product || product.active === false) {
      return { ok: false, code: 'INGREDIENT_NOT_IN_ORG' }
    }

    const presentation = normalizePresentationUnit(product.presentationUnit)
    const factor = product.conversionFactor
    const base = (product.baseUnit ?? '').trim().toLowerCase()
    if (
      product.divisible === false
      && presentation === 'u'
      && factor != null
      && factor > 0
      && (base === 'g' || base === 'ml')
    ) {
      const units = component.quantity / factor
      if (Math.abs(units - Math.round(units)) > 1e-6 || units < 1) {
        return { ok: false, code: 'INDIVISIBLE_QUANTITY' }
      }
    }
  }

  return { ok: true }
}

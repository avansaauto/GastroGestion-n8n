function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function identityKey(source: string, externalProductId: string) {
  return `${source}::${externalProductId}`
}

function mappingForLocation(
  row: Record<string, unknown>,
  locationId: string,
): {
  id: string
  source: string
  externalProductId: string
  recipeId: string | null
  active: boolean
} | null {
  if (asString(row.location_id) !== locationId) return null
  const id = asString(row.id)
  const source = asString(row.source)
  const externalProductId = asString(row.external_product_id)
  if (!id || !source || !externalProductId) return null
  return {
    id,
    source,
    externalProductId,
    recipeId: asString(row.recipe_id),
    active: row.active !== false,
  }
}

export function attachPendingProductRelations(
  products: Record<string, unknown>[],
  mappings: Record<string, unknown>[],
  recipes: Record<string, unknown>[],
  locationId: string,
): Record<string, unknown>[] {
  const mappingByKey = new Map<string, ReturnType<typeof mappingForLocation> & object>()
  for (const row of mappings) {
    const mapping = mappingForLocation(row, locationId)
    if (!mapping) continue
    const key = identityKey(mapping.source, mapping.externalProductId)
    const current = mappingByKey.get(key)
    if (!current || (mapping.active && !current.active)) {
      mappingByKey.set(key, mapping)
    }
  }

  const recipeNameById = new Map<string, string>()
  for (const row of recipes) {
    const id = asString(row.id)
    const name = asString(row.name)
    if (id && name) recipeNameById.set(id, name)
  }

  return products.map((product) => {
    const source = asString(product.source) ?? asString(product.origin)
    const externalProductId = asString(product.external_product_id)
      ?? asString(product.fudo_product_id)
      ?? asString(product.external_id)
    const mapping = source && externalProductId
      ? mappingByKey.get(identityKey(source, externalProductId)) ?? null
      : null
    return {
      ...product,
      mapping_id: mapping?.id ?? null,
      mapping_active: mapping ? mapping.active : null,
      recipe_id: mapping?.recipeId ?? null,
      recipe_name: mapping?.recipeId ? recipeNameById.get(mapping.recipeId) ?? null : null,
    }
  })
}

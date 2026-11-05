export type ConfirmedMappingMemory = {
  descriptionNormalized: string
  inventoryProductId: string
  inventoryProduct: {
    id: string
    name: string
    baseUnit: string | null
  }
  conversionFactor: number | null
}

export type InvoiceMappingSuggestion = {
  kind: 'exact' | 'approximate'
  inventoryProductId: string
  inventoryProduct: ConfirmedMappingMemory['inventoryProduct']
  conversionFactor: number | null
  source: 'confirmed_mapping'
}

export type MatchableIngredient = {
  id: string
  name: string
  baseUnit: string | null
  organizationId?: string
  active?: boolean
}

export type ExistingIngredientMatch =
  | { status: 'none' }
  | { status: 'reuse'; product: MatchableIngredient }
  | { status: 'ambiguous' }
  | { status: 'unit_mismatch' }

/** Reutiliza solo un insumo activo, de la misma organización, con el mismo nombre y la misma unidad base. */
export function matchExistingIngredient(
  name: string,
  baseUnit: string,
  products: MatchableIngredient[],
  organizationId?: string | null,
): ExistingIngredientMatch {
  const target = normalizeInvoiceConcept(name)
  if (!target) return { status: 'none' }
  const sameName = products.filter((product) => {
    if (organizationId && product.organizationId && product.organizationId !== organizationId) return false
    if (product.active === false) return false
    return normalizeInvoiceConcept(product.name) === target
  })
  if (sameName.length === 0) return { status: 'none' }
  if (sameName.length > 1) return { status: 'ambiguous' }
  const [product] = sameName
  if (product.baseUnit !== baseUnit) return { status: 'unit_mismatch' }
  return { status: 'reuse', product }
}

export function normalizeInvoiceConcept(value: string | null | undefined): string {
  if (!value?.trim()) return ''
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokens(value: string): string[] {
  return value.split(' ').filter((part) => part.length >= 3)
}

function approximateMatch(left: string, right: string): boolean {
  if (!left || !right || left === right) return false
  if (left.includes(right) || right.includes(left)) return true
  const a = new Set(tokens(left))
  const b = new Set(tokens(right))
  if (a.size === 0 || b.size === 0) return false
  let overlap = 0
  for (const token of a) {
    if (b.has(token)) overlap += 1
  }
  return overlap / Math.min(a.size, b.size) >= 0.6
}

export function suggestFromConfirmedMemory(
  line: {
    original: { description: string | null; quantity: number | null }
    reviewed: { description: string | null; quantity: number | null }
    mappingStatus: string | null
    inventoryProductId: string | null
  },
  memories: ConfirmedMappingMemory[],
): InvoiceMappingSuggestion | null {
  if (line.mappingStatus === 'mapped' && line.inventoryProductId) return null
  const concept = normalizeInvoiceConcept(line.reviewed.description || line.original.description)
  if (!concept) return null

  const exactMatches = memories.filter((memory) => memory.descriptionNormalized === concept)
  const exactProductIds = new Set(exactMatches.map((memory) => memory.inventoryProductId))
  if (exactProductIds.size === 1) {
    const exact = exactMatches[0]
    return {
      kind: 'exact',
      inventoryProductId: exact.inventoryProductId,
      inventoryProduct: exact.inventoryProduct,
      conversionFactor: exact.conversionFactor,
      source: 'confirmed_mapping',
    }
  }

  const approximate = memories.find((memory) => approximateMatch(concept, memory.descriptionNormalized))
  if (!approximate) return null
  return {
    kind: 'approximate',
    inventoryProductId: approximate.inventoryProductId,
    inventoryProduct: approximate.inventoryProduct,
    conversionFactor: approximate.conversionFactor,
    source: 'confirmed_mapping',
  }
}

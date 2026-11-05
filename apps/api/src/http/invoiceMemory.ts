export type MappingSuggestionKind = 'exact' | 'approximate'

export type MemoryProduct = {
  id: string
  name: string
  baseUnit: string | null
}

export type InvoiceMappingSuggestion = {
  kind: MappingSuggestionKind
  inventoryProductId: string
  inventoryProduct: MemoryProduct
  conversionFactor: number | null
  source: 'confirmed_mapping'
}

export type ConfirmedMappingMemory = {
  descriptionNormalized: string
  inventoryProductId: string
  inventoryProduct: MemoryProduct
  conversionFactor: number | null
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

export function conversionFactorFromQuantities(
  invoiceQuantity: number | null,
  physicalQuantity: number | null,
): number | null {
  if (invoiceQuantity == null || invoiceQuantity <= 0 || physicalQuantity == null || physicalQuantity <= 0) {
    return null
  }
  return Number((physicalQuantity / invoiceQuantity).toFixed(6))
}

export function confirmedMemoryFromMappedLine(input: {
  mappingStatus: string | null
  originalDescription: string | null
  reviewedDescription: string | null
  invoiceQuantity: number | null
  physicalQuantity: number | null
  inventoryProductId: string | null
  inventoryProduct: MemoryProduct | null
}): ConfirmedMappingMemory | null {
  if (input.mappingStatus !== 'mapped') return null
  if (!input.inventoryProductId || !input.inventoryProduct) return null
  const descriptionNormalized = normalizeInvoiceConcept(
    input.reviewedDescription || input.originalDescription,
  )
  if (!descriptionNormalized) return null
  return {
    descriptionNormalized,
    inventoryProductId: input.inventoryProductId,
    inventoryProduct: input.inventoryProduct,
    conversionFactor: conversionFactorFromQuantities(input.invoiceQuantity, input.physicalQuantity),
  }
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

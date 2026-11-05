import type { InventoryProduct, OrganizationRecipeItem, PendingProduct } from './api'
import {
  convertRecipeQuantityToBase,
  defaultInputUnit,
  formatRecipeQuantity,
} from './recipeUnits'

export type RecipeIntent = 'create' | 'link'

export const RECIPE_YIELD_UNITS = [
  { value: 'unit', label: 'Unidades (u)' },
  { value: 'g', label: 'Gramos (g)' },
  { value: 'ml', label: 'Mililitros (ml)' },
] as const

const YIELD_UNIT_VALUES = new Set<string>(RECIPE_YIELD_UNITS.map((unit) => unit.value))

export type RecipeIngredientDraft = {
  inventoryProductId: string
  name: string
  baseUnit: string | null
  quantity: string
  inputUnit: string
  presentationUnit?: string | null
  conversionFactor?: number | null
  divisible?: boolean | null
}

export type CreateRecipeBody = {
  intent: 'create'
  source: string
  externalProductId: string
  name: string
  yieldQuantity: number
  yieldUnit: string
  components: Array<{ inventoryProductId: string; quantity: number }>
}

export type LinkRecipeBody = {
  intent: 'link'
  source: string
  externalProductId: string
  existingRecipeId: string
}

function text(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

export function pendingProductName(product: PendingProduct) {
  return text(product, ['product_name', 'external_product_name', 'fudo_product_name', 'name']) || '—'
}

export function pendingProductIdentity(product: PendingProduct) {
  const source = text(product, ['source', 'origin'])
  const externalProductId = text(product, ['external_product_id', 'fudo_product_id', 'external_id'])
  if (!source || !externalProductId) return null
  return { source, externalProductId }
}

export function pendingTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function formatPendingTimestamp(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function findPendingProduct(
  products: PendingProduct[],
  source: string,
  externalProductId: string,
) {
  return products.find((product) => {
    const identity = pendingProductIdentity(product)
    return identity?.source === source && identity.externalProductId === externalProductId
  }) ?? null
}

export function createPendingRecipePath(input: {
  source: string
  externalProductId: string
  intent?: RecipeIntent
}) {
  const query = new URLSearchParams({
    source: input.source,
    externalProductId: input.externalProductId,
  })
  if (input.intent === 'link') query.set('intent', 'link')
  return `/pendientes/crear?${query}`
}

export function createRecipePath(input?: {
  source?: string
  externalProductId?: string
  intent?: RecipeIntent
}) {
  if (!input?.source?.trim() || !input.externalProductId?.trim()) return '/recetas/crear'
  const query = new URLSearchParams({
    source: input.source.trim(),
    externalProductId: input.externalProductId.trim(),
  })
  if (input.intent === 'link') query.set('intent', 'link')
  return `/recetas/crear?${query}`
}

export function parseCreatePendingRecipeSearch(search: URLSearchParams) {
  const source = search.get('source')?.trim() ?? ''
  const externalProductId = search.get('externalProductId')?.trim() ?? ''
  const intent: RecipeIntent = search.get('intent') === 'link' ? 'link' : 'create'
  return { source, externalProductId, intent }
}

export function pendingRecipeScopeKey(
  organizationId: string,
  locationId: string,
  source: string,
  externalProductId: string,
) {
  return `${organizationId}::${locationId}::${source}::${externalProductId}`
}

export function pendingRecipeForScope<T>(loadedKey: string, scopeKey: string, value: T) {
  return loadedKey === scopeKey ? value : null
}

export function parseQuantityInput(value: string) {
  const trimmed = value.trim().replace(/\s/g, '').replace(',', '.')
  if (!trimmed) return null
  const quantity = Number(trimmed)
  return Number.isFinite(quantity) ? quantity : null
}

export function addRecipeIngredient(
  list: RecipeIngredientDraft[],
  product: InventoryProduct,
): { ok: true; list: RecipeIngredientDraft[] } | { ok: false; reason: 'duplicate' } {
  if (list.some((item) => item.inventoryProductId === product.id)) {
    return { ok: false, reason: 'duplicate' }
  }
  return {
    ok: true,
    list: [
      ...list,
      {
        inventoryProductId: product.id,
        name: product.name,
        baseUnit: product.baseUnit,
        quantity: '',
        inputUnit: defaultInputUnit(product.baseUnit, product),
        presentationUnit: product.presentationUnit ?? null,
        conversionFactor: product.conversionFactor ?? null,
        divisible: product.divisible ?? null,
      },
    ],
  }
}

export function removeRecipeIngredient(list: RecipeIngredientDraft[], inventoryProductId: string) {
  return list.filter((item) => item.inventoryProductId !== inventoryProductId)
}

export function convertedIngredientQuantity(draft: RecipeIngredientDraft) {
  const quantity = parseQuantityInput(draft.quantity)
  if (quantity == null || !(quantity > 0)) {
    return { ok: false as const, message: 'Indicá una cantidad mayor a cero.' }
  }
  const baseUnit = draft.baseUnit?.trim() ?? ''
  const fromUnit = draft.inputUnit.trim() || baseUnit
  if (!baseUnit || !fromUnit) {
    return { ok: false as const, message: 'El insumo no tiene una unidad de inventario utilizable.' }
  }
  const converted = convertRecipeQuantityToBase({
    quantity,
    fromUnit,
    baseUnit,
    presentationUnit: draft.presentationUnit,
    conversionFactor: draft.conversionFactor,
    divisible: draft.divisible,
  })
  if (converted.kind === 'ok') {
    return {
      ok: true as const,
      quantity: converted.quantity,
      baseUnit: converted.baseUnit,
      label: formatRecipeQuantity(converted.quantity, converted.baseUnit),
    }
  }
  if (converted.kind === 'invalid' && (fromUnit === 'unit' || fromUnit === 'u')) {
    return {
      ok: false as const,
      message: 'En unidades comerciales indicá una cantidad entera (sin fracciones).',
    }
  }
  if (converted.kind === 'equivalence_required') {
    return {
      ok: false as const,
      message: 'Esta presentación no tiene una equivalencia configurada. No se puede guardar una cantidad estimada.',
    }
  }
  if (converted.kind === 'incompatible' && draft.divisible === false) {
    return {
      ok: false as const,
      message: 'Este insumo no admite consumos parciales. Usá unidades completas.',
    }
  }
  return {
    ok: false as const,
    message: 'No se puede convertir esa unidad a la unidad del insumo.',
  }
}

export function ingredientConversionPreview(draft: RecipeIngredientDraft) {
  const converted = convertedIngredientQuantity(draft)
  if (!converted.ok) return converted.message
  const inputUnit = draft.inputUnit.trim() || converted.baseUnit
  if (inputUnit === converted.baseUnit) return `Unidad del insumo: ${converted.baseUnit}`
  return `Equivale a ${converted.label}`
}

export function createRecipePayload(input: {
  source: string
  externalProductId: string
  name: string
  yieldQuantity: string
  yieldUnit: string
  ingredients: RecipeIngredientDraft[]
}): { ok: true; body: CreateRecipeBody } | { ok: false; error: string } {
  const source = input.source.trim()
  const externalProductId = input.externalProductId.trim()
  if (!source || !externalProductId) {
    return { ok: false, error: 'Falta la identidad del producto Fudo.' }
  }
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Indicá el nombre de la receta.' }
  const yieldQuantity = parseQuantityInput(input.yieldQuantity)
  if (yieldQuantity == null || !(yieldQuantity > 0)) {
    return { ok: false, error: 'El rendimiento debe ser mayor a cero.' }
  }
  const yieldUnit = input.yieldUnit.trim().toLowerCase()
  if (!YIELD_UNIT_VALUES.has(yieldUnit)) {
    return { ok: false, error: 'La unidad de rendimiento no es válida.' }
  }

  const seen = new Set<string>()
  const components: CreateRecipeBody['components'] = []
  for (const ingredient of input.ingredients) {
    if (seen.has(ingredient.inventoryProductId)) {
      return { ok: false, error: 'Hay un ingrediente repetido.' }
    }
    seen.add(ingredient.inventoryProductId)
    const converted = convertedIngredientQuantity(ingredient)
    if (!converted.ok) {
      return { ok: false, error: `${ingredient.name}: ${converted.message}` }
    }
    components.push({
      inventoryProductId: ingredient.inventoryProductId,
      quantity: converted.quantity,
    })
  }

  return {
    ok: true,
    body: {
      intent: 'create',
      source,
      externalProductId,
      name,
      yieldQuantity,
      yieldUnit,
      components,
    },
  }
}

export function linkRecipePayload(input: {
  source: string
  externalProductId: string
  existingRecipeId: string
}): { ok: true; body: LinkRecipeBody } | { ok: false; error: string } {
  const source = input.source.trim()
  const externalProductId = input.externalProductId.trim()
  if (!source || !externalProductId) {
    return { ok: false, error: 'Falta la identidad del producto Fudo.' }
  }
  const existingRecipeId = input.existingRecipeId.trim()
  if (!existingRecipeId) return { ok: false, error: 'Indicá la receta a vincular.' }
  return {
    ok: true,
    body: {
      intent: 'link',
      source,
      externalProductId,
      existingRecipeId,
    },
  }
}

export function canBeginRecipeSave(saving: boolean) {
  return !saving
}

export function linkableOrganizationRecipes(recipes: OrganizationRecipeItem[]) {
  return recipes.filter((recipe) => recipe.active && recipe.recipeType === 'sale_product')
}

export function recipeSaveErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'No se pudo guardar la receta.'
}

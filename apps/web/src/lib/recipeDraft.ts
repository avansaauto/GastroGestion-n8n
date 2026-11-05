import {
  RecipeSaveApiError,
  type CreateOrganizationRecipeInput,
  type RecipeCategory,
  type RecipeComponentDetail,
  type RecipeDetail,
  type UpdateOrganizationRecipeInput,
} from './api'
import {
  recipeCategoryCreateFields,
  type RecipeCategorySelection,
} from './recipeCategories'
import {
  convertedIngredientQuantity,
  parseQuantityInput,
  RECIPE_YIELD_UNITS,
  recipeSaveErrorMessage,
  type RecipeIngredientDraft,
} from './pendingRecipe'
import { defaultInputUnit } from './recipeUnits'

const YIELD_UNIT_VALUES = new Set<string>(RECIPE_YIELD_UNITS.map((unit) => unit.value))

export type RecipeDraftProductType = 'none' | 'direct' | 'compound'

export type RecipeDraftLineReason = 'ok' | 'quantity' | 'conversion' | 'valuation'

export type RecipeDraftLineCost = {
  inventoryProductId: string
  quantity: number | null
  lineCost: number | null
  pending: boolean
  reason: RecipeDraftLineReason
  message: string | null
}

export type RecipeDraftCostSummary = {
  productType: RecipeDraftProductType
  totalCost: number | null
  costPerYield: number | null
  incomplete: boolean
  lines: RecipeDraftLineCost[]
}

export const RECIPE_SHARED_WARNING =
  'Esta receta se utiliza en otros locales. Los cambios en ingredientes o rendimiento también afectarán sus costos calculados.'
export const RECIPE_NESTED_BOM_UNAVAILABLE =
  'Esta receta tiene subrecetas y todavía no se puede editar.'
export const RECIPE_INACTIVE_UNAVAILABLE = 'Esta receta no está activa.'
export const RECIPE_CATEGORY_REQUIRED = 'Indicá la categoría.'
export const RECIPE_CATEGORY_NAME_REQUIRED = 'Indicá el nombre de la categoría.'
export const RECIPE_SALE_PRICE_UNAVAILABLE =
  'Todavía no se puede guardar un precio de venta por local.'
export const RECIPE_PRICE_UNIT_ONLY =
  'El precio se edita cuando el rendimiento es por unidad.'
export const RECIPE_PRICE_CONFLICT =
  'El precio cambió desde que lo abriste. Recargá e intentá de nuevo.'
export const RECIPE_PROFIT_UNAVAILABLE = 'La ganancia se calculará cuando exista un precio de venta.'
export const RECIPE_MARGIN_UNAVAILABLE = 'El margen se calculará cuando exista un precio de venta.'
export const RECIPE_PRICE_RETRY_NOTICE =
  'La receta se guardó. El precio de venta no. Reintentá el precio sin volver a crear la receta.'
export const RECIPE_PENDING_DISCARD_BLOCKED =
  'Todavía no se puede retirar un producto Fudo pendiente. El modelo solo admite pending o resolved; resolved significa receta vinculada. Un ocultamiento se repondría en la próxima sincronización o perdería la identidad histórica.'

export function recipeDraftProductType(ingredientCount: number): RecipeDraftProductType {
  if (ingredientCount <= 0) return 'none'
  if (ingredientCount === 1) return 'direct'
  return 'compound'
}

export function recipeDraftProductTypeLabel(type: RecipeDraftProductType) {
  if (type === 'none') return 'Sin consumo'
  if (type === 'direct') return 'Directo'
  return 'Compuesto'
}

export function recipeCategorySelectionFromValue(
  value: string,
  newName: string,
  categories: RecipeCategory[],
): RecipeCategorySelection | null {
  if (value === 'new') {
    const name = newName.trim()
    return name ? { kind: 'new', name } : { kind: 'new', name: '' }
  }
  if (!value) return null
  return categories.some((item) => item.id === value)
    ? { kind: 'existing', categoryId: value }
    : null
}

export function createOrganizationRecipePayload(input: {
  name: string
  yieldQuantity: string
  yieldUnit: string
  ingredients: RecipeIngredientDraft[]
  category: RecipeCategorySelection | null
  categories?: RecipeCategory[]
}): { ok: true; body: CreateOrganizationRecipeInput } | { ok: false; error: string } {
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
  if (!input.category) return { ok: false, error: RECIPE_CATEGORY_REQUIRED }
  if (input.category.kind === 'new' && !input.category.name.trim()) {
    return { ok: false, error: RECIPE_CATEGORY_NAME_REQUIRED }
  }

  const seen = new Set<string>()
  const components: NonNullable<CreateOrganizationRecipeInput['components']> = []
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

  const categoryFields = recipeCategoryCreateFields(input.category, input.categories)
  if (!categoryFields.categoryId && !categoryFields.categoryName) {
    return { ok: false, error: RECIPE_CATEGORY_REQUIRED }
  }

  return {
    ok: true,
    body: {
      name,
      yieldQuantity,
      yieldUnit,
      components,
      ...categoryFields,
    },
  }
}

export type RecipeUpdateExpected = UpdateOrganizationRecipeInput['expected']

export function recipeUpdateExpectedFromDetail(
  detail: Pick<RecipeDetail, 'name' | 'yieldQuantity' | 'yieldUnit' | 'category' | 'components'>,
): { ok: true; expected: RecipeUpdateExpected } | { ok: false; error: string } {
  if (detail.components.some((component) => component.componentRecipeId)) {
    return { ok: false, error: RECIPE_NESTED_BOM_UNAVAILABLE }
  }
  const components: RecipeUpdateExpected['components'] = []
  for (const component of detail.components) {
    if (!component.inventoryProductId || !(component.quantity > 0)) {
      return { ok: false, error: RECIPE_NESTED_BOM_UNAVAILABLE }
    }
    components.push({
      inventoryProductId: component.inventoryProductId,
      quantity: component.quantity,
    })
  }
  return {
    ok: true,
    expected: {
      name: detail.name,
      yieldQuantity: detail.yieldQuantity,
      yieldUnit: detail.yieldUnit,
      categoryId: detail.category?.id ?? null,
      components,
    },
  }
}

export function ingredientsFromRecipeDetail(
  components: RecipeComponentDetail[],
  inventoryById?: Map<string, {
    presentationUnit?: string | null
    conversionFactor?: number | null
    divisible?: boolean | null
  }>,
): { ok: true; ingredients: RecipeIngredientDraft[] } | { ok: false; error: string } {
  if (components.some((component) => component.componentRecipeId)) {
    return { ok: false, error: RECIPE_NESTED_BOM_UNAVAILABLE }
  }
  const ingredients: RecipeIngredientDraft[] = []
  for (const component of components) {
    if (!component.inventoryProductId) {
      return { ok: false, error: RECIPE_NESTED_BOM_UNAVAILABLE }
    }
    const presentation = inventoryById?.get(component.inventoryProductId)
    ingredients.push({
      inventoryProductId: component.inventoryProductId,
      name: component.name ?? 'Insumo',
      baseUnit: component.baseUnit,
      // Cantidades persistidas están en unidad base: se muestran en base.
      // No reinterpretar a u sin acción explícita del usuario.
      quantity: String(component.quantity),
      inputUnit: defaultInputUnit(component.baseUnit) || component.baseUnit || '',
      presentationUnit: presentation?.presentationUnit ?? null,
      conversionFactor: presentation?.conversionFactor ?? null,
      divisible: presentation?.divisible ?? null,
    })
  }
  return { ok: true, ingredients }
}

export function updateOrganizationRecipePayload(input: {
  name: string
  yieldQuantity: string
  yieldUnit: string
  ingredients: RecipeIngredientDraft[]
  category: RecipeCategorySelection | null
  categories?: RecipeCategory[]
  expected: RecipeUpdateExpected
}): { ok: true; body: UpdateOrganizationRecipeInput } | { ok: false; error: string } {
  const created = createOrganizationRecipePayload(input)
  if (!created.ok) return created
  return {
    ok: true,
    body: {
      ...created.body,
      expected: input.expected,
    },
  }
}

export function recipeSharedLocationWarning(sharedLocationCount: number) {
  return sharedLocationCount > 1 ? RECIPE_SHARED_WARNING : null
}

export function estimateRecipeDraftCost(input: {
  yieldQuantity: string
  ingredients: Array<RecipeIngredientDraft & { averageUnitCost?: number | null }>
}): RecipeDraftCostSummary {
  const productType = recipeDraftProductType(input.ingredients.length)
  if (input.ingredients.length === 0) {
    return {
      productType,
      totalCost: 0,
      costPerYield: 0,
      incomplete: false,
      lines: [],
    }
  }

  const yieldQuantity = parseQuantityInput(input.yieldQuantity)
  const lines: RecipeDraftLineCost[] = input.ingredients.map((ingredient) => {
    const converted = convertedIngredientQuantity(ingredient)
    if (!converted.ok) {
      const quantityIssue = converted.message.includes('mayor a cero')
      return {
        inventoryProductId: ingredient.inventoryProductId,
        quantity: null,
        lineCost: null,
        pending: true,
        reason: quantityIssue ? 'quantity' as const : 'conversion' as const,
        message: converted.message,
      }
    }
    const unitCost = ingredient.averageUnitCost
    if (unitCost == null || !Number.isFinite(unitCost)) {
      return {
        inventoryProductId: ingredient.inventoryProductId,
        quantity: converted.quantity,
        lineCost: null,
        pending: true,
        reason: 'valuation' as const,
        message: `${ingredient.name} necesita valuación en este local.`,
      }
    }
    return {
      inventoryProductId: ingredient.inventoryProductId,
      quantity: converted.quantity,
      lineCost: converted.quantity * unitCost,
      pending: false,
      reason: 'ok' as const,
      message: null,
    }
  })

  const incomplete = lines.some((line) => line.pending || line.lineCost == null)
    || yieldQuantity == null
    || !(yieldQuantity > 0)
  if (incomplete) {
    return {
      productType,
      totalCost: null,
      costPerYield: null,
      incomplete: true,
      lines,
    }
  }

  const totalCost = lines.reduce((sum, line) => sum + (line.lineCost ?? 0), 0)
  return {
    productType,
    totalCost,
    costPerYield: totalCost / yieldQuantity,
    incomplete: false,
    lines,
  }
}

export function recipeDraftLineCostLabel(
  summary: RecipeDraftCostSummary,
  inventoryProductId: string,
  formatCost: (value: number) => string,
) {
  const line = summary.lines.find((item) => item.inventoryProductId === inventoryProductId)
  if (!line) return 'Costo pendiente'
  if (line.reason === 'conversion' || line.reason === 'quantity') {
    return line.message || 'Costo pendiente'
  }
  if (line.reason === 'valuation' || line.pending || line.lineCost == null) return 'Costo pendiente'
  return formatCost(line.lineCost)
}

export function recipeDraftValuationHint(
  summary: RecipeDraftCostSummary,
  ingredients: Array<{ inventoryProductId: string; name: string }>,
) {
  const missing = new Set(
    summary.lines
      .filter((line) => line.reason === 'valuation')
      .map((line) => line.inventoryProductId),
  )
  const names = ingredients
    .filter((item) => missing.has(item.inventoryProductId))
    .map((item) => item.name)
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} necesita valuación en este local.`
  return `Estos ingredientes necesitan valuación en este local: ${names.join(', ')}.`
}

export function recipeDraftTotalCostLabel(
  summary: RecipeDraftCostSummary,
  formatCost: (value: number) => string,
) {
  if (summary.productType === 'none') return 'Sin consumo'
  if (summary.incomplete || summary.totalCost == null) return 'Costo pendiente'
  return formatCost(summary.totalCost)
}

export function recipeDraftCostPerYieldLabel(
  summary: RecipeDraftCostSummary,
  formatCost: (value: number) => string,
) {
  if (summary.productType === 'none') return 'Sin consumo'
  if (summary.incomplete || summary.costPerYield == null) return 'Costo pendiente'
  return formatCost(summary.costPerYield)
}

export function recipeDraftHasSellableYield(yieldQuantity: string, yieldUnit: string) {
  const quantity = parseQuantityInput(yieldQuantity)
  return yieldUnit === 'unit' && quantity != null && quantity > 0
}

export type RecipeDraftProfitability = {
  comparable: boolean
  salePrice: number | null
  profit: number | null
  marginPct: number | null
  markupPct: number | null
}

export function estimateRecipeDraftProfitability(
  summary: RecipeDraftCostSummary,
  salePrice: number | null,
  comparable: boolean,
): RecipeDraftProfitability {
  const priced = salePrice != null && Number.isFinite(salePrice) && salePrice > 0 ? salePrice : null
  if (!comparable || priced == null) {
    return { comparable, salePrice: priced, profit: null, marginPct: null, markupPct: null }
  }
  if (
    summary.incomplete
    || summary.costPerYield == null
    || !Number.isFinite(summary.costPerYield)
    || summary.costPerYield < 0
  ) {
    return { comparable, salePrice: priced, profit: null, marginPct: null, markupPct: null }
  }
  const profit = priced - summary.costPerYield
  return {
    comparable,
    salePrice: priced,
    profit,
    marginPct: (profit / priced) * 100,
    markupPct: summary.costPerYield > 0 ? (profit / summary.costPerYield) * 100 : null,
  }
}

export function recipeDraftPctLabel(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(value)}%`
}

export type RecipePricePersistPlan =
  | { kind: 'skip' }
  | { kind: 'invalid'; error: string }
  | { kind: 'save'; salePrice: number; expectedVersion: number | null }

export function planRecipePricePersist(input: {
  comparable: boolean
  draft: string
  parsed: number | null
  salePriceVersion: number | null
  max: number
}): RecipePricePersistPlan {
  const trimmed = input.draft.trim()
  if (!trimmed || trimmed === '—') return { kind: 'skip' }
  if (!input.comparable) return { kind: 'skip' }
  if (input.parsed == null || !Number.isFinite(input.parsed)) {
    return { kind: 'invalid', error: 'Indicá un precio de venta válido.' }
  }
  const salePrice = Math.round(input.parsed * 100) / 100
  if (!(salePrice > 0) || salePrice > input.max) {
    return { kind: 'invalid', error: 'Indicá un precio de venta válido.' }
  }
  return {
    kind: 'save',
    salePrice,
    expectedVersion:
      input.salePriceVersion != null && Number.isInteger(input.salePriceVersion) && input.salePriceVersion > 0
        ? input.salePriceVersion
        : null,
  }
}

export async function persistRecipeAndLocationPrice(input: {
  skipRecipe: boolean
  persistedRecipeId: string | null
  saveRecipe: () => Promise<{ recipeId: string }>
  pricePlan: Extract<RecipePricePersistPlan, { kind: 'skip' | 'save' }>
  savePrice: (
    recipeId: string,
    salePrice: number,
    expectedVersion: number | null,
  ) => Promise<{ salePrice: number; version: number }>
}): Promise<
  | { ok: true; recipeId: string; price: { salePrice: number; version: number } | null }
  | { ok: false; recipeId: string; error: string; conflict: boolean }
> {
  let recipeId = input.persistedRecipeId
  if (!input.skipRecipe || !recipeId) {
    recipeId = (await input.saveRecipe()).recipeId
  }
  if (input.pricePlan.kind === 'skip') {
    return { ok: true, recipeId, price: null }
  }
  try {
    const price = await input.savePrice(
      recipeId,
      input.pricePlan.salePrice,
      input.pricePlan.expectedVersion,
    )
    return { ok: true, recipeId, price }
  } catch (error) {
    const conflict = error instanceof RecipeSaveApiError && error.code === 'CONCURRENT_UPDATE'
    return {
      ok: false,
      recipeId,
      error: conflict ? RECIPE_PRICE_CONFLICT : recipeSaveErrorMessage(error),
      conflict,
    }
  }
}

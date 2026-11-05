import type { RecipeCategory, SaveFudoRecipeInput } from './api'
import type { RecipeCategorySelection } from './recipeCategories'
import {
  createRecipePayload,
  type RecipeIngredientDraft,
} from './pendingRecipe'
import { createOrganizationRecipePayload } from './recipeDraft'

export const FUDO_CREATE_CATEGORY_RPC_ENABLED = true

export type FudoCreatePlan =
  | { ok: false; error: string }
  | { ok: true; body: SaveFudoRecipeInput }

export function planFudoRecipeCreate(input: {
  source: string
  externalProductId: string
  name: string
  yieldQuantity: string
  yieldUnit: string
  ingredients: RecipeIngredientDraft[]
  category: RecipeCategorySelection | null
  categories?: RecipeCategory[]
}): FudoCreatePlan {
  if (!FUDO_CREATE_CATEGORY_RPC_ENABLED) {
    return {
      ok: false,
      error: 'El alta Fudo atómica con categoría todavía no está habilitada.',
    }
  }

  const org = createOrganizationRecipePayload({
    name: input.name,
    yieldQuantity: input.yieldQuantity,
    yieldUnit: input.yieldUnit,
    ingredients: input.ingredients,
    category: input.category,
    categories: input.categories,
  })
  if (!org.ok) return org

  const created = createRecipePayload({
    source: input.source,
    externalProductId: input.externalProductId,
    name: input.name,
    yieldQuantity: input.yieldQuantity,
    yieldUnit: input.yieldUnit,
    ingredients: input.ingredients,
  })
  if (!created.ok) return created

  const body: SaveFudoRecipeInput = { ...created.body }
  if (org.body.categoryId) body.categoryId = org.body.categoryId
  if (org.body.categoryName) body.categoryName = org.body.categoryName
  return { ok: true, body }
}

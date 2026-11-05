import type { CreateOrganizationRecipeInput, RecipeCategory } from './api'

export const ADD_RECIPE_CATEGORY_LABEL = '+ Agregar categoría'

export type RecipeCategoryTab = {
  id: string
  label: string
}

export type RecipeCategorySelection =
  | { kind: 'existing'; categoryId: string }
  | { kind: 'new'; name: string }

export function normalizeRecipeCategoryName(name: string) {
  return name.trim()
}

export function findRecipeCategoryByName(
  categories: RecipeCategory[],
  name: string,
): RecipeCategory | null {
  const key = normalizeRecipeCategoryName(name).toLocaleLowerCase('es')
  if (!key) return null
  return categories.find((item) => (
    item.name.trim().toLocaleLowerCase('es') === key
  )) ?? null
}

export function recipeCategoryTabs(categories: RecipeCategory[]): RecipeCategoryTab[] {
  return [
    { id: 'all', label: 'Todas' },
    ...categories.map((item) => ({ id: item.id, label: item.name })),
  ]
}

export function recipeCategoryCreateFields(
  selection: RecipeCategorySelection,
  categories: RecipeCategory[] = [],
): Pick<CreateOrganizationRecipeInput, 'categoryId' | 'categoryName'> {
  if (selection.kind === 'existing') {
    return { categoryId: selection.categoryId }
  }
  const existing = findRecipeCategoryByName(categories, selection.name)
  if (existing) return { categoryId: existing.id }
  const name = normalizeRecipeCategoryName(selection.name)
  return name ? { categoryName: name } : {}
}

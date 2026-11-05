import { describe, expect, it } from 'vitest'
import {
  FUDO_CREATE_CATEGORY_RPC_ENABLED,
  planFudoRecipeCreate,
} from './fudoRecipeCreate'
import { linkRecipePayload } from './pendingRecipe'

const TAPEO_ID = '15151515-1515-4151-8151-151515151515'
const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BARRIL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const base = {
  source: 'fudo',
  externalProductId: '0125',
  name: 'Pinta IPA',
  yieldQuantity: '1',
  yieldUnit: 'unit',
  ingredients: [] as [],
  category: { kind: 'existing' as const, categoryId: TAPEO_ID },
  categories: [{ id: TAPEO_ID, name: 'Tapeo' }],
}

describe('plan Fudo create', () => {
  it('usa un CREATE atómico con categoría existente', () => {
    expect(FUDO_CREATE_CATEGORY_RPC_ENABLED).toBe(true)
    const plan = planFudoRecipeCreate(base)
    expect(plan).toEqual({
      ok: true,
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: '0125',
        name: 'Pinta IPA',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [],
        categoryId: TAPEO_ID,
      },
    })
    if (!plan.ok) return
    expect(plan.body).not.toHaveProperty('categoryName')
    expect(plan.body).not.toHaveProperty('existingRecipeId')
  })

  it('envía categoryName para una categoría nueva y no duplica una existente por nombre', () => {
    const created = planFudoRecipeCreate({
      ...base,
      category: { kind: 'new', name: 'Brunch' },
      categories: base.categories,
    })
    expect(created).toMatchObject({
      ok: true,
      body: {
        intent: 'create',
        categoryName: 'Brunch',
        source: 'fudo',
        externalProductId: '0125',
      },
    })
    if (!created.ok) return
    expect(created.body).not.toHaveProperty('categoryId')

    const reused = planFudoRecipeCreate({
      ...base,
      category: { kind: 'new', name: ' tapeo ' },
      categories: base.categories,
    })
    expect(reused).toMatchObject({
      ok: true,
      body: { categoryId: TAPEO_ID },
    })
    if (!reused.ok) return
    expect(reused.body).not.toHaveProperty('categoryName')
  })

  it('incluye ingredientes e identidad Fudo en el mismo CREATE', () => {
    const plan = planFudoRecipeCreate({
      ...base,
      ingredients: [{
        inventoryProductId: BARRIL_ID,
        name: 'Barril IPA',
        baseUnit: 'ml',
        quantity: '330',
        inputUnit: 'ml',
      }],
    })
    expect(plan).toMatchObject({
      ok: true,
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: '0125',
        categoryId: TAPEO_ID,
        components: [{ inventoryProductId: BARRIL_ID, quantity: 330 }],
      },
    })
  })

  it('el reintento envía el mismo CREATE y no cae a LINK ni a dos operaciones', () => {
    const first = planFudoRecipeCreate(base)
    const retry = planFudoRecipeCreate(base)
    expect(first).toEqual(retry)
    if (!retry.ok) return
    expect(retry.body.intent).toBe('create')
    expect(retry.body.existingRecipeId).toBeUndefined()
  })

  it('LINK de receta existente no manda categoría ni ingredientes', () => {
    const linked = linkRecipePayload({
      source: 'fudo',
      externalProductId: '0125',
      existingRecipeId: RECIPE_ID,
    })
    expect(linked).toEqual({
      ok: true,
      body: {
        intent: 'link',
        source: 'fudo',
        externalProductId: '0125',
        existingRecipeId: RECIPE_ID,
      },
    })
    if (!linked.ok) return
    expect(linked.body).not.toHaveProperty('categoryId')
    expect(linked.body).not.toHaveProperty('categoryName')
    expect(linked.body).not.toHaveProperty('components')
    expect(linked.body).not.toHaveProperty('name')
  })

  it('exige categoría antes de armar el CREATE', () => {
    const plan = planFudoRecipeCreate({ ...base, category: null })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toMatch(/categoría/i)
  })
})

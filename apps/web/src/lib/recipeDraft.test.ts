import { describe, expect, it } from 'vitest'
import { RecipeSaveApiError } from './api'
import { ADD_RECIPE_CATEGORY_LABEL } from './recipeCategories'
import {
  RECIPE_CATEGORY_NAME_REQUIRED,
  RECIPE_CATEGORY_REQUIRED,
  RECIPE_NESTED_BOM_UNAVAILABLE,
  RECIPE_PRICE_CONFLICT,
  RECIPE_PRICE_RETRY_NOTICE,
  RECIPE_SHARED_WARNING,
  createOrganizationRecipePayload,
  estimateRecipeDraftCost,
  estimateRecipeDraftProfitability,
  ingredientsFromRecipeDetail,
  persistRecipeAndLocationPrice,
  planRecipePricePersist,
  recipeDraftCostPerYieldLabel,
  recipeDraftHasSellableYield,
  recipeDraftLineCostLabel,
  recipeDraftValuationHint,
  recipeDraftPctLabel,
  recipeDraftProductType,
  recipeDraftTotalCostLabel,
  recipeSharedLocationWarning,
  recipeUpdateExpectedFromDetail,
  updateOrganizationRecipePayload,
} from './recipeDraft'
import type { RecipeIngredientDraft } from './pendingRecipe'

const BARRIL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TAPEO_ID = '15151515-1515-4151-8151-151515151515'

function ingredient(overrides: Partial<RecipeIngredientDraft & { averageUnitCost?: number | null }> = {}) {
  return {
    inventoryProductId: BARRIL_ID,
    name: 'Barril IPA',
    baseUnit: 'l',
    quantity: '500',
    inputUnit: 'ml',
    averageUnitCost: 1000,
    ...overrides,
  }
}

describe('alta de receta sin Fudo', () => {
  it('exige categoría y no persiste una categoría nueva en el payload hasta confirmar', () => {
    expect(createOrganizationRecipePayload({
      name: 'Hamburguesa clásica',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [],
      category: null,
    })).toEqual({ ok: false, error: RECIPE_CATEGORY_REQUIRED })

    expect(createOrganizationRecipePayload({
      name: 'Hamburguesa clásica',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [],
      category: { kind: 'new', name: '   ' },
    })).toEqual({ ok: false, error: RECIPE_CATEGORY_NAME_REQUIRED })

    expect(createOrganizationRecipePayload({
      name: 'Hamburguesa clásica',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [],
      category: { kind: 'new', name: '  Tapeo  ' },
      categories: [{ id: TAPEO_ID, name: 'Tapeo' }],
    })).toEqual({
      ok: true,
      body: {
        name: 'Hamburguesa clásica',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [],
        categoryId: TAPEO_ID,
      },
    })

    expect(createOrganizationRecipePayload({
      name: 'Hamburguesa clásica',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [],
      category: { kind: 'new', name: 'Brunch' },
    })).toEqual({
      ok: true,
      body: {
        name: 'Hamburguesa clásica',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [],
        categoryName: 'Brunch',
      },
    })
    expect(ADD_RECIPE_CATEGORY_LABEL).toBe('+ Agregar categoría')
  })

  it('convierte cantidades a unidad base y rechaza conversiones desconocidas', () => {
    const created = createOrganizationRecipePayload({
      name: 'Pinta IPA',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [ingredient()],
      category: { kind: 'existing', categoryId: TAPEO_ID },
    })
    expect(created).toEqual({
      ok: true,
      body: {
        name: 'Pinta IPA',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [{ inventoryProductId: BARRIL_ID, quantity: 0.5 }],
        categoryId: TAPEO_ID,
      },
    })
    expect(createOrganizationRecipePayload({
      name: 'Pinta IPA',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [ingredient({ baseUnit: 'barril', inputUnit: 'ml' })],
      category: { kind: 'existing', categoryId: TAPEO_ID },
    }).ok).toBe(false)
  })
})

describe('costos del borrador', () => {
  it('deriva el tipo y no representa un costo desconocido como cero', () => {
    expect(recipeDraftProductType(0)).toBe('none')
    expect(recipeDraftProductType(1)).toBe('direct')
    expect(recipeDraftProductType(2)).toBe('compound')

    const empty = estimateRecipeDraftCost({ yieldQuantity: '1', ingredients: [] })
    expect(recipeDraftTotalCostLabel(empty, (value) => String(value))).toBe('Sin consumo')
    expect(recipeDraftCostPerYieldLabel(empty, (value) => String(value))).toBe('Sin consumo')

    const pending = estimateRecipeDraftCost({
      yieldQuantity: '1',
      ingredients: [ingredient({ averageUnitCost: null })],
    })
    expect(pending.incomplete).toBe(true)
    expect(pending.lines[0]?.reason).toBe('valuation')
    expect(recipeDraftTotalCostLabel(pending, (value) => String(value))).toBe('Costo pendiente')
    expect(pending.totalCost).toBeNull()
    expect(recipeDraftValuationHint(pending, [ingredient({ averageUnitCost: null })])).toBe(
      'Barril IPA necesita valuación en este local.',
    )

    const conversion = estimateRecipeDraftCost({
      yieldQuantity: '1',
      ingredients: [ingredient({ baseUnit: 'barril', inputUnit: 'ml' })],
    })
    expect(conversion.lines[0]?.reason).toBe('conversion')
    expect(recipeDraftLineCostLabel(conversion, BARRIL_ID, (value) => String(value))).toContain('equivalencia')
    expect(recipeDraftLineCostLabel(conversion, BARRIL_ID, (value) => String(value))).not.toBe('Costo pendiente')
    expect(recipeDraftValuationHint(conversion, [ingredient({ baseUnit: 'barril' })])).toBeNull()

    const ipa = estimateRecipeDraftCost({
      yieldQuantity: '1',
      ingredients: [ingredient({ name: 'IPA', baseUnit: 'l', quantity: '500', inputUnit: 'ml', averageUnitCost: 1320 })],
    })
    expect(ipa.incomplete).toBe(false)
    expect(ipa.lines[0]?.reason).toBe('ok')
    expect(ipa.lines[0]?.quantity).toBe(0.5)
    expect(ipa.totalCost).toBe(660)
    expect(ipa.costPerYield).toBe(660)
    expect(recipeDraftValuationHint(ipa, [ingredient({ name: 'IPA' })])).toBeNull()

    const ipaPending = estimateRecipeDraftCost({
      yieldQuantity: '1',
      ingredients: [ingredient({ name: 'IPA', averageUnitCost: null })],
    })
    expect(ipaPending.lines[0]?.reason).toBe('valuation')
    expect(recipeDraftValuationHint(ipaPending, [ingredient({ name: 'IPA' })])).toBe(
      'IPA necesita valuación en este local.',
    )

    const complete = estimateRecipeDraftCost({
      yieldQuantity: '2',
      ingredients: [ingredient()],
    })
    expect(complete.incomplete).toBe(false)
    expect(complete.totalCost).toBe(500)
    expect(complete.costPerYield).toBe(250)
  })

  it('calcula ganancia y margen solo con unidad vendible y costo conocido', () => {
    const ipaPour = estimateRecipeDraftCost({
      yieldQuantity: '1',
      ingredients: [ingredient({
        name: 'IPA',
        baseUnit: 'ml',
        quantity: '500',
        inputUnit: 'ml',
        averageUnitCost: 1.8,
      })],
    })
    expect(ipaPour.incomplete).toBe(false)
    expect(ipaPour.totalCost).toBe(900)
    const pricedIpa = estimateRecipeDraftProfitability(ipaPour, 8500, true)
    expect(pricedIpa.profit).toBe(7600)
    expect(pricedIpa.marginPct).toBeCloseTo(89.41, 2)

    const secondPurchase = estimateRecipeDraftCost({
      yieldQuantity: '1',
      ingredients: [ingredient({
        name: 'IPA',
        baseUnit: 'ml',
        quantity: '500',
        inputUnit: 'ml',
        averageUnitCost: 2,
      })],
    })
    expect(secondPurchase.totalCost).toBe(1000)
    const pricedSecond = estimateRecipeDraftProfitability(secondPurchase, 8500, true)
    expect(pricedSecond.profit).toBe(7500)
    expect(pricedSecond.marginPct).toBeCloseTo(88.24, 2)

    const liters = estimateRecipeDraftCost({
      yieldQuantity: '1',
      ingredients: [ingredient({
        name: 'IPA',
        baseUnit: 'l',
        quantity: '500',
        inputUnit: 'ml',
        averageUnitCost: 1800,
      })],
    })
    expect(liters.lines[0]?.quantity).toBe(0.5)
    expect(liters.totalCost).toBe(900)

    const honey = estimateRecipeDraftCost({
      yieldQuantity: '1',
      ingredients: [ingredient({ name: 'Honey', baseUnit: 'l', quantity: '500', inputUnit: 'ml', averageUnitCost: 1000 })],
    })
    expect(honey.totalCost).toBe(500)
    expect(honey.costPerYield).toBe(500)
    expect(recipeDraftHasSellableYield('1', 'unit')).toBe(true)
    expect(recipeDraftHasSellableYield('1', 'ml')).toBe(false)

    const priced = estimateRecipeDraftProfitability(honey, 4500, true)
    expect(priced.profit).toBe(4000)
    expect(priced.marginPct).toBeCloseTo((4000 / 4500) * 100)
    expect(priced.markupPct).toBeCloseTo(800)
    expect(recipeDraftPctLabel(priced.marginPct)).toBe('88,9%')

    const unknown = estimateRecipeDraftProfitability(
      estimateRecipeDraftCost({ yieldQuantity: '1', ingredients: [ingredient({ averageUnitCost: null })] }),
      4500,
      true,
    )
    expect(unknown.profit).toBeNull()
    expect(unknown.marginPct).toBeNull()

    const grams = estimateRecipeDraftProfitability(honey, 4500, false)
    expect(grams.profit).toBeNull()
    expect(grams.marginPct).toBeNull()

    const none = estimateRecipeDraftProfitability(
      estimateRecipeDraftCost({ yieldQuantity: '1', ingredients: [] }),
      1000,
      true,
    )
    expect(none.profit).toBe(1000)
    expect(none.marginPct).toBe(100)
    expect(none.markupPct).toBeNull()
  })

  it('coordina receta y precio sin duplicar el alta si el precio falla', async () => {
    expect(planRecipePricePersist({
      comparable: true,
      draft: '',
      parsed: null,
      salePriceVersion: null,
      max: 9999999999.99,
    }).kind).toBe('skip')
    expect(planRecipePricePersist({
      comparable: true,
      draft: '4.500',
      parsed: 4500,
      salePriceVersion: null,
      max: 9999999999.99,
    })).toEqual({ kind: 'save', salePrice: 4500, expectedVersion: null })
    expect(planRecipePricePersist({
      comparable: true,
      draft: '0',
      parsed: 0,
      salePriceVersion: 1,
      max: 9999999999.99,
    }).kind).toBe('invalid')

    let recipes = 0
    let prices = 0
    const saveRecipe = async () => {
      recipes += 1
      return { recipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
    }
    const savePrice = async () => {
      prices += 1
      throw new RecipeSaveApiError(RECIPE_PRICE_CONFLICT, 409, 'CONCURRENT_UPDATE')
    }
    const failed = await persistRecipeAndLocationPrice({
      skipRecipe: false,
      persistedRecipeId: null,
      saveRecipe,
      pricePlan: { kind: 'save', salePrice: 4500, expectedVersion: null },
      savePrice,
    })
    expect(failed).toMatchObject({
      ok: false,
      recipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      conflict: true,
    })
    expect(recipes).toBe(1)
    expect(prices).toBe(1)
    expect(RECIPE_PRICE_RETRY_NOTICE).toContain('sin volver a crear la receta')

    let retried = 0
    const retry = await persistRecipeAndLocationPrice({
      skipRecipe: true,
      persistedRecipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      saveRecipe,
      pricePlan: { kind: 'save', salePrice: 4500, expectedVersion: 2 },
      savePrice: async (_recipeId, salePrice, expectedVersion) => {
        retried += 1
        expect(expectedVersion).toBe(2)
        return { salePrice, version: 3 }
      },
    })
    expect(retry).toEqual({
      ok: true,
      recipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      price: { salePrice: 4500, version: 3 },
    })
    expect(recipes).toBe(1)
    expect(retried).toBe(1)
  })
})

describe('edición de receta', () => {
  const expected = {
    name: 'Pinta IPA',
    yieldQuantity: 1,
    yieldUnit: 'unit',
    categoryId: TAPEO_ID,
    components: [{ inventoryProductId: BARRIL_ID, quantity: 0.5 }],
  }

  it('arma el PATCH con huella expected y no crea la categoría hasta confirmar', () => {
    expect(updateOrganizationRecipePayload({
      name: 'Pinta IPA',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [ingredient()],
      category: { kind: 'existing', categoryId: TAPEO_ID },
      expected,
    })).toEqual({
      ok: true,
      body: {
        name: 'Pinta IPA',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [{ inventoryProductId: BARRIL_ID, quantity: 0.5 }],
        categoryId: TAPEO_ID,
        expected,
      },
    })
    expect(updateOrganizationRecipePayload({
      name: 'Pinta IPA',
      yieldQuantity: '2',
      yieldUnit: 'unit',
      ingredients: [],
      category: { kind: 'new', name: 'Brunch' },
      expected,
    })).toEqual({
      ok: true,
      body: {
        name: 'Pinta IPA',
        yieldQuantity: 2,
        yieldUnit: 'unit',
        components: [],
        categoryName: 'Brunch',
        expected,
      },
    })
  })

  it('precarga ingredientes reales y rechaza subrecetas', () => {
    expect(ingredientsFromRecipeDetail([{
      id: 'comp',
      inventoryProductId: BARRIL_ID,
      componentRecipeId: null,
      name: 'Barril IPA',
      baseUnit: 'l',
      quantity: 0.5,
      unitCost: 1000,
      lineCost: 500,
      costMissing: false,
    }])).toEqual({
      ok: true,
      ingredients: [{
        inventoryProductId: BARRIL_ID,
        name: 'Barril IPA',
        baseUnit: 'l',
        quantity: '0.5',
        inputUnit: 'l',
      }],
    })
    expect(recipeUpdateExpectedFromDetail({
      name: 'Pinta IPA',
      yieldQuantity: 1,
      yieldUnit: 'unit',
      category: { id: TAPEO_ID, name: 'Tapeo' },
      components: [{
        id: 'comp',
        inventoryProductId: BARRIL_ID,
        componentRecipeId: 'nested',
        name: 'Jarabe',
        baseUnit: null,
        quantity: 1,
        unitCost: null,
        lineCost: null,
        costMissing: true,
      }],
    })).toEqual({ ok: false, error: RECIPE_NESTED_BOM_UNAVAILABLE })
  })

  it('advierte recetas compartidas y no duplica por local', () => {
    expect(recipeSharedLocationWarning(1)).toBeNull()
    expect(recipeSharedLocationWarning(2)).toBe(RECIPE_SHARED_WARNING)
    expect(RECIPE_SHARED_WARNING).toBe(
      'Esta receta se utiliza en otros locales. Los cambios en ingredientes o rendimiento también afectarán sus costos calculados.',
    )
  })
})

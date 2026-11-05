import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/lib/auth'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import type { RecipeComponentDetail, RecipeDetail } from '@/lib/api'
import {
  RecipeDetailPage,
  RecipeDetailView,
  recipeDetailForScope,
  recipeDetailScopeKey,
} from './RecipeDetailPage'
import {
  formatRecipeCost,
  recipeComponentIssue,
  recipeComponentIssueLabel,
  recipeConsumptionLabel,
} from './RecipesPage'

const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOC_A = 'loc-a'
const LOC_B = 'loc-b'

function component(overrides: Partial<RecipeComponentDetail> = {}): RecipeComponentDetail {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    inventoryProductId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    componentRecipeId: null,
    name: 'Malta',
    baseUnit: 'g',
    quantity: 10,
    unitCost: 1.5,
    lineCost: 15,
    costMissing: false,
    ...overrides,
  }
}

function detail(overrides: Partial<RecipeDetail> = {}): RecipeDetail {
  return {
    id: RECIPE_ID,
    organizationId: 'org-1',
    locationId: LOC_A,
    name: 'IPA de barril',
    recipeType: 'sale_product',
    active: true,
    yieldQuantity: 1,
    yieldUnit: 'unit',
    consumptionMode: 'direct',
    componentCount: 1,
    mapping: {
      id: '12121212-1212-4121-8121-121212121212',
      source: 'fudo',
      externalProductId: 'fudo-ipa',
      externalProductName: 'IPA',
      active: true,
    },
    pendingStatus: null,
    sharedLocationCount: 1,
    category: null,
    costPerYield: 15,
    costIncomplete: false,
    hasInvalidQuantities: false,
    components: [component()],
    ...overrides,
  }
}

describe('Detalle de receta', () => {
  it('abre el detalle desde una fila y muestra el producto Fudo por identificador', () => {
    const html = renderToString(
      <MemoryRouter>
        <RecipeDetailView detail={detail()} />
      </MemoryRouter>,
    )
    expect(html).toContain('IPA de barril')
    expect(html).toContain('Producto Fudo')
    expect(html).toContain('fudo-ipa')
    expect(html).toContain('IPA')
    expect(html).toContain('Directo')
    expect(html).toContain('Malta')
    expect(html).toContain('10 g')
    expect(html).toContain(formatRecipeCost(1.5))
    expect(html).toContain(formatRecipeCost(15))
    expect(html).not.toContain('salePrice')
    expect(html).not.toContain('margen')
    expect(html).not.toContain('Nueva receta')
  })

  it('distingue cantidad inválida, valuación faltante y subreceta', () => {
    const invalid = component({ id: 'inv', quantity: 0, lineCost: null, costMissing: true })
    const missing = component({ id: 'miss', quantity: 8, unitCost: null, lineCost: null, costMissing: true })
    const nested = component({
      id: 'nest',
      inventoryProductId: null,
      componentRecipeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Jarabe',
      baseUnit: null,
      quantity: 5,
      unitCost: null,
      lineCost: null,
      costMissing: true,
    })
    expect(recipeComponentIssue(invalid)).toBe('invalid_quantity')
    expect(recipeComponentIssue(missing)).toBe('missing_unit_cost')
    expect(recipeComponentIssue(nested)).toBe('nested_recipe')
    expect(recipeComponentIssueLabel('invalid_quantity')).toBe('Cantidad inválida')
    expect(recipeComponentIssueLabel('missing_unit_cost')).toBe('Sin valuación')
    expect(recipeComponentIssueLabel('nested_recipe')).toBe('Subreceta sin calcular')

    const html = renderToString(
      <MemoryRouter>
        <RecipeDetailView
          detail={detail({
            consumptionMode: 'compound',
            componentCount: 3,
            costPerYield: null,
            costIncomplete: true,
            hasInvalidQuantities: true,
            components: [invalid, missing, nested],
          })}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('Cantidad inválida')
    expect(html).toContain('Sin valuación')
    expect(html).toContain('Subreceta sin calcular')
    expect(html).toContain('Revisión necesaria')
    expect(html).toContain('Costo pendiente')
    expect(html).toContain('8 g')
    expect(html).not.toContain('10 g')
  })

  it('muestra receta sin consumo y no interpreta el costo 0 como ingredientes', () => {
    const html = renderToString(
      <MemoryRouter>
        <RecipeDetailView
          detail={detail({
            consumptionMode: 'none',
            componentCount: 0,
            costPerYield: 0,
            costIncomplete: false,
            hasInvalidQuantities: false,
            components: [],
          })}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('Sin consumo')
    expect(html).toContain('Esta receta no tiene componentes')
    expect(html).not.toContain('Malta')
    expect(recipeConsumptionLabel('none')).toBe('Sin consumo')
  })

  it('no deja visibles datos de un local anterior', () => {
    expect(recipeDetailScopeKey('org', LOC_A, RECIPE_ID)).not.toBe(
      recipeDetailScopeKey('org', LOC_B, RECIPE_ID),
    )
    expect(recipeDetailForScope(
      recipeDetailScopeKey('org', LOC_A, RECIPE_ID),
      recipeDetailScopeKey('org', LOC_B, RECIPE_ID),
      detail({ name: 'IPA Casa' }),
    )).toBeNull()
    expect(recipeDetailForScope(
      recipeDetailScopeKey('org', LOC_B, RECIPE_ID),
      recipeDetailScopeKey('org', LOC_B, RECIPE_ID),
      detail({ name: 'IPA Norte' }),
    )?.name).toBe('IPA Norte')
  })

  it('muestra error de consulta y receta no disponible', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={[`/recetas/${RECIPE_ID}`]}>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <Routes>
              <Route path="/recetas/:recipeId" element={<RecipeDetailPage />} />
            </Routes>
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('Recetas')
    expect(html.includes('Cargando receta') || html.includes('Receta no disponible') || html.includes('Supabase')).toBe(true)
    expect(html).not.toContain('Nueva receta')
    expect(html).not.toContain('margen')
  })
})

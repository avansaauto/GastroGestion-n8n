import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/lib/auth'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import { canBeginRecipeSave } from '@/lib/pendingRecipe'
import {
  RECIPE_INACTIVE_UNAVAILABLE,
  RECIPE_NESTED_BOM_UNAVAILABLE,
  RECIPE_SHARED_WARNING,
  ingredientsFromRecipeDetail,
  recipeSharedLocationWarning,
  recipeUpdateExpectedFromDetail,
  updateOrganizationRecipePayload,
} from '@/lib/recipeDraft'
import { CreateRecipeForm } from './CreateRecipePage'
import {
  EditRecipePage,
  FUDO_PRODUCT_ID_LOCKED,
  editRecipePath,
} from './EditRecipePage'

const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TAPEO_ID = '15151515-1515-4151-8151-151515151515'
const BARRIL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('ruta de edición', () => {
  it('abre /recetas/:id/editar y no llama al alta', () => {
    expect(editRecipePath(RECIPE_ID)).toBe(`/recetas/${RECIPE_ID}/editar`)
    const html = renderToString(
      <MemoryRouter initialEntries={[editRecipePath(RECIPE_ID)]}>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <EditRecipePage />
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('Editar receta')
    expect(html).toContain('href="/recetas"')
    expect(html).toContain('Cancelar no guarda nada')
  })
})

describe('precarga y guardado de edición', () => {
  const expected = recipeUpdateExpectedFromDetail({
    name: 'Pinta IPA',
    yieldQuantity: 1,
    yieldUnit: 'unit',
    category: { id: TAPEO_ID, name: 'Tapeo' },
    components: [{
      id: 'comp',
      inventoryProductId: BARRIL_ID,
      componentRecipeId: null,
      name: 'Barril IPA',
      baseUnit: 'l',
      quantity: 0.5,
      unitCost: null,
      lineCost: null,
      costMissing: true,
    }],
  })

  it('precarga nombre, categoría, rendimiento e ingredientes', () => {
    expect(expected.ok).toBe(true)
    const preloaded = ingredientsFromRecipeDetail([{
      id: 'comp',
      inventoryProductId: BARRIL_ID,
      componentRecipeId: null,
      name: 'Barril IPA',
      baseUnit: 'l',
      quantity: 0.5,
      unitCost: null,
      lineCost: null,
      costMissing: true,
    }])
    expect(preloaded).toMatchObject({
      ok: true,
      ingredients: [{
        inventoryProductId: BARRIL_ID,
        name: 'Barril IPA',
        quantity: '0.5',
      }],
    })
  })

  it('cambia nombre, categoría nueva, rendimiento e ingredientes en el mismo payload', () => {
    if (!expected.ok) throw new Error('expected')
    const updated = updateOrganizationRecipePayload({
      name: 'Pinta nueva',
      yieldQuantity: '2',
      yieldUnit: 'unit',
      ingredients: [{
        inventoryProductId: BARRIL_ID,
        name: 'Barril IPA',
        baseUnit: 'l',
        quantity: '300',
        inputUnit: 'ml',
      }],
      category: { kind: 'new', name: 'Brunch' },
      expected: expected.expected,
    })
    expect(updated).toMatchObject({
      ok: true,
      body: {
        name: 'Pinta nueva',
        yieldQuantity: 2,
        categoryName: 'Brunch',
        components: [{ inventoryProductId: BARRIL_ID, quantity: 0.3 }],
        expected: expected.expected,
      },
    })
  })

  it('cancelar es un enlace a /recetas y el doble envío queda bloqueado', () => {
    expect(canBeginRecipeSave(true)).toBe(false)
    const html = renderToString(
      <MemoryRouter>
        <CreateRecipeForm
          intent="create"
          fudoSource="fudo"
          fudoExternalProductId="0125"
          fudoProductName="Pinta Fudo"
          fudoReadOnlyNote={FUDO_PRODUCT_ID_LOCKED}
          recipeName="Pinta IPA"
          onRecipeName={() => undefined}
          categoryValue={TAPEO_ID}
          onCategoryValue={() => undefined}
          categoryName=""
          onCategoryName={() => undefined}
          categories={[{ id: TAPEO_ID, name: 'Tapeo' }]}
          yieldQuantity="1"
          onYieldQuantity={() => undefined}
          yieldUnit="unit"
          onYieldUnit={() => undefined}
          ingredientSearch=""
          onIngredientSearch={() => undefined}
          inventoryMatches={[]}
          ingredients={[{
            inventoryProductId: BARRIL_ID,
            name: 'Barril IPA',
            baseUnit: 'l',
            quantity: '0.5',
            inputUnit: 'l',
            averageUnitCost: null,
          }]}
          onAddIngredient={() => undefined}
          onRemoveIngredient={() => undefined}
          onIngredientQuantity={() => undefined}
          onIngredientUnit={() => undefined}
          recipeSearch=""
          onRecipeSearch={() => undefined}
          recipes={[]}
          selectedRecipeId=""
          onSelectRecipe={() => undefined}
          saving
          saveError="La receta cambió desde que la abriste. Recargá e intentá de nuevo."
          canSubmit
          onSubmit={() => undefined}
          notice={RECIPE_SHARED_WARNING}
          submitLabel="Guardar cambios"
        />
      </MemoryRouter>,
    )
    expect(html).toContain('href="/recetas"')
    expect(html).toContain('Cancelar')
    expect(html).toContain('Guardando…')
    expect(html).toContain('disabled')
    expect(html).toContain('La receta cambió desde que la abriste. Recargá e intentá de nuevo.')
    expect(html).toContain(RECIPE_SHARED_WARNING)
    expect(html).not.toContain(FUDO_PRODUCT_ID_LOCKED)
    expect(html).not.toContain('Producto Fudo')
    expect(html).toContain('Costo pendiente')
    expect(html).toContain('Barril IPA necesita valuación en este local.')
  })

  it('no duplica recetas por local y rechaza subrecetas o inactivas', () => {
    expect(recipeSharedLocationWarning(3)).toBe(RECIPE_SHARED_WARNING)
    expect(RECIPE_INACTIVE_UNAVAILABLE).toBe('Esta receta no está activa.')
    expect(recipeUpdateExpectedFromDetail({
      name: 'Pinta IPA',
      yieldQuantity: 1,
      yieldUnit: 'unit',
      category: null,
      components: [{
        id: 'nested',
        inventoryProductId: null,
        componentRecipeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'Jarabe',
        baseUnit: null,
        quantity: 1,
        unitCost: null,
        lineCost: null,
        costMissing: true,
      }],
    })).toEqual({ ok: false, error: RECIPE_NESTED_BOM_UNAVAILABLE })
  })
})

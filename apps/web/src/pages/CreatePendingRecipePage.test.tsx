import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/lib/auth'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import type { InventoryProduct, OrganizationRecipeItem } from '@/lib/api'
import { RecipeSaveApiError } from '@/lib/api'
import {
  addRecipeIngredient,
  canBeginRecipeSave,
  createPendingRecipePath,
  createRecipePayload,
  findPendingProduct,
  linkRecipePayload,
  linkableOrganizationRecipes,
  parseCreatePendingRecipeSearch,
  pendingProductIdentity,
  pendingRecipeForScope,
  pendingRecipeScopeKey,
  recipeSaveErrorMessage,
  removeRecipeIngredient,
  type RecipeIngredientDraft,
} from '@/lib/pendingRecipe'
import {
  CreatePendingRecipeForm,
  CreatePendingRecipePage,
} from './CreatePendingRecipePage'

const BARRIL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const barril: InventoryProduct = {
  id: BARRIL_ID,
  organizationId: 'org',
  name: 'Barril IPA',
  baseUnit: 'l',
  active: true,
  onHand: null,
}

const pinta: OrganizationRecipeItem = {
  id: RECIPE_ID,
  name: 'Pinta IPA',
  recipeType: 'sale_product',
  active: true,
  yieldQuantity: 1,
  yieldUnit: 'unit',
  consumptionMode: 'direct',
  componentCount: 1,
  category: null,
}

function ingredient(overrides: Partial<RecipeIngredientDraft> = {}): RecipeIngredientDraft {
  return {
    inventoryProductId: BARRIL_ID,
    name: 'Barril IPA',
    baseUnit: 'l',
    quantity: '500',
    inputUnit: 'ml',
    ...overrides,
  }
}

const formProps: Parameters<typeof CreatePendingRecipeForm>[0] = {
  intent: 'create',
  source: 'fudo',
  externalProductId: 'fudo-pinta-ipa',
  productName: 'Pinta IPA',
  createPath: createPendingRecipePath({ source: 'fudo', externalProductId: 'fudo-pinta-ipa' }),
  linkPath: createPendingRecipePath({ source: 'fudo', externalProductId: 'fudo-pinta-ipa', intent: 'link' }),
  recipeName: 'Pinta IPA',
  onRecipeName: () => undefined,
  yieldQuantity: '1',
  onYieldQuantity: () => undefined,
  yieldUnit: 'unit',
  onYieldUnit: () => undefined,
  ingredientSearch: '',
  onIngredientSearch: () => undefined,
  inventoryMatches: [] as InventoryProduct[],
  ingredients: [] as RecipeIngredientDraft[],
  onAddIngredient: () => undefined,
  onRemoveIngredient: () => undefined,
  onIngredientQuantity: () => undefined,
  onIngredientUnit: () => undefined,
  recipeSearch: '',
  onRecipeSearch: () => undefined,
  recipes: [] as OrganizationRecipeItem[],
  selectedRecipeId: '',
  onSelectRecipe: () => undefined,
  saving: false,
  saveError: '',
  canSubmit: true,
  onSubmit: () => undefined,
}

function formHtml(overrides: Partial<typeof formProps> = {}) {
  return renderToString(
    <MemoryRouter>
      <CreatePendingRecipeForm {...formProps} {...overrides} />
    </MemoryRouter>,
  )
}

describe('apertura desde un pendiente', () => {
  it('conserva source y externalProductId, no el nombre', () => {
    const path = createPendingRecipePath({
      source: 'fudo',
      externalProductId: 'fudo-pinta-ipa',
    })
    expect(path).toBe('/pendientes/crear?source=fudo&externalProductId=fudo-pinta-ipa')
    expect(path).not.toContain('Pinta')
    expect(parseCreatePendingRecipeSearch(new URLSearchParams(path.split('?')[1]))).toEqual({
      source: 'fudo',
      externalProductId: 'fudo-pinta-ipa',
      intent: 'create',
    })
    expect(pendingProductIdentity({
      id: '1',
      location_id: 'loc',
      product_name: 'Pinta IPA',
      source: 'fudo',
      external_product_id: 'fudo-pinta-ipa',
    })).toEqual({ source: 'fudo', externalProductId: 'fudo-pinta-ipa' })
    expect(findPendingProduct([{
      id: '1',
      location_id: 'loc',
      product_name: 'Pinta IPA',
      source: 'fudo',
      external_product_id: 'otra',
    }], 'fudo', 'fudo-pinta-ipa')).toBeNull()
  })

  it('muestra el producto Fudo y las acciones de crear o vincular', () => {
    const html = formHtml()
    expect(html).toContain('Producto Fudo')
    expect(html).toContain('Pinta IPA')
    expect(html).toContain('fudo-pinta-ipa')
    expect(html).toContain('fudo')
    expect(html).toContain('Crear receta')
    expect(html).toContain('Vincular receta existente')
    expect(html).toContain('/pendientes/crear?source=fudo&amp;externalProductId=fudo-pinta-ipa')
  })
})

describe('ingredientes, cantidades y unidades', () => {
  it('agrega, evita duplicados y quita insumos reales', () => {
    const added = addRecipeIngredient([], barril)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.list[0]?.inputUnit).toBe('l')
    expect(addRecipeIngredient(added.list, barril)).toEqual({ ok: false, reason: 'duplicate' })
    expect(removeRecipeIngredient(added.list, BARRIL_ID)).toEqual([])
  })

  it('convierte 500 ml a 0,5 l para Barril IPA y no guarda si no puede convertir', () => {
    const created = createRecipePayload({
      source: 'fudo',
      externalProductId: 'fudo-pinta-ipa',
      name: 'Pinta IPA',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [ingredient()],
    })
    expect(created).toEqual({
      ok: true,
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: 'fudo-pinta-ipa',
        name: 'Pinta IPA',
        yieldQuantity: 1,
        yieldUnit: 'unit',
        components: [{ inventoryProductId: BARRIL_ID, quantity: 0.5 }],
      },
    })

    const blocked = createRecipePayload({
      source: 'fudo',
      externalProductId: 'fudo-pinta-ipa',
      name: 'Pinta IPA',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [ingredient({ baseUnit: 'barril', inputUnit: 'ml' })],
    })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.error).toContain('equivalencia')
  })

  it('rechaza cantidades inválidas y permite crear sin consumo', () => {
    expect(createRecipePayload({
      source: 'fudo',
      externalProductId: 'fudo-pinta-ipa',
      name: 'Pinta IPA',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [ingredient({ quantity: '0' })],
    }).ok).toBe(false)
    expect(createRecipePayload({
      source: 'fudo',
      externalProductId: 'fudo-pinta-ipa',
      name: 'Pinta IPA',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [],
    })).toMatchObject({
      ok: true,
      body: { intent: 'create', components: [] },
    })
  })

  it('muestra la unidad del insumo y la equivalencia convertida', () => {
    const html = formHtml({
      ingredients: [ingredient()],
    })
    expect(html).toContain('Barril IPA')
    expect(html).toContain('Unidad del insumo: Litros')
    expect(html).toContain('(l)')
    expect(html).toContain('Equivale a 0,5 l')
    expect(html).toContain('value="ml"')
    expect(html).toContain('value="l"')
  })
})

describe('CREATE y LINK', () => {
  it('arma CREATE con ingredientes y LINK solo con existingRecipeId', () => {
    const created = createRecipePayload({
      source: 'fudo',
      externalProductId: 'fudo-pinta-ipa',
      name: 'Pinta IPA',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [ingredient()],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.body.intent).toBe('create')
    expect(created.body).not.toHaveProperty('existingRecipeId')

    const linked = linkRecipePayload({
      source: 'fudo',
      externalProductId: 'fudo-pinta-ipa',
      existingRecipeId: RECIPE_ID,
    })
    expect(linked).toEqual({
      ok: true,
      body: {
        intent: 'link',
        source: 'fudo',
        externalProductId: 'fudo-pinta-ipa',
        existingRecipeId: RECIPE_ID,
      },
    })
    expect(linked.ok && 'components' in linked.body).toBe(false)
  })

  it('no ofrece recetas inactivas o de preparación', () => {
    const html = formHtml({
      intent: 'link',
      recipes: [pinta],
      selectedRecipeId: RECIPE_ID,
    })
    expect(html).toContain('Vincular receta')
    expect(html).toContain('Pinta IPA')
    expect(html).toContain('Seleccionada')
    expect(html).toContain('Vincular no modifica los ingredientes')
    expect(linkableOrganizationRecipes([
      pinta,
      { ...pinta, id: 'prep', name: 'Jarabe', recipeType: 'preparation' },
      { ...pinta, id: 'off', name: 'IPA vieja', active: false },
    ]).map((recipe) => recipe.name)).toEqual(['Pinta IPA'])
  })
})

describe('errores, local y doble envío', () => {
  it('muestra el error del POST y no afirma que se guardó', () => {
    const html = formHtml({
      saveError: 'Ya existe una receta con ese nombre.',
    })
    expect(html).toContain('Ya existe una receta con ese nombre.')
    expect(html).not.toContain('Receta guardada')
    expect(recipeSaveErrorMessage(
      new RecipeSaveApiError('Ese producto Fudo ya está vinculado a otra receta.', 409, 'ALREADY_LINKED'),
    )).toBe('Ese producto Fudo ya está vinculado a otra receta.')
    expect(recipeSaveErrorMessage(
      new RecipeSaveApiError('Esta receta no está activa.', 409, 'RECIPE_INACTIVE'),
    )).toBe('Esta receta no está activa.')
  })

  it('oculta el pendiente de un local anterior', () => {
    const locA = pendingRecipeScopeKey('org', 'loc-a', 'fudo', 'fudo-pinta-ipa')
    const locB = pendingRecipeScopeKey('org', 'loc-b', 'fudo', 'fudo-pinta-ipa')
    expect(locA).not.toBe(locB)
    expect(pendingRecipeForScope(locA, locB, {
      id: '1',
      location_id: 'loc-a',
      product_name: 'Pinta IPA',
    })).toBeNull()
  })

  it('deshabilita el botón y evita un segundo envío', () => {
    const html = formHtml({ saving: true, canSubmit: true })
    expect(html).toContain('Guardando…')
    expect(html).toContain('disabled')
    expect(canBeginRecipeSave(true)).toBe(false)
    expect(canBeginRecipeSave(false)).toBe(true)
  })
})

describe('página crear receta', () => {
  it('usa el local global y no duplica selectores', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/pendientes/crear?source=fudo&externalProductId=fudo-pinta-ipa']}>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <CreatePendingRecipePage />
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('Crear receta')
    expect(html).not.toContain('>Organización<')
    expect(html).not.toContain('>Local<')
  })
})

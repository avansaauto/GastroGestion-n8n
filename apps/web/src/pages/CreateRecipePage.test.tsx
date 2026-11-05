import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/lib/auth'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import { RecipeSaveApiError, type InventoryProduct, type OrganizationRecipeItem } from '@/lib/api'
import { ADD_RECIPE_CATEGORY_LABEL } from '@/lib/recipeCategories'
import { FUDO_CREATE_CATEGORY_RPC_ENABLED, planFudoRecipeCreate } from '@/lib/fudoRecipeCreate'
import {
  RECIPE_MARGIN_UNAVAILABLE,
  RECIPE_PRICE_RETRY_NOTICE,
  RECIPE_PRICE_UNIT_ONLY,
  RECIPE_PROFIT_UNAVAILABLE,
  RECIPE_SHARED_WARNING,
  createOrganizationRecipePayload,
} from '@/lib/recipeDraft'
import { formatRecipeCost } from './RecipesPage'
import {
  canBeginRecipeSave,
  createRecipePath,
  linkRecipePayload,
  parseCreatePendingRecipeSearch,
} from '@/lib/pendingRecipe'
import { CreateRecipeForm, CreateRecipePage } from './CreateRecipePage'

const BARRIL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TAPEO_ID = '15151515-1515-4151-8151-151515151515'

const barril: InventoryProduct = {
  id: BARRIL_ID,
  organizationId: 'org',
  name: 'Barril IPA',
  baseUnit: 'l',
  active: true,
  onHand: null,
  averageUnitCost: 1000,
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
  category: { id: TAPEO_ID, name: 'Tapeo' },
}

const formProps: Parameters<typeof CreateRecipeForm>[0] = {
  intent: 'create',
  fudoSource: '',
  fudoExternalProductId: '',
  fudoProductName: '',
  recipeName: 'Hamburguesa clásica',
  onRecipeName: () => undefined,
  categoryValue: TAPEO_ID,
  onCategoryValue: () => undefined,
  categoryName: '',
  onCategoryName: () => undefined,
  categories: [{ id: TAPEO_ID, name: 'Tapeo' }],
  yieldQuantity: '1',
  onYieldQuantity: () => undefined,
  yieldUnit: 'unit',
  onYieldUnit: () => undefined,
  ingredientSearch: '',
  onIngredientSearch: () => undefined,
  inventoryMatches: [barril],
  ingredients: [],
  onAddIngredient: () => undefined,
  onRemoveIngredient: () => undefined,
  onIngredientQuantity: () => undefined,
  onIngredientUnit: () => undefined,
  recipeSearch: '',
  onRecipeSearch: () => undefined,
  recipes: [],
  selectedRecipeId: '',
  onSelectRecipe: () => undefined,
  saving: false,
  saveError: '',
  canSubmit: true,
  onSubmit: () => undefined,
  salePriceDraft: '',
  onSalePriceDraft: () => undefined,
}

function formHtml(overrides: Partial<typeof formProps> = {}) {
  return renderToString(
    <MemoryRouter>
      <CreateRecipeForm {...formProps} {...overrides} />
    </MemoryRouter>,
  )
}

describe('ruta y apertura', () => {
  it('abre el alta general y conserva la identidad Fudo cuando viene de un pendiente', () => {
    expect(createRecipePath()).toBe('/recetas/crear')
    expect(createRecipePath({
      source: 'fudo',
      externalProductId: '0125',
    })).toBe('/recetas/crear?source=fudo&externalProductId=0125')
    expect(parseCreatePendingRecipeSearch(new URLSearchParams('source=fudo&externalProductId=0125&intent=link'))).toEqual({
      source: 'fudo',
      externalProductId: '0125',
      intent: 'link',
    })

    const html = renderToString(
      <MemoryRouter initialEntries={['/recetas/crear']}>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <CreateRecipePage />
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('Crear receta')
    expect(html).toContain('href="/recetas"')
    expect(html).not.toContain('>Organización<')
    expect(html).not.toContain('>Local<')
  })
})

describe('formulario de creación', () => {
  it('muestra información básica e ingredientes, sin tipo de producto técnico', () => {
    const html = formHtml()
    expect(html).toContain('Información básica')
    expect(html).toContain('Nombre de receta')
    expect(html).toContain('Categoría')
    expect(html).toContain('Tapeo')
    expect(html).toContain(ADD_RECIPE_CATEGORY_LABEL)
    expect(html).not.toContain('Tipo de producto')
    expect(html).not.toContain('>Directo<')
    expect(html).not.toContain('>Compuesto<')
    expect(html).toContain('Ingredientes')
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('role="option"')
    expect(html).not.toContain('No hay insumos disponibles.')
    expect(html).toContain('Precio de venta')
    expect(html).toContain('Costo total de ingredientes')
    expect(html).toContain('Costo por unidad vendible')
    expect(html).toContain('Ganancia bruta')
    expect(html).toContain('Margen sobre precio')
    expect(html).toContain('Markup')
    expect(html).toContain('Costos por ingrediente')
    expect(html).toContain(RECIPE_PROFIT_UNAVAILABLE)
    expect(html).toContain(RECIPE_MARGIN_UNAVAILABLE)
    expect(html).not.toContain('0%')
    expect(html).toContain('Cancelar')
    expect(html).toContain('href="/recetas"')
    expect(html).toContain('Guardar receta')
    expect(html).toContain('Producto de Fudo (opcional)')
    expect(html).not.toContain('Producto Fudo')
  })

  it('reutiliza el formulario para edición con advertencia compartida, sin tarjeta Fudo', () => {
    const html = formHtml({
      notice: RECIPE_SHARED_WARNING,
      submitLabel: 'Guardar cambios',
      fudoSource: 'fudo',
      fudoExternalProductId: '0125',
      fudoProductName: 'Pinta Fudo',
      fudoReadOnlyNote: 'El Product ID de Fudo no se modifica.',
    })
    expect(html).toContain(RECIPE_SHARED_WARNING)
    expect(html).toContain('Guardar cambios')
    expect(html).not.toContain('Producto Fudo')
    expect(html).not.toContain('El Product ID de Fudo no se modifica.')
    expect(html).toContain('href="/recetas"')
    expect(html).not.toContain('name="externalProductId"')
  })

  it('abre el desplegable de insumos solo al escribir y lo ancla al buscador', () => {
    const html = formHtml({ ingredientSearch: 'ipa' })
    expect(html).toContain('role="listbox"')
    expect(html).toContain('max-h-64')
    expect(html).toContain('overflow-y-auto')
    expect(html).toContain('Barril IPA')
    expect(html).toContain('role="option"')
    expect(html).toContain('aria-selected="true"')

    const added = formHtml({
      ingredientSearch: 'ipa',
      ingredients: [{
        inventoryProductId: BARRIL_ID,
        name: 'Barril IPA',
        baseUnit: 'l',
        quantity: '1',
        inputUnit: 'l',
        averageUnitCost: 1000,
      }],
    })
    expect(added).toContain('No hay insumos para esa búsqueda.')
    expect(added).not.toContain('role="option"')
    expect(added).toContain('aria-label="Cantidad de Barril IPA"')
    expect(added).toContain('aria-label="Quitar Barril IPA"')
    expect(added).toContain('sm:flex-row')
  })

  it('muestra el costo pendiente y no un cero inventado', () => {
    const html = formHtml({
      ingredients: [{
        inventoryProductId: BARRIL_ID,
        name: 'Barril IPA',
        baseUnit: 'l',
        quantity: '500',
        inputUnit: 'ml',
        averageUnitCost: null,
      }],
    })
    expect(html).toContain('Costo pendiente')
    expect(html).toContain('Barril IPA necesita valuación en este local.')
    expect(html).not.toContain('$ 0,00')
    expect(html).not.toContain('Tipo de producto')
    expect(html).not.toContain('Producto Fudo')

    const conversion = formHtml({
      ingredients: [{
        inventoryProductId: BARRIL_ID,
        name: 'IPA',
        baseUnit: 'barril',
        quantity: '500',
        inputUnit: 'ml',
        averageUnitCost: 1320,
      }],
    })
    expect(conversion).toContain('equivalencia')
    expect(conversion).not.toContain('IPA necesita valuación')
  })

  it('convierte 500 ml, calcula ganancia y deja g/ml sin margen', () => {
    const honey = formHtml({
      recipeName: 'Honey',
      fudoSource: 'fudo',
      fudoExternalProductId: '13',
      fudoProductName: 'Honey',
      salePriceDraft: '4.500',
      ingredients: [{
        inventoryProductId: BARRIL_ID,
        name: 'Honey',
        baseUnit: 'l',
        quantity: '500',
        inputUnit: 'ml',
        averageUnitCost: 1000,
      }],
    })
    expect(honey).not.toContain('Producto Fudo')
    expect(honey).toContain('Honey')
    expect(honey).toContain('Equivale a')
    expect(honey).toContain(formatRecipeCost(500))
    expect(honey).toContain(formatRecipeCost(4000))
    expect(honey).toContain('88,9%')
    expect(honey).toContain('800%')
    expect(honey).not.toContain('$ 0,00')

    const grams = formHtml({
      yieldUnit: 'g',
      yieldQuantity: '250',
      salePriceDraft: '4.500',
      ingredients: [{
        inventoryProductId: BARRIL_ID,
        name: 'Honey',
        baseUnit: 'l',
        quantity: '500',
        inputUnit: 'ml',
        averageUnitCost: 1000,
      }],
    })
    expect(grams).toContain(RECIPE_PRICE_UNIT_ONLY)
    expect(grams).toContain('Costo por rendimiento')
    expect(grams).not.toContain('88,9%')

    const retry = formHtml({
      recipeLocked: true,
      notice: RECIPE_PRICE_RETRY_NOTICE,
      salePriceDraft: '4.500',
    })
    expect(retry).toContain(RECIPE_PRICE_RETRY_NOTICE)
    expect(retry).toContain('Reintentar precio')
  })

  it('busca el producto Fudo por nombre y permite guardar sin vinculación', () => {
    const html = formHtml({
      fudoProducts: [{
        id: 'pend-1',
        location_id: 'loc',
        product_name: 'Sprite',
        source: 'fudo',
        external_product_id: 'sku-sprite-99',
        status: 'pending',
      }],
    })
    expect(html).toContain('Producto de Fudo (opcional)')
    expect(html).toContain('Buscar por nombre o ID…')
    // Dropdown cerrado por defecto: la lista aparece al focus / búsqueda.
    expect(html).not.toContain('Sprite')
    expect(html).not.toContain('sku-sprite-99')
    expect(html).toContain('Podés guardar la receta sin vincular')
    expect(createOrganizationRecipePayload({
      name: 'Hamburguesa clásica',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [],
      category: { kind: 'existing', categoryId: TAPEO_ID },
      categories: [{ id: TAPEO_ID, name: 'Tapeo' }],
    }).ok).toBe(true)
  })

  it('permite agregar una categoría nueva solo en el formulario', () => {
    const html = formHtml({
      categories: [],
      categoryValue: 'new',
      categoryName: 'Brunch',
    })
    expect(html).toContain(ADD_RECIPE_CATEGORY_LABEL)
    expect(html).toContain('Nombre de la categoría')
    expect(html).toContain('value="Brunch"')
    expect(createOrganizationRecipePayload({
      name: 'Tostado',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [],
      category: { kind: 'new', name: 'Brunch' },
    }).ok).toBe(true)
  })

  it('muestra el producto Fudo y el selector de recetas al vincular', () => {
    const html = formHtml({
      intent: 'link',
      fudoSource: 'fudo',
      fudoExternalProductId: '0125',
      fudoProductName: 'Pinta Fudo',
      recipes: [pinta],
      selectedRecipeId: RECIPE_ID,
    })
    expect(html).not.toContain('Producto Fudo')
    expect(html).toContain('Vincular receta')
    expect(html).toContain('Vincular no modifica los ingredientes')
    expect(html).toContain('Seleccionada')
    expect(linkRecipePayload({
      source: 'fudo',
      externalProductId: '0125',
      existingRecipeId: RECIPE_ID,
    }).ok).toBe(true)
  })

  it('muestra RECIPE_INACTIVE al vincular una receta inactiva', () => {
    const html = formHtml({
      intent: 'link',
      fudoSource: 'fudo',
      fudoExternalProductId: '0125',
      recipes: [pinta],
      selectedRecipeId: RECIPE_ID,
      saveError: new RecipeSaveApiError('Esta receta no está activa.', 409, 'RECIPE_INACTIVE').message,
    })
    expect(html).toContain('Esta receta no está activa.')
    expect(html).toContain('Vincular receta')
    expect(html).not.toContain('Receta guardada')
  })

  it('muestra el error de API y evita un segundo envío', () => {
    const html = formHtml({
      saveError: new RecipeSaveApiError('Ya existe una receta con ese nombre.', 409, 'DUPLICATE_RECIPE_NAME').message,
      saving: true,
    })
    expect(html).toContain('Ya existe una receta con ese nombre.')
    expect(html).toContain('Guardando…')
    expect(html).toContain('disabled')
    expect(canBeginRecipeSave(true)).toBe(false)
  })

  it('el CREATE Fudo atómico manda categoría e identidad externa en una sola operación', () => {
    expect(FUDO_CREATE_CATEGORY_RPC_ENABLED).toBe(true)
    const plan = planFudoRecipeCreate({
      source: 'fudo',
      externalProductId: '0125',
      name: 'Pinta IPA',
      yieldQuantity: '1',
      yieldUnit: 'unit',
      ingredients: [],
      category: { kind: 'existing', categoryId: TAPEO_ID },
      categories: [{ id: TAPEO_ID, name: 'Tapeo' }],
    })
    expect(plan).toMatchObject({
      ok: true,
      body: {
        intent: 'create',
        source: 'fudo',
        externalProductId: '0125',
        categoryId: TAPEO_ID,
      },
    })
    const html = formHtml({
      fudoSource: 'fudo',
      fudoExternalProductId: '0125',
      fudoProductName: 'Pinta Fudo',
      saveError: 'Ese producto Fudo ya está vinculado a otra receta.',
    })
    expect(html).not.toContain('Producto Fudo')
    expect(html).toContain('Ese producto Fudo ya está vinculado a otra receta.')
    expect(html).not.toContain('Reintentá para vincularla')
  })
})

import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/lib/auth'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import { formatPendingTimestamp } from '@/lib/pendingRecipe'
import { RecipeSaveApiError, type OrganizationRecipeItem, type PendingProduct, type RecipeListItem } from '@/lib/api'
import {
  RECIPE_CATALOG_EMPTY,
  RECIPE_CATEGORIES_EMPTY,
  RECIPE_FUDO_MAPPING_WARNING,
  RECIPE_INACTIVE_EMPTY,
  RECIPE_STATUS_FILTERS,
  FudoHistoryPanel,
  RECIPE_BULK_RETIRE_LABEL,
  RECIPE_SELECT_ALL_VISIBLE_HINT,
  RecipeBulkRetireConfirm,
  RecipeStatusConfirm,
  RecipesCatalog,
  classifyRecipeForRetire,
  recipeBulkSelectionLabel,
  RecipesPage,
  overlayFudoDetections,
  overlayLocationPrices,
  applySavedLocationPrice,
  expectedVersionForPrice,
  filterRecipeCatalog,
  formatArgentineMoneyDraft,
  formatRecipeCost,
  locationRecipePriceSaveBody,
  locationRecipePriceSaveError,
  parseArgentineMoneyInput,
  recipePriceEditable,
  recipePriceFieldTitle,
  RECIPE_LINK_FILTERS,
  mergeOrganizationRecipes,
  pendingCatalogRow,
  pruneRecipeSelection,
  recipeDependentsBlockMessage,
  recipeLinkFilter,
  recipeCostAmountLabel,
  recipeCostKind,
  recipeFudoProductIds,
  recipeFudoStatusLabel,
  recipeListRowKey,
  recipeGrossMarginPct,
  recipeHasComparableSellableYield,
  recipeMarginLabel,
  recipeSalePriceLabel,
  recipeStatusActionLabel,
  recipeYieldLabel,
  recipesForScope,
  recipesScopeKey,
  selectVisibleRecipes,
  toggleRecipeSelection,
  unifyRecipeCatalog,
  visibleRecipeSelectionState,
  type RecipeCatalogItem,
} from './RecipesPage'
import {
  RECIPE_INACTIVE_UNAVAILABLE,
  RECIPE_PENDING_DISCARD_BLOCKED,
  RECIPE_PRICE_CONFLICT,
  RECIPE_PRICE_UNIT_ONLY,
  RECIPE_SALE_PRICE_UNAVAILABLE,
} from '@/lib/recipeDraft'

const mapping = {
  id: '12121212-1212-4121-8121-121212121212',
  source: 'fudo',
  externalProductId: 'fudo-ipa',
  externalProductName: 'IPA',
  active: true,
}

function orgItem(overrides: Partial<OrganizationRecipeItem> = {}): OrganizationRecipeItem {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Pinta IPA',
    recipeType: 'sale_product',
    active: true,
    yieldQuantity: 1,
    yieldUnit: 'unit',
    consumptionMode: 'direct',
    componentCount: 1,
    category: null,
    ...overrides,
  }
}

function locationItem(overrides: Partial<RecipeListItem> = {}): RecipeListItem {
  return {
    ...orgItem(),
    mapping,
    pendingStatus: null,
    costPerYield: 660,
    costIncomplete: false,
    hasInvalidQuantities: false,
    ...overrides,
  }
}

function catalogItem(overrides: Partial<RecipeCatalogItem> = {}): RecipeCatalogItem {
  const kind = overrides.kind ?? 'recipe'
  return {
    ...orgItem(),
    kind: 'recipe',
    category: null,
    categoryId: null,
    pendingStatus: null,
    pendingIdentity: null,
    fudoRecords: [],
    firstSeenAt: null,
    lastSeenAt: null,
    costPerYield: 660,
    costIncomplete: false,
    hasInvalidQuantities: false,
    salePrice: null,
    salePriceVersion: null,
    ...overrides,
    mappings: overrides.mappings ?? (kind === 'pending_fudo' ? [] : [mapping]),
  }
}

const catalogProps = {
  error: '',
  loading: false,
  search: '',
  onSearch: () => undefined,
  recipes: [] as RecipeCatalogItem[],
  selectedIds: [] as string[],
  onToggle: () => undefined,
  onToggleAll: () => undefined,
  onRequestBulkAction: () => undefined,
  categoryId: 'all',
  onCategory: () => undefined,
}

function pageHtml() {
  return renderToString(
    <MemoryRouter>
      <AuthProvider>
        <AuthorizedScopeProvider>
          <RecipesPage />
        </AuthorizedScopeProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

function pendingProduct(overrides: Partial<PendingProduct> = {}): PendingProduct {
  return {
    id: 'pend-1',
    location_id: 'loc',
    product_name: 'Pinta Fudo',
    source: 'fudo',
    external_product_id: '125',
    status: 'pending',
    ...overrides,
  }
}

describe('Listado de recetas', () => {
  it('usa el local global, el título pedido y habilita el alta', () => {
    const html = pageHtml()
    expect(html).toContain('Recetas')
    expect(html).toContain('Gestioná tus recetas y productos de venta')
    expect(html).toContain('Crear receta')
    expect(html).not.toContain('Historial Fudo')
    expect(html).toContain('href="/recetas/crear"')
    expect(html).not.toContain('El editor general todavía no está disponible')
    expect(html).not.toContain('>Organización<')
    expect(html).not.toContain('>Local<')
    expect(html).not.toContain('Todavía no hay recetas conectadas')
    expect(html).not.toContain('Nueva receta')
  })

  it('no deja visibles recetas de un local anterior', () => {
    expect(recipesScopeKey('org-1', 'loc-a')).not.toBe(recipesScopeKey('org-1', 'loc-b'))
    expect(recipesForScope(
      'org-1::loc-a',
      'org-1::loc-b',
      [catalogItem({ name: 'IPA Casa' })],
    )).toEqual([])
    expect(recipesForScope(
      'org-1::loc-b',
      'org-1::loc-b',
      [catalogItem({ name: 'IPA Norte' })],
    ).map((row) => row.name)).toEqual(['IPA Norte'])
  })

  it('muestra vacío de organización y error sin filas de ejemplo', () => {
    const empty = renderToString(<RecipesCatalog {...catalogProps} />)
    expect(empty).toContain(RECIPE_CATALOG_EMPTY)
    expect(empty).not.toContain('Pinta IPA')
    expect(empty).not.toContain('Harina 000')
    expect(empty).toContain('Todas')
    expect(empty).toContain('Activas')
    expect(empty).toContain('Inactivas')
    expect(empty).toContain(RECIPE_CATEGORIES_EMPTY)
    expect(empty).not.toContain('Entradas')
    expect(empty).not.toContain('Platos principales')

    const error = renderToString(
      <RecipesCatalog {...catalogProps} error="No se pudieron consultar las recetas." />,
    )
    expect(error).toContain('No se pudieron consultar las recetas.')
    expect(error).toContain('border-red-200')

    const loading = renderToString(<RecipesCatalog {...catalogProps} loading />)
    expect(loading).toContain('Cargando recetas')
    expect(loading).not.toContain('Pinta IPA')
  })
})

describe('catálogo de organización y Fudo', () => {
  it('lista recetas de la organización aunque no estén vinculadas a Fudo', () => {
    const merged = mergeOrganizationRecipes(
      [
        orgItem({ id: 'unlinked', name: 'Salsa de la casa', consumptionMode: 'none', componentCount: 0 }),
        orgItem({ name: 'Pinta IPA' }),
      ],
      [locationItem()],
    )
    expect(merged.map((row) => row.name)).toEqual(['Pinta IPA', 'Salsa de la casa'])
    expect(merged.find((row) => row.id === 'unlinked')?.mappings).toEqual([])
    expect(recipeFudoStatusLabel(merged.find((row) => row.id === 'unlinked')!)).toBe('Sin vincular')
    expect(recipeFudoProductIds(merged.find((row) => row.name === 'Pinta IPA')!)).toEqual(['fudo-ipa'])
    expect(recipeFudoStatusLabel(merged.find((row) => row.name === 'Pinta IPA')!)).toBe('Vinculado')
    expect(recipeListRowKey(merged[0])).toBe(merged[0]?.id)

    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={merged} />
      </MemoryRouter>,
    )
    expect(html).toContain('Salsa de la casa')
    expect(html).toContain('Pinta IPA')
    expect(html).toContain('Vinculación')
    expect(html).toContain('Vinculado')
    expect(html).toContain('Sin vincular')
    expect(html).not.toContain('fudo-ipa')
    expect(html).not.toContain('Manual')
    expect(html).not.toContain('Vinculada')
    expect(html).not.toContain('Vinculada en Fudo')
    expect(html).not.toContain('Producto Fudo')
  })

  it('no muestra Product ID ni mezcla pendientes Fudo en el listado de recetas', () => {
    const numeric = locationItem({
      mapping: { ...mapping, externalProductId: '125' },
    })
    const leadingZero = locationItem({
      mapping: { ...mapping, id: 'm2', externalProductId: '0125' },
    })
    const nonNumeric = locationItem({
      mapping: { ...mapping, id: 'm3', externalProductId: 'sku-ipa' },
    })
    const merged = mergeOrganizationRecipes([orgItem()], [numeric, leadingZero, nonNumeric])
    expect(recipeFudoProductIds(merged[0]!)).toEqual(['125', '0125', 'sku-ipa'])
    expect(recipeFudoStatusLabel(merged[0]!)).toBe('Vinculado')

    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={merged} />
      </MemoryRouter>,
    )
    expect(html).toContain('Vinculado')
    expect(html).not.toContain('>125<')
    expect(html).not.toContain('>0125<')
    expect(html).not.toContain('>sku-ipa<')
    expect(html).not.toContain('Vinculada')
    expect(merged).toHaveLength(1)
  })

  it('une pendientes activos sin duplicar productos ya vinculados ni resueltos', () => {
    const recipes = mergeOrganizationRecipes([orgItem()], [locationItem({
      mapping: { ...mapping, externalProductId: '125' },
    })])
    const pending = [
      pendingProduct(),
      pendingProduct({
        id: 'pend-2',
        product_name: 'Papas bravas',
        external_product_id: 'bravas-01',
      }),
      pendingProduct({
        id: 'pend-dup',
        product_name: 'Papas bravas',
        external_product_id: 'bravas-01',
      }),
      pendingProduct({
        id: 'pend-done',
        product_name: 'Resuelta',
        external_product_id: '999',
        status: 'resolved',
      }),
    ]
    const unified = unifyRecipeCatalog(recipes, pending)
    expect(unified.map((row) => row.name)).toEqual(['Papas bravas', 'Pinta IPA'])
    expect(unified.find((row) => row.kind === 'pending_fudo')?.pendingIdentity).toEqual({
      source: 'fudo',
      externalProductId: 'bravas-01',
    })
    expect(pendingCatalogRow(pending[3]!)).toBeNull()

    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={unified} />
      </MemoryRouter>,
    )
    expect(html).toContain('Pinta IPA')
    expect(html).not.toContain('Papas bravas')
    expect(html).not.toContain('Pendiente')
    expect(html).not.toContain('aria-label="Crear receta de Papas bravas"')
    expect(html).not.toContain('Vincular receta existente')
    expect(html).not.toContain('intent=link')
    expect(html).not.toContain('>125<')
    expect(html).not.toContain('Resuelta')
    expect(RECIPE_PENDING_DISCARD_BLOCKED).toContain('pending o resolved')
  })

  it('filtra por estado de forma independiente de la categoría y muestra fechas reales', () => {
    const category = { id: '15151515-1515-4151-8151-151515151515', name: 'Tapeo' }
    const recipes = mergeOrganizationRecipes([
      orgItem({ name: 'Pinta IPA', category }),
      orgItem({ id: 'unlinked', name: 'Salsa de la casa', consumptionMode: 'none', componentCount: 0 }),
    ], [locationItem({ mapping: { ...mapping, externalProductId: '125' } })])
    const pending = pendingProduct({
      id: 'pend-2',
      product_name: 'Papas bravas',
      external_product_id: 'bravas-01',
      first_seen_at: '2026-03-01T12:00:00.000Z',
      last_seen_at: '2026-03-02T15:30:00.000Z',
    })
    const unified = unifyRecipeCatalog(recipes, [pending])
    const row = pendingCatalogRow(pending)
    expect(recipeLinkFilter(unified.find((item) => item.name === 'Pinta IPA')!)).toBe('linked')
    expect(recipeLinkFilter(unified.find((item) => item.name === 'Salsa de la casa')!)).toBe('unlinked')
    expect(recipeLinkFilter(row!)).toBe('pending')
    expect(row?.firstSeenAt).toBe('2026-03-01T12:00:00.000Z')
    expect(row?.lastSeenAt).toBe('2026-03-02T15:30:00.000Z')
    expect(formatPendingTimestamp(null)).toBe('—')
    expect(formatPendingTimestamp('no-es-fecha')).toBe('no-es-fecha')
    expect(RECIPE_LINK_FILTERS.map((item) => item.label)).toEqual([
      'Todos',
      'Vinculado',
      'Sin vincular',
    ])
    expect(filterRecipeCatalog(unified, '', 'all', 'pending')).toEqual([])
    expect(filterRecipeCatalog(unified, '', 'all', 'linked').map((item) => item.name)).toEqual(['Pinta IPA'])
    expect(filterRecipeCatalog(unified, '', 'all', 'unlinked').map((item) => item.name)).toEqual(['Salsa de la casa'])
    expect(filterRecipeCatalog(unified, '', category.id, 'linked').map((item) => item.name)).toEqual(['Pinta IPA'])
    expect(filterRecipeCatalog(unified, '', category.id, 'pending')).toEqual([])

    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog
          {...catalogProps}
          recipes={unified}
          linkFilter="unlinked"
        />
      </MemoryRouter>,
    )
    expect(html).toContain('Todos')
    expect(html).not.toContain('Pendientes')
    expect(html).toContain('Vinculado')
    expect(html).toContain('Sin vincular')
    expect(html).not.toContain('Ver detalle')
    expect(html).not.toContain('Vincular receta existente')
    expect(html).not.toContain('Papas bravas')
    expect(html).toContain('Salsa de la casa')
    expect(html).not.toContain('Pinta IPA')
  })

  it('usa categorías reales de la API y deja pendientes sin categoría solo en Todas', () => {
    const category = { id: '15151515-1515-4151-8151-151515151515', name: 'Tapeo' }
    const merged = mergeOrganizationRecipes([
      orgItem({ name: 'Entrada de jamón' }),
      orgItem({ id: 'unlinked', name: 'Papas bravas', category }),
    ], [])
    const unified = unifyRecipeCatalog(merged, [
      pendingProduct({ id: 'pend-2', product_name: 'Milanesa Fudo', external_product_id: '88' }),
    ])
    expect(merged.find((row) => row.name === 'Entrada de jamón')?.category).toBeNull()
    expect(filterRecipeCatalog(unified, '', 'all').map((row) => row.name)).toEqual([
      'Entrada de jamón',
      'Papas bravas',
    ])
    expect(filterRecipeCatalog(unified, '', category.id).map((row) => row.name)).toEqual(['Papas bravas'])

    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={unified} categories={[category]} />
      </MemoryRouter>,
    )
    expect(html).toContain('Tapeo')
    expect(html).toContain('Papas bravas')
    expect(html).not.toContain('Entradas')
    expect(html).not.toContain('Platos principales')
    expect(html).not.toContain(RECIPE_CATEGORIES_EMPTY)
  })
})

describe('búsqueda, costos y acciones', () => {
  it('filtra por nombre de receta y no por coincidencia inventada de categoría', () => {
    const rows = [
      catalogItem({ id: '1', name: 'Pinta IPA' }),
      catalogItem({ id: '2', name: 'Papas bravas', mappings: [] }),
    ]
    expect(filterRecipeCatalog(rows, 'pinta', 'all').map((row) => row.name)).toEqual(['Pinta IPA'])
    expect(filterRecipeCatalog(rows, 'entradas', 'all')).toEqual([])
    const found = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={rows} search="bravas" />
      </MemoryRouter>,
    )
    expect(found).toContain('Papas bravas')
    expect(found).not.toContain('Pinta IPA')
    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={rows} search="zzz" />
      </MemoryRouter>,
    )
    expect(html).toContain('No hay resultados para la búsqueda.')
    expect(html).not.toContain('Papas bravas')
  })

  it('distingue sin consumo, costo pendiente y no inventa precio ni margen', () => {
    const none = catalogItem({
      id: 'none',
      name: 'Agua',
      mappings: [],
      consumptionMode: 'none',
      componentCount: 0,
      costPerYield: 0,
      costIncomplete: false,
    })
    const pending = catalogItem({
      id: 'pending',
      name: 'Guiso',
      mappings: [],
      consumptionMode: 'compound',
      componentCount: 2,
      costPerYield: null,
      costIncomplete: true,
    })
    const complete = catalogItem()

    expect(recipeCostKind(none)).toBe('none')
    expect(recipeCostAmountLabel(none)).toBe('Sin consumo')
    expect(recipeCostKind(pending)).toBe('pending')
    expect(recipeCostAmountLabel(pending)).toBe('Costo pendiente')
    expect(recipeCostAmountLabel(complete)).toBe(formatRecipeCost(660))
    expect(recipeSalePriceLabel(complete)).toBe('—')
    expect(recipeMarginLabel(complete)).toBe('—')
    expect(recipeYieldLabel(1, 'unit')).toBe('1 u')

    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={[none, pending, complete]} />
      </MemoryRouter>,
    )
    expect(html).toContain('Sin consumo')
    expect(html).toContain('Costo pendiente')
    expect(html).toContain(formatRecipeCost(660))
    expect(html).toContain('Precio de venta')
    expect(html).toContain('Margen %')
    expect(html).toContain('Costo por porción')
    expect(html).toContain('Guardar')
    expect(html).toContain('disabled')
    expect(html).not.toContain(RECIPE_SALE_PRICE_UNAVAILABLE)
    expect(html).not.toContain('0%')
    expect(html).not.toContain('$ 0,00')
  })

  it('habilita el lápiz hacia la edición y el tacho para retirar', () => {
    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={[catalogItem()]} />
      </MemoryRouter>,
    )
    expect(html).toContain('href="/recetas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/editar"')
    expect(html).toContain('aria-label="Editar Pinta IPA"')
    expect(html).toContain('aria-label="Retirar Pinta IPA"')
    expect(html).not.toContain('Desactivar')
    expect(html).not.toContain('Ver Fudo')
    expect(html).not.toContain('Ver detalle')
    expect(html).not.toContain('Vincular receta existente')
    expect(html).not.toContain('Eliminar Pinta IPA')
    expect(html).not.toContain('/pendientes/crear')
  })
})

describe('desactivación y recetas inactivas', () => {
  it('conserva inactivas en el catálogo y las filtra por estado', () => {
    const merged = mergeOrganizationRecipes([
      orgItem({ name: 'Pinta IPA' }),
      orgItem({ id: 'off', name: 'IPA archivada', active: false }),
    ], [])
    const pending = pendingProduct({
      id: 'pend-2',
      product_name: 'Papas bravas',
      external_product_id: 'bravas-01',
    })
    const unified = unifyRecipeCatalog(merged, [pending])
    expect(merged.map((row) => row.name)).toEqual(['IPA archivada', 'Pinta IPA'])
    expect(filterRecipeCatalog(unified, '', 'all', 'all', 'active').map((row) => row.name)).toEqual([
      'Pinta IPA',
    ])
    expect(filterRecipeCatalog(unified, '', 'all', 'all', 'inactive').map((row) => row.name)).toEqual([
      'IPA archivada',
    ])
    expect(filterRecipeCatalog(unified, '', 'all', 'all', 'all').map((row) => row.name)).toEqual([
      'IPA archivada',
      'Pinta IPA',
    ])
    expect(RECIPE_STATUS_FILTERS.map((item) => item.label)).toEqual(['Activas', 'Inactivas', 'Todas'])
    expect(recipeStatusActionLabel(true)).toBe('Desactivar')
    expect(recipeStatusActionLabel(false)).toBe('Reactivar')

    const hidden = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={unified} />
      </MemoryRouter>,
    )
    expect(hidden).toContain('Pinta IPA')
    expect(hidden).not.toContain('Papas bravas')
    expect(hidden).not.toContain('IPA archivada')

    const shown = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} recipes={unified} statusFilter="inactive" />
      </MemoryRouter>,
    )
    expect(shown).toContain('IPA archivada')
    expect(shown).toContain('Inactiva')
    expect(shown).toContain('Reactivar')
    expect(shown).toContain(RECIPE_INACTIVE_UNAVAILABLE)
    expect(shown).not.toContain('href="/recetas/off/editar"')
    expect(shown).not.toContain('Pinta IPA')
  })

  it('muestra vacío de inactivas sin borrar el catálogo', () => {
    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} statusFilter="inactive" />
      </MemoryRouter>,
    )
    expect(html).toContain(RECIPE_INACTIVE_EMPTY)
    expect(html).not.toContain(RECIPE_CATALOG_EMPTY)
  })

  it('bloquea desactivar con dependencias y advierte mappings Fudo', () => {
    const blocked = renderToString(
      <RecipeStatusConfirm
        dialog={{
          item: catalogItem({ name: 'Salsa de la casa' }),
          nextActive: false,
          usage: {
            recipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            active: true,
            usedBy: [{ recipeId: 'parent', name: 'Milanesa napolitana' }],
            activeMappingCount: 2,
          },
          loading: false,
          error: '',
          submitting: false,
        }}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(blocked).toContain(recipeDependentsBlockMessage(['Milanesa napolitana']))
    expect(blocked).toContain('Retirar receta')
    expect(blocked).toContain('disabled')
    expect(blocked).not.toContain(RECIPE_FUDO_MAPPING_WARNING)

    const warned = renderToString(
      <RecipeStatusConfirm
        dialog={{
          item: catalogItem({ name: 'Pinta IPA' }),
          nextActive: false,
          usage: {
            recipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            active: true,
            usedBy: [],
            activeMappingCount: 2,
          },
          loading: false,
          error: '',
          submitting: false,
        }}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(warned).toContain(RECIPE_FUDO_MAPPING_WARNING)
    expect(warned).toContain('Retirar receta')
    expect(warned).toContain('sin borrar ingredientes')
    expect(warned).toContain('stock ni ventas')
    expect(warned).not.toContain('Milanesa napolitana')

    const pending = renderToString(
      <RecipeStatusConfirm
        dialog={{
          item: catalogItem(),
          nextActive: false,
          usage: null,
          loading: false,
          error: 'El cambio de estado de recetas todavía no está habilitado.',
          submitting: false,
        }}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(pending).toContain('El cambio de estado de recetas todavía no está habilitado.')
  })
})

describe('selección de recetas', () => {
  it('permite marcar una, todas las visibles y se recorta al filtrar o cambiar de local', () => {
    const ids = ['a', 'b', 'c']
    expect(toggleRecipeSelection([], 'a')).toEqual(['a'])
    expect(toggleRecipeSelection(['a'], 'a')).toEqual([])
    expect(selectVisibleRecipes(ids, true)).toEqual(ids)
    expect(selectVisibleRecipes(ids, false)).toEqual([])
    expect(visibleRecipeSelectionState(['a', 'b'], ids)).toBe('some')
    expect(visibleRecipeSelectionState(ids, ids)).toBe('all')
    expect(pruneRecipeSelection(['a', 'c', 'z'], ['a', 'b'])).toEqual(['a'])
    expect(recipesScopeKey('org', 'loc-a')).not.toBe(recipesScopeKey('org', 'loc-b'))

    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog
          {...catalogProps}
          recipes={[catalogItem({ id: 'a', name: 'Alfa' }), catalogItem({ id: 'b', name: 'Beta' })]}
          selectedIds={['a', 'b']}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('aria-label="Seleccionar todas las recetas visibles"')
    expect(html).toContain('aria-label="Seleccionar Alfa"')
    expect(html).toContain('checked')
    expect(html).toContain(RECIPE_SELECT_ALL_VISIBLE_HINT)
    expect(html).toContain(RECIPE_BULK_RETIRE_LABEL)
    expect(html).toContain(recipeBulkSelectionLabel(2))
  })

  it('oculta la baja masiva sin selección y reporta pendientes, bloqueos y retiradas', () => {
    const empty = renderToString(
      <MemoryRouter>
        <RecipesCatalog
          {...catalogProps}
          recipes={[catalogItem({ id: 'a', name: 'Alfa' })]}
          selectedIds={[]}
        />
      </MemoryRouter>,
    )
    expect(empty).not.toContain(RECIPE_BULK_RETIRE_LABEL)
    expect(empty).toContain('aria-label="Seleccionar Alfa"')

    const pending = pendingCatalogRow(pendingProduct({ product_name: 'Papas bravas' }))
    expect(pending).not.toBeNull()
    if (!pending) return
    expect(classifyRecipeForRetire(pending, null).kind).toBe('pending_fudo')
    expect(classifyRecipeForRetire(catalogItem({ active: false }), null).kind).toBe('already_inactive')
    expect(classifyRecipeForRetire(catalogItem({ name: 'Salsa' }), {
      recipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      active: true,
      usedBy: [{ recipeId: 'parent', name: 'Milanesa napolitana' }],
      activeMappingCount: 0,
    }).kind).toBe('blocked')
    expect(classifyRecipeForRetire(catalogItem({ mappings: [mapping] }), {
      recipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      active: true,
      usedBy: [],
      activeMappingCount: 1,
    })).toMatchObject({ kind: 'eligible', mappingWarning: true })

    const confirm = renderToString(
      <RecipeBulkRetireConfirm
        dialog={{
          items: [catalogItem({ name: 'Pinta IPA' }), pending],
          classifications: [
            classifyRecipeForRetire(catalogItem({ name: 'Pinta IPA' }), {
              recipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              active: true,
              usedBy: [],
              activeMappingCount: 1,
            }),
            classifyRecipeForRetire(pending, null),
          ],
          loading: false,
          submitting: false,
          error: '',
          outcomes: null,
        }}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(confirm).toContain('Pinta IPA')
    expect(confirm).toContain('No se retiran')
    expect(confirm).toContain(RECIPE_PENDING_DISCARD_BLOCKED)
    expect(confirm).toContain(RECIPE_FUDO_MAPPING_WARNING)
    expect(confirm).toContain('Cancelar')

    const done = renderToString(
      <RecipeBulkRetireConfirm
        dialog={{
          items: [catalogItem({ name: 'Pinta IPA' })],
          classifications: [classifyRecipeForRetire(catalogItem({ name: 'Pinta IPA' }), {
            recipeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            active: true,
            usedBy: [],
            activeMappingCount: 0,
          })],
          loading: false,
          submitting: false,
          error: '',
          outcomes: [
            { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Pinta IPA', result: 'retired' },
            { id: 'pend', name: 'Papas bravas', result: 'skipped', reason: RECIPE_PENDING_DISCARD_BLOCKED },
          ],
        }}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(done).toContain('1 retirada, 1 sin cambios')
    expect(done).toContain('Papas bravas')
    expect(done).toContain('Cerrar')
    expect(done).not.toContain('>Retirar<')
  })
})

describe('precios de venta y margen por local', () => {
  const priceScope = {
    organizationId: '11111111-1111-4111-8111-111111111111',
    locationId: '22222222-2222-4222-8222-222222222222',
  }

  it('no inventa precio, calcula margen y deja g/ml sin margen', () => {
    const withoutPrice = catalogItem()
    const unknownCost = catalogItem({
      salePrice: 4500,
      salePriceVersion: 1,
      costPerYield: null,
      costIncomplete: true,
    })
    const zeroCost = catalogItem({
      name: 'Agua',
      consumptionMode: 'none',
      componentCount: 0,
      costPerYield: 0,
      costIncomplete: false,
      salePrice: 1000,
      salePriceVersion: 1,
    })
    const priced = catalogItem({ salePrice: 1200, salePriceVersion: 2 })
    const grams = catalogItem({
      yieldUnit: 'g',
      yieldQuantity: 250,
      salePrice: 1200,
      salePriceVersion: 1,
    })
    const ml = catalogItem({
      yieldUnit: 'ml',
      yieldQuantity: 330,
      salePrice: 1200,
      salePriceVersion: 1,
    })

    expect(recipeSalePriceLabel(withoutPrice)).toBe('—')
    expect(recipeMarginLabel(withoutPrice)).toBe('—')
    expect(recipeGrossMarginPct(unknownCost)).toBeNull()
    expect(recipeMarginLabel(unknownCost)).toBe('—')
    expect(recipeGrossMarginPct(zeroCost)).toBe(100)
    expect(recipeHasComparableSellableYield(grams)).toBe(false)
    expect(recipeMarginLabel(grams)).toBe('—')
    expect(recipeMarginLabel(ml)).toBe('—')
    expect(recipeSalePriceLabel(priced)).toBe(formatRecipeCost(1200))
    expect(recipeGrossMarginPct(priced)).toBeCloseTo(45)
    expect(recipePriceEditable(withoutPrice)).toBe(true)
    expect(recipePriceEditable(grams)).toBe(false)
    expect(recipePriceFieldTitle(grams)).toBe(RECIPE_PRICE_UNIT_ONLY)
  })

  it('arma el primer precio, un update y un reintento idéntico sin autosave', () => {
    const first = catalogItem()
    expect(expectedVersionForPrice(first)).toBeNull()
    expect(locationRecipePriceSaveBody(first, '4.500,50')).toEqual({
      ok: true,
      salePrice: 4500.5,
      expectedVersion: null,
    })
    expect(parseArgentineMoneyInput('$ 1.200')).toBe(1200)
    expect(parseArgentineMoneyInput('0')).toBe(0)
    expect(locationRecipePriceSaveBody(first, '0')).toEqual({
      ok: false,
      error: 'Indicá un precio de venta válido.',
    })
    expect(locationRecipePriceSaveBody(first, '-10')).toEqual({
      ok: false,
      error: 'Indicá un precio de venta válido.',
    })
    expect(locationRecipePriceSaveBody(first, '10000000000')).toEqual({
      ok: false,
      error: 'Indicá un precio de venta válido.',
    })

    const existing = catalogItem({ salePrice: 4500, salePriceVersion: 1 })
    expect(expectedVersionForPrice(existing)).toBe(1)
    expect(locationRecipePriceSaveBody(existing, '4.800')).toEqual({
      ok: true,
      salePrice: 4800,
      expectedVersion: 1,
    })
    expect(locationRecipePriceSaveBody(existing, formatArgentineMoneyDraft(4500))).toEqual({
      ok: true,
      salePrice: 4500,
      expectedVersion: 1,
    })

    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} {...priceScope} recipes={[first]} />
      </MemoryRouter>,
    )
    expect(html).toContain('aria-label="Precio de venta de Pinta IPA"')
    expect(html).toContain('Guardar')
    expect(html).not.toContain('Guardando')
    expect(html).not.toContain(RECIPE_SALE_PRICE_UNAVAILABLE)
  })

  it('actualiza precio y versión, recalcula margen y avisa conflicto', () => {
    const withoutPrice = catalogItem()
    const saved = applySavedLocationPrice([withoutPrice], withoutPrice.id, 4500, 1)
    expect(saved[0]?.salePrice).toBe(4500)
    expect(saved[0]?.salePriceVersion).toBe(1)
    expect(recipeGrossMarginPct(saved[0]!)).toBeCloseTo(((4500 - 660) / 4500) * 100)
    expect(recipeMarginLabel(saved[0]!)).toBe('85,3%')

    const unknownCost = applySavedLocationPrice([
      catalogItem({ costPerYield: null, costIncomplete: true }),
    ], withoutPrice.id, 4500, 1)[0]!
    expect(recipeGrossMarginPct(unknownCost)).toBeNull()
    expect(recipeMarginLabel(unknownCost)).toBe('—')

    const otherOperator = overlayLocationPrices(saved, [
      { recipeId: withoutPrice.id, salePrice: 3800, version: 2 },
    ])
    expect(otherOperator[0]?.salePrice).toBe(3800)
    expect(expectedVersionForPrice(otherOperator[0]!)).toBe(2)
    expect(locationRecipePriceSaveError(
      new RecipeSaveApiError(RECIPE_PRICE_CONFLICT, 409, 'CONCURRENT_UPDATE'),
    )).toEqual({ conflict: true, message: RECIPE_PRICE_CONFLICT })
    expect(locationRecipePriceSaveError(
      new RecipeSaveApiError('No se pudo guardar el precio de venta.', 500, 'PRICE_SAVE_FAILED'),
    )).toEqual({ conflict: false, message: 'No se pudo guardar el precio de venta.' })
  })

  it('aplica el precio del local seleccionado y lo limpia al cambiar de local u org', () => {
    const merged = mergeOrganizationRecipes([orgItem()], [locationItem()])
    expect(merged[0]?.salePrice).toBeNull()
    const locA = overlayLocationPrices(merged, [
      { recipeId: merged[0]!.id, salePrice: 4500, version: 1 },
    ])
    const locB = overlayLocationPrices(merged, [
      { recipeId: merged[0]!.id, salePrice: 3800, version: 3 },
    ])
    expect(locA[0]?.salePrice).toBe(4500)
    expect(locA[0]?.salePriceVersion).toBe(1)
    expect(locB[0]?.salePrice).toBe(3800)
    expect(recipesScopeKey('org-1', 'loc-a')).not.toBe(recipesScopeKey('org-1', 'loc-b'))
    expect(recipesScopeKey('org-1', 'loc-a')).not.toBe(recipesScopeKey('org-2', 'loc-a'))
    expect(recipesForScope('org-1::loc-a', 'org-1::loc-b', locA)).toEqual([])
    expect(overlayLocationPrices(merged, []).every((row) => row.salePrice == null)).toBe(true)

    const inactive = overlayLocationPrices(
      mergeOrganizationRecipes([orgItem({ id: 'off', name: 'IPA archivada', active: false })], []),
      [{ recipeId: 'off', salePrice: 3200, version: 4 }],
    )
    expect(inactive[0]?.active).toBe(false)
    expect(inactive[0]?.salePrice).toBe(3200)
    expect(recipeSalePriceLabel(inactive[0]!)).toBe(formatRecipeCost(3200))
    expect(recipePriceEditable(inactive[0]!)).toBe(false)
    expect(recipePriceFieldTitle(inactive[0]!)).toBe(RECIPE_INACTIVE_UNAVAILABLE)
    const inactiveHtml = renderToString(
      <MemoryRouter>
        <RecipesCatalog
          {...catalogProps}
          {...priceScope}
          recipes={inactive}
          statusFilter="inactive"
        />
      </MemoryRouter>,
    )
    expect(inactiveHtml).toContain(`value="${formatArgentineMoneyDraft(3200)}"`)
    expect(inactiveHtml).toContain('disabled')
    expect(inactiveHtml).toContain(RECIPE_INACTIVE_UNAVAILABLE)
    expect(inactiveHtml).not.toContain('Guardar')
    expect(inactiveHtml).not.toContain(RECIPE_SALE_PRICE_UNAVAILABLE)

    const pending = pendingCatalogRow(pendingProduct())!
    expect(overlayLocationPrices([pending], [
      { recipeId: pending.id, salePrice: 4500, version: 1 },
    ])[0]?.salePrice).toBeNull()

    const grams = catalogItem({
      name: 'Salsa',
      yieldUnit: 'g',
      yieldQuantity: 250,
      salePrice: 1200,
      salePriceVersion: 1,
    })
    const gramsHtml = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} {...priceScope} recipes={[grams]} />
      </MemoryRouter>,
    )
    expect(gramsHtml).toContain('disabled')
    expect(gramsHtml).toContain(RECIPE_PRICE_UNIT_ONLY)
    expect(gramsHtml).not.toContain('Guardar')
    expect(recipeMarginLabel(grams)).toBe('—')

    const html = renderToString(
      <MemoryRouter>
        <RecipesCatalog {...catalogProps} {...priceScope} recipes={locA} />
      </MemoryRouter>,
    )
    expect(html).toContain(`value="${formatArgentineMoneyDraft(4500)}"`)
    expect(html).toContain('Guardar')
    expect(html).not.toContain('Recargar precio')
    expect(html).not.toContain(RECIPE_PRICE_CONFLICT)
    expect(html).not.toContain(RECIPE_SALE_PRICE_UNAVAILABLE)
    expect(html).toContain('85,3%')
  })
})

describe('combinación de costos del local', () => {
  it('usa el costo del local cuando hay mapping y deja pendiente si falta valuación', () => {
    const merged = mergeOrganizationRecipes(
      [orgItem(), orgItem({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Guiso', consumptionMode: 'compound', componentCount: 2 })],
      [locationItem()],
      [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        mapping: null,
        costPerYield: null,
        costIncomplete: true,
        hasInvalidQuantities: false,
        pendingStatus: null,
      }],
    )
    const pinta = merged.find((row) => row.name === 'Pinta IPA')
    const guiso = merged.find((row) => row.name === 'Guiso')
    expect(pinta?.costPerYield).toBe(660)
    expect(pinta?.mappings[0]?.externalProductId).toBe('fudo-ipa')
    expect(recipeCostAmountLabel(guiso!)).toBe('Costo pendiente')
    expect(recipeFudoStatusLabel(guiso!)).toBe('Sin vincular')
  })
})

describe('historial Fudo y detecciones', () => {
  it('no duplica un resuelto con mapping activo y deja sin receta al resuelto huérfano', () => {
    const recipes = mergeOrganizationRecipes([orgItem()], [locationItem({
      mapping: { ...mapping, externalProductId: '0125' },
    })])
    const detections = [
      pendingProduct({
        id: 'linked',
        status: 'resolved',
        external_product_id: '0125',
        product_name: 'Pinta Fudo',
        first_seen_at: '2026-01-10T10:00:00.000Z',
        last_seen_at: '2026-01-11T10:00:00.000Z',
        recipe_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        recipe_name: 'Pinta IPA',
        mapping_active: true,
      }),
      pendingProduct({
        id: 'orphan',
        status: 'resolved',
        product_name: 'Pinta IPA',
        external_product_id: '999',
        recipe_id: null,
        recipe_name: null,
        mapping_active: null,
      }),
      pendingProduct({
        id: 'inactive',
        status: 'resolved',
        product_name: 'Vieja IPA',
        external_product_id: 'sku-ipa',
        recipe_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        recipe_name: 'Archivada',
        mapping_active: false,
      }),
    ]
    const unified = overlayFudoDetections(unifyRecipeCatalog(recipes, detections), detections)
    expect(unified.map((row) => row.name)).toEqual(['Pinta IPA'])
    expect(unified[0]?.fudoRecords).toEqual([{
      source: 'fudo',
      externalProductId: '0125',
      externalProductName: 'IPA',
      firstSeenAt: '2026-01-10T10:00:00.000Z',
      lastSeenAt: '2026-01-11T10:00:00.000Z',
      pendingStatus: 'resolved',
      mappingActive: true,
    }])
    expect(filterRecipeCatalog(unified, '', 'all', 'linked')).toHaveLength(1)
    expect(filterRecipeCatalog(unified, '', 'all', 'unlinked')).toHaveLength(0)

    const historyItems = detections.map((product) => ({
      id: product.id,
      name: product.product_name ?? '—',
      source: 'fudo',
      externalProductId: String(product.external_product_id),
      status: product.status === 'resolved' ? 'resolved' as const : 'pending' as const,
      firstSeenAt: product.first_seen_at ?? null,
      lastSeenAt: product.last_seen_at ?? null,
      recipeId: typeof product.recipe_id === 'string' ? product.recipe_id : null,
      recipeName: typeof product.recipe_name === 'string' ? product.recipe_name : null,
      mappingActive: typeof product.mapping_active === 'boolean' ? product.mapping_active : null,
    }))
    const html = renderToString(
      <MemoryRouter>
        <FudoHistoryPanel
          detailItem={historyItems[0]!}
          error=""
          items={historyItems}
          loading={false}
          locationLabel="Casa Central"
          search=""
          status="all"
          onCloseDetail={() => undefined}
          onOpenDetail={() => undefined}
          onSearch={() => undefined}
          onStatus={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('Pinta Fudo')
    expect(html).toContain('>0125<')
    expect(html).toContain('>999<')
    expect(html).toContain('>sku-ipa<')
    expect(html).toContain('Archivada')
    expect(html).toContain('Inactivo')
    expect(html).toContain('Activo')
    expect(html).toContain('Casa Central')
    expect(html).toContain('Local')
    expect(html).not.toContain('Crear receta')
  })

  it('cambia de local sin mezclar historial anterior', () => {
    expect(recipesScopeKey('org-1', 'loc-a')).not.toBe(recipesScopeKey('org-2', 'loc-a'))
    expect(recipesForScope(
      'org-1::loc-a',
      'org-1::loc-b',
      [{ id: 'old' }] as never,
    )).toEqual([])
  })
})

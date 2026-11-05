import { AlertCircle, ArrowLeft, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import {
  getFudoCatalog,
  getInventoryProducts,
  getLocationRecipePrices,
  getOrganizationRecipeCategories,
  getPendingProducts,
  getRecipe,
  saveFudoRecipe,
  setLocationRecipePrice,
  updateOrganizationRecipe,
  type InventoryProduct,
  type LocationRecipePrice,
  type PendingProduct,
  type RecipeCategory,
  type RecipeDetail,
} from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import { locationName, organizationName } from '@/lib/operations'
import { FUDO_PRODUCT_LOCKED_NOTE, mergeFudoPickerProducts } from '@/lib/fudoProductPicker'
import {
  addRecipeIngredient,
  canBeginRecipeSave,
  findPendingProduct,
  linkRecipePayload,
  pendingProductIdentity,
  pendingProductName,
  recipeSaveErrorMessage,
  removeRecipeIngredient,
  type RecipeIngredientDraft,
} from '@/lib/pendingRecipe'
import {
  RECIPE_INACTIVE_UNAVAILABLE,
  RECIPE_PRICE_CONFLICT,
  RECIPE_PRICE_RETRY_NOTICE,
  ingredientsFromRecipeDetail,
  persistRecipeAndLocationPrice,
  planRecipePricePersist,
  recipeCategorySelectionFromValue,
  recipeDraftHasSellableYield,
  recipeSharedLocationWarning,
  recipeUpdateExpectedFromDetail,
  updateOrganizationRecipePayload,
  type RecipeUpdateExpected,
} from '@/lib/recipeDraft'
import {
  formatArgentineMoneyDraft,
  parseArgentineMoneyInput,
  RECIPE_SALE_PRICE_MAX,
  recipesScopeKey,
} from './RecipesPage'
import { CreateRecipeForm } from './CreateRecipePage'

type DraftIngredient = RecipeIngredientDraft & { averageUnitCost?: number | null }

export const FUDO_PRODUCT_ID_LOCKED = FUDO_PRODUCT_LOCKED_NOTE

export function editRecipePath(recipeId: string) {
  return `/recetas/${encodeURIComponent(recipeId)}/editar`
}

export function editRecipeScopeKey(organizationId: string, locationId: string, recipeId: string) {
  return `${recipesScopeKey(organizationId, locationId)}::${recipeId}`
}

function quantityWithCost(
  ingredients: RecipeIngredientDraft[],
  detail: RecipeDetail,
): DraftIngredient[] {
  const costById = new Map(
    detail.components
      .filter((component) => component.inventoryProductId)
      .map((component) => [component.inventoryProductId as string, component.unitCost]),
  )
  return ingredients.map((item) => ({
    ...item,
    averageUnitCost: costById.get(item.inventoryProductId) ?? null,
  }))
}

export function EditRecipePage() {
  const navigate = useNavigate()
  const { recipeId = '' } = useParams()
  const { previewMode } = useAuth()
  const {
    organization,
    organizationId,
    location,
    locationId,
    loading: scopeLoading,
    error: scopeError,
  } = useAuthorizedScopeContext()
  const scopeKey = editRecipeScopeKey(organizationId, locationId, recipeId)
  const [load, setLoad] = useState<{
    key: string
    detail: RecipeDetail | null
    inventory: InventoryProduct[]
    pendingProducts: PendingProduct[]
    categories: RecipeCategory[]
    expected: RecipeUpdateExpected | null
    price: LocationRecipePrice | null
    error: string
  }>({
    key: '',
    detail: null,
    inventory: [],
    pendingProducts: [],
    categories: [],
    expected: null,
    price: null,
    error: '',
  })
  const [recipeName, setRecipeName] = useState('')
  const [categoryValue, setCategoryValue] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [yieldQuantity, setYieldQuantity] = useState('1')
  const [yieldUnit, setYieldUnit] = useState('unit')
  const [ingredients, setIngredients] = useState<DraftIngredient[]>([])
  const [ingredientSearch, setIngredientSearch] = useState('')
  const [fudoProductSearch, setFudoProductSearch] = useState('')
  const [selectedFudo, setSelectedFudo] = useState<{ source: string; externalProductId: string } | null>(null)
  const [salePriceDraft, setSalePriceDraft] = useState('')
  const [salePriceVersion, setSalePriceVersion] = useState<number | null>(null)
  const [priceRetryOnly, setPriceRetryOnly] = useState(false)
  const [priceConflict, setPriceConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const savingRef = useRef(false)
  const requestRef = useRef(0)
  const primedKey = useRef('')

  const detail = load.key === scopeKey ? load.detail : null
  const inventory = load.key === scopeKey ? load.inventory : []
  const pendingProducts = load.key === scopeKey ? load.pendingProducts : []
  const categories = load.key === scopeKey ? load.categories : []
  const expected = load.key === scopeKey ? load.expected : null
  const loadError = load.key === scopeKey ? load.error : ''
  const loading = scopeLoading || (Boolean(organizationId && locationId && recipeId) && load.key !== scopeKey)

  useEffect(() => {
    primedKey.current = ''
    setRecipeName('')
    setCategoryValue('')
    setCategoryName('')
    setYieldQuantity('1')
    setYieldUnit('unit')
    setIngredients([])
    setIngredientSearch('')
    setFudoProductSearch('')
    setSelectedFudo(null)
    setSalePriceDraft('')
    setSalePriceVersion(null)
    setPriceRetryOnly(false)
    setPriceConflict(false)
    setSaveError('')
  }, [scopeKey])

  useEffect(() => {
    if (previewMode || !organizationId || !locationId || !recipeId) {
      requestRef.current += 1
      setLoad({
        key: editRecipeScopeKey(organizationId, locationId, recipeId),
        detail: null,
        inventory: [],
        pendingProducts: [],
        categories: [],
        expected: null,
        price: null,
        error: !previewMode && (!organizationId || !locationId)
          ? 'No hay un local activo.'
          : '',
      })
      return
    }
    const key = scopeKey
    const requestId = ++requestRef.current
    Promise.all([
      getRecipe(recipeId, locationId),
      getOrganizationRecipeCategories(organizationId).catch(() => [] as RecipeCategory[]),
      getInventoryProducts(organizationId, { locationId }),
      getLocationRecipePrices(organizationId, locationId).catch(() => [] as LocationRecipePrice[]),
      Promise.all([
        getFudoCatalog(locationId).catch(() => [] as PendingProduct[]),
        getPendingProducts(locationId).catch(() => [] as PendingProduct[]),
      ]).then(([catalog, historical]) => mergeFudoPickerProducts(catalog, historical)),
    ])
      .then(([nextDetail, nextCategories, inventoryProducts, prices, nextPendingProducts]) => {
        if (requestId !== requestRef.current) return
        const price = prices.find((item) => item.recipeId === recipeId && item.salePrice > 0) ?? null
        if (!nextDetail.active) {
          setLoad({
            key,
            detail: nextDetail,
            inventory: inventoryProducts,
            pendingProducts: nextPendingProducts,
            categories: nextCategories,
            expected: null,
            price,
            error: RECIPE_INACTIVE_UNAVAILABLE,
          })
          return
        }
        const snapshot = recipeUpdateExpectedFromDetail(nextDetail)
        const inventoryById = new Map(
          inventoryProducts.map((product) => [product.id, {
            presentationUnit: product.presentationUnit ?? null,
            conversionFactor: product.conversionFactor ?? null,
            divisible: product.divisible ?? null,
          }]),
        )
        const preloaded = ingredientsFromRecipeDetail(nextDetail.components, inventoryById)
        if (!snapshot.ok || !preloaded.ok) {
          setLoad({
            key,
            detail: nextDetail,
            inventory: inventoryProducts,
            pendingProducts: nextPendingProducts,
            categories: nextCategories,
            expected: null,
            price,
            error: !snapshot.ok ? snapshot.error : !preloaded.ok ? preloaded.error : '',
          })
          return
        }
        setLoad({
          key,
          detail: nextDetail,
          inventory: inventoryProducts,
          pendingProducts: nextPendingProducts,
          categories: nextCategories,
          expected: snapshot.expected,
          price,
          error: '',
        })
      })
      .catch((reason: Error) => {
        if (requestId !== requestRef.current) return
        setLoad({
          key,
          detail: null,
          inventory: [],
          pendingProducts: [],
          categories: [],
          expected: null,
          price: null,
          error: reason.message,
        })
      })
  }, [locationId, organizationId, previewMode, recipeId, scopeKey])

  useEffect(() => {
    if (!detail || !expected || primedKey.current === scopeKey) return
    setRecipeName(detail.name)
    setCategoryValue(detail.category?.id ?? (categories.length === 0 ? 'new' : ''))
    setCategoryName('')
    setYieldQuantity(String(detail.yieldQuantity))
    setYieldUnit(detail.yieldUnit)
    const inventoryById = new Map(
      load.inventory.map((product) => [product.id, {
        presentationUnit: product.presentationUnit ?? null,
        conversionFactor: product.conversionFactor ?? null,
        divisible: product.divisible ?? null,
      }]),
    )
    const preloaded = ingredientsFromRecipeDetail(detail.components, inventoryById)
    setIngredients(preloaded.ok ? quantityWithCost(preloaded.ingredients, detail) : [])
    const price = load.price
    setSalePriceDraft(price && price.salePrice > 0 ? formatArgentineMoneyDraft(price.salePrice) : '')
    setSalePriceVersion(price?.version ?? null)
    primedKey.current = scopeKey
  }, [categories.length, detail, expected, load.price, scopeKey])

  const addedIds = useMemo(
    () => new Set(ingredients.map((item) => item.inventoryProductId)),
    [ingredients],
  )
  const inventoryMatches = useMemo(() => {
    const term = ingredientSearch.trim().toLocaleLowerCase('es')
    if (!term) return []
    return inventory
      .filter((product) => product.active)
      .filter((product) => !addedIds.has(product.id))
      .filter((product) => product.name.toLocaleLowerCase('es').includes(term))
  }, [addedIds, ingredientSearch, inventory])

  const categorySelection = recipeCategorySelectionFromValue(categoryValue, categoryName, categories)
  const updateReady = expected
    ? updateOrganizationRecipePayload({
      name: recipeName,
      yieldQuantity,
      yieldUnit,
      ingredients,
      category: categorySelection,
      categories,
      expected,
    })
    : { ok: false as const, error: loadError || 'No se pudo precargar la receta.' }
  const canSubmit = updateReady.ok && Boolean(organizationId && recipeId && expected)
  const sharedWarning = detail ? recipeSharedLocationWarning(detail.sharedLocationCount) : null
  const mapping = detail?.mapping
  const mappingLocked = Boolean(mapping?.active)
  const selectedFudoIdentity = mappingLocked && mapping
    ? { source: mapping.source, externalProductId: mapping.externalProductId }
    : selectedFudo
  const selectedPending = selectedFudoIdentity
    ? findPendingProduct(pendingProducts, selectedFudoIdentity.source, selectedFudoIdentity.externalProductId)
    : null
  const selectedFudoName = mappingLocked
    ? (mapping?.externalProductName?.trim() || '')
    : selectedPending
      ? pendingProductName(selectedPending)
      : ''

  if (previewMode) {
    return (
      <Card className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
        <h2 className="mb-0 mt-5 text-xl font-bold">Supabase todavía no está configurado</h2>
        <p className="mb-0 mt-2 max-w-lg text-sm leading-6 text-senda-muted">
          Configurá las variables del frontend y la API para editar recetas reales.
        </p>
      </Card>
    )
  }

  async function submit() {
    if (!canBeginRecipeSave(saving) || savingRef.current) return
    if (!organizationId || !recipeId || (!priceRetryOnly && !updateReady.ok)) {
      setSaveError(updateReady.ok ? 'No hay una organización activa.' : updateReady.error)
      return
    }
    const comparable = recipeDraftHasSellableYield(yieldQuantity, yieldUnit)
    const pricePlan = planRecipePricePersist({
      comparable,
      draft: salePriceDraft,
      parsed: parseArgentineMoneyInput(salePriceDraft),
      salePriceVersion,
      max: RECIPE_SALE_PRICE_MAX,
    })
    if (pricePlan.kind === 'invalid') {
      setSaveError(pricePlan.error)
      return
    }
    if (pricePlan.kind === 'save' && !locationId) {
      setSaveError('No hay un local activo.')
      return
    }
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    setPriceConflict(false)
    try {
      const result = await persistRecipeAndLocationPrice({
        skipRecipe: priceRetryOnly,
        persistedRecipeId: recipeId,
        saveRecipe: () => {
          if (!updateReady.ok) throw new Error(updateReady.error)
          return updateOrganizationRecipe(organizationId, recipeId, updateReady.body)
        },
        pricePlan,
        savePrice: (nextRecipeId, salePrice, expectedVersion) => (
          setLocationRecipePrice(organizationId, locationId, nextRecipeId, { salePrice, expectedVersion })
        ),
      })
      if (!result.ok) {
        setPriceRetryOnly(true)
        setPriceConflict(result.conflict)
        setSaveError(result.conflict ? RECIPE_PRICE_CONFLICT : result.error)
        savingRef.current = false
        setSaving(false)
        return
      }
      if (!mappingLocked && selectedFudoIdentity && locationId) {
        const linkReady = linkRecipePayload({
          source: selectedFudoIdentity.source,
          externalProductId: selectedFudoIdentity.externalProductId,
          existingRecipeId: recipeId,
        })
        if (!linkReady.ok) {
          setSaveError(linkReady.error)
          savingRef.current = false
          setSaving(false)
          return
        }
        await saveFudoRecipe(locationId, linkReady.body)
      }
      navigate('/recetas')
    } catch (error) {
      setSaveError(recipeSaveErrorMessage(error))
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link className="inline-flex items-center gap-2 text-sm font-semibold text-senda-navy hover:underline" to="/recetas">
            <ArrowLeft size={16} /> Recetas
          </Link>
          <h2 className="mb-0 mt-3 text-2xl font-extrabold tracking-tight">Editar receta</h2>
          <p className="mb-0 mt-2 text-sm text-senda-muted">
            Cambiá nombre, categoría, rendimiento e ingredientes. Cancelar no guarda nada.
          </p>
          {organization && location && (
            <p className="mb-0 mt-2 text-xs text-senda-muted">
              {locationName(location)} · {organizationName(organization)}
            </p>
          )}
        </div>
      </div>

      {(loadError || scopeError) && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} /> {loadError || scopeError}
        </div>
      )}

      {loading ? (
        <Card className="flex min-h-64 items-center justify-center gap-2 text-sm text-senda-muted">
          <Loader2 className="animate-spin" size={19} /> Cargando…
        </Card>
      ) : detail && expected ? (
        <CreateRecipeForm
          canSubmit={canSubmit}
          categories={categories}
          categoryName={categoryName}
          categoryValue={categoryValue}
          fudoExternalProductId={selectedFudoIdentity?.externalProductId ?? ''}
          fudoLocked={mappingLocked}
          fudoProductName={selectedFudoName}
          fudoProductSearch={fudoProductSearch}
          fudoProducts={pendingProducts}
          fudoReadOnlyNote={mappingLocked ? FUDO_PRODUCT_LOCKED_NOTE : undefined}
          fudoSource={selectedFudoIdentity?.source ?? ''}
          onFudoProductSearch={setFudoProductSearch}
          onSelectFudoProduct={(product) => {
            setSelectedFudo(product ? pendingProductIdentity(product) : null)
            setFudoProductSearch('')
          }}
          ingredientSearch={ingredientSearch}
          ingredients={ingredients}
          intent="create"
          inventoryMatches={inventoryMatches}
          notice={priceRetryOnly ? RECIPE_PRICE_RETRY_NOTICE : sharedWarning ?? undefined}
          onReloadPrice={async () => {
            if (!organizationId || !locationId || !recipeId) return
            const prices = await getLocationRecipePrices(organizationId, locationId)
            const current = prices.find((item) => item.recipeId === recipeId)
            setSalePriceDraft(current ? formatArgentineMoneyDraft(current.salePrice) : '')
            setSalePriceVersion(current?.version ?? null)
            setPriceConflict(false)
            setSaveError('')
          }}
          onSalePriceDraft={(value) => {
            setSalePriceDraft(value)
            setPriceConflict(false)
          }}
          priceConflict={priceConflict}
          recipeLocked={priceRetryOnly}
          salePriceDraft={salePriceDraft}
          onAddIngredient={(product) => {
            const next = addRecipeIngredient(ingredients, product)
            if (next.ok) {
              setIngredients(next.list.map((item) => (
                item.inventoryProductId === product.id
                  ? { ...item, averageUnitCost: product.averageUnitCost ?? null }
                  : item
              )))
              setIngredientSearch('')
              setSaveError('')
            } else {
              setSaveError('Hay un ingrediente repetido.')
            }
          }}
          onCategoryName={setCategoryName}
          onCategoryValue={(value) => {
            setCategoryValue(value)
            if (value !== 'new') setCategoryName('')
          }}
          onIngredientQuantity={(inventoryProductId, quantity) => {
            setIngredients((current) => current.map((item) => (
              item.inventoryProductId === inventoryProductId ? { ...item, quantity } : item
            )))
          }}
          onIngredientSearch={setIngredientSearch}
          onIngredientUnit={(inventoryProductId, unit) => {
            setIngredients((current) => current.map((item) => (
              item.inventoryProductId === inventoryProductId ? { ...item, inputUnit: unit } : item
            )))
          }}
          onRecipeName={setRecipeName}
          onRecipeSearch={() => undefined}
          onRemoveIngredient={(inventoryProductId) => {
            setIngredients((current) => removeRecipeIngredient(current, inventoryProductId))
          }}
          onSelectRecipe={() => undefined}
          onSubmit={() => { void submit() }}
          onYieldQuantity={setYieldQuantity}
          onYieldUnit={setYieldUnit}
          recipeName={recipeName}
          recipeSearch=""
          recipes={[]}
          saveError={saveError}
          saving={saving}
          selectedRecipeId=""
          submitLabel={priceRetryOnly ? 'Reintentar precio' : 'Guardar cambios'}
          yieldQuantity={yieldQuantity}
          yieldUnit={yieldUnit}
        />
      ) : !loading && !detail ? (
        <Card className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
          <AlertCircle className="text-senda-muted" size={28} />
          <h3 className="mb-0 mt-4 text-lg font-bold">Receta no disponible</h3>
          <p className="mb-0 mt-2 max-w-md text-sm leading-6 text-senda-muted">
            {loadError || 'No se encontró la receta en el local activo.'}
          </p>
          <Link className="mt-4" to="/recetas">
            <Button type="button" variant="secondary">Volver a recetas</Button>
          </Link>
        </Card>
      ) : null}
    </div>
  )
}

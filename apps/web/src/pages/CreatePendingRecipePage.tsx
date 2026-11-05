import { AlertCircle, ArrowLeft, Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import {
  getInventoryProducts,
  getOrganizationRecipes,
  getPendingProducts,
  saveFudoRecipe,
  type InventoryProduct,
  type OrganizationRecipeItem,
  type PendingProduct,
} from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import { locationName, organizationName } from '@/lib/operations'
import {
  RECIPE_YIELD_UNITS,
  addRecipeIngredient,
  canBeginRecipeSave,
  createPendingRecipePath,
  createRecipePayload,
  findPendingProduct,
  ingredientConversionPreview,
  linkRecipePayload,
  linkableOrganizationRecipes,
  parseCreatePendingRecipeSearch,
  pendingProductName,
  pendingRecipeForScope,
  pendingRecipeScopeKey,
  recipeSaveErrorMessage,
  removeRecipeIngredient,
  type RecipeIngredientDraft,
  type RecipeIntent,
} from '@/lib/pendingRecipe'
import { inputUnitsForBase } from '@/lib/recipeUnits'
import { inventoryUnitLabel } from './InventoryPage'
import { recipeConsumptionLabel, recipeYieldLabel } from './RecipesPage'

export function CreatePendingRecipeForm({
  intent,
  source,
  externalProductId,
  productName,
  createPath,
  linkPath,
  recipeName,
  onRecipeName,
  yieldQuantity,
  onYieldQuantity,
  yieldUnit,
  onYieldUnit,
  ingredientSearch,
  onIngredientSearch,
  inventoryMatches,
  ingredients,
  onAddIngredient,
  onRemoveIngredient,
  onIngredientQuantity,
  onIngredientUnit,
  recipeSearch,
  onRecipeSearch,
  recipes,
  selectedRecipeId,
  onSelectRecipe,
  saving,
  saveError,
  canSubmit,
  onSubmit,
}: {
  intent: RecipeIntent
  source: string
  externalProductId: string
  productName: string
  createPath: string
  linkPath: string
  recipeName: string
  onRecipeName: (value: string) => void
  yieldQuantity: string
  onYieldQuantity: (value: string) => void
  yieldUnit: string
  onYieldUnit: (value: string) => void
  ingredientSearch: string
  onIngredientSearch: (value: string) => void
  inventoryMatches: InventoryProduct[]
  ingredients: RecipeIngredientDraft[]
  onAddIngredient: (product: InventoryProduct) => void
  onRemoveIngredient: (inventoryProductId: string) => void
  onIngredientQuantity: (inventoryProductId: string, quantity: string) => void
  onIngredientUnit: (inventoryProductId: string, unit: string) => void
  recipeSearch: string
  onRecipeSearch: (value: string) => void
  recipes: OrganizationRecipeItem[]
  selectedRecipeId: string
  onSelectRecipe: (recipeId: string) => void
  saving: boolean
  saveError: string
  canSubmit: boolean
  onSubmit: () => void
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Link
          className={`inline-flex min-h-10 items-center rounded-lg px-4 text-sm font-semibold ${
            intent === 'create'
              ? 'bg-senda-navy text-white'
              : 'border border-senda-border bg-white text-senda-ink hover:bg-senda-subtle'
          }`}
          to={createPath}
        >
          Crear receta
        </Link>
        <Link
          className={`inline-flex min-h-10 items-center rounded-lg px-4 text-sm font-semibold ${
            intent === 'link'
              ? 'bg-senda-navy text-white'
              : 'border border-senda-border bg-white text-senda-ink hover:bg-senda-subtle'
          }`}
          to={linkPath}
        >
          Vincular receta existente
        </Link>
      </div>

      <Card className="space-y-3 p-5">
        <h3 className="m-0 text-base font-bold">Producto Fudo</h3>
        <p className="mb-0 font-semibold">{productName}</p>
        <p className="mb-0 text-sm text-senda-muted">{externalProductId}</p>
        <p className="mb-0 text-xs text-senda-muted">{source}</p>
      </Card>

      {intent === 'create' ? (
        <>
          <Card className="space-y-4 p-5">
            <h3 className="m-0 text-base font-bold">Receta</h3>
            <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
              Nombre
              <Input
                onChange={(event) => onRecipeName(event.target.value)}
                placeholder="Nombre de la receta"
                value={recipeName}
              />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
                Rendimiento
                <Input
                  inputMode="decimal"
                  onChange={(event) => onYieldQuantity(event.target.value)}
                  placeholder="1"
                  value={yieldQuantity}
                />
              </label>
              <Select label="Unidad" onChange={onYieldUnit} value={yieldUnit}>
                {RECIPE_YIELD_UNITS.map((unit) => (
                  <option key={unit.value} value={unit.value}>{unit.label}</option>
                ))}
              </Select>
            </div>
          </Card>

          <Card className="space-y-4 p-5">
            <div>
              <h3 className="m-0 text-base font-bold">Ingredientes</h3>
              <p className="mb-0 mt-2 text-sm text-senda-muted">
                Podés crear la receta sin consumo si no agregás ingredientes.
              </p>
            </div>
            <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
              Buscar insumo del inventario
              <span className="relative block">
                <Search className="absolute left-3 top-3 text-slate-400" size={17} />
                <Input
                  className="pl-9"
                  onChange={(event) => onIngredientSearch(event.target.value)}
                  placeholder="Barril IPA…"
                  value={ingredientSearch}
                />
              </span>
            </label>
            {ingredientSearch.trim() && (
              <div className="overflow-hidden rounded-xl border border-senda-border">
                {inventoryMatches.length === 0 ? (
                  <p className="mb-0 px-4 py-3 text-sm text-senda-muted">No hay insumos para esa búsqueda.</p>
                ) : (
                  <ul className="m-0 list-none divide-y divide-senda-border p-0">
                    {inventoryMatches.map((product) => (
                      <li className="flex items-center justify-between gap-3 px-4 py-3" key={product.id}>
                        <div>
                          <p className="mb-0 font-semibold">{product.name}</p>
                          <p className="mb-0 text-xs text-senda-muted">{inventoryUnitLabel(product.baseUnit)}</p>
                        </div>
                        <Button onClick={() => onAddIngredient(product)} type="button" variant="secondary">
                          <Plus size={16} /> Agregar
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {ingredients.length === 0 ? (
              <p className="mb-0 text-sm text-senda-muted">Sin ingredientes. La receta se creará sin consumo.</p>
            ) : (
              <ul className="m-0 list-none space-y-3 p-0">
                {ingredients.map((ingredient) => {
                  const units = inputUnitsForBase(ingredient.baseUnit)
                  return (
                    <li
                      className="space-y-3 rounded-xl border border-senda-border p-4"
                      key={ingredient.inventoryProductId}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="mb-0 font-semibold">{ingredient.name}</p>
                          <p className="mb-0 text-xs text-senda-muted">
                            {`Unidad del insumo: ${inventoryUnitLabel(ingredient.baseUnit)}${ingredient.baseUnit ? ` (${ingredient.baseUnit})` : ''}`}
                          </p>
                        </div>
                        <Button
                          onClick={() => onRemoveIngredient(ingredient.inventoryProductId)}
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 size={16} /> Quitar
                        </Button>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
                          Cantidad
                          <Input
                            inputMode="decimal"
                            onChange={(event) => onIngredientQuantity(ingredient.inventoryProductId, event.target.value)}
                            placeholder="0"
                            value={ingredient.quantity}
                          />
                        </label>
                        <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
                          Unidad ingresada
                          <select
                            className="h-11 w-full rounded-lg border border-senda-border bg-white px-3 text-sm text-senda-ink"
                            onChange={(event) => onIngredientUnit(ingredient.inventoryProductId, event.target.value)}
                            value={ingredient.inputUnit}
                          >
                            {units.map((unit) => (
                              <option key={unit.value} value={unit.value}>{unit.label}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="mb-0 text-xs text-senda-muted">
                        {ingredientConversionPreview(ingredient)}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </>
      ) : (
        <Card className="space-y-4 p-5">
          <h3 className="m-0 text-base font-bold">Receta existente</h3>
          <p className="mb-0 text-sm text-senda-muted">
            Vincular no modifica los ingredientes de la receta.
          </p>
          <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
            Buscar receta
            <span className="relative block">
              <Search className="absolute left-3 top-3 text-slate-400" size={17} />
              <Input
                className="pl-9"
                onChange={(event) => onRecipeSearch(event.target.value)}
                placeholder="Pinta IPA…"
                value={recipeSearch}
              />
            </span>
          </label>
          {recipes.length === 0 ? (
            <p className="mb-0 text-sm text-senda-muted">
              {recipeSearch ? 'No hay recetas para esa búsqueda.' : 'No hay recetas disponibles para vincular.'}
            </p>
          ) : (
            <ul className="m-0 list-none divide-y divide-senda-border overflow-hidden rounded-xl border border-senda-border p-0">
              {recipes.map((recipe) => {
                const selected = recipe.id === selectedRecipeId
                return (
                  <li key={recipe.id}>
                    <button
                      className={`flex w-full items-start justify-between gap-3 px-4 py-3 text-left ${
                        selected ? 'bg-senda-subtle' : 'bg-white hover:bg-senda-subtle'
                      }`}
                      onClick={() => onSelectRecipe(recipe.id)}
                      type="button"
                    >
                      <div>
                        <p className="mb-0 font-semibold">{recipe.name}</p>
                        <p className="mb-0 text-xs text-senda-muted">
                          Rinde {recipeYieldLabel(recipe.yieldQuantity, recipe.yieldUnit)}
                          {' · '}
                          {recipeConsumptionLabel(recipe.consumptionMode)}
                        </p>
                      </div>
                      {selected && <Badge tone="success">Seleccionada</Badge>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      )}

      {saveError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} /> {saveError}
        </div>
      )}

      <div className="flex justify-end">
        <Button disabled={!canSubmit || saving} onClick={onSubmit} type="button">
          {saving ? <Loader2 className="animate-spin" size={16} /> : null}
          {saving ? 'Guardando…' : intent === 'link' ? 'Vincular receta' : 'Crear receta'}
        </Button>
      </div>
    </div>
  )
}

export function CreatePendingRecipePage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { source, externalProductId, intent } = parseCreatePendingRecipeSearch(params)
  const { previewMode } = useAuth()
  const {
    organization,
    organizationId,
    location,
    locationId,
    loading: scopeLoading,
    error: scopeError,
  } = useAuthorizedScopeContext()
  const scopeKey = pendingRecipeScopeKey(organizationId, locationId, source, externalProductId)
  const [load, setLoad] = useState<{
    key: string
    pending: PendingProduct | null
    inventory: InventoryProduct[]
    recipes: OrganizationRecipeItem[]
    error: string
  }>({
    key: '',
    pending: null,
    inventory: [],
    recipes: [],
    error: '',
  })
  const [recipeName, setRecipeName] = useState('')
  const [yieldQuantity, setYieldQuantity] = useState('1')
  const [yieldUnit, setYieldUnit] = useState('unit')
  const [ingredients, setIngredients] = useState<RecipeIngredientDraft[]>([])
  const [ingredientSearch, setIngredientSearch] = useState('')
  const [recipeSearch, setRecipeSearch] = useState('')
  const [selectedRecipeId, setSelectedRecipeId] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const savingRef = useRef(false)
  const requestRef = useRef(0)
  const namedForKey = useRef('')

  const pending = pendingRecipeForScope(load.key, scopeKey, load.pending)
  const inventory = pendingRecipeForScope(load.key, scopeKey, load.inventory) ?? []
  const organizationRecipes = pendingRecipeForScope(load.key, scopeKey, load.recipes) ?? []
  const loadError = load.key === scopeKey ? load.error : ''
  const loading = scopeLoading || (Boolean(locationId && source && externalProductId) && load.key !== scopeKey)

  useEffect(() => {
    setIngredients([])
    setIngredientSearch('')
    setRecipeSearch('')
    setSelectedRecipeId('')
    setSaveError('')
    setYieldQuantity('1')
    setYieldUnit('unit')
    namedForKey.current = ''
  }, [scopeKey])

  useEffect(() => {
    if (previewMode || !locationId || !organizationId || !source || !externalProductId) {
      requestRef.current += 1
      setLoad({
        key: pendingRecipeScopeKey(organizationId, locationId, source, externalProductId),
        pending: null,
        inventory: [],
        recipes: [],
        error: !previewMode && !locationId
          ? 'No hay un local activo.'
          : !source || !externalProductId
            ? 'Falta la identidad del producto Fudo.'
            : '',
      })
      return
    }
    const key = pendingRecipeScopeKey(organizationId, locationId, source, externalProductId)
    const requestId = ++requestRef.current
    Promise.all([
      getPendingProducts(locationId),
      getInventoryProducts(organizationId),
      getOrganizationRecipes(organizationId),
    ])
      .then(([pendingProducts, inventoryProducts, recipes]) => {
        if (requestId !== requestRef.current) return
        const match = findPendingProduct(pendingProducts, source, externalProductId)
        setLoad({
          key,
          pending: match,
          inventory: inventoryProducts,
          recipes,
          error: match ? '' : 'Este producto Fudo no está disponible para vincular en el local activo.',
        })
      })
      .catch((reason: Error) => {
        if (requestId !== requestRef.current) return
        setLoad({
          key,
          pending: null,
          inventory: [],
          recipes: [],
          error: reason.message,
        })
      })
  }, [externalProductId, locationId, organizationId, previewMode, source])

  useEffect(() => {
    if (!pending || namedForKey.current === scopeKey) return
    const name = pendingProductName(pending)
    if (name && name !== '—') setRecipeName(name)
    namedForKey.current = scopeKey
  }, [pending, scopeKey])

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
      .slice(0, 8)
  }, [addedIds, ingredientSearch, inventory])

  const linkableRecipes = useMemo(() => {
    const term = recipeSearch.trim().toLocaleLowerCase('es')
    return linkableOrganizationRecipes(organizationRecipes).filter((recipe) => (
      !term || recipe.name.toLocaleLowerCase('es').includes(term)
    ))
  }, [organizationRecipes, recipeSearch])

  const createReady = createRecipePayload({
    source,
    externalProductId,
    name: recipeName,
    yieldQuantity,
    yieldUnit,
    ingredients,
  })
  const linkReady = linkRecipePayload({
    source,
    externalProductId,
    existingRecipeId: selectedRecipeId,
  })
  const canSubmit = intent === 'link' ? linkReady.ok : createReady.ok

  if (previewMode) {
    return (
      <Card className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
        <h2 className="mb-0 mt-5 text-xl font-bold">Supabase todavía no está configurado</h2>
        <p className="mb-0 mt-2 max-w-lg text-sm leading-6 text-senda-muted">
          Configurá las variables del frontend y la API para crear o vincular recetas reales.
        </p>
      </Card>
    )
  }

  async function submit() {
    if (!locationId || !canBeginRecipeSave(saving) || savingRef.current) return
    const payload = intent === 'link' ? linkReady : createReady
    if (!payload.ok) {
      setSaveError(payload.error)
      return
    }
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    try {
      const result = await saveFudoRecipe(locationId, payload.body)
      navigate(`/recetas/${result.recipeId}`)
    } catch (error) {
      setSaveError(recipeSaveErrorMessage(error))
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link className="inline-flex items-center gap-2 text-sm font-semibold text-senda-navy hover:underline" to="/pendientes">
          <ArrowLeft size={16} /> Productos pendientes
        </Link>
        <h2 className="mb-0 mt-3 text-2xl font-extrabold tracking-tight">
          {intent === 'link' ? 'Vincular receta existente' : 'Crear receta'}
        </h2>
        <p className="mb-0 mt-2 text-sm text-senda-muted">
          {intent === 'link'
            ? 'Asociá el producto Fudo a una receta ya cargada en la organización.'
            : 'Definí la receta y el consumo para el producto Fudo pendiente.'}
        </p>
        {organization && location && (
          <p className="mb-0 mt-2 text-xs text-senda-muted">
            {locationName(location)} · {organizationName(organization)}
          </p>
        )}
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
      ) : pending ? (
        <CreatePendingRecipeForm
          canSubmit={canSubmit && Boolean(locationId)}
          createPath={createPendingRecipePath({ source, externalProductId })}
          externalProductId={externalProductId}
          ingredientSearch={ingredientSearch}
          ingredients={ingredients}
          intent={intent}
          inventoryMatches={inventoryMatches}
          linkPath={createPendingRecipePath({ source, externalProductId, intent: 'link' })}
          onAddIngredient={(product) => {
            const next = addRecipeIngredient(ingredients, product)
            if (next.ok) {
              setIngredients(next.list)
              setIngredientSearch('')
              setSaveError('')
            } else {
              setSaveError('Hay un ingrediente repetido.')
            }
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
          onRecipeSearch={setRecipeSearch}
          onRemoveIngredient={(inventoryProductId) => {
            setIngredients((current) => removeRecipeIngredient(current, inventoryProductId))
          }}
          onSelectRecipe={setSelectedRecipeId}
          onSubmit={() => { void submit() }}
          onYieldQuantity={setYieldQuantity}
          onYieldUnit={setYieldUnit}
          productName={pendingProductName(pending)}
          recipeName={recipeName}
          recipeSearch={recipeSearch}
          recipes={linkableRecipes}
          saveError={saveError}
          saving={saving}
          selectedRecipeId={selectedRecipeId}
          source={source}
          yieldQuantity={yieldQuantity}
          yieldUnit={yieldUnit}
        />
      ) : null}
    </div>
  )
}

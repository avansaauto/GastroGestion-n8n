import { AlertCircle, ArrowLeft, Loader2, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import {
  createOrganizationRecipe,
  getInventoryProducts,
  getLocationRecipePrices,
  getOrganizationRecipeCategories,
  getOrganizationRecipes,
  getFudoCatalog,
  getPendingProducts,
  saveFudoRecipe,
  setLocationRecipePrice,
  type InventoryProduct,
  type OrganizationRecipeItem,
  type PendingProduct,
  type RecipeCategory,
} from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import { locationName, organizationName } from '@/lib/operations'
import {
  ADD_RECIPE_CATEGORY_LABEL,
} from '@/lib/recipeCategories'
import {
  RECIPE_YIELD_UNITS,
  addRecipeIngredient,
  canBeginRecipeSave,
  findPendingProduct,
  ingredientConversionPreview,
  linkRecipePayload,
  linkableOrganizationRecipes,
  parseCreatePendingRecipeSearch,
  pendingProductIdentity,
  pendingProductName,
  pendingRecipeForScope,
  pendingRecipeScopeKey,
  recipeSaveErrorMessage,
  removeRecipeIngredient,
  type RecipeIngredientDraft,
} from '@/lib/pendingRecipe'
import {
  RECIPE_CATEGORY_REQUIRED,
  RECIPE_MARGIN_UNAVAILABLE,
  RECIPE_PRICE_CONFLICT,
  RECIPE_PRICE_RETRY_NOTICE,
  RECIPE_PRICE_UNIT_ONLY,
  RECIPE_PROFIT_UNAVAILABLE,
  createOrganizationRecipePayload,
  estimateRecipeDraftCost,
  estimateRecipeDraftProfitability,
  persistRecipeAndLocationPrice,
  planRecipePricePersist,
  recipeCategorySelectionFromValue,
  recipeDraftCostPerYieldLabel,
  recipeDraftHasSellableYield,
  recipeDraftLineCostLabel,
  recipeDraftPctLabel,
  recipeDraftTotalCostLabel,
  recipeDraftValuationHint,
} from '@/lib/recipeDraft'
import { planFudoRecipeCreate } from '@/lib/fudoRecipeCreate'
import {
  FUDO_PRODUCT_EMPTY,
  FUDO_PRODUCT_FIELD_LABEL,
  FUDO_PRODUCT_HINT,
  FUDO_PRODUCT_LOCKED_NOTE,
  filterFudoProductsByName,
  fudoProductDisplayName,
  fudoProductMatchesIdentity,
  mergeFudoPickerProducts,
} from '@/lib/fudoProductPicker'
import { inventoryStockUnitColumnLabel } from '@/lib/inventoryCatalog'
import { inputUnitsForInventoryProduct } from '@/lib/recipeUnits'
import {
  formatArgentineMoneyDraft,
  formatRecipeCost,
  parseArgentineMoneyInput,
  RECIPE_SALE_PRICE_MAX,
  recipeConsumptionLabel,
  recipeYieldLabel,
} from './RecipesPage'

type DraftIngredient = RecipeIngredientDraft & { averageUnitCost?: number | null }

function IngredientSearch({
  disabled,
  ingredients,
  matches,
  onAdd,
  onSearch,
  search,
}: {
  disabled: boolean
  ingredients: { inventoryProductId: string }[]
  matches: InventoryProduct[]
  onAdd: (product: InventoryProduct) => void
  onSearch: (value: string) => void
  search: string
}) {
  const [active, setActive] = useState(0)
  const term = search.trim()
  const added = new Set(ingredients.map((item) => item.inventoryProductId))
  const visible = term ? matches.filter((product) => !added.has(product.id)) : []
  const open = term.length > 0
  const highlighted = visible.length === 0 ? -1 : Math.min(Math.max(active, 0), visible.length - 1)

  useEffect(() => {
    setActive(visible.length > 0 ? 0 : -1)
  }, [search, visible.length])

  function choose(index: number) {
    const product = visible[index]
    if (!product || disabled) return
    onAdd(product)
    onSearch('')
  }

  return (
    <div className="relative">
      <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
        Buscar insumo del inventario
        <span className="relative block">
          <Search className="pointer-events-none absolute left-3 top-3 text-slate-400" size={17} />
          <Input
            aria-activedescendant={open && highlighted >= 0 ? `ingredient-option-${visible[highlighted]?.id}` : undefined}
            aria-autocomplete="list"
            aria-controls="ingredient-search-list"
            aria-expanded={open}
            className="pl-9"
            disabled={disabled}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={(event) => {
              if (!open) return
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (visible.length === 0) return
                setActive((current) => (current + 1) % visible.length)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                if (visible.length === 0) return
                setActive((current) => (current <= 0 ? visible.length - 1 : current - 1))
              } else if (event.key === 'Enter') {
                if (highlighted < 0) return
                event.preventDefault()
                choose(highlighted)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onSearch('')
              }
            }}
            placeholder="Honey, Barril IPA…"
            role="combobox"
            value={search}
          />
        </span>
      </label>
      {open ? (
        <div
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-senda-border bg-white shadow-lg"
          id="ingredient-search-list"
          role="listbox"
        >
          {visible.length === 0 ? (
            <p className="mb-0 px-4 py-3 text-sm text-senda-muted">No hay insumos para esa búsqueda.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {visible.map((product, index) => (
                <li key={product.id}>
                  <button
                    aria-selected={index === highlighted}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm ${
                      index === highlighted ? 'bg-senda-subtle' : 'bg-white hover:bg-senda-subtle'
                    }`}
                    disabled={disabled}
                    id={`ingredient-option-${product.id}`}
                    onClick={() => choose(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    role="option"
                    type="button"
                  >
                    <span className="font-semibold">{product.name}</span>
                    <span className="text-xs text-senda-muted">{inventoryStockUnitColumnLabel(product)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function CreateRecipeForm({
  intent,
  fudoSource,
  fudoExternalProductId,
  fudoProductName,
  fudoProducts = [],
  fudoProductSearch = '',
  onFudoProductSearch,
  onSelectFudoProduct,
  fudoLocked = false,
  fudoReadOnlyNote,
  recipeName,
  onRecipeName,
  categoryValue,
  onCategoryValue,
  categoryName,
  onCategoryName,
  categories,
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
  notice,
  submitLabel,
  salePriceDraft = '',
  onSalePriceDraft,
  recipeLocked = false,
  priceConflict = false,
  onReloadPrice,
}: {
  intent: 'create' | 'link'
  fudoSource: string
  fudoExternalProductId: string
  fudoProductName: string
  fudoProducts?: PendingProduct[]
  fudoProductSearch?: string
  onFudoProductSearch?: (value: string) => void
  onSelectFudoProduct?: (product: PendingProduct | null) => void
  fudoLocked?: boolean
  recipeName: string
  onRecipeName: (value: string) => void
  categoryValue: string
  onCategoryValue: (value: string) => void
  categoryName: string
  onCategoryName: (value: string) => void
  categories: RecipeCategory[]
  yieldQuantity: string
  onYieldQuantity: (value: string) => void
  yieldUnit: string
  onYieldUnit: (value: string) => void
  ingredientSearch: string
  onIngredientSearch: (value: string) => void
  inventoryMatches: InventoryProduct[]
  ingredients: DraftIngredient[]
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
  notice?: string
  submitLabel?: string
  fudoReadOnlyNote?: string
  salePriceDraft?: string
  onSalePriceDraft?: (value: string) => void
  recipeLocked?: boolean
  priceConflict?: boolean
  onReloadPrice?: () => void | Promise<void>
}) {
  const categorySelection = recipeCategorySelectionFromValue(categoryValue, categoryName, categories)
  const draftCost = estimateRecipeDraftCost({ yieldQuantity, ingredients })
  const yieldAmount = Number(yieldQuantity.replace(',', '.'))
  const yieldReady = Number.isFinite(yieldAmount) && yieldAmount > 0
  const comparable = recipeDraftHasSellableYield(yieldQuantity, yieldUnit)
  const parsedSalePrice = parseArgentineMoneyInput(salePriceDraft)
  const profitability = estimateRecipeDraftProfitability(
    draftCost,
    salePriceDraft.trim() && salePriceDraft.trim() !== '—' ? parsedSalePrice : null,
    comparable,
  )
  const priceFieldEnabled = comparable && Boolean(onSalePriceDraft)
  const valuationHint = recipeDraftValuationHint(draftCost, ingredients)
  const fudoMatches = filterFudoProductsByName(fudoProducts, fudoProductSearch)
  const selectedFudoName = fudoProductName.trim() || null
  const showFudoPicker = intent === 'create'
  const [fudoListOpen, setFudoListOpen] = useState(false)

  return (
    <div className="space-y-6">
      {notice && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <AlertCircle size={18} /> {notice}
        </div>
      )}

      {intent === 'link' ? (
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
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-8">
            <Card>
              <div className="border-b border-senda-border px-5 py-3">
                <h3 className="m-0 text-sm font-bold">Información básica</h3>
              </div>
              <div className="space-y-4 p-5">
                <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
                  Nombre de receta
                  <Input
                    disabled={recipeLocked}
                    onChange={(event) => onRecipeName(event.target.value)}
                    placeholder="Hamburguesa clásica"
                    value={recipeName}
                  />
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
                    Categoría
                    <select
                      className="h-11 w-full rounded-lg border border-senda-border bg-white px-3 text-sm text-senda-ink disabled:cursor-not-allowed disabled:bg-senda-subtle"
                      disabled={recipeLocked}
                      onChange={(event) => onCategoryValue(event.target.value)}
                      value={categoryValue}
                    >
                      <option value="">Seleccionar…</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>{category.name}</option>
                      ))}
                      <option value="new">{ADD_RECIPE_CATEGORY_LABEL}</option>
                    </select>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
                      Rendimiento
                      <Input
                        disabled={recipeLocked}
                        inputMode="decimal"
                        onChange={(event) => onYieldQuantity(event.target.value)}
                        placeholder="1"
                        value={yieldQuantity}
                      />
                    </label>
                    <Select disabled={recipeLocked} label="Unidad" onChange={onYieldUnit} value={yieldUnit}>
                      {RECIPE_YIELD_UNITS.map((unit) => (
                        <option key={unit.value} value={unit.value}>{unit.label}</option>
                      ))}
                    </Select>
                  </div>
                </div>
                {categoryValue === 'new' && (
                  <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
                    Nombre de la categoría
                    <Input
                      disabled={recipeLocked}
                      onChange={(event) => onCategoryName(event.target.value)}
                      placeholder="Tapeo"
                      value={categoryName}
                    />
                  </label>
                )}
                {showFudoPicker && (
                  <div className="space-y-2">
                    <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
                      {FUDO_PRODUCT_FIELD_LABEL}
                      {fudoLocked || selectedFudoName ? (
                        <Input disabled readOnly value={selectedFudoName ?? ''} />
                      ) : (
                        <span className="relative block">
                          <Search className="absolute left-3 top-3 text-slate-400" size={17} />
                          <Input
                            className="pl-9"
                            disabled={recipeLocked}
                            onBlur={() => {
                              window.setTimeout(() => setFudoListOpen(false), 120)
                            }}
                            onChange={(event) => {
                              setFudoListOpen(true)
                              onFudoProductSearch?.(event.target.value)
                            }}
                            onFocus={() => setFudoListOpen(true)}
                            placeholder="Buscar por nombre o ID…"
                            value={fudoProductSearch}
                          />
                          {fudoListOpen ? (
                            <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-senda-border bg-white shadow-lg">
                              {fudoMatches.length === 0 ? (
                                <p className="mb-0 px-4 py-3 text-sm text-senda-muted">
                                  {fudoProductSearch.trim()
                                    ? 'No hay productos Fudo para esa búsqueda.'
                                    : FUDO_PRODUCT_EMPTY}
                                </p>
                              ) : (
                                <ul className="m-0 list-none divide-y divide-senda-border p-0">
                                  {fudoMatches.map((product) => {
                                    const name = fudoProductDisplayName(product) ?? ''
                                    const selected = fudoProductMatchesIdentity(
                                      product,
                                      fudoSource,
                                      fudoExternalProductId,
                                    )
                                    return (
                                      <li key={product.id}>
                                        <button
                                          className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left ${
                                            selected ? 'bg-senda-subtle' : 'bg-white hover:bg-senda-subtle'
                                          }`}
                                          disabled={recipeLocked}
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={() => {
                                            onSelectFudoProduct?.(product)
                                            setFudoListOpen(false)
                                          }}
                                          type="button"
                                        >
                                          <span className="min-w-0">
                                            <span className="block font-semibold">{name}</span>
                                            <span className="block text-xs text-senda-muted">
                                              ID {String(product.external_product_id ?? '')}
                                            </span>
                                          </span>
                                          {selected ? <Badge tone="success">Seleccionado</Badge> : null}
                                        </button>
                                      </li>
                                    )
                                  })}
                                </ul>
                              )}
                            </div>
                          ) : null}
                        </span>
                      )}
                    </label>
                    <p className="mb-0 text-xs text-senda-muted">
                      {fudoLocked ? (fudoReadOnlyNote ?? FUDO_PRODUCT_LOCKED_NOTE) : FUDO_PRODUCT_HINT}
                    </p>
                    {fudoLocked || selectedFudoName ? (
                      !fudoLocked && onSelectFudoProduct ? (
                        <button
                          className="text-xs font-semibold text-senda-navy hover:underline"
                          disabled={recipeLocked}
                          onClick={() => onSelectFudoProduct(null)}
                          type="button"
                        >
                          Quitar vinculación
                        </button>
                      ) : null
                    ) : null}
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div className="border-b border-senda-border px-5 py-3">
                <h3 className="m-0 text-sm font-bold">Ingredientes</h3>
                <p className="mb-0 mt-1 text-xs text-senda-muted">
                  Buscá un insumo, agregalo y definí la cantidad consumida. Podés guardar sin ingredientes.
                </p>
              </div>
              <div className="space-y-4 p-5">
                <IngredientSearch
                  disabled={recipeLocked}
                  ingredients={ingredients}
                  matches={inventoryMatches}
                  onAdd={onAddIngredient}
                  onSearch={onIngredientSearch}
                  search={ingredientSearch}
                />

                {ingredients.length === 0 ? (
                  <p className="mb-0 text-sm text-senda-muted">Sin ingredientes. La receta se creará sin consumo.</p>
                ) : (
                  <ul className="m-0 list-none space-y-3 p-0">
                    {ingredients.map((ingredient) => {
                      const units = inputUnitsForInventoryProduct(ingredient)
                      const conversion = ingredientConversionPreview(ingredient)
                      const conversionNote = conversion.startsWith('Unidad del insumo:') ? null : conversion
                      return (
                        <li
                          className="rounded-xl border border-senda-border px-3 py-2"
                          key={ingredient.inventoryProductId}
                        >
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <p className="mb-0 min-w-0 flex-1 truncate text-sm font-semibold" title={ingredient.name}>
                              {ingredient.name}
                            </p>
                            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
                              <Input
                                aria-label={`Cantidad de ${ingredient.name}`}
                                className="h-9 w-24"
                                disabled={recipeLocked}
                                inputMode="decimal"
                                onChange={(event) => onIngredientQuantity(ingredient.inventoryProductId, event.target.value)}
                                placeholder="0"
                                value={ingredient.quantity}
                              />
                              <select
                                aria-label={`Unidad de ${ingredient.name}`}
                                className="h-9 min-w-0 flex-1 rounded-lg border border-senda-border bg-white px-2 text-sm text-senda-ink disabled:cursor-not-allowed disabled:bg-senda-subtle sm:w-36 sm:flex-none"
                                disabled={recipeLocked}
                                onChange={(event) => onIngredientUnit(ingredient.inventoryProductId, event.target.value)}
                                value={ingredient.inputUnit}
                              >
                                {units.map((unit) => (
                                  <option key={unit.value} value={unit.value}>{unit.label}</option>
                                ))}
                              </select>
                              <span className="whitespace-nowrap text-sm font-semibold">
                                {recipeDraftLineCostLabel(draftCost, ingredient.inventoryProductId, formatRecipeCost)}
                              </span>
                              {conversionNote ? (
                                <span className="text-xs text-senda-muted">{conversionNote}</span>
                              ) : null}
                              <button
                                aria-label={`Quitar ${ingredient.name}`}
                                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 disabled:opacity-50"
                                disabled={recipeLocked}
                                onClick={() => onRemoveIngredient(ingredient.inventoryProductId)}
                                title={`Quitar ${ingredient.name}`}
                                type="button"
                              >
                                <Trash2 aria-hidden size={16} />
                              </button>
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </Card>
          </div>

          <div className="lg:col-span-4">
            <div className="space-y-6 lg:sticky lg:top-24">
              <Card>
                <div className="space-y-4 p-5">
                  <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
                    Precio de venta
                    <span className="relative block">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg font-bold text-senda-muted">$</span>
                      <Input
                        aria-label="Precio de venta"
                        className="pl-8 text-2xl font-bold"
                        disabled={!priceFieldEnabled}
                        inputMode="decimal"
                        onChange={(event) => onSalePriceDraft?.(event.target.value)}
                        placeholder="—"
                        readOnly={!priceFieldEnabled}
                        title={comparable ? undefined : RECIPE_PRICE_UNIT_ONLY}
                        value={salePriceDraft}
                      />
                    </span>
                  </label>
                  {!comparable ? (
                    <p className="mb-0 text-xs text-senda-muted">{RECIPE_PRICE_UNIT_ONLY}</p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-senda-border bg-senda-subtle p-3">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-senda-muted">Costo</p>
                      <p className="mb-0 font-bold">{recipeDraftCostPerYieldLabel(draftCost, formatRecipeCost)}</p>
                    </div>
                    <div className="rounded-xl border border-senda-border bg-senda-subtle p-3">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-senda-muted">Ganancia</p>
                      <p className="mb-0 font-bold">
                        {profitability.profit == null ? '—' : formatRecipeCost(profitability.profit)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-senda-border bg-senda-subtle p-3">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-senda-muted">Margen</p>
                      <p className="mb-0 font-bold">{recipeDraftPctLabel(profitability.marginPct)}</p>
                    </div>
                    <div className="rounded-xl border border-senda-border bg-senda-subtle p-3">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-senda-muted">Markup</p>
                      <p className="mb-0 font-bold">{recipeDraftPctLabel(profitability.markupPct)}</p>
                    </div>
                  </div>
                  {valuationHint ? (
                    <p className="mb-0 text-xs text-senda-muted">{valuationHint}</p>
                  ) : null}
                  {profitability.salePrice == null ? (
                    <>
                      <p className="mb-0 text-xs text-senda-muted">{RECIPE_PROFIT_UNAVAILABLE}</p>
                      <p className="mb-0 text-xs text-senda-muted">{RECIPE_MARGIN_UNAVAILABLE}</p>
                    </>
                  ) : null}
                  {priceConflict && onReloadPrice ? (
                    <button
                      className="text-left text-xs font-semibold text-senda-navy hover:underline"
                      onClick={onReloadPrice}
                      type="button"
                    >
                      Recargar precio
                    </button>
                  ) : null}
                </div>
                <div className="border-t border-senda-border px-5 py-4">
                  <h4 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-senda-muted">Desglose</h4>
                  <dl className="mt-3 space-y-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-senda-muted">Costo total de ingredientes</dt>
                      <dd className="mb-0 font-semibold">{recipeDraftTotalCostLabel(draftCost, formatRecipeCost)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-senda-muted">Rendimiento</dt>
                      <dd className="mb-0 font-semibold">
                        {yieldReady ? recipeYieldLabel(yieldAmount, yieldUnit) : '—'}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-senda-muted">
                        {comparable ? 'Costo por unidad vendible' : 'Costo por rendimiento'}
                      </dt>
                      <dd className="mb-0 font-semibold">{recipeDraftCostPerYieldLabel(draftCost, formatRecipeCost)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="font-medium">Ganancia bruta</dt>
                      <dd className="mb-0 font-bold">
                        {profitability.profit == null ? '—' : formatRecipeCost(profitability.profit)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="font-medium">Markup</dt>
                      <dd className="mb-0 font-semibold">{recipeDraftPctLabel(profitability.markupPct)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="font-medium">Margen sobre precio</dt>
                      <dd className="mb-0 font-semibold">{recipeDraftPctLabel(profitability.marginPct)}</dd>
                    </div>
                  </dl>
                  <h4 className="mb-0 mt-4 text-[11px] font-semibold uppercase tracking-wide text-senda-muted">
                    Costos por ingrediente
                  </h4>
                  {ingredients.length === 0 ? (
                    <p className="mb-0 mt-2 text-sm text-senda-muted">Sin ingredientes</p>
                  ) : (
                    <ul className="mb-0 mt-2 list-none space-y-2 p-0 text-sm">
                      {ingredients.map((ingredient) => (
                        <li
                          className="flex items-center justify-between gap-3"
                          key={ingredient.inventoryProductId}
                        >
                          <span className="text-senda-muted">{ingredient.name}</span>
                          <span className="font-semibold">
                            {recipeDraftLineCostLabel(draftCost, ingredient.inventoryProductId, formatRecipeCost)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}

      {saveError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} /> {saveError}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Link to="/recetas">
          <Button type="button" variant="secondary">Cancelar</Button>
        </Link>
        <Button disabled={!canSubmit || saving} onClick={onSubmit} type="button">
          {saving ? <Loader2 className="animate-spin" size={16} /> : null}
          {saving ? 'Guardando…' : submitLabel ?? (recipeLocked ? 'Reintentar precio' : intent === 'link' ? 'Vincular receta' : 'Guardar receta')}
        </Button>
      </div>
      {intent === 'create' && !categorySelection && (
        <p className="mb-0 text-right text-xs text-senda-muted">{RECIPE_CATEGORY_REQUIRED}</p>
      )}
    </div>
  )
}

export function CreateRecipePage() {
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
  const fudoMode = Boolean(source && externalProductId)
  const scopeKey = fudoMode
    ? pendingRecipeScopeKey(organizationId, locationId, source, externalProductId)
    : `${organizationId}::${locationId}`
  const [load, setLoad] = useState<{
    key: string
    pending: PendingProduct | null
    pendingProducts: PendingProduct[]
    inventory: InventoryProduct[]
    recipes: OrganizationRecipeItem[]
    categories: RecipeCategory[]
    error: string
  }>({
    key: '',
    pending: null,
    pendingProducts: [],
    inventory: [],
    recipes: [],
    categories: [],
    error: '',
  })
  const [recipeName, setRecipeName] = useState('')
  const [categoryValue, setCategoryValue] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [yieldQuantity, setYieldQuantity] = useState('1')
  const [yieldUnit, setYieldUnit] = useState('unit')
  const [ingredients, setIngredients] = useState<DraftIngredient[]>([])
  const [ingredientSearch, setIngredientSearch] = useState('')
  const [recipeSearch, setRecipeSearch] = useState('')
  const [fudoProductSearch, setFudoProductSearch] = useState('')
  const [selectedFudo, setSelectedFudo] = useState<{ source: string; externalProductId: string } | null>(null)
  const [selectedRecipeId, setSelectedRecipeId] = useState('')
  const [salePriceDraft, setSalePriceDraft] = useState('')
  const [salePriceVersion, setSalePriceVersion] = useState<number | null>(null)
  const [persistedRecipeId, setPersistedRecipeId] = useState<string | null>(null)
  const [priceConflict, setPriceConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const savingRef = useRef(false)
  const requestRef = useRef(0)
  const namedForKey = useRef('')

  const pending = pendingRecipeForScope(load.key, scopeKey, load.pending)
  const pendingProducts = pendingRecipeForScope(load.key, scopeKey, load.pendingProducts) ?? []
  const inventory = pendingRecipeForScope(load.key, scopeKey, load.inventory) ?? []
  const organizationRecipes = pendingRecipeForScope(load.key, scopeKey, load.recipes) ?? []
  const categories = pendingRecipeForScope(load.key, scopeKey, load.categories) ?? []
  const loadError = load.key === scopeKey ? load.error : ''
  const loading = scopeLoading || (Boolean(organizationId) && load.key !== scopeKey)

  useEffect(() => {
    setIngredients([])
    setIngredientSearch('')
    setRecipeSearch('')
    setFudoProductSearch('')
    setSelectedFudo(null)
    setSelectedRecipeId('')
    setSalePriceDraft('')
    setSalePriceVersion(null)
    setPersistedRecipeId(null)
    setPriceConflict(false)
    setSaveError('')
    setYieldQuantity('1')
    setYieldUnit('unit')
    setCategoryValue('')
    setCategoryName('')
    setRecipeName('')
    namedForKey.current = ''
  }, [scopeKey])

  useEffect(() => {
    if (previewMode || !organizationId) {
      requestRef.current += 1
      setLoad({
        key: `${organizationId}::${locationId}`,
        pending: null,
        pendingProducts: [],
        inventory: [],
        recipes: [],
        categories: [],
        error: !previewMode && !organizationId ? 'No hay una organización activa.' : '',
      })
      return
    }
    if (fudoMode && !locationId) {
      requestRef.current += 1
      setLoad({
        key: pendingRecipeScopeKey(organizationId, locationId, source, externalProductId),
        pending: null,
        pendingProducts: [],
        inventory: [],
        recipes: [],
        categories: [],
        error: 'No hay un local activo.',
      })
      return
    }
    const key = scopeKey
    const requestId = ++requestRef.current
    Promise.all([
      getOrganizationRecipeCategories(organizationId).catch(() => [] as RecipeCategory[]),
      getInventoryProducts(organizationId, { locationId: locationId || undefined }),
      getOrganizationRecipes(organizationId),
      locationId
        // Sin filtro de status: incluye resolved huérfanos (sin mapping activo).
        ? Promise.all([
          getFudoCatalog(locationId).catch(() => [] as PendingProduct[]),
          getPendingProducts(locationId).catch(() => [] as PendingProduct[]),
        ]).then(([catalog, historical]) => mergeFudoPickerProducts(catalog, historical))
        : Promise.resolve([] as PendingProduct[]),
    ])
      .then(([nextCategories, inventoryProducts, recipes, nextPendingProducts]) => {
        if (requestId !== requestRef.current) return
        const match = fudoMode
          ? findPendingProduct(nextPendingProducts, source, externalProductId)
          : null
        setLoad({
          key,
          pending: match,
          pendingProducts: nextPendingProducts,
          inventory: inventoryProducts,
          recipes,
          categories: nextCategories,
          error: fudoMode && !match
            ? 'Este producto Fudo no está disponible para vincular en el local activo.'
            : '',
        })
        if (match) {
          const identity = pendingProductIdentity(match)
          if (identity) setSelectedFudo(identity)
        }
      })
      .catch((reason: Error) => {
        if (requestId !== requestRef.current) return
        setLoad({
          key,
          pending: null,
          pendingProducts: [],
          inventory: [],
          recipes: [],
          categories: [],
          error: reason.message,
        })
      })
  }, [externalProductId, fudoMode, locationId, organizationId, previewMode, scopeKey, source])

  useEffect(() => {
    if (!pending || namedForKey.current === scopeKey) return
    const name = pendingProductName(pending)
    if (name && name !== '—') setRecipeName(name)
    namedForKey.current = scopeKey
  }, [pending, scopeKey])

  useEffect(() => {
    if (categories.length === 0 && categoryValue === '') setCategoryValue('new')
  }, [categories, categoryValue])

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

  const linkableRecipes = useMemo(() => {
    const term = recipeSearch.trim().toLocaleLowerCase('es')
    return linkableOrganizationRecipes(organizationRecipes).filter((recipe) => (
      !term || recipe.name.toLocaleLowerCase('es').includes(term)
    ))
  }, [organizationRecipes, recipeSearch])

  const categorySelection = recipeCategorySelectionFromValue(categoryValue, categoryName, categories)
  const createReady = createOrganizationRecipePayload({
    name: recipeName,
    yieldQuantity,
    yieldUnit,
    ingredients,
    category: categorySelection,
    categories,
  })
  const selectedFudoIdentity = selectedFudo
    ?? (fudoMode ? { source, externalProductId } : null)
  const selectedPending = selectedFudoIdentity
    ? findPendingProduct(pendingProducts, selectedFudoIdentity.source, selectedFudoIdentity.externalProductId)
      ?? pending
    : null
  const fudoPlan = selectedFudoIdentity && intent === 'create'
    ? planFudoRecipeCreate({
      source: selectedFudoIdentity.source,
      externalProductId: selectedFudoIdentity.externalProductId,
      name: recipeName,
      yieldQuantity,
      yieldUnit,
      ingredients,
      category: categorySelection,
      categories,
    })
    : null
  const linkReady = linkRecipePayload({
    source,
    externalProductId,
    existingRecipeId: selectedRecipeId,
  })
  const canSubmit = intent === 'link'
    ? linkReady.ok && Boolean(locationId)
    : persistedRecipeId
      ? Boolean(organizationId && locationId)
      : selectedFudoIdentity
        ? Boolean(fudoPlan?.ok && locationId && selectedPending)
        : createReady.ok && Boolean(organizationId)

  if (previewMode) {
    return (
      <Card className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
        <h2 className="mb-0 mt-5 text-xl font-bold">Supabase todavía no está configurado</h2>
        <p className="mb-0 mt-2 max-w-lg text-sm leading-6 text-senda-muted">
          Configurá las variables del frontend y la API para crear recetas reales.
        </p>
      </Card>
    )
  }

  async function submit() {
    if (!canBeginRecipeSave(saving) || savingRef.current) return
    if (intent === 'link') {
      if (!locationId || !linkReady.ok) {
        setSaveError(linkReady.ok ? 'No hay un local activo.' : linkReady.error)
        return
      }
      savingRef.current = true
      setSaving(true)
      setSaveError('')
      try {
        await saveFudoRecipe(locationId, linkReady.body)
        navigate('/recetas')
      } catch (error) {
        setSaveError(recipeSaveErrorMessage(error))
        savingRef.current = false
        setSaving(false)
      }
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
    if (pricePlan.kind === 'save' && (!organizationId || !locationId)) {
      setSaveError('No hay un local activo.')
      return
    }

    async function saveCreatedRecipe() {
      if (selectedFudoIdentity && locationId) {
        const plan = fudoPlan ?? planFudoRecipeCreate({
          source: selectedFudoIdentity.source,
          externalProductId: selectedFudoIdentity.externalProductId,
          name: recipeName,
          yieldQuantity,
          yieldUnit,
          ingredients,
          category: categorySelection,
          categories,
        })
        if (!plan.ok) throw new Error(plan.error)
        return saveFudoRecipe(locationId, plan.body)
      }
      if (!organizationId || !createReady.ok) {
        throw new Error(createReady.ok ? 'No hay una organización activa.' : createReady.error)
      }
      return createOrganizationRecipe(organizationId, createReady.body)
    }

    if (!persistedRecipeId) {
      if (selectedFudoIdentity && (!locationId || !selectedPending)) {
        setSaveError(!locationId ? 'No hay un local activo.' : 'Este producto Fudo no está disponible para vincular en el local activo.')
        return
      }
      if (!selectedFudoIdentity && (!organizationId || !createReady.ok)) {
        setSaveError(createReady.ok ? 'No hay una organización activa.' : createReady.error)
        return
      }
    }

    savingRef.current = true
    setSaving(true)
    setSaveError('')
    setPriceConflict(false)
    try {
      const result = await persistRecipeAndLocationPrice({
        skipRecipe: Boolean(persistedRecipeId),
        persistedRecipeId,
        saveRecipe: saveCreatedRecipe,
        pricePlan,
        savePrice: (recipeId, salePrice, expectedVersion) => (
          setLocationRecipePrice(organizationId!, locationId!, recipeId, { salePrice, expectedVersion })
        ),
      })
      if (!result.ok) {
        setPersistedRecipeId(result.recipeId)
        setPriceConflict(result.conflict)
        setSaveError(result.conflict ? RECIPE_PRICE_CONFLICT : result.error)
        savingRef.current = false
        setSaving(false)
        return
      }
      navigate('/recetas')
    } catch (error) {
      setSaveError(recipeSaveErrorMessage(error))
      savingRef.current = false
      setSaving(false)
    }
  }

  const formReady = !fudoMode || Boolean(pending)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link className="inline-flex items-center gap-2 text-sm font-semibold text-senda-navy hover:underline" to="/recetas">
            <ArrowLeft size={16} /> Recetas
          </Link>
          <h2 className="mb-0 mt-3 text-2xl font-extrabold tracking-tight">
            {intent === 'link' ? 'Vincular receta existente' : 'Crear receta'}
          </h2>
          <p className="mb-0 mt-2 text-sm text-senda-muted">
            {intent === 'link'
              ? 'Asociá el producto Fudo a una receta ya cargada en la organización.'
              : 'Definí nombre, categoría, rendimiento, ingredientes y precio de venta.'}
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
      ) : formReady ? (
        <CreateRecipeForm
          canSubmit={canSubmit}
          categories={categories}
          categoryName={categoryName}
          categoryValue={categoryValue}
          fudoExternalProductId={selectedFudoIdentity?.externalProductId ?? ''}
          fudoLocked={fudoMode}
          fudoProductName={selectedPending ? pendingProductName(selectedPending) : ''}
          fudoProductSearch={fudoProductSearch}
          fudoProducts={pendingProducts}
          fudoReadOnlyNote={fudoMode ? FUDO_PRODUCT_LOCKED_NOTE : undefined}
          fudoSource={selectedFudoIdentity?.source ?? ''}
          onFudoProductSearch={setFudoProductSearch}
          onSelectFudoProduct={(product) => {
            setSelectedFudo(product ? pendingProductIdentity(product) : null)
            setFudoProductSearch('')
          }}
          ingredientSearch={ingredientSearch}
          ingredients={ingredients}
          intent={intent}
          inventoryMatches={inventoryMatches}
          notice={persistedRecipeId ? RECIPE_PRICE_RETRY_NOTICE : undefined}
          onReloadPrice={async () => {
            if (!organizationId || !locationId || !persistedRecipeId) return
            const prices = await getLocationRecipePrices(organizationId, locationId)
            const current = prices.find((item) => item.recipeId === persistedRecipeId)
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
          recipeLocked={Boolean(persistedRecipeId)}
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
          onRecipeSearch={setRecipeSearch}
          onRemoveIngredient={(inventoryProductId) => {
            setIngredients((current) => removeRecipeIngredient(current, inventoryProductId))
          }}
          onSelectRecipe={setSelectedRecipeId}
          onSubmit={() => { void submit() }}
          onYieldQuantity={setYieldQuantity}
          onYieldUnit={setYieldUnit}
          recipeName={recipeName}
          recipeSearch={recipeSearch}
          recipes={linkableRecipes}
          saveError={saveError}
          saving={saving}
          selectedRecipeId={selectedRecipeId}
          yieldQuantity={yieldQuantity}
          yieldUnit={yieldUnit}
        />
      ) : null}
    </div>
  )
}

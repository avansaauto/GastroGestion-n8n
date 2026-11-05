import { AlertCircle, Boxes, Loader2, Minus, Pencil, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import {
  adjustInventoryProductStock,
  createInventoryProduct,
  deleteInventoryProduct,
  getInventoryProducts,
  getOrganizationSuppliers,
  InventoryApiError,
  reactivateInventoryProduct,
  setInventoryPurchaseCost,
  updateInventoryProduct,
  type InventoryMovement,
  type InventoryProduct,
  type OrganizationSupplier,
} from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import {
  formatInventoryMinimumStock,
  formatInventoryStock,
  inventoryCategoryLabel,
  inventoryLowStockProducts,
  inventoryProductsActiveOnly,
  inventoryStockUnitColumnLabel,
  inventorySupplierLabel,
  isInventoryBelowMinimum,
} from '@/lib/inventoryCatalog'
import {
  commercialToPhysicalQty,
  commercialUnitLabel,
  hasReliableCommercialPresentation,
  physicalToCommercial,
} from '@/lib/inventoryPresentation'
import {
  CREATE_CONTENT_UNITS,
  CREATE_STOCK_UNITS,
  INITIAL_STOCK_ADJUST_REASON,
  physicalFromPresentationUnits,
  resolveCreateInsumoQuantities,
  showsContentPerUnitSection,
  stockUnitLabel,
} from '@/lib/inventoryCreateForm'
import {
  canRegisterInitialValuation,
  commercialQuantityFromOnHand,
  defaultInitialCostBasis,
  initialCostBasisLabel,
  planInitialAcquisitionCost,
  type InitialCostBasis,
} from '@/lib/inventoryInitialCost'
import { roundInventoryUnitCost } from '@/lib/inventoryPurchaseCost'
import { displayToPhysical, formatInventoryUnit, physicalToDisplay } from '@/lib/invoices/receptionUnits'
import { formatQuantity } from '@/lib/invoices/review'
import { useRegisterWorkspaceGuard } from '@/lib/WorkspaceGuardProvider'
import { inventoryWorkspaceGuard } from '@/lib/workspaceGuard'

export type InventoryCreateState = {
  open: boolean
  name: string
  category: string
  /** Unidad de stock del formulario: u | g | kg | ml | L */
  stockUnit: string
  initialStockDisplay: string
  minimumStockDisplay: string
  contentOpen: boolean
  contentQuantity: string
  contentUnit: string
  preferredSupplierId: string
  /** Vacío = sin valuación inicial (no inventa $0). */
  initialCostDisplay: string
  initialCostBasis: InitialCostBasis
  creating: boolean
  error: string
  inactiveProductId: string | null
  inactiveProductName: string | null
}

export const INITIAL_INVENTORY_CREATE: InventoryCreateState = {
  open: false,
  name: '',
  category: '',
  stockUnit: 'u',
  initialStockDisplay: '',
  minimumStockDisplay: '',
  contentOpen: false,
  contentQuantity: '',
  contentUnit: 'ml',
  preferredSupplierId: '',
  initialCostDisplay: '',
  initialCostBasis: 'stock',
  creating: false,
  error: '',
  inactiveProductId: null,
  inactiveProductName: null,
}

export type InventoryCreateAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'name'; value: string }
  | { type: 'category'; value: string }
  | { type: 'stockUnit'; value: string }
  | { type: 'initial'; value: string }
  | { type: 'minimum'; value: string }
  | { type: 'contentOpen'; value: boolean }
  | { type: 'contentQuantity'; value: string }
  | { type: 'contentUnit'; value: string }
  | { type: 'supplier'; value: string }
  | { type: 'initialCost'; value: string }
  | { type: 'initialCostBasis'; value: InitialCostBasis }
  | { type: 'submit' }
  | { type: 'success' }
  | { type: 'error'; message: string; inactiveProductId?: string | null; inactiveProductName?: string | null }

export function canSubmitInventoryCreate(creating: boolean, name: string) {
  return !creating && name.trim().length >= 2
}

export function appendCreatedInventoryProduct(
  products: InventoryProduct[],
  created: InventoryProduct,
) {
  return [...products, created].sort((left, right) => left.name.localeCompare(right.name, 'es'))
}

export function inventoryScopeKey(organizationId: string, locationId: string) {
  return `${organizationId}::${locationId}`
}

export function inventoryProductsForScope(
  loadedKey: string,
  scopeKey: string,
  products: InventoryProduct[],
) {
  return loadedKey === scopeKey ? products : []
}

export function inventoryCreateReducer(
  state: InventoryCreateState,
  action: InventoryCreateAction,
): InventoryCreateState {
  switch (action.type) {
    case 'open':
      return { ...INITIAL_INVENTORY_CREATE, open: true }
    case 'close':
      return state.creating ? state : INITIAL_INVENTORY_CREATE
    case 'name':
      return { ...state, name: action.value, inactiveProductId: null, inactiveProductName: null, error: '' }
    case 'category':
      return { ...state, category: action.value }
    case 'stockUnit': {
      const stockUnit = action.value
      const contentOpen = showsContentPerUnitSection(stockUnit) ? state.contentOpen : false
      return {
        ...state,
        stockUnit,
        contentOpen,
        initialCostBasis: defaultInitialCostBasis({
          stockUnit,
          contentEnabled: contentOpen,
          conversionFactor: null,
        }),
        error: '',
      }
    }
    case 'initial':
      return { ...state, initialStockDisplay: action.value }
    case 'minimum':
      return { ...state, minimumStockDisplay: action.value }
    case 'contentOpen':
      return {
        ...state,
        contentOpen: action.value,
        initialCostBasis: defaultInitialCostBasis({
          stockUnit: state.stockUnit,
          contentEnabled: action.value,
          conversionFactor: null,
        }),
      }
    case 'contentQuantity':
      return { ...state, contentQuantity: action.value }
    case 'contentUnit':
      return { ...state, contentUnit: action.value }
    case 'supplier':
      return { ...state, preferredSupplierId: action.value }
    case 'initialCost':
      return { ...state, initialCostDisplay: action.value }
    case 'initialCostBasis':
      return { ...state, initialCostBasis: action.value }
    case 'submit':
      if (!canSubmitInventoryCreate(state.creating, state.name) && !state.inactiveProductId) return state
      if (state.creating) return state
      return { ...state, creating: true, error: '' }
    case 'success':
      return INITIAL_INVENTORY_CREATE
    case 'error':
      return {
        ...state,
        creating: false,
        error: action.message,
        open: true,
        inactiveProductId: action.inactiveProductId ?? null,
        inactiveProductName: action.inactiveProductName ?? null,
      }
  }
}

export function inventoryUnitLabel(unit: string | null | undefined) {
  const key = unit?.trim().toLowerCase()
  if (key === 'g' || key === 'gr' || key === 'gramos') return 'Gramos'
  if (key === 'ml' || key === 'mililitros') return 'Mililitros'
  if (key === 'unit' || key === 'u' || key === 'unidades') return 'Unidades'
  if (key === 'l' || key === 'litros') return 'Litros'
  if (key === 'kg' || key === 'kilogramos') return 'Kilogramos'
  return unit?.trim() || '—'
}

export function applyInventoryPurchaseCost(
  products: InventoryProduct[],
  inventoryProductId: string,
  averageUnitCost: number,
  onHand: number,
) {
  return products.map((product) => (
    product.id === inventoryProductId
      ? { ...product, averageUnitCost, onHand }
      : product
  ))
}

export function applyInventoryProductPatch(
  products: InventoryProduct[],
  inventoryProductId: string,
  patch: Partial<InventoryProduct>,
) {
  return products.map((product) => (
    product.id === inventoryProductId ? { ...product, ...patch } : product
  ))
}

export function removeInventoryProduct(
  products: InventoryProduct[],
  inventoryProductId: string,
) {
  return products.filter((product) => product.id !== inventoryProductId)
}

export function InventoryCreateModal({
  open,
  name,
  onName,
  category,
  onCategory,
  stockUnit,
  onStockUnit,
  initialStockDisplay,
  onInitialStock,
  minimumStockDisplay,
  onMinimumStock,
  contentOpen,
  onContentOpen,
  contentQuantity,
  onContentQuantity,
  contentUnit,
  onContentUnit,
  preferredSupplierId,
  onSupplier,
  initialCostDisplay,
  onInitialCost,
  initialCostBasis,
  onInitialCostBasis,
  supplierOptions,
  creating,
  createError,
  inactiveProductId,
  inactiveProductName,
  onCreate,
  onReactivate,
  onClose,
}: {
  open: boolean
  name: string
  onName: (value: string) => void
  category: string
  onCategory: (value: string) => void
  stockUnit: string
  onStockUnit: (value: string) => void
  initialStockDisplay: string
  onInitialStock: (value: string) => void
  minimumStockDisplay: string
  onMinimumStock: (value: string) => void
  contentOpen: boolean
  onContentOpen: (value: boolean) => void
  contentQuantity: string
  onContentQuantity: (value: string) => void
  contentUnit: string
  onContentUnit: (value: string) => void
  preferredSupplierId: string
  onSupplier: (value: string) => void
  initialCostDisplay: string
  onInitialCost: (value: string) => void
  initialCostBasis: InitialCostBasis
  onInitialCostBasis: (value: InitialCostBasis) => void
  supplierOptions: OrganizationSupplier[]
  creating: boolean
  createError: string
  inactiveProductId: string | null
  inactiveProductName: string | null
  onCreate: () => void
  onReactivate: () => void
  onClose: () => void
}) {
  useEffect(() => {
    if (!open || creating) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [creating, onClose, open])

  const showContent = showsContentPerUnitSection(stockUnit)
  const unitHint = stockUnitLabel(stockUnit)
  const presentationCostAvailable = showContent && contentOpen && Number(contentQuantity.replace(',', '.')) > 0
  const costPreview = planInitialAcquisitionCost({
    costDisplay: initialCostDisplay,
    basis: initialCostBasis,
    stockUnit,
    quantityDisplay: initialStockDisplay,
    contentEnabled: presentationCostAvailable,
    contentQuantity,
    contentUnit,
  })

  return (
    <Modal open={open} title="Nuevo insumo" onClose={creating ? () => undefined : onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (inactiveProductId) onReactivate()
          else onCreate()
        }}
      >
        <p className="mb-0 text-sm text-senda-muted">
          Alta manual. El costo principal sigue llegando desde facturas (CPP).
          El costo inicial es opcional para mercadería preexistente.
        </p>
        <label className="block space-y-1.5 text-xs font-semibold text-senda-muted" htmlFor="inventory-create-name">
          Nombre del insumo
          <Input
            autoFocus
            disabled={creating}
            id="inventory-create-name"
            onChange={(event) => onName(event.target.value)}
            placeholder="Fernet, harina, huevos…"
            value={name}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5 text-xs font-semibold text-senda-muted" htmlFor="inventory-create-initial">
            Stock inicial
            <Input
              disabled={creating}
              id="inventory-create-initial"
              inputMode="decimal"
              onChange={(event) => onInitialStock(event.target.value)}
              placeholder="Opcional"
              value={initialStockDisplay}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-semibold text-senda-muted" htmlFor="inventory-create-minimum">
            Stock mínimo
            <Input
              disabled={creating}
              id="inventory-create-minimum"
              inputMode="decimal"
              onChange={(event) => onMinimumStock(event.target.value)}
              placeholder="Opcional"
              value={minimumStockDisplay}
            />
          </label>
        </div>
        <Select disabled={creating} label="Unidad de medida" onChange={onStockUnit} value={stockUnit}>
          {CREATE_STOCK_UNITS.map((unit) => (
            <option key={unit.value} value={unit.value}>{unit.label}</option>
          ))}
        </Select>
        <p className="mb-0 -mt-2 text-xs text-senda-muted">
          Stock inicial y mínimo se interpretan en {unitHint}.
        </p>
        {showContent ? (
          <div className="rounded-xl border border-senda-border">
            <button
              aria-controls="inventory-create-content"
              aria-expanded={contentOpen}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left text-xs font-semibold text-senda-muted"
              disabled={creating}
              id="inventory-create-content-toggle"
              onClick={() => onContentOpen(!contentOpen)}
              type="button"
            >
              Contenido por unidad
              <span className="font-normal text-senda-muted">{contentOpen ? 'Ocultar' : 'Opcional'}</span>
            </button>
            {contentOpen ? (
              <div className="grid gap-3 border-t border-senda-border px-3 py-3 sm:grid-cols-2" id="inventory-create-content">
                <label className="block space-y-1.5 text-xs font-semibold text-senda-muted" htmlFor="inventory-create-content-qty">
                  Cantidad de contenido
                  <Input
                    disabled={creating}
                    id="inventory-create-content-qty"
                    inputMode="decimal"
                    onChange={(event) => onContentQuantity(event.target.value)}
                    placeholder="Ej. 750"
                    value={contentQuantity}
                  />
                </label>
                <Select
                  disabled={creating}
                  label="Unidad de contenido"
                  onChange={onContentUnit}
                  value={contentUnit}
                >
                  {CREATE_CONTENT_UNITS.map((unit) => (
                    <option key={unit.value} value={unit.value}>{unit.label}</option>
                  ))}
                </Select>
                <p className="mb-0 sm:col-span-2 text-xs text-senda-muted">
                  Si lo indicás, el inventario interno usa g o ml y las recetas pueden consumir fracciones.
                  Sin contenido, cada unidad se consume entera.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        <Select
          disabled={creating}
          label="Proveedor (opcional)"
          onChange={onSupplier}
          value={preferredSupplierId}
        >
          <option value="">Sin proveedor</option>
          {supplierOptions.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
          ))}
        </Select>
        <div className="rounded-xl border border-senda-border p-3 space-y-3">
          <p className="m-0 text-xs font-semibold text-senda-muted">Costo inicial (opcional)</p>
          <p className="mb-0 text-xs text-senda-muted">
            Independiente del proveedor y del precio de venta. Vacío = sin valuación (las recetas
            mostrarán costo pendiente hasta una factura o esta carga).
          </p>
          {presentationCostAvailable ? (
            <Select
              disabled={creating}
              label="Base del costo"
              onChange={(value) => onInitialCostBasis(value as InitialCostBasis)}
              value={initialCostBasis}
            >
              <option value="presentation">{initialCostBasisLabel('presentation', stockUnit)}</option>
              <option value="stock">{initialCostBasisLabel('stock', stockUnit)}</option>
            </Select>
          ) : null}
          <label className="block space-y-1.5 text-xs font-semibold text-senda-muted" htmlFor="inventory-create-initial-cost">
            {initialCostBasisLabel(
              presentationCostAvailable ? initialCostBasis : 'stock',
              stockUnit,
            )}
            <Input
              disabled={creating}
              id="inventory-create-initial-cost"
              inputMode="decimal"
              onChange={(event) => onInitialCost(event.target.value)}
              placeholder="Opcional"
              value={initialCostDisplay}
            />
          </label>
          {costPreview.ok && !costPreview.skip ? (
            <p className="mb-0 text-xs text-senda-muted">
              Equivale a {roundInventoryUnitCost(costPreview.unitCost)} por unidad base
              {costPreview.purchaseQuantity > 0
                ? ` (valoriza ${formatQuantity(costPreview.purchaseQuantity)} en base)`
                : ''}
              .
            </p>
          ) : null}
        </div>
        <label className="block space-y-1.5 text-xs font-semibold text-senda-muted" htmlFor="inventory-create-category">
          Categoría
          <Input
            disabled={creating}
            id="inventory-create-category"
            onChange={(event) => onCategory(event.target.value)}
            placeholder="Opcional"
            value={category}
          />
        </label>
        {createError && (
          <p className="mb-0 text-sm text-red-700" role="alert">{createError}</p>
        )}
        {inactiveProductId ? (
          <p className="mb-0 text-sm text-senda-muted">
            Se reactivará «{inactiveProductName ?? name}» con el mismo identificador e historial.
            No se crea un producto nuevo.
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={creating} onClick={onClose} type="button" variant="secondary">
            Cancelar
          </Button>
          {inactiveProductId ? (
            <Button disabled={creating} type="submit">
              {creating ? 'Reactivando…' : 'Reactivar insumo'}
            </Button>
          ) : (
            <Button disabled={!canSubmitInventoryCreate(creating, name)} type="submit">
              {creating ? 'Creando…' : 'Crear insumo'}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  )
}


export function InventoryCatalog({
  products,
  search,
  onSearch,
  loading,
  error,
  onEdit,
  onDelete,
  onWaste,
}: {
  products: InventoryProduct[]
  search: string
  onSearch: (value: string) => void
  loading: boolean
  error: string
  onEdit?: (product: InventoryProduct) => void
  onDelete?: (product: InventoryProduct) => void
  onWaste?: (product: InventoryProduct) => void
}) {
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es')
    const active = inventoryProductsActiveOnly(products)
    if (!term) return active
    return active.filter((product) => product.name.toLocaleLowerCase('es').includes(term))
  }, [products, search])
  const lowStock = useMemo(() => inventoryLowStockProducts(products), [products])

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
          Buscar
          <span className="relative block">
            <Search className="absolute left-3 top-3 text-slate-400" size={17} />
            <Input
              className="pl-9"
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Nombre del producto…"
              value={search}
            />
          </span>
        </label>
      </Card>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {lowStock.length > 0 && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900" role="status">
          <p className="m-0 font-semibold">Stock bajo</p>
          <p className="mb-0 mt-1">
            {lowStock.map((product) => product.name).join(', ')}
            {' '}
            {lowStock.length === 1 ? 'está' : 'están'} en el mínimo o por debajo.
          </p>
        </div>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-senda-muted">
            <Loader2 className="animate-spin" size={19} /> Cargando inventario…
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-5 text-center text-sm text-senda-muted">
            {search
              ? 'No hay resultados para la búsqueda.'
              : 'Todavía no hay productos en este inventario. Crealos acá para vincularlos en las facturas.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="border-b border-senda-border bg-senda-subtle text-xs uppercase tracking-wide text-senda-muted">
                <tr>
                  {['Producto', 'Categoría', 'Proveedor', 'Stock actual', 'Unidad', 'Stock mínimo', 'Acciones'].map((label) => (
                    <th className="px-5 py-3 font-semibold" key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => (
                  <tr className="border-b border-senda-border last:border-0" key={product.id}>
                    <td className="px-5 py-4 font-semibold">{product.name}</td>
                    <td className="px-5 py-4 text-senda-muted">{inventoryCategoryLabel(product)}</td>
                    <td className="px-5 py-4 text-senda-muted">{inventorySupplierLabel(product)}</td>
                    <td className="px-5 py-4">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-senda-ink">
                            {formatInventoryStock(product.onHand, product, formatQuantity, { withBaseEquivalence: false })}
                          </span>
                          {isInventoryBelowMinimum(product.onHand, product.minimumStock) ? (
                            <span className="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-800">
                              Stock bajo
                            </span>
                          ) : null}
                        </div>
                        {hasReliableCommercialPresentation(product) ? (
                          <p className="mb-0 text-xs text-senda-muted">
                            {formatInventoryStock(product.onHand, product.baseUnit, formatQuantity)}
                            {' disponibles'}
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-senda-muted">{inventoryStockUnitColumnLabel(product)}</td>
                    <td className="px-5 py-4 text-senda-muted">
                      {formatInventoryMinimumStock(product.minimumStock ?? null, product, formatQuantity)}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        {onEdit ? (
                          <button
                            aria-label={`Editar ${product.name}`}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-senda-navy hover:bg-senda-subtle"
                            onClick={() => onEdit(product)}
                            title={`Editar ${product.name}`}
                            type="button"
                          >
                            <Pencil aria-hidden size={17} />
                          </button>
                        ) : null}
                        {onWaste ? (
                          <button
                            aria-label={`Registrar merma de ${product.name}`}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-senda-navy hover:bg-senda-subtle"
                            onClick={() => onWaste(product)}
                            title={`Registrar merma de ${product.name}`}
                            type="button"
                          >
                            <Minus aria-hidden size={17} />
                          </button>
                        ) : null}
                        {onDelete ? (
                          <button
                            aria-label={`Eliminar ${product.name}`}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-red-700 hover:bg-red-50"
                            onClick={() => onDelete(product)}
                            title={`Eliminar ${product.name}`}
                            type="button"
                          >
                            <Trash2 aria-hidden size={17} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

export function InventoryEditModal({
  product,
  locationId,
  saving,
  error,
  onClose,
  onSave,
}: {
  product: InventoryProduct | null
  locationId: string
  saving: boolean
  error: string
  onClose: () => void
  onSave: (input: {
    name: string
    category: string
    minimumStockDisplay: string
    stockDeltaDisplay: string
    presentationDeltaDisplay: string
    adjustReason: string
    initialCostDisplay: string
    initialCostBasis: InitialCostBasis
  }) => void
}) {
  const open = Boolean(product)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [minimumStockDisplay, setMinimumStockDisplay] = useState('')
  const [stockDeltaDisplay, setStockDeltaDisplay] = useState('')
  const [presentationDeltaDisplay, setPresentationDeltaDisplay] = useState('')
  const [adjustReason, setAdjustReason] = useState('')
  const [initialCostDisplay, setInitialCostDisplay] = useState('')
  const [initialCostBasis, setInitialCostBasis] = useState<InitialCostBasis>('stock')

  useEffect(() => {
    if (!product) return
    setName(product.name)
    setCategory(product.category ?? '')
    const minDisplay = product.minimumStock == null
      ? ''
      : String(
        physicalToCommercial(product.minimumStock, product)
        ?? physicalToDisplay(product.minimumStock, product.baseUnit)
        ?? product.minimumStock,
      )
    setMinimumStockDisplay(minDisplay)
    setStockDeltaDisplay('')
    setPresentationDeltaDisplay('')
    setAdjustReason('')
    setInitialCostDisplay('')
    setInitialCostBasis(
      hasReliableCommercialPresentation(product) ? 'presentation' : 'stock',
    )
  }, [product])

  useEffect(() => {
    if (!open || saving) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open, saving])

  const hasPresentation = hasReliableCommercialPresentation(product)
  const unitLabel = commercialUnitLabel(product)
  const canSeedCost = Boolean(product && locationId && canRegisterInitialValuation(product.averageUnitCost))
  const editCostPreview = product && canSeedCost
    ? planInitialAcquisitionCost({
      costDisplay: initialCostDisplay,
      basis: initialCostBasis,
      stockUnit: hasPresentation ? 'u' : (product.baseUnit === 'unit' ? 'u' : (product.baseUnit ?? 'u')),
      quantityDisplay: hasPresentation
        ? String(commercialQuantityFromOnHand(product.onHand, product.conversionFactor) ?? '')
        : String(product.onHand && product.onHand > 0 ? product.onHand : ''),
      conversionFactor: product.conversionFactor,
      contentEnabled: hasPresentation,
      contentQuantity: hasPresentation ? String(product.conversionFactor) : undefined,
      contentUnit: product.baseUnit === 'g' ? 'g' : 'ml',
    })
    : null

  return (
    <Modal open={open} title="Editar producto" onClose={saving ? () => undefined : onClose}>
      {product ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            onSave({
              name,
              category,
              minimumStockDisplay,
              stockDeltaDisplay,
              presentationDeltaDisplay,
              adjustReason,
              initialCostDisplay,
              initialCostBasis,
            })
          }}
        >
          <p className="mb-0 text-sm text-senda-muted">
            El CPP se actualiza con facturas recibidas. Podés cargar un costo inicial solo si todavía no hay valuación.
            El stock solo se cambia con un movimiento registrado.
            {locationId ? '' : ' Elegí un local activo para stock mínimo y ajustes.'}
          </p>
          <label className="block space-y-1.5 text-xs font-semibold text-senda-muted">
            Nombre
            <Input disabled={saving} onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <label className="block space-y-1.5 text-xs font-semibold text-senda-muted">
            Categoría
            <Input
              disabled={saving}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="Opcional"
              value={category}
            />
          </label>
          {product.supplierName ? (
            <p className="mb-0 text-sm text-senda-muted">
              Proveedor habitual: <span className="font-semibold text-senda-ink">{product.supplierName}</span>
            </p>
          ) : null}
          {hasPresentation ? (
            <p className="mb-0 rounded-lg border border-senda-border bg-senda-subtle px-3 py-2 text-sm text-senda-muted">
              Contenido por unidad: {formatQuantity(product.conversionFactor)}{' '}
              {formatInventoryUnit(product.baseUnit)}/u
            </p>
          ) : null}
          <label className="block space-y-1.5 text-xs font-semibold text-senda-muted">
            Stock mínimo ({unitLabel})
            <Input
              disabled={saving || !locationId}
              inputMode="decimal"
              onChange={(event) => setMinimumStockDisplay(event.target.value)}
              placeholder="0"
              value={minimumStockDisplay}
            />
          </label>
          {canSeedCost ? (
            <div className="rounded-xl border border-senda-border p-4 space-y-3">
              <p className="m-0 text-sm font-semibold">Valuación inicial</p>
              <p className="mb-0 text-xs text-senda-muted">
                Registra el costo de mercadería preexistente sin sumar stock.
                Si ya hay CPP válido, esta opción no aparece.
              </p>
              {hasPresentation ? (
                <Select
                  disabled={saving || !locationId}
                  label="Base del costo"
                  onChange={(value) => setInitialCostBasis(value as InitialCostBasis)}
                  value={initialCostBasis}
                >
                  <option value="presentation">Costo inicial por u</option>
                  <option value="stock">
                    Costo inicial por {product.baseUnit === 'unit' ? 'unidad' : (product.baseUnit ?? 'base')}
                  </option>
                </Select>
              ) : null}
              <label className="block space-y-1.5 text-xs font-semibold text-senda-muted">
                {initialCostBasis === 'presentation'
                  ? 'Costo inicial por u'
                  : `Costo inicial por ${product.baseUnit === 'unit' ? 'unidad' : (product.baseUnit ?? 'base')}`}
                <Input
                  disabled={saving || !locationId}
                  inputMode="decimal"
                  onChange={(event) => setInitialCostDisplay(event.target.value)}
                  placeholder="Opcional"
                  value={initialCostDisplay}
                />
              </label>
              {editCostPreview?.ok && !editCostPreview.skip ? (
                <p className="mb-0 text-xs text-senda-muted">
                  Equivale a {roundInventoryUnitCost(editCostPreview.unitCost)} por unidad base.
                </p>
              ) : null}
            </div>
          ) : product.averageUnitCost != null ? (
            <p className="mb-0 rounded-lg border border-senda-border bg-senda-subtle px-3 py-2 text-sm text-senda-muted">
              Ya tiene valuación (CPP). Las facturas nuevas seguirán actualizando el promedio.
            </p>
          ) : null}
          <div className="rounded-xl border border-senda-border bg-senda-subtle p-4 space-y-3">
            <p className="m-0 text-sm font-semibold">Corrección de inventario</p>
            <p className="mb-0 text-xs text-senda-muted">
              Stock actual: {formatInventoryStock(product.onHand, product, formatQuantity)}.
              Indicá la diferencia (+ o −) en {unitLabel}.
              Una pérdida de mercadería se registra con Registrar merma, no como corrección.
            </p>
            {hasPresentation ? (
              <label className="block space-y-1.5 text-xs font-semibold text-senda-muted">
                Diferencia ({unitLabel})
                <Input
                  disabled={saving || !locationId}
                  inputMode="decimal"
                  onChange={(event) => setPresentationDeltaDisplay(event.target.value)}
                  placeholder="Ej. 10"
                  value={presentationDeltaDisplay}
                />
              </label>
            ) : (
              <label className="block space-y-1.5 text-xs font-semibold text-senda-muted">
                Diferencia ({unitLabel})
                <Input
                  disabled={saving || !locationId}
                  inputMode="decimal"
                  onChange={(event) => setStockDeltaDisplay(event.target.value)}
                  placeholder="Ej. -0,5 o 1"
                  value={stockDeltaDisplay}
                />
              </label>
            )}
            <label className="block space-y-1.5 text-xs font-semibold text-senda-muted">
              Motivo del ajuste
              <Input
                disabled={
                  saving
                  || !locationId
                  || (!stockDeltaDisplay.trim() && !presentationDeltaDisplay.trim())
                }
                onChange={(event) => setAdjustReason(event.target.value)}
                placeholder="Corrección de inventario"
                value={adjustReason}
              />
            </label>
          </div>
          {error ? <p className="mb-0 text-sm text-red-700" role="alert">{error}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={saving} onClick={onClose} type="button" variant="secondary">Cancelar</Button>
            <Button disabled={saving || name.trim().length < 2} type="submit">
              {saving ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      ) : null}
    </Modal>
  )
}

export function InventoryDeleteModal({
  product,
  deleting,
  error,
  onClose,
  onConfirm,
}: {
  product: InventoryProduct | null
  deleting: boolean
  error: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      open={Boolean(product)}
      title="Eliminar producto"
      onClose={deleting ? () => undefined : onClose}
    >
      {product ? (
        <div className="space-y-4">
          <p className="mb-0 text-sm text-senda-muted">
            ¿Eliminar <span className="font-semibold text-senda-ink">{product.name}</span>?
            Si no tiene historial se borra del todo. Si tiene compras, movimientos o recetas,
            se da de baja y desaparece del inventario activo sin perder el historial.
          </p>
          {error ? <p className="mb-0 text-sm text-red-700" role="alert">{error}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={deleting} onClick={onClose} type="button" variant="secondary">Cancelar</Button>
            <Button disabled={deleting} onClick={onConfirm} type="button">
              {deleting ? 'Eliminando…' : 'Confirmar eliminación'}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

export function InventoryWasteModal({
  product,
  saving,
  error,
  onClose,
  onSave,
}: {
  product: InventoryProduct | null
  saving: boolean
  error: string
  onClose: () => void
  onSave: (input: { quantityDisplay: string; note: string }) => void
}) {
  const [quantityDisplay, setQuantityDisplay] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    setQuantityDisplay('')
    setNote('')
  }, [product?.id])

  const unitLabel = formatInventoryUnit(product?.baseUnit)
  return (
    <Modal open={Boolean(product)} title="Registrar merma" onClose={saving ? () => undefined : onClose}>
      {product ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            onSave({ quantityDisplay, note })
          }}
        >
          <p className="mb-0 text-sm text-senda-muted">
            {product.name}. La merma descuenta stock y queda identificada en el historial. No corrige un conteo.
          </p>
          <label className="block space-y-1.5 text-xs font-semibold text-senda-muted">
            Cantidad perdida ({unitLabel})
            <Input
              disabled={saving}
              inputMode="decimal"
              onChange={(event) => setQuantityDisplay(event.target.value)}
              placeholder="Ej. 0,5"
              value={quantityDisplay}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-semibold text-senda-muted">
            Qué pasó
            <Input
              disabled={saving}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Se venció, se rompió, se tiró"
              value={note}
            />
          </label>
          {error ? <p className="mb-0 text-sm text-red-700" role="alert">{error}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={saving} onClick={onClose} type="button" variant="secondary">Cancelar</Button>
            <Button disabled={saving} type="submit">{saving ? 'Registrando…' : 'Registrar merma'}</Button>
          </div>
        </form>
      ) : null}
    </Modal>
  )
}

export const INVENTORY_HISTORY_PAGE_SIZE = 15

export function inventoryHistoryPageNumbers(totalPages: number, currentPage: number) {
  const pages = Math.max(1, totalPages)
  const current = Math.min(Math.max(1, currentPage), pages)
  return Array.from({ length: pages }, (_, index) => index + 1).filter((page) => {
    if (pages <= 7) return true
    if (page === 1 || page === pages) return true
    return Math.abs(page - current) <= 2
  })
}

export function InventoryHistoryPanel({
  loading,
  error,
  rows,
  page = 1,
  totalPages = 1,
  total = 0,
  onPageChange,
}: {
  loading: boolean
  error: string
  rows: InventoryMovement[]
  page?: number
  totalPages?: number
  total?: number
  onPageChange?: (page: number) => void
}) {
  const pages = inventoryHistoryPageNumbers(totalPages, page)

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-senda-border px-5 py-4">
        <h3 className="m-0 text-base font-bold">Historial de la sucursal</h3>
        <p className="mb-0 mt-1 text-sm text-senda-muted">Compras, consumos de ventas, mermas y ajustes.</p>
      </div>
      {loading ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-senda-muted">
          <Loader2 className="animate-spin" size={18} /> Cargando historial…
        </div>
      ) : error ? (
        <p className="m-0 p-5 text-sm text-red-700" role="alert">{error}</p>
      ) : rows.length === 0 ? (
        <p className="m-0 p-5 text-sm text-senda-muted">Todavía no hay movimientos en esta sucursal.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-senda-border bg-senda-subtle text-xs uppercase tracking-wide text-senda-muted">
                <tr>
                  {['Fecha', 'Movimiento', 'Producto', 'Cantidad', 'Detalle'].map((label) => (
                    <th className="px-5 py-3 font-semibold" key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr className="border-b border-senda-border last:border-0" key={row.id}>
                    <td className="px-5 py-3 whitespace-nowrap text-senda-muted">{formatMovementWhen(row.occurredAt)}</td>
                    <td className="px-5 py-3">
                      <Badge
                        tone={
                          row.kind === 'waste' || row.label === 'Merma'
                            ? 'warning'
                            : row.kind === 'purchase' || row.label === 'Compra'
                              ? 'success'
                              : row.label.toLowerCase().includes('anul')
                                ? 'danger'
                                : 'neutral'
                        }
                      >
                        {row.label}
                      </Badge>
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="font-semibold">{row.productName}</span>
                        {row.productActive === false ? (
                          <span className="text-xs font-normal text-senda-muted">Eliminado</span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap font-medium text-senda-ink">
                      {formatInventoryStock(row.quantity, row.baseUnit, formatQuantity)}
                    </td>
                    <td className="max-w-xs px-5 py-3 text-senda-muted">
                      <span className="line-clamp-2 break-words" title={row.detail?.trim() || undefined}>
                        {row.detail?.trim() || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && onPageChange ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-senda-border px-5 py-3">
              <p className="m-0 text-xs text-senda-muted">
                {`${rows.length} de ${total} movimiento${total === 1 ? '' : 's'} · página ${page} de ${totalPages}`}
              </p>
              <nav aria-label="Paginación del historial" className="flex flex-wrap items-center gap-1">
                {pages.map((pageNumber, index) => {
                  const previous = pages[index - 1]
                  const showEllipsis = previous != null && pageNumber - previous > 1
                  return (
                    <span className="contents" key={pageNumber}>
                      {showEllipsis ? (
                        <span className="px-1 text-xs text-senda-muted" aria-hidden>…</span>
                      ) : null}
                      <button
                        aria-current={pageNumber === page ? 'page' : undefined}
                        aria-label={`Ir a la página ${pageNumber}`}
                        className={`min-w-8 rounded-lg px-2.5 py-1.5 text-sm font-semibold transition ${
                          pageNumber === page
                            ? 'bg-senda-navy text-white'
                            : 'text-senda-navy hover:bg-senda-subtle'
                        }`}
                        onClick={() => onPageChange(pageNumber)}
                        type="button"
                      >
                        {pageNumber}
                      </button>
                    </span>
                  )
                })}
              </nav>
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}

function formatMovementWhen(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

export function InventoryPage() {
  const { previewMode } = useAuth()
  const { organizationId, locationId, error: scopeError } = useAuthorizedScopeContext()
  const scopeKey = inventoryScopeKey(organizationId, locationId)
  const [load, setLoad] = useState<{ key: string; products: InventoryProduct[]; error: string }>({
    key: '',
    products: [],
    error: '',
  })
  const [search, setSearch] = useState('')
  const [create, dispatchCreate] = useReducer(inventoryCreateReducer, INITIAL_INVENTORY_CREATE)
  const [editProduct, setEditProduct] = useState<InventoryProduct | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [deleteProduct, setDeleteProduct] = useState<InventoryProduct | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [wasteProduct, setWasteProduct] = useState<InventoryProduct | null>(null)
  const [wasteSaving, setWasteSaving] = useState(false)
  const [wasteError, setWasteError] = useState('')
  const creatingRef = useRef(false)
  const editRef = useRef(false)
  const deleteRef = useRef(false)
  const wasteRef = useRef(false)
  const adjustKeyRef = useRef('')
  const wasteKeyRef = useRef('')
  const requestRef = useRef(0)
  const discardCreate = useCallback(() => {
    dispatchCreate({ type: 'close' })
    setEditProduct(null)
    setDeleteProduct(null)
    setWasteProduct(null)
    setEditError('')
    setDeleteError('')
    setWasteError('')
  }, [])
  useRegisterWorkspaceGuard(
    'inventory-create',
    inventoryWorkspaceGuard({
      creating: create.creating || editSaving || deleting || wasteSaving,
      open: create.open || Boolean(editProduct) || Boolean(deleteProduct) || Boolean(wasteProduct),
      name: create.name,
      costing: false,
      costOpen: false,
    }),
    discardCreate,
  )
  const products = inventoryProductsForScope(load.key, scopeKey, load.products)
  const [suppliers, setSuppliers] = useState<OrganizationSupplier[]>([])
  const error = load.key === scopeKey ? load.error : ''
  const loading = Boolean(organizationId) && load.key !== scopeKey

  useEffect(() => {
    if (!organizationId || !create.open) return
    let cancelled = false
    getOrganizationSuppliers(organizationId)
      .then((rows) => {
        if (!cancelled) setSuppliers(rows)
      })
      .catch(() => {
        if (!cancelled) setSuppliers([])
      })
    return () => {
      cancelled = true
    }
  }, [organizationId, create.open])

  useEffect(() => {
    if (!organizationId) {
      setLoad({ key: inventoryScopeKey('', ''), products: [], error: '' })
      return
    }
    const key = inventoryScopeKey(organizationId, locationId)
    const requestId = ++requestRef.current
    getInventoryProducts(organizationId, {
      locationId: locationId || undefined,
      includeInactive: false,
    })
      .then((next) => {
        if (requestId !== requestRef.current) return
        setLoad({ key, products: next, error: '' })
      })
      .catch((reason: Error) => {
        if (requestId !== requestRef.current) return
        setLoad({ key, products: [], error: reason.message })
      })
  }, [organizationId, locationId])

  useEffect(() => {
    setEditProduct(null)
    setDeleteProduct(null)
    setWasteProduct(null)
    setEditError('')
    setDeleteError('')
    setWasteError('')
  }, [scopeKey])

  function resolveCreateQuantities() {
    return resolveCreateInsumoQuantities({
      stockUnit: create.stockUnit,
      initialStock: create.initialStockDisplay,
      minimumStock: create.minimumStockDisplay,
      contentEnabled: create.contentOpen && showsContentPerUnitSection(create.stockUnit),
      contentQuantity: create.contentQuantity,
      contentUnit: create.contentUnit,
    })
  }

  function resolveCreateInitialCost(conversionFactor: number | null) {
    return planInitialAcquisitionCost({
      costDisplay: create.initialCostDisplay,
      basis: create.initialCostBasis,
      stockUnit: create.stockUnit,
      quantityDisplay: create.initialStockDisplay,
      contentEnabled: create.contentOpen && showsContentPerUnitSection(create.stockUnit),
      contentQuantity: create.contentQuantity,
      contentUnit: create.contentUnit,
      conversionFactor,
    })
  }

  async function createProduct() {
    if (!organizationId || creatingRef.current) return
    if (!canSubmitInventoryCreate(create.creating, create.name)) return
    const resolved = resolveCreateQuantities()
    if (!resolved.ok) {
      dispatchCreate({ type: 'error', message: resolved.error })
      return
    }
    const {
      baseUnit,
      initialPhysical,
      minimumPhysical,
      presentationUnit,
      conversionFactor,
    } = resolved.value
    const costPlan = resolveCreateInitialCost(conversionFactor)
    if (!costPlan.ok) {
      dispatchCreate({ type: 'error', message: costPlan.error })
      return
    }
    if (initialPhysical != null && initialPhysical > 0 && !locationId) {
      dispatchCreate({
        type: 'error',
        message: 'Elegí un local activo para registrar el stock inicial.',
      })
      return
    }
    if (!costPlan.skip && !locationId) {
      dispatchCreate({
        type: 'error',
        message: 'Elegí un local activo para registrar el costo inicial.',
      })
      return
    }
    const selectedSupplier = suppliers.find((row) => row.id === create.preferredSupplierId) ?? null
    creatingRef.current = true
    dispatchCreate({ type: 'submit' })
    try {
      const created = await createInventoryProduct(organizationId, {
        name: create.name,
        baseUnit,
        category: create.category.trim() || null,
        minimumStock: minimumPhysical,
        locationId: locationId || undefined,
        presentationUnit,
        conversionFactor,
        preferredSupplierId: create.preferredSupplierId || null,
        preferredSupplierName: selectedSupplier?.name ?? null,
      })
      let onHand = created.onHand ?? 0
      let averageUnitCost = created.averageUnitCost ?? null
      if (initialPhysical != null && initialPhysical > 0 && locationId) {
        await adjustInventoryProductStock(organizationId, locationId, created.id, {
          quantityDelta: initialPhysical,
          reason: INITIAL_STOCK_ADJUST_REASON,
          idempotencyKey: crypto.randomUUID(),
          kind: 'correction',
        })
        onHand = initialPhysical
      }
      if (!costPlan.skip && locationId) {
        const costResult = await setInventoryPurchaseCost(organizationId, locationId, created.id, {
          purchaseQuantity: costPlan.purchaseQuantity,
          purchaseCost: costPlan.purchaseCost,
        })
        averageUnitCost = costResult.averageUnitCost
        onHand = costResult.onHand
      }
      setLoad((current) => (
        current.key === inventoryScopeKey(organizationId, locationId)
          ? {
              ...current,
              products: appendCreatedInventoryProduct(current.products, {
                ...created,
                onHand,
                averageUnitCost,
                category: create.category.trim() || created.category || null,
                minimumStock: minimumPhysical ?? created.minimumStock ?? null,
                presentationUnit: presentationUnit ?? created.presentationUnit ?? null,
                conversionFactor: conversionFactor ?? created.conversionFactor ?? null,
                preferredSupplierId: created.preferredSupplierId
                  ?? (create.preferredSupplierId.startsWith('issuer:')
                    ? null
                    : create.preferredSupplierId || null),
                supplierName: selectedSupplier?.name ?? created.supplierName ?? null,
              }),
            }
          : current
      ))
      dispatchCreate({ type: 'success' })
    } catch (reason) {
      if (reason instanceof InventoryApiError && reason.code === 'INACTIVE_PRODUCT_EXISTS') {
        const inactiveId = typeof reason.details.inventoryProductId === 'string'
          ? reason.details.inventoryProductId
          : null
        const inactiveName = typeof reason.details.name === 'string'
          ? reason.details.name
          : create.name
        dispatchCreate({
          type: 'error',
          message: reason.message,
          inactiveProductId: inactiveId,
          inactiveProductName: inactiveName,
        })
      } else {
        dispatchCreate({
          type: 'error',
          message: reason instanceof InventoryApiError ? reason.message : 'No se pudo crear el insumo.',
        })
      }
    } finally {
      creatingRef.current = false
    }
  }

  async function reactivateProduct() {
    const inactiveId = create.inactiveProductId
    const inactiveName = create.inactiveProductName
    if (!organizationId || !inactiveId || creatingRef.current) return
    const resolved = resolveCreateQuantities()
    if (!resolved.ok) {
      dispatchCreate({
        type: 'error',
        message: resolved.error,
        inactiveProductId: inactiveId,
        inactiveProductName: inactiveName,
      })
      return
    }
    const {
      baseUnit,
      initialPhysical,
      minimumPhysical,
      presentationUnit,
      conversionFactor,
    } = resolved.value
    const costPlan = resolveCreateInitialCost(conversionFactor)
    if (!costPlan.ok) {
      dispatchCreate({
        type: 'error',
        message: costPlan.error,
        inactiveProductId: inactiveId,
        inactiveProductName: inactiveName,
      })
      return
    }
    if (!costPlan.skip && !locationId) {
      dispatchCreate({
        type: 'error',
        message: 'Elegí un local activo para registrar el costo inicial.',
        inactiveProductId: inactiveId,
        inactiveProductName: inactiveName,
      })
      return
    }
    const selectedSupplier = suppliers.find((row) => row.id === create.preferredSupplierId) ?? null
    creatingRef.current = true
    dispatchCreate({ type: 'submit' })
    try {
      const restored = await reactivateInventoryProduct(organizationId, inactiveId, {
        locationId: locationId || undefined,
        category: create.category.trim() || null,
        minimumStock: minimumPhysical,
      })
      if (locationId && (presentationUnit || conversionFactor != null || create.preferredSupplierId)) {
        await updateInventoryProduct(organizationId, locationId, inactiveId, {
          presentationUnit,
          conversionFactor,
          preferredSupplierId: create.preferredSupplierId || null,
          preferredSupplierName: selectedSupplier?.name ?? null,
        })
      }
      let onHand = restored.onHand ?? 0
      let averageUnitCost = restored.averageUnitCost ?? null
      if (initialPhysical != null && initialPhysical > 0 && locationId) {
        await adjustInventoryProductStock(organizationId, locationId, inactiveId, {
          quantityDelta: initialPhysical,
          reason: INITIAL_STOCK_ADJUST_REASON,
          idempotencyKey: crypto.randomUUID(),
          kind: 'correction',
        })
        onHand = (restored.onHand ?? 0) + initialPhysical
      }
      if (!costPlan.skip && locationId && canRegisterInitialValuation(averageUnitCost)) {
        const costResult = await setInventoryPurchaseCost(organizationId, locationId, inactiveId, {
          purchaseQuantity: costPlan.purchaseQuantity,
          purchaseCost: costPlan.purchaseCost,
        })
        averageUnitCost = costResult.averageUnitCost
        onHand = costResult.onHand
      }
      setLoad((current) => (
        current.key === inventoryScopeKey(organizationId, locationId)
          ? {
              ...current,
              products: appendCreatedInventoryProduct(current.products, {
                ...restored,
                name: inactiveName ?? create.name,
                baseUnit: baseUnit || restored.baseUnit,
                category: create.category.trim() || null,
                minimumStock: minimumPhysical ?? null,
                onHand,
                averageUnitCost,
                presentationUnit: presentationUnit ?? restored.presentationUnit ?? null,
                conversionFactor: conversionFactor ?? restored.conversionFactor ?? null,
                preferredSupplierId: restored.preferredSupplierId
                  ?? (create.preferredSupplierId.startsWith('issuer:')
                    ? null
                    : create.preferredSupplierId || null),
                supplierName: selectedSupplier?.name ?? restored.supplierName ?? null,
                active: true,
              }),
            }
          : current
      ))
      dispatchCreate({ type: 'success' })
    } catch (reason) {
      dispatchCreate({
        type: 'error',
        message: reason instanceof InventoryApiError ? reason.message : 'No se pudo reactivar el insumo.',
        inactiveProductId: inactiveId,
        inactiveProductName: inactiveName,
      })
    } finally {
      creatingRef.current = false
    }
  }

  async function saveEdit(input: {
    name: string
    category: string
    minimumStockDisplay: string
    stockDeltaDisplay: string
    presentationDeltaDisplay: string
    adjustReason: string
    initialCostDisplay: string
    initialCostBasis: InitialCostBasis
  }) {
    if (!organizationId || !editProduct || editRef.current) return
    if (!locationId) {
      setEditError('Elegí un local activo para editar stock mínimo o ajustar existencias.')
      return
    }
    const trimmedName = input.name.trim()
    if (trimmedName.length < 2) {
      setEditError('Indicá un nombre de producto.')
      return
    }
    let minimumStock: number | null | undefined
    if (input.minimumStockDisplay.trim()) {
      const parsedMin = Number(input.minimumStockDisplay.trim().replace(',', '.'))
      if (!Number.isFinite(parsedMin) || parsedMin < 0) {
        setEditError('Indicá un stock mínimo válido.')
        return
      }
      const physicalMin = commercialToPhysicalQty(parsedMin, editProduct)
      if (physicalMin == null) {
        setEditError('Indicá un stock mínimo válido.')
        return
      }
      minimumStock = physicalMin
    } else {
      minimumStock = null
    }

    const presentationRaw = input.presentationDeltaDisplay.trim()
    const deltaRaw = input.stockDeltaDisplay.trim()
    let quantityDelta = 0
    if (presentationRaw && deltaRaw) {
      setEditError('Usá una sola diferencia de stock.')
      return
    }
    if (presentationRaw) {
      const parsedPresentation = Number(presentationRaw.replace(',', '.'))
      if (!Number.isFinite(parsedPresentation) || parsedPresentation === 0) {
        setEditError('La diferencia de stock debe ser un número distinto de cero.')
        return
      }
      const physical = commercialToPhysicalQty(parsedPresentation, editProduct)
        ?? physicalFromPresentationUnits(parsedPresentation, editProduct.conversionFactor)
      if (physical == null) {
        setEditError('Este insumo no tiene contenido por unidad persistido.')
        return
      }
      if (/^merma\b/i.test(input.adjustReason.trim())) {
        setEditError('Una merma se registra con Registrar merma, no como corrección de inventario.')
        return
      }
      if (input.adjustReason.trim().length < 3) {
        setEditError('Indicá un motivo para el ajuste de stock.')
        return
      }
      quantityDelta = physical
    } else if (deltaRaw) {
      const parsedDelta = Number(deltaRaw.replace(',', '.'))
      if (!Number.isFinite(parsedDelta) || parsedDelta === 0) {
        setEditError('La diferencia de stock debe ser un número distinto de cero.')
        return
      }
      if (/^merma\b/i.test(input.adjustReason.trim())) {
        setEditError('Una merma se registra con Registrar merma, no como corrección de inventario.')
        return
      }
      if (input.adjustReason.trim().length < 3) {
        setEditError('Indicá un motivo para el ajuste de stock.')
        return
      }
      quantityDelta = displayToPhysical(parsedDelta, editProduct.baseUnit)
    }

    const hasPresentation = hasReliableCommercialPresentation(editProduct)
    const costPlan = canRegisterInitialValuation(editProduct.averageUnitCost)
      ? planInitialAcquisitionCost({
        costDisplay: input.initialCostDisplay,
        basis: input.initialCostBasis,
        stockUnit: hasPresentation ? 'u' : (editProduct.baseUnit === 'unit' ? 'u' : (editProduct.baseUnit ?? 'u')),
        quantityDisplay: hasPresentation
          ? String(commercialQuantityFromOnHand(
            (editProduct.onHand ?? 0) + quantityDelta,
            editProduct.conversionFactor,
          ) ?? '')
          : String(
            ((editProduct.onHand ?? 0) + quantityDelta) > 0
              ? (editProduct.onHand ?? 0) + quantityDelta
              : '',
          ),
        conversionFactor: editProduct.conversionFactor,
        contentEnabled: hasPresentation,
        contentQuantity: hasPresentation ? String(editProduct.conversionFactor) : undefined,
        contentUnit: editProduct.baseUnit === 'g' ? 'g' : 'ml',
      })
      : { ok: true as const, skip: true as const }
    if (!costPlan.ok) {
      setEditError(costPlan.error)
      return
    }

    editRef.current = true
    setEditSaving(true)
    setEditError('')
    try {
      await updateInventoryProduct(organizationId, locationId, editProduct.id, {
        name: trimmedName,
        category: input.category.trim() || null,
        minimumStock,
      })
      if (quantityDelta !== 0) {
        if (!adjustKeyRef.current) adjustKeyRef.current = crypto.randomUUID()
        await adjustInventoryProductStock(organizationId, locationId, editProduct.id, {
          quantityDelta,
          reason: input.adjustReason.trim(),
          idempotencyKey: adjustKeyRef.current,
          kind: 'correction',
        })
        adjustKeyRef.current = ''
      }
      let averageUnitCost = editProduct.averageUnitCost ?? null
      let nextOnHand = (editProduct.onHand ?? 0) + quantityDelta
      if (!costPlan.skip) {
        const costResult = await setInventoryPurchaseCost(organizationId, locationId, editProduct.id, {
          purchaseQuantity: costPlan.purchaseQuantity,
          purchaseCost: costPlan.purchaseCost,
        })
        averageUnitCost = costResult.averageUnitCost
        nextOnHand = costResult.onHand
      }
      setLoad((current) => {
        if (current.key !== inventoryScopeKey(organizationId, locationId)) return current
        return {
          ...current,
          products: applyInventoryProductPatch(current.products, editProduct.id, {
            name: trimmedName,
            category: input.category.trim() || null,
            minimumStock: minimumStock ?? null,
            onHand: nextOnHand,
            averageUnitCost,
          }),
        }
      })
      setEditProduct(null)
    } catch (reason) {
      setEditError(reason instanceof InventoryApiError ? reason.message : 'No se pudo guardar el producto.')
    } finally {
      editRef.current = false
      setEditSaving(false)
    }
  }

  async function saveWaste(input: { quantityDisplay: string; note: string }) {
    if (!organizationId || !locationId || !wasteProduct || wasteRef.current) return
    const parsed = Number(input.quantityDisplay.trim().replace(',', '.'))
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setWasteError('Indicá la cantidad perdida, mayor a cero.')
      return
    }
    const note = input.note.trim()
    if (note.replace(/^merma\s*:?\s*/i, '').trim().length < 3) {
      setWasteError('Describí la merma. No alcanza con la palabra merma.')
      return
    }
    const quantityDelta = -Math.abs(displayToPhysical(parsed, wasteProduct.baseUnit))
    if (!wasteKeyRef.current) wasteKeyRef.current = crypto.randomUUID()
    wasteRef.current = true
    setWasteSaving(true)
    setWasteError('')
    try {
      await adjustInventoryProductStock(organizationId, locationId, wasteProduct.id, {
        quantityDelta,
        reason: note,
        idempotencyKey: wasteKeyRef.current,
        kind: 'waste',
      })
      const productId = wasteProduct.id
      wasteKeyRef.current = ''
      setLoad((current) => ({
        ...current,
        products: applyInventoryProductPatch(current.products, productId, {
          onHand: (current.products.find((row) => row.id === productId)?.onHand ?? 0) + quantityDelta,
        }),
      }))
      setWasteProduct(null)
    } catch (reason) {
      setWasteError(reason instanceof InventoryApiError ? reason.message : 'No se pudo registrar la merma.')
    } finally {
      wasteRef.current = false
      setWasteSaving(false)
    }
  }

  async function confirmDelete() {
    if (!organizationId || !deleteProduct || deleteRef.current) return
    deleteRef.current = true
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteInventoryProduct(organizationId, deleteProduct.id)
      setLoad((current) => (
        current.key === inventoryScopeKey(organizationId, locationId)
          ? { ...current, products: removeInventoryProduct(current.products, deleteProduct.id) }
          : current
      ))
      setDeleteProduct(null)
    } catch (reason) {
      setDeleteError(reason instanceof InventoryApiError ? reason.message : 'No se pudo eliminar el producto.')
    } finally {
      deleteRef.current = false
      setDeleting(false)
    }
  }

  if (previewMode) {
    return (
      <Card className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
        <span className="rounded-2xl bg-senda-subtle p-4 text-senda-muted"><Boxes size={30} /></span>
        <h2 className="mb-0 mt-5 text-xl font-bold">Supabase todavía no está configurado</h2>
        <p className="mb-0 mt-2 max-w-lg text-sm leading-6 text-senda-muted">
          Configurá las variables del frontend y la API para consultar insumos reales. El modo vista previa nunca solicita información operativa.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="m-0 text-2xl font-extrabold tracking-tight">Inventario</h2>
          <p className="mb-0 mt-2 text-sm text-senda-muted">
            Productos del local activo. El CPP se actualiza con facturas; el costo inicial cubre mercadería preexistente.
          </p>
        </div>
        <Button
          aria-expanded={create.open}
          aria-haspopup="dialog"
          className="w-auto shrink-0 self-start"
          disabled={!organizationId}
          onClick={() => dispatchCreate({ type: 'open' })}
        >
          + Nuevo insumo
        </Button>
      </div>

      <InventoryCatalog
        error={error || scopeError}
        loading={loading}
        products={products}
        search={search}
        onDelete={setDeleteProduct}
        onEdit={(product) => {
          adjustKeyRef.current = crypto.randomUUID()
          setEditError('')
          setEditProduct(product)
        }}
        onSearch={setSearch}
        onWaste={(product) => {
          wasteKeyRef.current = crypto.randomUUID()
          setWasteError('')
          setWasteProduct(product)
        }}
      />

      <InventoryEditModal
        error={editError}
        locationId={locationId}
        product={editProduct}
        saving={editSaving}
        onClose={() => {
          if (editSaving) return
          setEditProduct(null)
          setEditError('')
        }}
        onSave={(input) => void saveEdit(input)}
      />

      <InventoryWasteModal
        error={wasteError}
        product={wasteProduct}
        saving={wasteSaving}
        onClose={() => {
          if (wasteSaving) return
          setWasteProduct(null)
          setWasteError('')
        }}
        onSave={(input) => void saveWaste(input)}
      />

      <InventoryDeleteModal
        deleting={deleting}
        error={deleteError}
        product={deleteProduct}
        onClose={() => {
          if (deleting) return
          setDeleteProduct(null)
          setDeleteError('')
        }}
        onConfirm={() => void confirmDelete()}
      />

      <InventoryCreateModal
        category={create.category}
        contentOpen={create.contentOpen}
        contentQuantity={create.contentQuantity}
        contentUnit={create.contentUnit}
        createError={create.error}
        creating={create.creating}
        inactiveProductId={create.inactiveProductId}
        inactiveProductName={create.inactiveProductName}
        initialCostBasis={create.initialCostBasis}
        initialCostDisplay={create.initialCostDisplay}
        initialStockDisplay={create.initialStockDisplay}
        minimumStockDisplay={create.minimumStockDisplay}
        name={create.name}
        open={create.open}
        stockUnit={create.stockUnit}
        preferredSupplierId={create.preferredSupplierId}
        supplierOptions={suppliers}
        onCategory={(value) => dispatchCreate({ type: 'category', value })}
        onClose={() => dispatchCreate({ type: 'close' })}
        onContentOpen={(value) => dispatchCreate({ type: 'contentOpen', value })}
        onContentQuantity={(value) => dispatchCreate({ type: 'contentQuantity', value })}
        onContentUnit={(value) => dispatchCreate({ type: 'contentUnit', value })}
        onCreate={() => void createProduct()}
        onInitialCost={(value) => dispatchCreate({ type: 'initialCost', value })}
        onInitialCostBasis={(value) => dispatchCreate({ type: 'initialCostBasis', value })}
        onInitialStock={(value) => dispatchCreate({ type: 'initial', value })}
        onMinimumStock={(value) => dispatchCreate({ type: 'minimum', value })}
        onName={(value) => dispatchCreate({ type: 'name', value })}
        onReactivate={() => void reactivateProduct()}
        onStockUnit={(value) => dispatchCreate({ type: 'stockUnit', value })}
        onSupplier={(value) => dispatchCreate({ type: 'supplier', value })}
      />
    </div>
  )
}

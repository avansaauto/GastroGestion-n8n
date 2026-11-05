import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/lib/auth'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import type { InventoryProduct } from '@/lib/api'
import {
  InventoryCatalog,
  InventoryCreateModal,
  InventoryEditModal,
  InventoryHistoryPanel,
  inventoryHistoryPageNumbers,
  InventoryPage,
  INITIAL_INVENTORY_CREATE,
  appendCreatedInventoryProduct,
  applyInventoryPurchaseCost,
  canSubmitInventoryCreate,
  inventoryCreateReducer,
  inventoryProductsForScope,
  inventoryScopeKey,
  inventoryUnitLabel,
} from './InventoryPage'

const catalogProps: {
  error: string
  loading: boolean
  products: InventoryProduct[]
  search: string
  onSearch: (value: string) => void
} = {
  error: '',
  loading: false,
  products: [],
  search: '',
  onSearch: () => undefined,
}

const tomate: InventoryProduct = {
  id: '2',
  organizationId: 'org',
  name: 'Tomate',
  baseUnit: 'g',
  active: true,
  onHand: null,
}

function pageHtml() {
  return renderToString(
    <MemoryRouter>
      <AuthProvider>
        <AuthorizedScopeProvider>
          <InventoryPage />
        </AuthorizedScopeProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

function modalHtml(open: boolean, extras: Partial<Parameters<typeof InventoryCreateModal>[0]> = {}) {
  return renderToString(
    <InventoryCreateModal
      category=""
      contentOpen={false}
      contentQuantity=""
      contentUnit="ml"
      createError=""
      creating={false}
      inactiveProductId={null}
      inactiveProductName={null}
      initialCostBasis="stock"
      initialCostDisplay=""
      initialStockDisplay=""
      minimumStockDisplay=""
      name=""
      open={open}
      stockUnit="u"
      preferredSupplierId=""
      supplierOptions={[]}
      onCategory={() => undefined}
      onClose={() => undefined}
      onContentOpen={() => undefined}
      onContentQuantity={() => undefined}
      onContentUnit={() => undefined}
      onCreate={() => undefined}
      onInitialCost={() => undefined}
      onInitialCostBasis={() => undefined}
      onInitialStock={() => undefined}
      onMinimumStock={() => undefined}
      onName={() => undefined}
      onReactivate={() => undefined}
      onStockUnit={() => undefined}
      onSupplier={() => undefined}
      {...extras}
    />,
  )
}

describe('Inventario', () => {
  it('no muestra filas de ejemplo desconectadas ni selección masiva', () => {
    const html = pageHtml()
    expect(html).toContain('Inventario')
    expect(html).toContain('Productos del local activo')
    expect(html).not.toContain('Harina 000')
    expect(html).not.toContain('Ejemplo visual')
    expect(html).not.toContain('Actualizar stock')
    expect(html).not.toContain('productos visibles seleccionados')
    expect(html).not.toContain('Eliminar seleccionados')
    expect(html).not.toContain('Seleccionar todos los productos visibles')
  })

  it('coloca + Nuevo insumo a la derecha del título y no duplica selectores', () => {
    const html = pageHtml()
    const titleAt = html.indexOf('Inventario')
    const createAt = html.indexOf('+ Nuevo insumo')
    const searchAt = html.indexOf('Buscar')
    const header = html.slice(0, searchAt)
    expect(header).toContain('sm:flex-row sm:items-start sm:justify-between')
    expect(header).toContain('w-auto shrink-0 self-start')
    expect(header).toContain('+ Nuevo insumo')
    expect(header).toContain('aria-haspopup="dialog"')
    expect(header).not.toContain('>Organización<')
    expect(header).not.toContain('>Local<')
    expect(header).not.toContain('Seleccionar…')
    expect(html).not.toContain('>Organización<')
    expect(html).not.toContain('>Local<')
    expect(createAt).toBeGreaterThan(titleAt)
    expect(createAt).toBeLessThan(searchAt)
  })

  it('no mezcla existencias entre locales y recarga al cambiar el alcance', () => {
    expect(inventoryScopeKey('org-ogham', 'loc-chino')).not.toBe(inventoryScopeKey('org-ogham', 'loc-casa'))
    expect(inventoryProductsForScope(
      'org-ogham::loc-chino',
      'org-ogham::loc-casa',
      [{ id: '1', organizationId: 'org-ogham', name: 'Pilsen', baseUnit: 'ml', active: true, onHand: 20000 }],
    )).toEqual([])
    expect(inventoryProductsForScope(
      'org-ogham::loc-casa',
      'org-ogham::loc-casa',
      [{ id: '1', organizationId: 'org-ogham', name: 'Pilsen', baseUnit: 'ml', active: true, onHand: 5000 }],
    )[0]?.onHand).toBe(5000)
  })

  it('mantiene el modal cerrado al entrar a Inventario', () => {
    const html = pageHtml()
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('Crear insumo')
    expect(html).not.toContain('Cancelar')
    expect(html).toContain('aria-expanded="false"')
    expect(inventoryCreateReducer(INITIAL_INVENTORY_CREATE, { type: 'open' }).open).toBe(true)
    expect(inventoryCreateReducer(
      { ...INITIAL_INVENTORY_CREATE, open: true, name: 'Tomate' },
      { type: 'close' },
    )).toEqual(INITIAL_INVENTORY_CREATE)
  })

  it('abre el modal universal con stock, unidad y contenido opcional', () => {
    const closed = modalHtml(false)
    expect(closed).not.toContain('role="dialog"')
    expect(closed).not.toContain('Nombre del insumo')

    const open = modalHtml(true, { name: 'Tomate' })
    expect(open).toContain('role="dialog"')
    expect(open).toContain('aria-modal="true"')
    expect(open).toContain('Nombre del insumo')
    expect(open).toContain('Stock inicial')
    expect(open).toContain('Stock mínimo')
    expect(open).toContain('Unidad de medida')
    expect(open).toContain('Contenido por unidad')
    expect(open).toContain('Proveedor (opcional)')
    expect(open).toContain('Costo inicial (opcional)')
    expect(open).toContain('Cancelar')
    expect(open).toContain('Crear insumo')
    expect(open).toContain('for="inventory-create-name"')
    expect(open).toContain('id="inventory-create-name"')
    expect(open).not.toContain('productos visibles seleccionados')
    expect(open).not.toContain('Eliminar seleccionados')
    expect(open).not.toContain('Stock inicial (botellas)')
    expect(open).not.toContain('Stock mínimo (paquetes)')
    expect(open).not.toContain('botellas')
    expect(open).not.toContain('paquetes')

    expect(inventoryCreateReducer(
      { ...INITIAL_INVENTORY_CREATE, open: true, name: 'Tomate' },
      { type: 'close' },
    ).open).toBe(false)
  })

  it('ofrece reactivar cuando el nombre pertenece a un insumo inactivo', () => {
    const html = modalHtml(true, {
      name: 'Carne picada',
      createError: 'Hay un insumo desactivado con ese nombre.',
      inactiveProductId: 'inactive-1',
      inactiveProductName: 'Carne picada',
    })
    expect(html).toContain('Reactivar insumo')
    expect(html).toContain('mismo identificador e historial')
    expect(html).not.toContain('>Crear insumo<')
  })

  it('ofrece u, g, kg, ml y L; contenido solo con unidad u', () => {
    const html = modalHtml(true)
    expect(html).toContain('value="u"')
    expect(html).toContain('value="g"')
    expect(html).toContain('value="kg"')
    expect(html).toContain('value="ml"')
    expect(html).toContain('value="L"')
    expect(html).toContain('Unidad (u)')
    expect(html).toContain('Contenido por unidad')
    expect(canSubmitInventoryCreate(false, '')).toBe(false)
    expect(canSubmitInventoryCreate(false, 'T')).toBe(false)
    expect(canSubmitInventoryCreate(false, 'Tomate')).toBe(true)

    const withoutContent = modalHtml(true, { stockUnit: 'kg' })
    expect(withoutContent).not.toContain('Contenido por unidad')
    expect(withoutContent).not.toContain('inventory-create-content-toggle')

    const contentOpen = modalHtml(true, {
      stockUnit: 'u',
      contentOpen: true,
      contentQuantity: '750',
      contentUnit: 'ml',
    })
    expect(contentOpen).toContain('Cantidad de contenido')
    expect(contentOpen).toContain('Unidad de contenido')
    expect(contentOpen).toContain('value="750"')
  })

  it('oculta contenido al cambiar de u a otra unidad', () => {
    const openContent = inventoryCreateReducer(
      { ...INITIAL_INVENTORY_CREATE, open: true, contentOpen: true },
      { type: 'stockUnit', value: 'kg' },
    )
    expect(openContent.stockUnit).toBe('kg')
    expect(openContent.contentOpen).toBe(false)
  })

  it('cierra el modal y actualiza el listado al crear', () => {
    const submitted = inventoryCreateReducer(
      { ...INITIAL_INVENTORY_CREATE, open: true, name: 'Tomate', creating: true },
      { type: 'success' },
    )
    expect(submitted).toEqual(INITIAL_INVENTORY_CREATE)
    expect(appendCreatedInventoryProduct([], tomate)).toEqual([tomate])
  })

  it('aplica costo de compra al producto correcto', () => {
    const next = applyInventoryPurchaseCost(
      [{ ...tomate, averageUnitCost: null, onHand: 0 }],
      tomate.id,
      12.5,
      1000,
    )
    expect(next[0]?.averageUnitCost).toBe(12.5)
    expect(next[0]?.onHand).toBe(1000)
  })

  it('etiqueta unidades legacy de inventario', () => {
    expect(inventoryUnitLabel('g')).toBe('Gramos')
    expect(inventoryUnitLabel('ml')).toBe('Mililitros')
    expect(inventoryUnitLabel('unit')).toBe('Unidades')
    expect(inventoryUnitLabel('kg')).toBe('Kilogramos')
    expect(inventoryUnitLabel('l')).toBe('Litros')
  })

  it('renderiza catálogo, edición e historial sin romper el alcance', () => {
    const catalog = renderToString(
      <InventoryCatalog
        {...catalogProps}
        products={[
          {
            id: '1',
            organizationId: 'org',
            name: 'Golden Ale',
            baseUnit: 'ml',
            active: true,
            onHand: 50000,
            minimumStock: 10000,
          },
          { id: '3', organizationId: 'org', name: 'Huevos', baseUnit: 'unit', active: false, onHand: 0 },
        ]}
      />,
    )
    expect(catalog).toContain('Golden Ale')
    expect(catalog).toContain('Stock mínimo')
    expect(catalog).not.toContain('Huevos')

    const edit = renderToString(
      <InventoryEditModal
        error=""
        locationId="loc-1"
        product={{
          id: '1',
          organizationId: 'org',
          name: 'Golden Ale',
          baseUnit: 'ml',
          active: true,
          onHand: 50000,
          minimumStock: 10000,
        }}
        saving={false}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    )
    expect(edit).toContain('Stock mínimo')
    expect(edit).toContain('Editar producto')
    expect(edit).toContain('50 L')
    expect(edit).toContain('Valuación inicial')

    const valued = renderToString(
      <InventoryEditModal
        error=""
        locationId="loc-1"
        product={{
          id: '1',
          organizationId: 'org',
          name: 'Golden Ale',
          baseUnit: 'ml',
          active: true,
          onHand: 50000,
          minimumStock: 10000,
          averageUnitCost: 1.2,
        }}
        saving={false}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    )
    expect(valued).toContain('Ya tiene valuación')
    expect(valued).not.toContain('Valuación inicial')

    expect(inventoryHistoryPageNumbers(1, 1)).toEqual([1])
    expect(inventoryHistoryPageNumbers(5, 3)).toEqual([1, 2, 3, 4, 5])

    const history = renderToString(
      <InventoryHistoryPanel
        error=""
        loading={false}
        rows={[
          {
            id: 'm1',
            occurredAt: '2026-01-01T12:00:00.000Z',
            productId: '1',
            productName: 'Harina',
            productActive: true,
            baseUnit: 'g',
            quantity: 1000,
            kind: 'adjustment',
            label: 'Ajuste',
            detail: 'Stock inicial',
          },
          {
            id: 'm2',
            occurredAt: '2026-01-02T12:00:00.000Z',
            productId: '2',
            productName: 'Harina',
            productActive: false,
            baseUnit: 'g',
            quantity: -100,
            kind: 'waste',
            label: 'Merma',
            detail: null,
          },
          {
            id: 'm3',
            occurredAt: '2026-01-03T12:00:00.000Z',
            productId: '3',
            productName: 'Azúcar',
            productActive: null,
            baseUnit: 'g',
            quantity: 50,
            kind: 'purchase',
            label: 'Compra',
            detail: null,
          },
        ]}
      />,
    )
    expect(history).toContain('Harina')
    expect(history).toContain('Stock inicial')
    expect(history).toContain('Eliminado')
    expect(history.match(/Eliminado/g)?.length).toBe(1)
  })
})

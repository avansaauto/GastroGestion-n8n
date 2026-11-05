import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { zIndex } from '@/design-system/zIndex'
import {
  cycleHighlight,
  filterCatalogProducts,
  mappingPickerKeyAction,
  mappingPickerTriggerLabel,
} from '@/lib/invoices/mappingPicker'
import {
  conversionMessage,
  previewPhysicalQuantity,
} from '@/lib/invoices/mapping'
import {
  factorFromPresentationAnswer,
  parsePresentationAnswer,
  physicalResultLabel,
  presentationQuestion,
} from '@/lib/invoices/presentation'
import { resolveLineInventoryConversion } from '@/lib/invoices/reviewMapping'
import { formatUnit } from '@/lib/invoices/review'
import type { InvoiceAnalysisLine } from '@/lib/invoices/types'
import type {
  InventoryProductOption,
  InvoiceMappingSuggestion,
} from '@/lib/invoices/types'

export type InvoiceProductCatalog = {
  products: InventoryProductOption[]
  loading: boolean
  error: string
}

const MENU_MAX_HEIGHT = 320

function menuStyle(anchor: DOMRect | null): CSSProperties {
  if (!anchor) {
    return {
      position: 'absolute',
      top: '100%',
      left: 0,
      marginTop: 4,
      width: '100%',
      maxHeight: MENU_MAX_HEIGHT,
      zIndex: zIndex.dropdown,
    }
  }
  const width = Math.min(Math.max(anchor.width, 240), Math.max(16, window.innerWidth - 16))
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - width - 8)
  const spaceBelow = window.innerHeight - anchor.bottom
  const openUp = spaceBelow < 160 && anchor.top > spaceBelow
  return {
    position: 'fixed',
    top: openUp ? undefined : anchor.bottom + 4,
    bottom: openUp ? window.innerHeight - anchor.top + 4 : undefined,
    left,
    width,
    maxHeight: MENU_MAX_HEIGHT,
    zIndex: zIndex.dropdown,
  }
}

function MenuLayer({
  children,
  style,
}: {
  children: ReactNode
  style: CSSProperties
}) {
  const node = (
    <div
      className="overflow-hidden rounded-lg border border-senda-border bg-white shadow-panel"
      data-mapping-menu="true"
      style={style}
    >
      {children}
    </div>
  )
  if (typeof document === 'undefined') return node
  return createPortal(node, document.body)
}

export function InvoiceMappingPicker({
  quantity,
  unit,
  inventoryPhysicalQuantity = null,
  lineAmount = null,
  suggestion,
  catalog,
  productId,
  approximateAccepted,
  conversionFactor = null,
  disabled = false,
  compact = false,
  showPendingHint = false,
  defaultOpen = false,
  allowCreate = false,
  onProductIdChange,
  onAcceptApproximate,
  onConversionFactorChange,
  onCreateNew,
}: {
  quantity: number | null
  unit: string | null
  /** Cantidad física ya calculada en el análisis (g/ml). */
  inventoryPhysicalQuantity?: number | null
  /** Importe neto de línea (sin IVA) para estimar costo / unidad física. */
  lineAmount?: number | null
  suggestion: InvoiceMappingSuggestion | null
  catalog: InvoiceProductCatalog
  productId: string
  approximateAccepted: boolean
  conversionFactor?: number | null
  disabled?: boolean
  compact?: boolean
  showPendingHint?: boolean
  defaultOpen?: boolean
  allowCreate?: boolean
  onProductIdChange: (productId: string) => void
  onAcceptApproximate: (suggestion: InvoiceMappingSuggestion) => void
  onConversionFactorChange?: (factor: number | null) => void
  onCreateNew?: () => void
}) {
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(defaultOpen)
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [contentDraft, setContentDraft] = useState('')
  const products = catalog.products
  const loading = catalog.loading
  const catalogError = catalog.error
  const filteredProducts = useMemo(
    () => filterCatalogProducts(products, search),
    [products, search],
  )

  const selected = useMemo(() => {
    const extras = [suggestion?.inventoryProduct].filter(
      (product): product is InventoryProductOption => Boolean(product?.id),
    )
    return products.find((product) => product.id === productId)
      ?? extras.find((product) => product.id === productId)
      ?? null
  }, [products, productId, suggestion])

  const physicalHintLine = {
    quantity,
    unit,
    inventoryPhysicalQuantity: inventoryPhysicalQuantity ?? 0,
  } as InvoiceAnalysisLine
  const resolved = selected
    ? resolveLineInventoryConversion(physicalHintLine, selected.baseUnit, conversionFactor)
    : null
  const effectiveFactor = resolved?.factor ?? null
  // Empaque / u→g: pedir factor solo si no hay física analizada ni borrador.
  const needsManualFactor = Boolean(
    selected
    && resolved
    && !resolved.conversion.ok
    && resolved.conversion.code === 'EQUIVALENCE_REQUIRED',
  )
  const showIncompatible = Boolean(
    selected
    && resolved
    && !resolved.conversion.ok
    && resolved.conversion.code === 'INCOMPATIBLE_UNITS',
  )
  const physical = resolved?.physical
    ?? (effectiveFactor != null ? previewPhysicalQuantity(quantity, effectiveFactor) : null)
  const catalogEmpty = !loading && !catalogError && products.length === 0
  const pendingCreate = productId.startsWith('create:')
  const exactProposal = suggestion?.kind === 'exact' && productId === suggestion.inventoryProductId
  const showApproximate = suggestion?.kind === 'approximate' && !approximateAccepted
  const triggerLabel = mappingPickerTriggerLabel(selected, loading)
  const canOpen = !disabled && !loading && (!catalogEmpty || allowCreate)

  useEffect(() => {
    setContentDraft('')
  }, [productId])

  function closeMenu() {
    setOpen(false)
    setSearch('')
    setHighlight(0)
  }

  function openMenu() {
    if (!canOpen) return
    const selectedIndex = filteredProducts.findIndex((product) => product.id === productId)
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  function choose(id: string) {
    onProductIdChange(id)
    closeMenu()
    triggerRef.current?.focus()
  }

  function requestCreate() {
    closeMenu()
    onCreateNew?.()
  }

  useEffect(() => {
    if (!open) return
    function syncAnchor() {
      setAnchor(triggerRef.current?.getBoundingClientRect() ?? null)
    }
    syncAnchor()
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node | null
      if (rootRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[data-mapping-menu="true"]')) return
      closeMenu()
    }
    function onKeyDown(event: KeyboardEvent) {
      const action = mappingPickerKeyAction(event.key, true)
      if (action === 'close') {
        event.preventDefault()
        closeMenu()
        triggerRef.current?.focus()
        return
      }
      if (action === 'next' || action === 'prev') {
        event.preventDefault()
        setHighlight((current) => cycleHighlight(current, action === 'next' ? 1 : -1, filteredProducts.length))
        return
      }
      if (action === 'select') {
        const product = filteredProducts[highlight]
        if (product) {
          event.preventDefault()
          choose(product.id)
        }
      }
    }
    window.addEventListener('resize', syncAnchor)
    window.addEventListener('scroll', syncAnchor, true)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', syncAnchor)
      window.removeEventListener('scroll', syncAnchor, true)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, filteredProducts, highlight])

  return (
    <div
      className={`relative ${compact ? 'w-[13.5rem] max-w-full' : 'max-w-full sm:w-[16rem]'}`}
      ref={rootRef}
    >
      <div className="flex items-center gap-1">
        <button
          aria-controls={listId}
          aria-expanded={open}
          aria-haspopup="listbox"
          className="flex h-9 min-w-0 flex-1 items-center gap-1 rounded-lg border border-senda-border bg-white px-2.5 text-left text-sm text-senda-ink disabled:bg-senda-subtle"
          disabled={!canOpen}
          ref={triggerRef}
          type="button"
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={(event) => {
            const action = mappingPickerKeyAction(event.key, open)
            if (action === 'open') {
              event.preventDefault()
              openMenu()
            }
          }}
        >
          <span className={`min-w-0 flex-1 truncate ${selected ? 'font-medium' : 'text-slate-400'}`}>
            {triggerLabel}
          </span>
          {selected?.baseUnit && (
            <span className="shrink-0 text-[11px] font-semibold text-senda-muted">
              {formatUnit(selected.baseUnit)}
            </span>
          )}
          <ChevronDown className="shrink-0 text-senda-muted" size={14} />
        </button>
        {selected && !disabled && (
          <button
            aria-label="Quitar propuesta"
            className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-senda-muted hover:bg-senda-subtle hover:text-senda-ink"
            type="button"
            onClick={() => {
              onProductIdChange('')
              onConversionFactorChange?.(null)
              closeMenu()
            }}
          >
            <X size={14} />
            <span className="sr-only">Quitar propuesta</span>
          </button>
        )}
      </div>

      {open && canOpen && (
        <MenuLayer style={menuStyle(anchor)}>
          <div className="border-b border-senda-border p-2">
            <label className="sr-only" htmlFor={`${listId}-search`}>Buscar y seleccionar insumo</label>
            <Input
              autoFocus
              className="h-9"
              disabled={disabled || loading || catalogEmpty}
              id={`${listId}-search`}
              placeholder={catalogEmpty ? 'Sin insumos en el catálogo' : 'Buscar insumo…'}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setHighlight(0)
              }}
            />
          </div>
          {allowCreate && onCreateNew && (
            <div className="border-b border-senda-border p-1">
              <button
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-semibold text-senda-navy hover:bg-senda-subtle"
                type="button"
                onClick={requestCreate}
              >
                <Plus size={14} />
                Crear insumo nuevo
              </button>
            </div>
          )}
          {catalogEmpty ? (
            <p className="mb-0 px-3 py-2 text-sm text-senda-muted">
              {allowCreate
                ? 'Todavía no hay insumos. Creá uno o dejá la línea pendiente.'
                : 'No hay insumos en el catálogo de esta organización.'}
            </p>
          ) : search && filteredProducts.length === 0 ? (
            <p className="mb-0 px-3 py-2 text-sm text-senda-muted">Ningún insumo coincide con la búsqueda.</p>
          ) : (
            <ul
              className="m-0 max-h-52 list-none overflow-y-auto p-0"
              id={listId}
              role="listbox"
            >
              {filteredProducts.map((product, index) => {
                const active = product.id === productId
                const focused = index === highlight
                return (
                  <li className="m-0" key={product.id}>
                    <button
                      aria-selected={active}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${
                        focused ? 'bg-senda-subtle' : 'bg-white hover:bg-senda-subtle'
                      } ${active ? 'font-semibold' : ''}`}
                      role="option"
                      type="button"
                      onClick={() => choose(product.id)}
                      onMouseEnter={() => setHighlight(index)}
                    >
                      <span className="min-w-0 truncate">{product.name}</span>
                      <span className="shrink-0 text-[11px] font-semibold text-senda-muted">
                        {formatUnit(product.baseUnit)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </MenuLayer>
      )}

      {pendingCreate && selected && (
        <p className="mb-0 mt-1 text-[11px] leading-4 text-senda-navy">
          Se creará al guardar
        </p>
      )}

      {exactProposal && suggestion && (
        <p className="mb-0 mt-1 text-[11px] leading-4 text-senda-muted">
          Propuesta por vinculación anterior
        </p>
      )}

      {showApproximate && suggestion && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-orange-800">
          <span>Sugerencia aproximada: ¿Es {suggestion.inventoryProduct.name}?</span>
          <Button
            className="min-h-7 px-2 text-[11px]"
            disabled={disabled}
            onClick={() => onAcceptApproximate(suggestion)}
            variant="secondary"
          >
            Confirmar sugerencia
          </Button>
        </div>
      )}

      {catalogError && <p className="mb-0 mt-1 text-[11px] leading-4 text-red-700">{catalogError}</p>}

      {catalogEmpty && !allowCreate && (
        <p className="mb-0 mt-1 text-[11px] leading-4 text-senda-muted">
          No hay insumos en el catálogo de esta organización.
        </p>
      )}

      {allowCreate && onCreateNew && !disabled && !pendingCreate && (
        <button
          className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold leading-4 text-senda-navy hover:underline"
          type="button"
          onClick={() => onCreateNew()}
        >
          <Plus size={12} />
          Crear insumo nuevo
        </button>
      )}

      {loading && !selected && (
        <p className="mb-0 mt-1 text-[11px] leading-4 text-senda-muted">Cargando insumos…</p>
      )}

      {selected && needsManualFactor && (
        <div className="mt-1 space-y-1">
          <label className="block text-[11px] font-semibold leading-4 text-senda-muted" htmlFor={`${listId}-content`}>
            {presentationQuestion(unit, selected.baseUnit) ?? '¿Cuánto contenido trae cada unidad?'}
            <Input
              className="mt-1 h-8"
              disabled={disabled}
              id={`${listId}-content`}
              inputMode="decimal"
              placeholder="Ej. 3,5"
              value={contentDraft}
              onChange={(event) => {
                const next = event.target.value
                setContentDraft(next)
                const answer = parsePresentationAnswer(next)
                onConversionFactorChange?.(
                  answer == null ? null : factorFromPresentationAnswer(answer, selected.baseUnit),
                )
              }}
            />
          </label>
          {contentDraft.trim() !== '' && parsePresentationAnswer(contentDraft) == null && (
            <p className="mb-0 text-[11px] leading-4 text-red-700">
              La cantidad tiene que ser mayor que cero.
            </p>
          )}
        </div>
      )}

      {selected && physical != null && (
        <p className="mb-0 mt-1 truncate text-[11px] leading-4 text-senda-muted">
          {physicalResultLabel(physical, selected.baseUnit, lineAmount)}
        </p>
      )}

      {showIncompatible && (
        <p className="mb-0 mt-1 text-[11px] leading-4 text-red-700">
          {conversionMessage('INCOMPATIBLE_UNITS')}
        </p>
      )}

      {showPendingHint && !productId && !showApproximate && !loading && (
        <p className="mb-0 mt-1 text-[11px] leading-4 text-senda-muted">
          Sin insumo. Quedará pendiente de vinculación después de guardar.
        </p>
      )}
    </div>
  )
}

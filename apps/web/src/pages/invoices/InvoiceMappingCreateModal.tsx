import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import {
  createInventoryProduct,
  getInventoryProducts,
  InventoryApiError,
  type InventoryProduct,
} from '@/lib/api'
import {
  preloadInventoryName,
  suggestInventoryBaseUnit,
  type SuggestedBaseUnit,
} from '@/lib/invoices/invoiceCreateProduct'
import { displayToPhysical, formatInventoryUnit } from '@/lib/invoices/receptionUnits'
import type { ReviewMappingCreateIntent } from '@/lib/invoices/reviewMapping'

function canSubmit(busy: boolean, name: string) {
  return !busy && name.trim().length >= 2
}

const BASE_UNITS: { value: SuggestedBaseUnit; label: string }[] = [
  { value: 'g', label: 'Gramos (g)' },
  { value: 'ml', label: 'Mililitros (ml)' },
  { value: 'unit', label: 'Unidades (u)' },
]

export type InvoiceCreateProductResult = {
  product: InventoryProduct
  reactivated: boolean
}

export function InvoiceMappingCreateModal({
  open,
  organizationId,
  locationId,
  commercialDescription,
  invoiceUnit,
  contentUnit = null,
  mode = 'defer',
  onPrepared,
  onCreated,
  onClose,
}: {
  open: boolean
  organizationId: string
  locationId?: string
  commercialDescription: string
  invoiceUnit: string | null
  contentUnit?: string | null
  /** defer: alta en confirm-intake. persist: crea ya (detalle de factura). */
  mode?: 'defer' | 'persist'
  onPrepared?: (intent: ReviewMappingCreateIntent) => void
  onCreated?: (result: InvoiceCreateProductResult) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [baseUnit, setBaseUnit] = useState<SuggestedBaseUnit>('g')
  const [minimumStockDisplay, setMinimumStockDisplay] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setName(preloadInventoryName(commercialDescription))
    setCategory('')
    setBaseUnit(suggestInventoryBaseUnit(commercialDescription, invoiceUnit, contentUnit))
    setMinimumStockDisplay('')
    setBusy(false)
    setError('')
  }, [open, commercialDescription, contentUnit, invoiceUnit])

  useEffect(() => {
    if (!open || busy) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  function parseMinimumStock(): number | null | undefined {
    const raw = minimumStockDisplay.trim()
    if (!raw) return null
    const parsed = Number(raw.replace(',', '.'))
    if (!Number.isFinite(parsed) || parsed < 0) return undefined
    return displayToPhysical(parsed, baseUnit)
  }

  async function submit() {
    if (!organizationId || busy || !canSubmit(busy, name)) return
    const minimumStock = parseMinimumStock()
    if (minimumStock === undefined) {
      setError('Indicá un stock mínimo válido.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (mode === 'persist') {
        const created = await createInventoryProduct(organizationId, {
          name: name.trim(),
          baseUnit,
          category: category.trim() || null,
          minimumStock,
          locationId: locationId || undefined,
        })
        onCreated?.({ product: created, reactivated: false })
        onClose()
        return
      }

      const existing = await getInventoryProducts(organizationId, { includeInactive: true })
      const normalized = name.trim().toLocaleLowerCase('es')
      const duplicate = existing.find((row) => row.active && row.name.trim().toLocaleLowerCase('es') === normalized)
      if (duplicate) {
        setError('Ya existe un insumo activo con ese nombre.')
        return
      }
      onPrepared?.({
        name: name.trim(),
        baseUnit,
        category: category.trim() || null,
        minimumStock,
      })
      onClose()
    } catch (reason) {
      setError(reason instanceof InventoryApiError ? reason.message : 'No se pudo validar el nombre.')
    } finally {
      setBusy(false)
    }
  }

  const unitLabel = formatInventoryUnit(baseUnit)

  return (
    <Modal open={open} title="Crear insumo nuevo" onClose={busy ? () => undefined : onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {commercialDescription.trim() && (
          <p className="mb-0 rounded-lg border border-senda-border bg-senda-subtle px-3 py-2 text-sm text-senda-muted">
            Descripción en la factura:{' '}
            <span className="font-semibold text-senda-ink">{commercialDescription.trim()}</span>
            . Se conserva en el comprobante aunque el nombre del inventario sea distinto.
          </p>
        )}
        {mode === 'defer' && (
          <p className="mb-0 text-sm text-senda-muted">
            El insumo se crea al confirmar la recepción, junto con la vinculación y el stock.
          </p>
        )}
        <label className="block space-y-1.5 text-xs font-semibold text-senda-muted" htmlFor="invoice-create-name">
          Nombre en inventario
          <Input
            autoFocus
            disabled={busy}
            id="invoice-create-name"
            onChange={(event) => {
              setName(event.target.value)
              setError('')
            }}
            placeholder="Nombre del insumo"
            value={name}
          />
        </label>
        <label className="block space-y-1.5 text-xs font-semibold text-senda-muted" htmlFor="invoice-create-category">
          Categoría
          <Input
            disabled={busy}
            id="invoice-create-category"
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Opcional"
            value={category}
          />
        </label>
        <Select
          disabled={busy}
          label="Unidad base"
          onChange={(value) => setBaseUnit(value as SuggestedBaseUnit)}
          value={baseUnit}
        >
          {BASE_UNITS.map((unit) => (
            <option key={unit.value} value={unit.value}>{unit.label}</option>
          ))}
        </Select>
        <label className="block space-y-1.5 text-xs font-semibold text-senda-muted" htmlFor="invoice-create-minimum">
          Stock mínimo ({unitLabel})
          <Input
            disabled={busy}
            id="invoice-create-minimum"
            inputMode="decimal"
            onChange={(event) => setMinimumStockDisplay(event.target.value)}
            placeholder="0"
            value={minimumStockDisplay}
          />
        </label>
        {error && (
          <p className="mb-0 text-sm text-red-700" role="alert">{error}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onClick={onClose} type="button" variant="secondary">
            Cancelar
          </Button>
          <Button disabled={!canSubmit(busy, name)} type="submit">
            {busy
              ? (mode === 'persist' ? 'Guardando…' : 'Validando…')
              : (mode === 'persist' ? 'Crear y vincular' : 'Preparar alta')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { InvoiceApiError, listInvoiceProducts, mapInvoiceLine } from '@/lib/invoices/api'
import {
  lineAmount,
  lineDescription,
  lineQuantity,
  lineUnit,
} from '@/lib/invoices/mapping'
import { formatComprehensibleQuantity } from '@/lib/invoices/presentation'
import { resolveLineInventoryConversion } from '@/lib/invoices/reviewMapping'
import { formatQuantity, formatUnit } from '@/lib/invoices/review'
import type {
  InventoryProductOption,
  InvoiceMapResult,
  InvoiceStoredLine,
} from '@/lib/invoices/types'
import { InvoiceMappingCreateModal } from './InvoiceMappingCreateModal'
import { InvoiceMappingPicker, type InvoiceProductCatalog } from './InvoiceMappingPicker'

export type { InvoiceProductCatalog }

export function InvoiceMappingForm({
  invoiceId,
  line,
  catalog,
  organizationId,
  locationId,
  onMapped,
  onCatalogProduct,
}: {
  invoiceId: string
  line: InvoiceStoredLine
  catalog?: InvoiceProductCatalog
  organizationId?: string
  locationId?: string
  onMapped: (result: InvoiceMapResult) => void
  onCatalogProduct?: (product: InventoryProductOption) => void
}) {
  const quantity = lineQuantity(line)
  const unit = lineUnit(line)
  const suggestion = line.mappingSuggestion ?? null
  const [productId, setProductId] = useState(
    line.inventoryProductId
    || (suggestion?.kind === 'exact' ? suggestion.inventoryProductId : ''),
  )
  const [conversionFactor, setConversionFactor] = useState<number | null>(
    suggestion?.conversionFactor ?? null,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [approximateAccepted, setApproximateAccepted] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [products, setProducts] = useState<InventoryProductOption[]>(catalog?.products ?? [])
  const [catalogError, setCatalogError] = useState(catalog?.error ?? '')
  const [loading, setLoading] = useState(catalog ? catalog.loading : true)

  useEffect(() => {
    if (catalog) {
      setProducts(catalog.products)
      setCatalogError(catalog.error)
      setLoading(catalog.loading)
      return
    }
    setLoading(true)
    listInvoiceProducts(invoiceId)
      .then((items) => {
        setProducts(items)
        setCatalogError('')
      })
      .catch((reason: Error) => {
        setProducts([])
        setCatalogError(reason instanceof InvoiceApiError ? reason.message : reason.message)
      })
      .finally(() => setLoading(false))
  }, [invoiceId, catalog])

  const selected = products.find((product) => product.id === productId)
    ?? (line.inventoryProduct?.id === productId ? line.inventoryProduct : null)
    ?? (suggestion?.inventoryProduct.id === productId ? suggestion.inventoryProduct : null)
  const resolved = selected
    ? resolveLineInventoryConversion(
      {
        quantity,
        unit,
        inventoryPhysicalQuantity: line.inventoryPhysicalQuantity ?? 0,
      } as Parameters<typeof resolveLineInventoryConversion>[0],
      selected.baseUnit,
      conversionFactor,
    )
    : null
  const rawConversion = resolved?.conversion ?? null
  const needsManualFactor = Boolean(
    rawConversion && !rawConversion.ok && rawConversion.code === 'EQUIVALENCE_REQUIRED',
  )
  const effectiveFactor = resolved?.factor ?? null
  const physical = resolved?.physical != null
    ? resolved.physical
    : line.mappingStatus === 'mapped' && selected
      ? line.inventoryPhysicalQuantity
      : null
  const mapped = line.mappingStatus === 'mapped'
  const hasReceipts = (line.receivedQuantity ?? 0) > 0
  const canSave = Boolean(
    productId
    && effectiveFactor != null
    && physical != null
    && !hasReceipts
    && !loading,
  )
  const commercialDescription = lineDescription(line)
  const allowCreate = Boolean(organizationId)

  async function save() {
    if (!productId || effectiveFactor == null || hasReceipts) return
    setSaving(true)
    setError('')
    try {
      const result = await mapInvoiceLine(invoiceId, line.id, {
        inventoryProductId: productId,
        ...(needsManualFactor && conversionFactor != null
          ? { conversionFactor }
          : {}),
      })
      onMapped(result)
    } catch (reason) {
      setError(reason instanceof InvoiceApiError ? reason.message : 'No se pudo vincular el producto.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="m-0 text-sm font-semibold">{commercialDescription}</p>
        <p className="mb-0 mt-1 text-xs text-senda-muted">
          {`${formatQuantity(quantity)} ${formatUnit(unit)}`}
        </p>
      </div>

      {mapped && line.inventoryProduct && (
        <p className="mb-0 text-sm text-senda-muted">
          {`${line.inventoryProduct.name} · ${formatComprehensibleQuantity(line.inventoryPhysicalQuantity, line.inventoryProduct.baseUnit) ?? '—'}`}
        </p>
      )}

      <InvoiceMappingPicker
        allowCreate={allowCreate}
        approximateAccepted={approximateAccepted}
        catalog={{ products, loading, error: catalogError }}
        compact
        conversionFactor={conversionFactor}
        disabled={saving || hasReceipts}
        inventoryPhysicalQuantity={line.inventoryPhysicalQuantity}
        lineAmount={lineAmount(line)}
        productId={productId}
        quantity={quantity}
        suggestion={mapped ? null : suggestion}
        unit={unit}
        onAcceptApproximate={(next) => {
          setProductId(next.inventoryProductId)
          setApproximateAccepted(true)
          if (next.conversionFactor != null) {
            setConversionFactor(next.conversionFactor)
          }
        }}
        onConversionFactorChange={setConversionFactor}
        onCreateNew={() => setCreateOpen(true)}
        onProductIdChange={(nextId) => {
          setProductId(nextId)
          setConversionFactor(null)
        }}
      />

      {hasReceipts && (
        <p className="mb-0 text-sm text-senda-muted">
          No se puede cambiar el insumo de una línea ya recibida.
        </p>
      )}

      {error && <p className="mb-0 text-sm text-red-700">{error}</p>}

      <Button disabled={saving || !canSave} onClick={() => void save()}>
        {saving ? 'Vinculando…' : mapped ? 'Actualizar vinculación' : 'Guardar vinculación'}
      </Button>

      {organizationId && (
        <InvoiceMappingCreateModal
          commercialDescription={commercialDescription}
          invoiceUnit={unit}
          locationId={locationId}
          mode="persist"
          open={createOpen}
          organizationId={organizationId}
          onClose={() => setCreateOpen(false)}
          onCreated={({ product }) => {
            const option: InventoryProductOption = {
              id: product.id,
              name: product.name,
              baseUnit: product.baseUnit,
              organizationId: product.organizationId,
              active: product.active,
            }
            setProducts((current) => (
              current.some((item) => item.id === option.id)
                ? current.map((item) => (item.id === option.id ? option : item))
                : [...current, option].sort((left, right) => left.name.localeCompare(right.name, 'es'))
            ))
            onCatalogProduct?.(option)
            setProductId(option.id)
            setConversionFactor(null)
            setCreateOpen(false)
          }}
        />
      )}
    </div>
  )
}

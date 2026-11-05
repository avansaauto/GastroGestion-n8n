import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { isInventoriableLine, LINE_ASSOCIATION_MISSING, lineDescription } from '@/lib/invoices/mapping'
import { formatComprehensibleQuantity } from '@/lib/invoices/presentation'
import type { AttemptStore } from '@/lib/invoices/receiveAttempt'
import { receiveVisualState, type ReceiveLineFn } from '@/lib/invoices/receiveSubmit'
import type {
  InventoryProductOption,
  InvoiceMapResult,
  InvoiceReceiveResult,
  InvoiceStoredLine,
} from '@/lib/invoices/types'
import { InvoiceMappingForm, type InvoiceProductCatalog } from './InvoiceMappingSection'

export type InvoiceLineOperations = {
  invoiceId: string
  lines: InvoiceStoredLine[]
  status: string
  catalog?: InvoiceProductCatalog
  organizationId?: string
  locationId?: string
  onMapped: (result: InvoiceMapResult) => void
  onReceived: (result: InvoiceReceiveResult) => void
  onCatalogProduct?: (product: InventoryProductOption) => void
  receiveLine?: ReceiveLineFn
  store?: AttemptStore
}

function savedLineCaption(line: InvoiceStoredLine): string | null {
  const product = line.inventoryProduct?.name?.trim() ?? ''
  const description = lineDescription(line).trim()
  const sameName = Boolean(
    product
    && description
    && product.localeCompare(description, 'es', { sensitivity: 'accent' }) === 0,
  )
  const partial = receiveVisualState(line) === 'partial'
  const readable = partial
    ? formatComprehensibleQuantity(line.receivedQuantity ?? 0, line.inventoryProduct?.baseUnit)
    : null
  const parts: string[] = []
  if (product && !sameName) parts.push(product)
  if (readable) parts.push(`Recibido ${readable}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function InvoiceConceptActions({
  associationMissing = false,
  classificationLabel,
  classificationTone = 'neutral',
  quietComplete = false,
  receptionBlocked = false,
  storedLine,
  operations,
  readOnly = false,
}: {
  associationMissing?: boolean
  classificationLabel: string
  classificationTone?: 'neutral' | 'warning' | 'success'
  quietComplete?: boolean
  receptionBlocked?: boolean
  storedLine?: InvoiceStoredLine
  operations?: InvoiceLineOperations
  readOnly?: boolean
}) {
  const [modal, setModal] = useState<'map' | 'receive' | null>(null)
  const inventoriable = Boolean(
    !associationMissing
    && storedLine
    && isInventoriableLine(storedLine)
    && operations,
  )
  const mapped = storedLine?.mappingStatus === 'mapped'
  const hasReceipts = (storedLine?.receivedQuantity ?? 0) > 0
  const receiveState = storedLine ? receiveVisualState(storedLine) : 'pending_configuration'
  const hideSuccess = quietComplete && classificationTone === 'success'
  const unmappedPending = quietComplete && inventoriable && !mapped
  const caption = readOnly && storedLine ? savedLineCaption(storedLine) : null

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {unmappedPending ? <Badge tone="warning">Sin insumo</Badge> : null}
        {!unmappedPending && !hideSuccess ? (
          <Badge tone={classificationTone}>{classificationLabel}</Badge>
        ) : null}
        {inventoriable && mapped && !quietComplete ? <Badge tone="success">Vinculado</Badge> : null}
        {inventoriable && mapped && receiveState === 'none' && !receptionBlocked && <Badge tone="warning">Sin recibir</Badge>}
        {inventoriable && mapped && receptionBlocked && classificationLabel !== 'Revisión comercial' ? (
          <Badge tone="warning">Revisión comercial</Badge>
        ) : null}
        {inventoriable && receiveState === 'partial' && <Badge tone="warning">Recibido parcial</Badge>}
        {inventoriable && receiveState === 'complete' && !quietComplete ? <Badge tone="success">Recibido</Badge> : null}
      </div>

      {caption ? <p className="mb-0 text-xs text-senda-ink">{caption}</p> : null}

      {inventoriable && storedLine && operations && !readOnly && (
        <div className="flex flex-wrap gap-2">
          {!mapped && (
            <Button className="min-h-8 px-3 text-xs" onClick={() => setModal('map')}>
              Vincular
            </Button>
          )}
          {mapped && !hasReceipts && (
            <Button className="min-h-8 px-3 text-xs" variant="secondary" onClick={() => setModal('map')}>
              Editar vínculo
            </Button>
          )}
        </div>
      )}

      {inventoriable && mapped && receptionBlocked && (
        <p className="mb-0 text-xs text-senda-muted">
          La recepción queda bloqueada hasta resolver la discrepancia comercial.
        </p>
      )}

      {associationMissing && (
        <p className="mb-0 text-xs text-senda-muted">{LINE_ASSOCIATION_MISSING}</p>
      )}

      {inventoriable && mapped && hasReceipts && !readOnly && (
        <p className="mb-0 text-xs text-senda-muted">
          No se puede editar el vínculo: ya hay recepciones.
        </p>
      )}

      {inventoriable && storedLine && operations && !readOnly && (
        <>
          <Modal
            open={modal === 'map'}
            title={mapped ? (hasReceipts ? 'Vínculo' : 'Editar vínculo') : 'Vincular concepto'}
            onClose={() => setModal(null)}
          >
            <InvoiceMappingForm
              catalog={operations.catalog}
              invoiceId={operations.invoiceId}
              line={storedLine}
              locationId={operations.locationId}
              organizationId={operations.organizationId}
              onCatalogProduct={operations.onCatalogProduct}
              onMapped={(result) => {
                operations.onMapped(result)
                setModal(null)
              }}
            />
          </Modal>
        </>
      )}
    </div>
  )
}

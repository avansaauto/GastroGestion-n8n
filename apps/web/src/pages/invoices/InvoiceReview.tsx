import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { Input } from '@/components/ui/Input'
import {
  DOCUMENT_CLASSIFICATION_LABEL,
  SERVICE_TYPE_LABEL,
  bonusQuestion,
  dimensionLabel,
  displayedFiscalStatus,
  fiscalReviewNotes,
  formatIssueDate,
  formatMoney,
  formatQuantity,
  formatUnit,
  lineDescription,
  needsFiscalAcceptance,
  partitionReviewLines,
  quantityDisplay,
  relationEffectiveStatus,
  toCommercialDecisionPayload,
} from '@/lib/invoices/review'
import { reviewInventorySummary, reviewLineVisual } from '@/lib/invoices/reviewSummary'
import { isInventoriableAnalysisLine, storedLineForAnalysis } from '@/lib/invoices/mapping'
import { commercialReviewLineIds } from '@/lib/invoices/savedIntakeRecovery'
import {
  canEditReviewReceived,
  initialReviewReceivedDrafts,
  reviewReceivedRemainingLabel,
  reviewReceivedView,
  type ReviewReceivedDrafts,
} from '@/lib/invoices/reviewReceived'
import type {
  InvoiceAnalysisApiResult,
  InvoiceAnalysisLine,
  InvoiceSaveApiResult,
  LocalRelationDecision,
} from '@/lib/invoices/types'
import { InvoiceConceptActions, type InvoiceLineOperations } from './InvoiceConceptActions'
import { InvoiceMappingPicker, type InvoiceProductCatalog } from './InvoiceMappingPicker'
import {
  emptyReviewMappingDraft,
  type ReviewMappingDrafts,
  type ReviewMappingSuggestions,
} from '@/lib/invoices/reviewMapping'
import { intakeOutcomeSummary, type IntakeLineResult } from '@/lib/invoices/reviewIntake'

export type InvoiceReviewSaveProps = {
  canSave: boolean
  canConfirm?: boolean
  canRetry?: boolean
  saving: boolean
  saved: InvoiceSaveApiResult | null
  error: { message: string; code?: string } | null
  blockedReason: string | null
  confirmBlockedReason?: string | null
  progressMessage?: string | null
  intakeLines?: IntakeLineResult[]
  acceptFiscalInconsistency: boolean
  onAcceptFiscal: (value: boolean) => void
  /** Guardar comprobante y, si las líneas están listas, confirmar recepción (dos pasos backend). */
  onSave: () => void
  /** Solo conservar factura sin movimiento de stock (explícito). */
  onSavePendingOnly?: () => void
  onCancel?: () => void
  /** @deprecated Preferir onSave que encadena confirmación. */
  onConfirm?: () => void
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="m-0 text-xs font-semibold uppercase tracking-wide text-senda-muted">{label}</p>
      <p className="mb-0 mt-1 text-sm font-semibold">{value || '—'}</p>
    </div>
  )
}

function toneForDimension(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'consistent') return 'success'
  if (status === 'requires_review' || status === 'inconsistent') return 'warning'
  return 'neutral'
}

function consumptionLabel(value: { quantity: number; unit: string } | null) {
  if (!value) return '—'
  return `${formatQuantity(value.quantity)} ${formatUnit(value.unit)}`
}

function lineColumns(
  currency: string,
  operations?: InvoiceLineOperations,
  received?: {
    drafts: ReviewReceivedDrafts
    locked: boolean
    onChange?: (sourceLineId: string, displayValue: string) => void
  },
  mapping?: {
    catalog: InvoiceProductCatalog
    drafts: ReviewMappingDrafts
    suggestions: ReviewMappingSuggestions
    locked: boolean
    allowCreate?: boolean
    onProductIdChange?: (sourceLineId: string, productId: string) => void
    onAcceptSuggestion?: (sourceLineId: string) => void
    onConversionFactorChange?: (sourceLineId: string, factor: number | null) => void
    onCreateNew?: (sourceLineId: string) => void
  },
  options?: {
    quantityLabel?: string
    showUnitColumn?: boolean
    receptionBlockedLineIds?: ReadonlySet<string>
    readOnly?: boolean
    quietComplete?: boolean
  },
): Column<InvoiceAnalysisLine>[] {
  const showUnitColumn = options?.showUnitColumn !== false
  const columns: Column<InvoiceAnalysisLine>[] = [
    {
      key: 'name',
      label: 'Descripción',
      render: (line) => {
        const description = lineDescription(line)
        return (
          <div>
            <p className="m-0 font-semibold">{description.title}</p>
            {description.detail && (
              <p className="mb-0 mt-1 text-xs text-senda-muted">{description.detail}</p>
            )}
          </div>
        )
      },
    },
    {
      key: 'quantity',
      label: options?.quantityLabel ?? 'Cantidad',
      render: (line) => {
        const display = quantityDisplay(line)
        return (
          <span>
            {`${display.quantity}${!showUnitColumn && display.unit ? ` ${display.unit}` : ''}`}
            {display.hint && <span className="block text-xs text-senda-muted">{display.hint}</span>}
          </span>
        )
      },
    },
  ]
  if (received) {
    columns.push({
      key: 'received',
      label: 'Recibido',
      render: (line) => {
        if (!canEditReviewReceived(line)) return '—'
        const displayValue = received.drafts[line.id]
          ?? initialReviewReceivedDrafts([line])[line.id]
          ?? ''
        const view = reviewReceivedView(line, displayValue)
        return (
          <div className="min-w-[8.5rem]">
            <div className="flex items-center gap-2">
              <Input
                className="h-9 w-24"
                disabled={received.locked}
                inputMode="decimal"
                type="text"
                value={displayValue}
                onChange={(event) => received.onChange?.(line.id, event.target.value)}
              />
              <span className="text-sm font-medium text-senda-muted">{quantityDisplay(line).unit}</span>
            </div>
            {view?.showRemaining && (
              <p className="mb-0 mt-1 text-xs text-senda-muted">{reviewReceivedRemainingLabel(view)}</p>
            )}
            {view?.error && (
              <p className="mb-0 mt-1 text-xs text-red-700">{view.error}</p>
            )}
          </div>
        )
      },
    })
  }
  if (mapping) {
    columns.push({
      key: 'product',
      label: 'Insumo',
      render: (line) => {
        if (!canEditReviewReceived(line)) return '—'
        const draft = mapping.drafts[line.id] ?? emptyReviewMappingDraft()
        const pendingCreate = draft.createIntent
          ? [{
            id: draft.inventoryProductId || `create:${line.id}`,
            name: draft.createIntent.reactivateProductName || draft.createIntent.name,
            baseUnit: draft.createIntent.baseUnit,
          }]
          : []
        return (
          <InvoiceMappingPicker
            allowCreate={mapping.allowCreate}
            approximateAccepted={draft.approximateAccepted}
            catalog={{
              ...mapping.catalog,
              products: pendingCreate.length
                ? [
                  ...pendingCreate,
                  ...mapping.catalog.products.filter((product) => product.id !== pendingCreate[0]?.id),
                ]
                : mapping.catalog.products,
            }}
            compact
            conversionFactor={draft.conversionFactor}
            disabled={mapping.locked}
            inventoryPhysicalQuantity={line.inventoryPhysicalQuantity}
            lineAmount={line.amount}
            productId={draft.inventoryProductId || pendingCreate[0]?.id || ''}
            quantity={line.quantity}
            showPendingHint
            suggestion={mapping.suggestions[line.id] ?? null}
            unit={line.unit}
            onAcceptApproximate={() => mapping.onAcceptSuggestion?.(line.id)}
            onConversionFactorChange={(factor) => mapping.onConversionFactorChange?.(line.id, factor)}
            onCreateNew={() => mapping.onCreateNew?.(line.id)}
            onProductIdChange={(productId) => mapping.onProductIdChange?.(line.id, productId)}
          />
        )
      },
    })
  }
  if (showUnitColumn) {
    columns.push({ key: 'unit', label: 'Unidad', render: (line) => quantityDisplay(line).unit })
  }
  columns.push(
    { key: 'unitPrice', label: 'P. unitario', render: (line) => formatMoney(line.unitPrice, currency) },
    { key: 'amount', label: 'Importe', render: (line) => formatMoney(line.amount, currency) },
    {
      key: 'classification',
      label: 'Clasificación',
      render: (line) => {
        const storedLine = operations ? storedLineForAnalysis(line, operations.lines) : undefined
        const visual = reviewLineVisual(line, {
          mappingAvailable: Boolean(mapping),
          mappingDraft: mapping?.drafts[line.id],
        })
        return (
          <InvoiceConceptActions
            associationMissing={Boolean(operations && !storedLine && isInventoriableAnalysisLine(line))}
            classificationLabel={visual.label}
            classificationTone={visual.tone}
            operations={operations}
            quietComplete={options?.quietComplete ?? false}
            readOnly={options?.readOnly ?? false}
            receptionBlocked={options?.receptionBlockedLineIds?.has(line.id) ?? false}
            storedLine={storedLine}
          />
        )
      },
    },
  )
  return columns
}

export function InvoiceReview({
  result,
  originalResult,
  localDecisions,
  receivedDrafts,
  mappingDrafts,
  mappingSuggestions,
  mappingCatalog,
  onDecide,
  onReceivedChange,
  onMappingProductChange,
  onAcceptMappingSuggestion,
  onMappingConversionFactorChange,
  onCreateMappingProduct,
  save,
  mode = 'review',
  documentStatus,
  lineOperations,
  readOnly = false,
}: {
  result: InvoiceAnalysisApiResult
  originalResult?: InvoiceAnalysisApiResult | null
  localDecisions: Record<string, LocalRelationDecision>
  receivedDrafts?: ReviewReceivedDrafts
  mappingDrafts?: ReviewMappingDrafts
  mappingSuggestions?: ReviewMappingSuggestions
  mappingCatalog?: InvoiceProductCatalog
  onDecide?: (relationId: string, decision: LocalRelationDecision) => void
  onReceivedChange?: (sourceLineId: string, displayValue: string) => void
  onMappingProductChange?: (sourceLineId: string, productId: string) => void
  onAcceptMappingSuggestion?: (sourceLineId: string) => void
  onMappingConversionFactorChange?: (sourceLineId: string, factor: number | null) => void
  onCreateMappingProduct?: (sourceLineId: string) => void
  save?: InvoiceReviewSaveProps
  mode?: 'review' | 'saved'
  documentStatus?: string
  lineOperations?: InvoiceLineOperations
  readOnly?: boolean
}) {
  const currency = result.document.header.currency
  const notes = fiscalReviewNotes(result)
  const fiscalStatus = displayedFiscalStatus(result)
  const isService = result.document.classification === 'service'
  const localPayload = toCommercialDecisionPayload(result, localDecisions)
  const { concepts, adjustments, taxes } = partitionReviewLines(
    result.document.lines,
    result.interpretation.relations,
  )
  const amounts = result.document.amounts
  const saved = mode === 'saved'
  const confirmed = Boolean(save?.intakeLines && save.intakeLines.length > 0 && !save?.canRetry)
  const locked = Boolean(save?.saving || confirmed || saved)
  const intakeSummary = intakeOutcomeSummary({
    saved: save?.saved,
    intakeLines: save?.intakeLines,
  })
  const saveBusy = Boolean(save?.saving)
  const inventoryComplete = Boolean(
    save?.intakeLines
    && save.intakeLines.length > 0
    && save.intakeLines.every((line) => line.status === 'received')
    && !save.canRetry
  )
  const primarySaveEnabled = Boolean(
    save
    && !saveBusy
    && !inventoryComplete
    && (
      (save.canSave && !save.confirmBlockedReason)
      || (save.canRetry && !save.confirmBlockedReason)
    ),
  )
  const cancelEnabled = Boolean(save?.onCancel && !saveBusy && !confirmed)
  const drafts = receivedDrafts ?? initialReviewReceivedDrafts(result.document.lines)
  const mappingAvailable = !saved && Boolean(mappingCatalog)
  const showReceivedColumn = !saved && concepts.some(canEditReviewReceived)
  const inventory = reviewInventorySummary(result, {
    mappingAvailable,
    mappingDrafts,
    receivedDrafts: drafts,
    settled: saved,
  })
  const receptionBlockedLineIds = new Set(commercialReviewLineIds(result, originalResult))
  const conceptColumns = lineColumns(
    currency,
    lineOperations,
    showReceivedColumn ? {
      drafts,
      locked,
      onChange: onReceivedChange,
    } : undefined,
    mappingAvailable && mappingCatalog && concepts.some(canEditReviewReceived) ? {
      catalog: mappingCatalog,
      drafts: mappingDrafts ?? {},
      suggestions: mappingSuggestions ?? {},
      locked,
      allowCreate: Boolean(onCreateMappingProduct),
      onProductIdChange: onMappingProductChange,
      onAcceptSuggestion: onAcceptMappingSuggestion,
      onConversionFactorChange: onMappingConversionFactorChange,
      onCreateNew: onCreateMappingProduct,
    } : undefined,
    isService
      ? undefined
      : {
        quantityLabel: 'Facturado',
        showUnitColumn: false,
        receptionBlockedLineIds,
        readOnly,
        quietComplete: saved,
      },
  )
  const taxColumns = lineColumns(currency)
  const showSave = !saved && (
    result.inventory.eligibleLines >= 1
    || result.interpretation.relations.length > 0
  )
  const fiscalNeedsAcceptance = needsFiscalAcceptance(result)
  const originalAmounts = originalResult?.document.amounts
  const originalCurrency = originalResult?.document.header.currency ?? currency

  return (
    <div className="space-y-5">
      <p className="m-0 rounded-xl border border-senda-border bg-senda-subtle px-4 py-3 text-sm text-senda-muted">
          {saved
          ? `Factura guardada${documentStatus ? ` · ${documentStatus}` : ''}. Consulta de solo lectura.`
          : save?.saved
            ? `${intakeSummary?.title ?? 'Operación incompleta.'} ID: ${save.saved.id}.`
            : 'El análisis todavía no está guardado. Al guardar se vinculan los insumos y se actualiza el inventario.'}
      </p>

      {originalResult && (
        <Card className="p-5">
          <h3 className="m-0 text-base font-bold">Datos originales</h3>
          <p className="mb-0 mt-2 text-sm text-senda-muted">
            Snapshot inmutable del análisis. Las correcciones y decisiones aparecen en la revisión de abajo.
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Proveedor" value={originalResult.document.supplier.name ?? '—'} />
            <Field label="CUIT" value={originalResult.document.supplier.taxId ?? '—'} />
            <Field label="Tipo" value={originalResult.document.header.type ?? '—'} />
            <Field label="Número" value={originalResult.document.header.number ?? '—'} />
            <Field label="Fecha" value={formatIssueDate(originalResult.document.header.issueDate)} />
            <Field label="Total original" value={formatMoney(originalAmounts?.total, originalCurrency)} />
          </div>
        </Card>
      )}

      <Card className="p-5">
        <h3 className="m-0 text-base font-bold">
          {originalResult ? 'Datos revisados' : 'Información general'}
        </h3>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Proveedor" value={result.document.supplier.name ?? '—'} />
          <Field label="CUIT" value={result.document.supplier.taxId ?? '—'} />
          <Field label="Tipo" value={result.document.header.type ?? '—'} />
          <Field label="Número" value={result.document.header.number ?? '—'} />
          <Field label="Fecha" value={formatIssueDate(result.document.header.issueDate)} />
          <Field label="Moneda" value={currency === '$' ? 'ARS' : currency} />
          <Field
            label="Clasificación"
            value={DOCUMENT_CLASSIFICATION_LABEL[result.document.classification] ?? result.document.classification}
          />
          {result.metadata.fileSha256 && (
            <Field label="SHA-256" value={`${result.metadata.fileSha256.slice(0, 12)}…`} />
          )}
        </div>
        {isService && result.document.service && (
          <div className="mt-5 grid gap-4 border-t border-senda-border pt-5 sm:grid-cols-2 xl:grid-cols-4">
            <Field
              label="Tipo de servicio"
              value={SERVICE_TYPE_LABEL[result.document.service.type] ?? result.document.service.type}
            />
            <Field
              label="Período"
              value={
                result.document.service.billingPeriod
                || [result.document.service.periodStart, result.document.service.periodEnd]
                  .filter(Boolean)
                  .map((value) => formatIssueDate(value))
                  .join(' – ')
                || '—'
              }
            />
            <Field label="Consumo real" value={consumptionLabel(result.document.service.actualConsumption)} />
            <Field label="Consumo facturado" value={consumptionLabel(result.document.service.billedConsumption)} />
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-senda-border px-5 py-4">
          <h3 className="m-0 text-base font-bold">
            {isService ? 'Conceptos de servicio' : 'Mercadería'}
          </h3>
        </div>
        {concepts.length > 0 ? (
          <DataTable columns={conceptColumns} rowKey={(line) => line.id} rows={concepts} />
        ) : (
          <p className="px-5 py-4 text-sm text-senda-muted">No hay mercadería física en este comprobante.</p>
        )}
      </Card>

      {adjustments.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-senda-border px-5 py-4">
            <h3 className="m-0 text-base font-bold">Ajustes comerciales</h3>
            <p className="mb-0 mt-2 text-sm text-senda-muted">
              Importes negativos de la factura. No representan mercadería física ni mueven stock.
            </p>
          </div>
          <DataTable columns={taxColumns} rowKey={(line) => line.id} rows={adjustments} />
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-senda-border px-5 py-4">
          <h3 className="m-0 text-base font-bold">Impuestos, tasas y percepciones</h3>
        </div>
        {taxes.length > 0 ? (
          <DataTable columns={taxColumns} rowKey={(line) => line.id} rows={taxes} />
        ) : (amounts.taxes ?? 0) !== 0 || (amounts.otherTaxes ?? 0) !== 0 ? (
          <p className="px-5 py-4 text-sm text-senda-muted">
            El IVA y los otros impuestos están en los totales del comprobante.
          </p>
        ) : (
          <p className="px-5 py-4 text-sm text-senda-muted">No se identificaron líneas fiscales de detalle.</p>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="m-0 text-base font-bold">Subtotales y totales</h3>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="Subtotal" value={formatMoney(amounts.subtotal, currency)} />
          <Field label="Descuentos" value={formatMoney(amounts.discounts, currency)} />
          <Field label="IVA" value={formatMoney(amounts.taxes, currency)} />
          <Field label="Otros impuestos" value={formatMoney(amounts.otherTaxes, currency)} />
          <Field label="Total" value={formatMoney(amounts.total, currency)} />
        </div>
      </Card>

      {(() => {
        const validationRows = ([
          ['Matemática', result.validation.dimensions.mathematical.status],
          ['Fiscal', fiscalStatus],
          ['Comercial', result.validation.dimensions.commercial.status],
        ] as const).filter(([, status]) => status !== 'consistent' && status !== 'not_applicable')
        if (validationRows.length === 0 && notes.length === 0) return null
        return (
          <Card className="p-5">
            <h3 className="m-0 text-base font-bold">Advertencias y validaciones</h3>
            {validationRows.length > 0 ? (
              <div className="mt-4 space-y-3 text-sm">
                {validationRows.map(([label, status]) => (
                  <div className="flex items-center justify-between gap-3" key={label}>
                    <span>{label}</span>
                    <Badge tone={toneForDimension(status)}>{dimensionLabel(status)}</Badge>
                  </div>
                ))}
              </div>
            ) : null}
            {notes.length > 0 && (
              <ul className="mb-0 mt-4 space-y-2 pl-5 text-sm text-senda-muted">
                {notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            )}
          </Card>
        )
      })()}

      {(inventory.title || inventory.stats.length > 0) ? (
      <Card className="p-5">
        <h3 className="m-0 text-base font-bold">Inventario</h3>
        {inventory.stats.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {inventory.stats.map((stat) => (
              <span
                className="inline-flex items-center rounded-full bg-senda-subtle px-2.5 py-1 text-xs font-semibold text-senda-muted"
                key={stat.key}
              >
                {`${stat.label}: ${stat.count}`}
              </span>
            ))}
          </div>
        )}
        {inventory.title ? <p className="mt-3 text-sm font-semibold">{inventory.title}</p> : null}
        {inventory.body ? <p className="mb-0 mt-2 text-sm leading-6 text-senda-muted">{inventory.body}</p> : null}
      </Card>
      ) : null}

      {result.interpretation.relations.length > 0 && (
        <Card className="space-y-4 p-5">
          <div>
            <h3 className="m-0 text-base font-bold">Bonificaciones y descuentos</h3>
            <p className="mb-0 mt-2 text-sm text-senda-muted">
              {saved
                ? 'Decisiones comerciales guardadas. El ajuste negativo no mueve stock.'
                : 'Confirmá o rechazá cada relación antes de guardar. Los importes fiscales originales no cambian.'}
            </p>
          </div>
          {result.interpretation.relations.map((relation) => {
            const status = relationEffectiveStatus(relation, localDecisions[relation.id])
            const statusLabel = status === 'confirm'
              ? 'confirmada'
              : status === 'reject'
                ? 'rechazada'
                : 'pendiente'
            const ambiguous = !relation.targetLineId && relation.candidateTargetLineIds.length > 1
            const kind = relation.type === 'discount' ? 'Descuento' : 'Bonificación'
            return (
              <div className="rounded-xl border border-senda-border p-4" key={relation.id}>
                <p className="m-0 text-sm font-semibold">{bonusQuestion(relation, result)}</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <Field label="Importe bruto" value={formatMoney(relation.grossAmount, currency)} />
                  <Field label={kind} value={formatMoney(-Math.abs(relation.bonusAmount), currency)} />
                  <Field label="Neto comercial" value={formatMoney(relation.netAcquisitionAmount, currency)} />
                </div>
                {relation.proposedPhysicalQuantity != null && (
                  <p className="mb-0 mt-3 text-xs text-senda-muted">
                    Cantidad facturada: {formatQuantity(relation.proposedPhysicalQuantity)} {formatUnit(relation.unit)}.
                    {status === 'confirm'
                      ? ' La cantidad recibida se indica en la tabla de mercadería.'
                      : ' No es la cantidad recibida.'}
                  </p>
                )}
                {ambiguous && status === 'pending' && (
                  <p className="mb-0 mt-3 text-sm text-senda-muted">
                    Hay más de un producto candidato. No se confirma automáticamente.
                  </p>
                )}
                {status === 'reject' && (
                  <p className="mb-0 mt-3 text-sm text-senda-muted">
                    Relación cerrada. El ajuste negativo no ingresa al inventario.
                  </p>
                )}
                {!saved && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      disabled={locked || (ambiguous && status !== 'confirm')}
                      variant={status === 'confirm' ? 'primary' : 'secondary'}
                      onClick={() => onDecide?.(relation.id, status === 'confirm' ? 'pending' : 'confirm')}
                    >
                      Confirmar
                    </Button>
                    <Button
                      disabled={locked}
                      variant={status === 'reject' ? 'primary' : 'secondary'}
                      onClick={() => onDecide?.(relation.id, status === 'reject' ? 'pending' : 'reject')}
                    >
                      Rechazar
                    </Button>
                    <Button disabled={locked} variant="ghost" onClick={() => onDecide?.(relation.id, 'pending')}>
                      Dejar pendiente
                    </Button>
                  </div>
                )}
                <p className="mb-0 mt-2 text-xs text-senda-muted">
                  Estado actual: {statusLabel}
                </p>
              </div>
            )
          })}
          {localPayload.length > 0 && (
            <p className="mb-0 text-xs text-senda-muted">
              {saved || save?.saved
                ? `Decisiones comerciales guardadas: ${localPayload.length}.`
                : `Decisiones listas para guardar: ${localPayload.length}.`}
            </p>
          )}
        </Card>
      )}

      {showSave && (
        <Card className="p-5">
          <h3 className="m-0 text-base font-bold">Guardar</h3>
          <p className="mb-0 mt-2 text-sm text-senda-muted">
            Guardar valida los datos, conserva el comprobante y confirma la recepción de las líneas listas
            (crea o vincula insumos y registra stock). Son dos pasos en el servidor: si el segundo falla,
            la factura queda guardada y podés reintentar sin duplicar el documento.
            Las líneas pendientes no mueven inventario.
          </p>
          {fiscalNeedsAcceptance && (
            <label className="mt-4 flex items-start gap-3 text-sm">
              <input
                checked={Boolean(save?.acceptFiscalInconsistency)}
                className="mt-1"
                disabled={locked || !save || Boolean(save.saved)}
                type="checkbox"
                onChange={(event) => save?.onAcceptFiscal(event.target.checked)}
              />
              <span>Confirmo la diferencia fiscal y quiero guardar igual.</span>
            </label>
          )}
          {saveBusy && (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-senda-border bg-senda-subtle px-4 py-3">
              <Loader2 className="mt-0.5 animate-spin text-senda-navy" size={18} />
              <p className="mb-0 text-sm font-semibold">{save?.progressMessage || 'Procesando…'}</p>
            </div>
          )}
          {save?.saved && intakeSummary && (
            <div className={`mt-4 rounded-xl px-4 py-3 text-sm ${
              intakeSummary.kind === 'errors'
                ? 'border border-red-200 bg-red-50 text-red-700'
                : intakeSummary.kind === 'complete'
                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                  : intakeSummary.kind === 'already_registered'
                    ? 'border border-senda-border bg-senda-subtle text-senda-ink'
                    : 'border border-orange-200 bg-orange-50 text-orange-800'
            }`}>
              <p className="m-0 font-semibold">{intakeSummary.title}</p>
              <p className="mb-0 mt-1">{intakeSummary.body}</p>
            </div>
          )}
          {save?.saved && !intakeSummary && save.saved.idempotent && (
            <div className="mt-4 rounded-xl border border-senda-border bg-senda-subtle px-4 py-3 text-sm">
              Factura ya registrada. ID: {save.saved.id}. No se modificó el inventario durante este intento.
            </div>
          )}
          {save?.intakeLines && save.intakeLines.length > 0 && !save.saved?.idempotent && (
            <ul className="mb-0 mt-4 space-y-2 pl-5 text-sm">
              {save.intakeLines.map((line) => (
                <li key={line.sourceLineId}>
                  <span className="font-semibold">{line.label}:</span> {line.message}
                </li>
              ))}
            </ul>
          )}
          {save?.saved && (
            <p className="mb-0 mt-4 text-sm">
              <a className="font-semibold text-senda-navy hover:underline" href={`/facturas/${save.saved.id}`}>
                Abrir detalle de la factura
              </a>
            </p>
          )}
          {save?.error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {save.error.message}
            </div>
          )}
          {save?.blockedReason && !saveBusy && !save.saved && !save.error && (
            <p className="mb-0 mt-4 text-sm text-senda-muted">{save.blockedReason}</p>
          )}
          {save?.confirmBlockedReason && !saveBusy && (
            <p className="mb-0 mt-4 text-sm text-senda-muted">{save.confirmBlockedReason}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={!primarySaveEnabled}
              onClick={() => save?.onSave()}
            >
              {save?.canRetry ? 'Reintentar' : 'Guardar'}
            </Button>
            <Button
              disabled={!cancelEnabled}
              onClick={() => save?.onCancel?.()}
              variant="secondary"
            >
              Cancelar
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}

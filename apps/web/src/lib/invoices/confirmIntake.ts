import {
  matchExistingIngredient,
  type ExistingIngredientMatch,
} from './invoiceMemory'
import { suggestInventoryBaseUnit } from './invoiceCreateProduct'
import {
  emptyReviewMappingDraft,
  resolveLineInventoryConversion,
  type ReviewMappingDrafts,
  type ReviewMappingSuggestions,
} from './reviewMapping'
import { canEditReviewReceived, reviewReceivedView, type ReviewReceivedDrafts } from './reviewReceived'
import type { InvoiceAnalysisLine, InventoryProductOption } from './types'

export { matchExistingIngredient }
export type { ExistingIngredientMatch }

export type ConfirmIntakeLinePayload = {
  purchaseDocumentLineId: string
  action: 'link_existing' | 'create' | 'reactivate' | 'pending'
  inventoryProductId?: string | null
  create?: {
    name: string
    baseUnit: string
    category: string | null
    minimumStock: number | null
  } | null
  conversionFactor?: number | null
  receiveQuantity?: number | null
  receiveIdempotencyKey?: string | null
}

export type ConfirmIntakeGuard = {
  commercialReviewLineIds?: ReadonlySet<string>
  suggestions?: ReviewMappingSuggestions
  organizationId?: string | null
}

function lineLabel(line: InvoiceAnalysisLine) {
  return line.name || line.originalDescription
}

export function confirmIntakeBlockReason(
  lines: InvoiceAnalysisLine[],
  receivedDrafts: ReviewReceivedDrafts,
  mappingDrafts: ReviewMappingDrafts,
  products: InventoryProductOption[],
  guard: ConfirmIntakeGuard = {},
): string | null {
  const catalog = new Map(products.map((product) => [product.id, product]))
  for (const line of lines) {
    if (!canEditReviewReceived(line)) continue
    const label = lineLabel(line)
    const view = reviewReceivedView(line, receivedDrafts[line.id])
    if (view?.error) return `${label}: ${view.error}`
    if (view && (view.received == null || view.received <= 0)) {
      return `${label}: la cantidad no alcanza para actualizar el stock. Corregila antes de guardar.`
    }
    if (guard.commercialReviewLineIds?.has(line.id)) {
      return `${label}: la interpretación comercial no alcanza para actualizar el stock. Corregila antes de guardar.`
    }
    const draft = mappingDrafts[line.id] ?? emptyReviewMappingDraft()
    if (draft.action === 'pending' || !draft.action) {
      if (guard.suggestions?.[line.id]?.kind === 'approximate') {
        return `${label}: hay un nombre parecido, pero no es una coincidencia segura. Elegí el insumo.`
      }
      const baseUnit = draft.createIntent?.baseUnit
        || suggestInventoryBaseUnit(label, line.unit, line.contentUnit)
      const match = matchExistingIngredient(
        draft.createIntent?.name || label,
        baseUnit,
        products,
        guard.organizationId,
      )
      if (match.status === 'ambiguous') {
        return `${label}: hay más de un insumo con ese nombre. Elegí uno.`
      }
      if (match.status === 'unit_mismatch') {
        return `${label}: ya existe un insumo con ese nombre y otra unidad base.`
      }
      return `${label}: falta definir el insumo antes de guardar.`
    }
    if (draft.action === 'create') {
      if (!draft.createIntent?.name || draft.createIntent.name.trim().length < 2) {
        return `${line.name || line.originalDescription}: falta el nombre del insumo nuevo.`
      }
      const match = matchExistingIngredient(
        draft.createIntent.name,
        draft.createIntent.baseUnit,
        products,
      )
      const label = line.name || line.originalDescription
      if (match.status === 'ambiguous') {
        return `${label}: hay más de un insumo con ese nombre. Elegí uno.`
      }
      if (match.status === 'unit_mismatch') {
        return `${label}: ya existe un insumo con ese nombre y otra unidad base.`
      }
      const resolved = resolveLineInventoryConversion(
        line,
        draft.createIntent.baseUnit,
        draft.conversionFactor,
      )
      if (!resolved.conversion.ok) {
        return resolved.conversion.code === 'EQUIVALENCE_REQUIRED'
          ? `${line.name || line.originalDescription}: indicá el factor de conversión o la cantidad física.`
          : `${line.name || line.originalDescription}: unidades incompatibles.`
      }
      continue
    }
    const productId = draft.action === 'reactivate'
      ? (draft.createIntent?.reactivateProductId || draft.inventoryProductId)
      : draft.inventoryProductId
    if (!productId) {
      return `${line.name || line.originalDescription}: falta el insumo.`
    }
    const product = catalog.get(productId) ?? (
      draft.createIntent
        ? { id: productId, name: draft.createIntent.reactivateProductName || draft.createIntent.name, baseUnit: draft.createIntent.baseUnit }
        : null
    )
    if (!product?.baseUnit) {
      return `${line.name || line.originalDescription}: no se pudo resolver la unidad del insumo.`
    }
    const resolved = resolveLineInventoryConversion(line, product.baseUnit, draft.conversionFactor)
    if (!resolved.conversion.ok) {
      return resolved.conversion.code === 'EQUIVALENCE_REQUIRED'
        ? `${line.name || line.originalDescription}: indicá el factor de conversión o la cantidad física.`
        : `${line.name || line.originalDescription}: unidades incompatibles.`
    }
  }
  return null
}

export function buildConfirmIntakeLines(
  lines: InvoiceAnalysisLine[],
  receivedDrafts: ReviewReceivedDrafts,
  mappingDrafts: ReviewMappingDrafts,
  products: InventoryProductOption[],
  createReceiveKey: () => string,
  blockReceptionLineIds: ReadonlySet<string> = new Set(),
): ConfirmIntakeLinePayload[] {
  const catalog = new Map(products.map((product) => [product.id, product]))
  const payload: ConfirmIntakeLinePayload[] = []
  for (const line of lines) {
    if (!canEditReviewReceived(line)) continue
    const draft = mappingDrafts[line.id] ?? emptyReviewMappingDraft()
    const view = reviewReceivedView(line, receivedDrafts[line.id])
    const receivedCommercial = view?.received ?? 0

    if (draft.action === 'pending' || (!draft.inventoryProductId && !draft.createIntent)) {
      payload.push({
        purchaseDocumentLineId: line.id,
        action: 'pending',
      })
      continue
    }

    if (draft.action === 'create' && draft.createIntent) {
      const resolved = resolveLineInventoryConversion(
        line,
        draft.createIntent.baseUnit,
        draft.conversionFactor,
      )
      const factor = resolved.factor
      const receptionBlocked = blockReceptionLineIds.has(line.id)
      // Para recepción parcial: factor × comercial recibida.
      // Para recepción completa con física analizada: preferir el total físico.
      const physicalReceive = (() => {
        if (receptionBlocked) return null
        if (factor == null || receivedCommercial <= 0) return null
        if (
          line.inventoryPhysicalQuantity > 0
          && line.quantity != null
          && line.quantity > 0
          && receivedCommercial === line.quantity
        ) {
          return line.inventoryPhysicalQuantity
        }
        return Number((receivedCommercial * factor).toFixed(6))
      })()
      const reuse = matchExistingIngredient(
        draft.createIntent.name,
        draft.createIntent.baseUnit,
        products,
      )
      if (reuse.status === 'reuse') {
        payload.push({
          purchaseDocumentLineId: line.id,
          action: 'link_existing',
          inventoryProductId: reuse.product.id,
          conversionFactor: factor,
          receiveQuantity: physicalReceive,
          receiveIdempotencyKey: physicalReceive != null ? createReceiveKey() : null,
        })
        continue
      }
      payload.push({
        purchaseDocumentLineId: line.id,
        action: 'create',
        create: {
          name: draft.createIntent.name,
          baseUnit: draft.createIntent.baseUnit,
          category: draft.createIntent.category,
          minimumStock: draft.createIntent.minimumStock,
        },
        // Siempre enviar factor efectivo: barra/plancha→g exige equivalencia en el backend.
        conversionFactor: factor,
        receiveQuantity: physicalReceive,
        receiveIdempotencyKey: physicalReceive != null ? createReceiveKey() : null,
      })
      continue
    }

    if (draft.action === 'reactivate') {
      const productId = draft.createIntent?.reactivateProductId || draft.inventoryProductId
      const baseUnit = draft.createIntent?.baseUnit
        || catalog.get(productId)?.baseUnit
        || null
      const resolved = resolveLineInventoryConversion(line, baseUnit, draft.conversionFactor)
      const factor = resolved.factor
      const physicalReceive = !blockReceptionLineIds.has(line.id) && factor != null && receivedCommercial > 0
        ? Number((receivedCommercial * factor).toFixed(6))
        : null
      payload.push({
        purchaseDocumentLineId: line.id,
        action: 'reactivate',
        inventoryProductId: productId,
        create: draft.createIntent
          ? {
            name: draft.createIntent.name,
            baseUnit: draft.createIntent.baseUnit,
            category: draft.createIntent.category,
            minimumStock: draft.createIntent.minimumStock,
          }
          : null,
        conversionFactor: factor,
        receiveQuantity: physicalReceive,
        receiveIdempotencyKey: physicalReceive != null ? createReceiveKey() : null,
      })
      continue
    }

    const product = catalog.get(draft.inventoryProductId)
    const resolved = resolveLineInventoryConversion(
      line,
      product?.baseUnit ?? null,
      draft.conversionFactor,
    )
    const factor = resolved.factor
    const physicalReceive = !blockReceptionLineIds.has(line.id) && factor != null && receivedCommercial > 0
      ? Number((receivedCommercial * factor).toFixed(6))
      : null
    payload.push({
      purchaseDocumentLineId: line.id,
      action: 'link_existing',
      inventoryProductId: draft.inventoryProductId,
      conversionFactor: factor,
      receiveQuantity: physicalReceive,
      receiveIdempotencyKey: physicalReceive != null ? createReceiveKey() : null,
    })
  }
  return payload
}

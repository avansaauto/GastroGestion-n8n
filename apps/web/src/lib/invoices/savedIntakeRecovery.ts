import { matchExistingIngredient, type ConfirmIntakeLinePayload } from './confirmIntake'
import { declaredInventoryBaseUnit } from './invoiceCreateProduct'
import type {
  InventoryProductOption,
  InvoiceAnalysisApiResult,
  InvoiceAnalysisLine,
  InvoiceStoredLine,
} from './types'

const COMMERCIAL_PRESENTATIONS: Record<string, string> = {
  barra: 'barra',
  barras: 'barra',
  plancha: 'plancha',
  planchas: 'plancha',
  bolsa: 'bolsa',
  bolsas: 'bolsa',
  pack: 'pack',
  packs: 'pack',
  caja: 'caja',
  cajas: 'caja',
  bulto: 'bulto',
  bultos: 'bulto',
  lata: 'lata',
  latas: 'lata',
  pieza: 'pieza',
  piezas: 'pieza',
  horma: 'horma',
  hormas: 'horma',
  bloque: 'bloque',
  bloques: 'bloque',
  botella: 'botella',
  botellas: 'botella',
  bidon: 'bidon',
  bidones: 'bidon',
  maple: 'maple',
  pallet: 'pallet',
  palet: 'pallet',
}

function normalizeToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** Misma regla que el análisis: una sola presentación, y solo si ya hay evidencia física. */
export function recoverStoredCommercialUnit(
  description: string | null | undefined,
  unit: string | null | undefined,
): string | null {
  const current = unit?.trim()
  if (current) return current
  const tokens = normalizeToken(description ?? '').split(/[^a-z0-9]+/).filter(Boolean)
  const found = new Set<string>()
  for (const token of tokens) {
    const presentation = COMMERCIAL_PRESENTATIONS[token]
    if (presentation) found.add(presentation)
  }
  if (found.size !== 1) return null
  return [...found][0] ?? null
}

export type SavedIntakePreview = {
  sourceLineId: string
  label: string
  message: string
  pending: boolean
}

export type SavedIntakeRecovery = {
  lines: ConfirmIntakeLinePayload[]
  previews: SavedIntakePreview[]
  actionableCount: number
  reason: string | null
}

type AnalysisLine = InvoiceAnalysisLine & {
  billedWeight?: number | null
  billedWeightUnit?: string | null
}

function analysisById(result: InvoiceAnalysisApiResult | null | undefined) {
  const map = new Map<string, AnalysisLine>()
  for (const line of result?.document.lines ?? []) {
    map.set(line.id, line)
  }
  return map
}

function interpretationStatus(
  result: InvoiceAnalysisApiResult | null | undefined,
  sourceLineId: string,
): string | null {
  const line = result?.interpretation.lines.find((item) => item.lineId === sourceLineId)
  return line?.status ?? null
}

/** Revisión guardada si existe; si no, el análisis original. */
export function lineRequiresCommercialReview(
  reviewed: InvoiceAnalysisApiResult | null | undefined,
  original: InvoiceAnalysisApiResult | null | undefined,
  sourceLineId: string,
): boolean {
  const status = interpretationStatus(reviewed, sourceLineId)
    ?? interpretationStatus(original, sourceLineId)
  return status === 'requires_review'
}

export function commercialReviewLineIds(
  reviewed: InvoiceAnalysisApiResult | null | undefined,
  original: InvoiceAnalysisApiResult | null | undefined,
): string[] {
  const ids = new Set<string>([
    ...(reviewed?.document.lines.map((line) => line.id) ?? []),
    ...(original?.document.lines.map((line) => line.id) ?? []),
  ])
  return [...ids].filter((id) => lineRequiresCommercialReview(reviewed, original, id))
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function evidenceFromOriginal(line: AnalysisLine | undefined, quantity: number) {
  if (!line || !(quantity > 0)) return null
  const contentBase = declaredInventoryBaseUnit(line.contentUnit)
  const billedBase = declaredInventoryBaseUnit(line.billedWeightUnit)
  const billed = positive(line.billedWeight)
  const content = positive(line.contentPerUnit)
  const hasEvidence = Boolean((content != null && contentBase) || (billed != null && billedBase))
  if (!hasEvidence) return null
  const baseUnit = contentBase ?? billedBase
  if (!baseUnit) return null
  const persisted = positive(line.inventoryPhysicalQuantity)
  const physical = persisted
    ?? (billed != null && billedBase === 'g' && normalizeToken(line.billedWeightUnit ?? 'kg') === 'kg'
      ? billed * 1000
      : billed)
  if (physical == null || physical <= 0) return null
  const description = line.originalDescription || line.name
  return {
    physical,
    baseUnit,
    factor: physical / quantity,
    commercialUnit: recoverStoredCommercialUnit(description, line.unit),
  }
}

function labelOf(stored: InvoiceStoredLine, line: AnalysisLine | undefined): string {
  return stored.reviewed.description
    || stored.original.description
    || line?.name
    || line?.originalDescription
    || 'Línea'
}

function inventoriableStored(line: InvoiceStoredLine): boolean {
  return line.inventoryEligibility === 'eligible'
    && line.mappingStatus !== 'not_applicable'
    && !['fiscal', 'service', 'ignored', 'expense', 'logistics'].includes(line.classification ?? '')
    && !['service_consumption', 'charge', 'none'].includes(line.quantityKind ?? '')
}

/**
 * Arma el payload de confirmPurchaseInvoiceIntake para una factura ya guardada.
 * La cantidad física sale del análisis original asociado por source_line_id.
 * Una línea sin esa evidencia queda pending y no se inventa.
 */
export function recoverSavedIntake(input: {
  organizationId: string
  lines: InvoiceStoredLine[]
  originalAnalysis: InvoiceAnalysisApiResult | null
  reviewedAnalysis: InvoiceAnalysisApiResult | null
  products: InventoryProductOption[]
}): SavedIntakeRecovery {
  const originalLines = analysisById(input.originalAnalysis)
  const reviewedLines = analysisById(input.reviewedAnalysis)
  const payloads: ConfirmIntakeLinePayload[] = []
  const previews: SavedIntakePreview[] = []

  for (const stored of input.lines) {
    if (!inventoriableStored(stored)) continue
    const sourceLineId = stored.sourceLineId
    const original = originalLines.get(sourceLineId)
    const reviewed = reviewedLines.get(sourceLineId)
    const quantity = positive(stored.reviewed.quantity) ?? positive(stored.original.quantity) ?? positive(original?.quantity)
    const evidence = evidenceFromOriginal(original, quantity ?? 0)
    const blocked = lineRequiresCommercialReview(input.reviewedAnalysis, input.originalAnalysis, sourceLineId)
    const label = labelOf(stored, original ?? reviewed)
    const alreadyReceived = (stored.receivedQuantity ?? 0) > 0

    if (!evidence || quantity == null) {
      payloads.push({ purchaseDocumentLineId: stored.id, action: 'pending' })
      previews.push({
        sourceLineId,
        label,
        pending: true,
        message: 'Queda pendiente: el análisis original no tiene cantidad física recuperable.',
      })
      continue
    }

    const receiveQuantity = blocked || alreadyReceived ? null : evidence.physical
    const unitLabel = evidence.commercialUnit ?? 'unidad comercial'
    const receiveLabel = blocked
      ? 'sin recepción hasta resolver la revisión comercial'
      : alreadyReceived
        ? 'ya recibida, no se vuelve a cargar'
        : `recibir ${evidence.physical} ${evidence.baseUnit}`

    if (stored.mappingStatus === 'mapped' && stored.inventoryProductId) {
      payloads.push({
        purchaseDocumentLineId: stored.id,
        action: 'link_existing',
        inventoryProductId: stored.inventoryProductId,
        conversionFactor: evidence.factor,
        receiveQuantity,
      })
      previews.push({
        sourceLineId,
        label,
        pending: false,
        message: `Ya vinculada · ${evidence.factor} ${evidence.baseUnit}/${unitLabel} · ${receiveLabel}.`,
      })
      continue
    }

    const createName = (stored.reviewed.description || original?.name || stored.original.description || '').trim()
    const match = matchExistingIngredient(
      createName,
      evidence.baseUnit,
      input.products,
      input.organizationId,
    )
    if (match.status === 'ambiguous' || match.status === 'unit_mismatch' || createName.length < 2) {
      payloads.push({ purchaseDocumentLineId: stored.id, action: 'pending' })
      previews.push({
        sourceLineId,
        label,
        pending: true,
        message: match.status === 'unit_mismatch'
          ? 'Queda pendiente: ya existe un insumo con ese nombre y otra unidad base.'
          : match.status === 'ambiguous'
            ? 'Queda pendiente: hay más de un insumo con ese nombre.'
            : 'Queda pendiente: falta un nombre comercial.',
      })
      continue
    }

    if (match.status === 'reuse') {
      payloads.push({
        purchaseDocumentLineId: stored.id,
        action: 'link_existing',
        inventoryProductId: match.product.id,
        conversionFactor: evidence.factor,
        receiveQuantity,
      })
      previews.push({
        sourceLineId,
        label,
        pending: false,
        message: `Vincular insumo existente · ${evidence.factor} ${evidence.baseUnit}/${unitLabel} · ${receiveLabel}.`,
      })
      continue
    }

    payloads.push({
      purchaseDocumentLineId: stored.id,
      action: 'create',
      create: {
        name: createName,
        baseUnit: evidence.baseUnit,
        category: null,
        minimumStock: null,
      },
      conversionFactor: evidence.factor,
      receiveQuantity,
    })
    previews.push({
      sourceLineId,
      label,
      pending: false,
      message: `Crear y vincular en ${evidence.baseUnit} · ${evidence.factor} ${evidence.baseUnit}/${unitLabel} · ${receiveLabel}.`,
    })
  }

  const actionableCount = payloads.filter((line) => line.action !== 'pending').length
  const pendingCount = payloads.length - actionableCount
  const reason = payloads.length === 0
    ? null
    : actionableCount === 0
      ? 'Ninguna línea tiene evidencia original suficiente para confirmar.'
      : pendingCount > 0
        ? 'Las líneas sin evidencia original quedan pendientes y no mueven stock.'
        : null

  return { lines: payloads, previews, actionableCount, reason }
}

export function intakeAttemptFingerprint(lines: ConfirmIntakeLinePayload[]): string {
  return lines.map((line) => [
    line.purchaseDocumentLineId,
    line.action,
    line.inventoryProductId ?? '',
    line.create?.name ?? '',
    line.create?.baseUnit ?? '',
    line.conversionFactor ?? '',
    line.receiveQuantity ?? '',
  ].join(':')).join('|')
}

/** Conserva una clave de confirmación y una clave de recepción por línea mientras el intento no cambia. */
export function withStableIntakeKeys(
  lines: ConfirmIntakeLinePayload[],
  state: { confirmKey: string | null; receiveKeys: Record<string, string> },
  randomUUID: () => string,
): {
  confirmKey: string
  receiveKeys: Record<string, string>
  lines: ConfirmIntakeLinePayload[]
} {
  const confirmKey = state.confirmKey ?? randomUUID()
  const receiveKeys = { ...state.receiveKeys }
  const next = lines.map((line) => {
    if (line.receiveQuantity == null || line.receiveQuantity <= 0) {
      return { ...line, receiveQuantity: line.receiveQuantity ?? null, receiveIdempotencyKey: null }
    }
    const existing = receiveKeys[line.purchaseDocumentLineId] ?? randomUUID()
    receiveKeys[line.purchaseDocumentLineId] = existing
    return { ...line, receiveIdempotencyKey: existing }
  })
  return { confirmKey, receiveKeys, lines: next }
}

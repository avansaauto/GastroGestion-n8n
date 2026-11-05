import {
  canonicalizeConsumptionUnit,
  classifyLine,
  inferServiceType,
  normalizeDocumentCategory,
  normalizeText,
  resolveDocumentClassification,
  resolveQuantityKind,
} from './classification.js'
import type {
  ExtractedInvoice,
  ExtractedInvoiceLine,
  InvoiceConsumption,
  NormalizedInvoiceDocument,
  NormalizedInvoiceLine,
} from './types.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function parseExtractedNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null

  let text = value.trim().replace(/[^\d,.-]/g, '')
  if (!text) return null
  const comma = text.lastIndexOf(',')
  const dot = text.lastIndexOf('.')
  if (comma > dot) {
    text = text.replace(/\./g, '').replace(',', '.')
  } else if (dot > comma && comma >= 0) {
    text = text.replace(/,/g, '')
  } else if (comma >= 0) {
    text = text.replace(',', '.')
  }
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  return text || null
}

function normalizeUnit(value: unknown): string | null {
  const unit = normalizeText(value)
  if (!unit) return null
  const aliases: Record<string, string> = {
    unidad: 'u',
    unidades: 'u',
    un: 'u',
    uni: 'u',
    und: 'u',
    unid: 'u',
    kilo: 'kg',
    kilos: 'kg',
    kilogramo: 'kg',
    kilogramos: 'kg',
    gramo: 'g',
    gramos: 'g',
    miligramo: 'mg',
    miligramos: 'mg',
    litro: 'l',
    litros: 'l',
    lt: 'l',
    lts: 'l',
    mililitro: 'ml',
    mililitros: 'ml',
    centilitro: 'cl',
    centilitros: 'cl',
    cc: 'ml',
    docenas: 'docena',
  }
  const consumption = canonicalizeConsumptionUnit(unit)
  if (consumption) return consumption
  return aliases[unit] ?? unit
}

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

/** Si Gemini no trae unidad, usa la presentación de la descripción solo cuando hay una sola. */
export function recoverCommercialPresentation(
  description: string | null | undefined,
  unit: string | null,
): string | null {
  if (unit) return unit
  const tokens = normalizeText(description).split(/[^a-z0-9]+/).filter(Boolean)
  const found = new Set<string>()
  for (const token of tokens) {
    const presentation = COMMERCIAL_PRESENTATIONS[token]
    if (presentation) found.add(presentation)
  }
  if (found.size !== 1) return null
  return [...found][0] ?? null
}

function parseConsumption(value: unknown): InvoiceConsumption | null {
  const record = asRecord(value)
  if (!record) return null
  const quantity = parseExtractedNumber(record.quantity ?? record.cantidad)
  const unit =
    canonicalizeConsumptionUnit(record.unit ?? record.unidad) ??
    normalizeUnit(record.unit ?? record.unidad)
  if (quantity == null || !unit) return null
  return { quantity, unit }
}

function parseIsoDate(value: unknown): string | null {
  const text = asNullableString(value)
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (!match) return null
  const [, day, month, year] = match
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

function normalizeCurrency(
  value: unknown,
  context: {
    supplierTaxId: string | null
    documentType: string | null
    lines: NormalizedInvoiceLine[]
  },
): { currency: string; needsConfirmation: boolean } {
  const raw = normalizeText(value).toUpperCase()
  if (!raw) return { currency: 'ARS', needsConfirmation: false }
  if (['ARS', 'PESO', 'PESOS', 'PESO ARGENTINO', 'PESOS ARGENTINOS'].includes(raw)) {
    return { currency: 'ARS', needsConfirmation: false }
  }
  if (['USD', 'US$', 'U$S', 'DOLAR', 'DOLARES'].includes(raw)) {
    return { currency: 'USD', needsConfirmation: false }
  }
  if (raw === '$') {
    const taxId = String(context.supplierTaxId ?? '').replace(/\D/g, '')
    const argentineFiscalContext =
      /^\d{11}$/.test(taxId) &&
      /factura|nota\s+(?:de\s+)?credito|nota\s+(?:de\s+)?debito|liquidacion|servicios\s+publicos/i.test(
        context.documentType ?? '',
      ) &&
      context.lines.some((line) =>
        /^iva\b|iibb|imp(?:uesto)?\.?\s*int/i.test(
          normalizeText(line.name || line.originalDescription),
        ),
      )
    return argentineFiscalContext
      ? { currency: 'ARS', needsConfirmation: false }
      : { currency: '$', needsConfirmation: true }
  }
  return { currency: String(value).trim().toUpperCase(), needsConfirmation: true }
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function normalizeLines(
  rawLines: unknown,
  proposedDocumentCategory: ReturnType<typeof normalizeDocumentCategory>,
): NormalizedInvoiceLine[] {
  if (!Array.isArray(rawLines)) return []
  const occurrences = new Map<string, number>()

  return rawLines.flatMap((candidate, sourceIndex) => {
    const record = asRecord(candidate) as ExtractedInvoiceLine | null
    if (!record) return []

    const originalDescription =
      asNullableString(record.description_original ?? record.descripcion_original) ??
      asNullableString(record.name ?? record.nombre) ??
      ''
    const name =
      asNullableString(record.name ?? record.nombre) ?? originalDescription
    const supplierSku = asNullableString(record.supplier_sku ?? record.codigo_proveedor)
    const directQuantity = parseExtractedNumber(record.quantity ?? record.cantidad)
    const packageCount = parseExtractedNumber(
      record.package_count ?? record.cantidad_bultos ?? record.cantidad_packs,
    )
    const unitsPerPackage = parseExtractedNumber(
      record.units_per_package ?? record.cantidad_unidades_por_bulto ?? record.pack,
    )
    const quantity = directQuantity ?? packageCount
    const unit = recoverCommercialPresentation(
      `${originalDescription} ${name}`,
      normalizeUnit(record.unit ?? record.unidad),
    )
    const contentPerUnit = parseExtractedNumber(record.content_per_unit ?? record.contenido)
    const contentUnit = normalizeUnit(record.content_unit ?? record.contenido_um)
    const billedWeight = parseExtractedNumber(
      record.billed_weight ?? record.peso_facturado ?? record.cant_kg,
    )
    const billedWeightUnit = normalizeUnit(
      record.billed_weight_unit ?? record.peso_facturado_um
      ?? (record.cant_kg != null ? 'kg' : null),
    )
    const unitPrice = parseExtractedNumber(record.unit_price ?? record.precio_unitario)
    const amount = parseExtractedNumber(record.amount ?? record.subtotal)
    const discount = parseExtractedNumber(record.discount ?? record.descuento)
    const category = asNullableString(record.category ?? record.categoria)
    const identityBase = [
      normalizeText(supplierSku),
      normalizeText(originalDescription),
      String(quantity ?? ''),
      String(amount ?? ''),
    ].join('|')
    const occurrence = (occurrences.get(identityBase) ?? 0) + 1
    occurrences.set(identityBase, occurrence)
    const id = `line-${stableHash(identityBase)}-${occurrence}`
    const missingFields: string[] = []
    if (!originalDescription) missingFields.push('description')
    if (unitPrice == null && amount == null) missingFields.push('price_or_amount')

    const detectedUnits =
      packageCount != null && unitsPerPackage != null
        ? packageCount * unitsPerPackage
        : packageCount == null
          ? quantity
          : null

    const draft = {
      id,
      sourceIndex,
      originalDescription,
      name,
      supplierSku,
      quantity,
      unit,
      packageCount,
      unitsPerPackage,
      contentPerUnit,
      contentUnit,
      billedWeight,
      billedWeightUnit,
      detectedUnits,
      unitPrice,
      amount,
      taxRate: parseExtractedNumber(record.tax_rate ?? record.porcentaje_iva),
      discount,
      category,
      usageType: asNullableString(record.usage_type ?? record.tipo_uso),
      missingFields,
      raw: record,
    }
    const classification = classifyLine(record, proposedDocumentCategory, draft)
    const quantityKind = resolveQuantityKind(classification.classification, unit)
    const isInventoryLine = classification.classification === 'stock'
    if (
      quantity == null &&
      record.es_subtotal !== true &&
      record.is_summary !== true &&
      isInventoryLine
    ) {
      missingFields.push('quantity')
    }

    return [{
      ...draft,
      detectedUnits: isInventoryLine ? draft.detectedUnits : null,
      classification: classification.classification,
      inventoryEligibility: classification.inventoryEligibility,
      quantityKind,
      inventoryPhysicalQuantity: isInventoryLine ? quantity ?? 0 : 0,
      ambiguities: classification.ambiguities,
    }]
  })
}

export function normalizeExtractedInvoice(value: unknown): NormalizedInvoiceDocument {
  const raw = asRecord(value) as ExtractedInvoice | null
  if (!raw) throw new TypeError('La extracción de factura debe ser un objeto JSON.')

  const rawCategory =
    raw.main_category ?? raw.rubro_principal ?? raw.expense_category ?? raw.categoria_gasto
  const proposedClassification = normalizeDocumentCategory(rawCategory)
  const documentType = asNullableString(
    raw.document_type ?? raw.tipo_comprobante_codigo ?? raw.tipo_comprobante,
  )
  const lines = normalizeLines(raw.lines ?? raw.items, proposedClassification)
  const classification = resolveDocumentClassification(proposedClassification, lines, {
    documentType,
  })
  const supplierTaxId = asNullableString(raw.supplier_tax_id ?? raw.proveedor_cuit)
  const currency = normalizeCurrency(raw.currency ?? raw.moneda, {
    supplierTaxId,
    documentType,
    lines,
  })
  const supplierName = asNullableString(raw.supplier_name ?? raw.proveedor_nombre)
  const serviceType =
    inferServiceType([
      raw.service_type,
      raw.tipo_servicio,
      ...lines.map((line) => `${line.originalDescription} ${line.name} ${line.unit ?? ''}`),
    ]) ??
    (classification === 'service' || lines.some((line) => line.classification === 'service')
      ? 'other'
      : null)
  const hasServiceSignal =
    classification === 'service' ||
    (classification === 'mixed' &&
      lines.some((line) => line.classification === 'service'))
  const service = hasServiceSignal && serviceType
    ? {
        type: serviceType,
        billingPeriod: asNullableString(raw.billing_period ?? raw.periodo_facturado),
        periodStart: parseIsoDate(raw.billing_period_start ?? raw.periodo_facturado_desde),
        periodEnd: parseIsoDate(raw.billing_period_end ?? raw.periodo_facturado_hasta),
        actualConsumption: parseConsumption(raw.actual_consumption ?? raw.consumo_real),
        billedConsumption: parseConsumption(raw.billed_consumption ?? raw.consumo_facturado),
        inventoryPhysicalQuantity: 0 as const,
      }
    : null

  return {
    supplier: {
      name: supplierName,
      taxId: supplierTaxId,
    },
    document: {
      type: documentType,
      number: asNullableString(
        raw.document_number ?? raw.numero ?? raw.numero_comprobante,
      ),
      issueDate: parseIsoDate(raw.issue_date ?? raw.fecha_emision),
      dueDate: parseIsoDate(raw.due_date ?? raw.fecha_vencimiento),
      currency: currency.currency,
      currencyNeedsConfirmation: currency.needsConfirmation,
      clientNumber: asNullableString(raw.client_number ?? raw.numero_cliente),
      meterNumber: asNullableString(raw.meter_number ?? raw.numero_medidor),
      paymentCode: asNullableString(raw.payment_code ?? raw.codigo_pago),
      printNumber: asNullableString(raw.print_number ?? raw.numero_impresion),
    },
    amounts: {
      subtotal: parseExtractedNumber(raw.subtotal),
      discounts: parseExtractedNumber(raw.discounts ?? raw.descuentos) ?? 0,
      taxes: parseExtractedNumber(raw.tax ?? raw.iva) ?? 0,
      otherTaxes: parseExtractedNumber(raw.other_taxes ?? raw.otros_impuestos) ?? 0,
      total: parseExtractedNumber(raw.total),
      taxesIncluded: raw.taxes_included === true || raw.impuestos_incluidos === true,
    },
    mainCategory: asNullableString(rawCategory) ?? 'unknown',
    classification,
    service,
    reviewStatus: 'requires_review',
    lines,
    raw,
  }
}

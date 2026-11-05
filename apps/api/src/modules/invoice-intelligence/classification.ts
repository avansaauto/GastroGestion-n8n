import type {
  ExtractedInvoiceLine,
  InventoryEligibility,
  InvoiceDocumentClassification,
  InvoiceLineClassification,
  InvoiceQuantityKind,
  InvoiceServiceType,
  NormalizedInvoiceLine,
} from './types.js'

const STOCK_DOCUMENT_CATEGORIES = new Set([
  'gastronomic_merchandise',
  'insumos_alimentos',
  'insumos_bebidas',
  'insumos_descartables',
  'insumos_mercaderia',
])

const DOCUMENT_CATEGORY_ALIASES: Record<string, InvoiceDocumentClassification> = {
  gastronomic_merchandise: 'gastronomic_merchandise',
  insumos_alimentos: 'gastronomic_merchandise',
  insumos_bebidas: 'gastronomic_merchandise',
  insumos_descartables: 'gastronomic_merchandise',
  insumos_mercaderia: 'gastronomic_merchandise',
  service: 'service',
  servicio: 'service',
  servicios: 'service',
  public_service: 'service',
  servicios_publicos: 'service',
  servicio_publico: 'service',
  liquidacion_de_servicios_publicos: 'service',
  liquidacion_de_servicios: 'service',
  factura_de_servicio: 'service',
  administrative_expense: 'administrative_expense',
  gasto_administrativo: 'administrative_expense',
  rent: 'rent',
  alquiler: 'rent',
  professional_fees: 'professional_fees',
  honorarios_profesionales: 'professional_fees',
  maintenance: 'service',
  mantenimiento: 'service',
  mantenimiento_reparaciones: 'service',
  equipment: 'equipment',
  equipamiento: 'equipment',
  logistics: 'logistics',
  combustible_flete: 'logistics',
  tax: 'tax',
  impuestos_tasas: 'tax',
  mixed: 'mixed',
  ambiguous: 'ambiguous',
  other: 'ambiguous',
  otro: 'ambiguous',
}

const FOOD_PATTERN =
  /\b(harina|carne|pollo|pescado|queso|lacteo|leche|pan|aceite|huevo|verdura|fruta|cerveza|vino|gaseosa|bebida|cafe|azucar|sal|condimento|fiambre|alimento|mercaderia|insumo|descartable|servilleta|envase)\b/i
const FOOD_CATEGORY_PATTERN =
  /\b(almacen|lacteos|quesos|carnes|fiambres|pescados|panaderia|congelados|cervezas|bebidas|snacks|condimentos|frutas|verduras|descartables|aceites)\b/i
const SERVICE_LINE_PATTERN =
  /\b(cargo fijo|cargo variable|cargo por consumo|consumo tramo|consumo facturado|consumo real|abono mensual|abono internet|energia electrica|electricidad|gas natural|agua corriente|fibra optica|enlace de datos|mantenimiento|reparacion|service tecnico|mano de obra|visita tecnica)\b/i
const SERVICE_CONSUMPTION_IN_TEXT =
  /\b\d+(?:[.,]\d+)?\s*(m3|m³|m\^3|kwh|kw\/h|kw\s*h)\b/i
const LOGISTICS_PATTERN = /\b(flete|logistica|transporte|envio|acarreo|delivery)\b/i
const FISCAL_PATTERN =
  /^(subtotal|total|neto gravado|i\.?\s*v\.?\s*a\.?\b|iibb\b|percepcion|retencion|impuesto|otros tributos|redondeo|recupero de costos|tasa\b|fondo\b|fdo\b|res\.?\s*\d)/i
const ADMIN_PATTERN =
  /\b(honorario|alquiler|locacion|administracion|contable|publicidad|marketing)\b/i
const EQUIPMENT_PATTERN = /\b(equipo|equipamiento|heladera|horno|freidora|mobiliario|maquinaria)\b/i
const PACKAGING_PATTERN = /\b(caja|pack|bulto|bolsa|maple|cajon|horma|bidon|plancha|barra|pieza|bloque)\b/i
const SERVICE_DOCUMENT_TYPE_PATTERN =
  /liquidacion(?:\s+de)?\s+servicios|servicios\s+publicos|factura\s+de\s+servicio/i
const SERVICE_CONSUMPTION_UNIT_PATTERN =
  /^(m3|m³|m\^3|metros?\s*cubicos?|kwh|kw\/h|kw\s*h|kilowatt\s*hora|kilovatios?\s*hora|kva)$/i

const SERVICE_TYPE_ALIASES: Record<string, InvoiceServiceType> = {
  gas: 'gas',
  gas_natural: 'gas',
  electricity: 'electricity',
  electricidad: 'electricity',
  energia: 'electricity',
  energia_electrica: 'electricity',
  internet: 'internet',
  fibra: 'internet',
  telecom: 'internet',
  maintenance: 'maintenance',
  mantenimiento: 'maintenance',
  reparacion: 'maintenance',
  other: 'other',
  otro: 'other',
}

export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/m³/g, 'm3')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeDocumentCategory(value: unknown): InvoiceDocumentClassification {
  const category = normalizeText(value).replace(/[\s/-]+/g, '_')
  return DOCUMENT_CATEGORY_ALIASES[category] ?? 'ambiguous'
}

export function isServiceConsumptionUnit(value: unknown): boolean {
  const unit = normalizeText(value).replace(/\s+/g, '')
  return SERVICE_CONSUMPTION_UNIT_PATTERN.test(unit) || SERVICE_CONSUMPTION_UNIT_PATTERN.test(normalizeText(value))
}

export function canonicalizeConsumptionUnit(value: unknown): string | null {
  const unit = normalizeText(value)
  if (!unit) return null
  if (/^(m3|m\^3|metros?\s*cubicos?)$/.test(unit) || unit.replace(/\s+/g, '') === 'm3') return 'm3'
  if (/^(kwh|kw\/h|kw\s*h|kilowatt\s*hora|kilovatios?\s*hora)$/.test(unit)) return 'kwh'
  if (unit === 'kva') return 'kva'
  return isServiceConsumptionUnit(unit) ? unit : null
}

export function inferServiceType(values: unknown[]): InvoiceServiceType | null {
  for (const value of values) {
    const alias = SERVICE_TYPE_ALIASES[normalizeText(value).replace(/[\s/-]+/g, '_')]
    if (alias) return alias
  }
  const blob = values.map((value) => normalizeText(value)).join(' ')
  if (/\b(gas|m3|metro cubico)\b/.test(blob)) return 'gas'
  if (/\b(electricidad|energia electrica|kwh|edenor|edesur)\b/.test(blob)) return 'electricity'
  if (/\b(internet|fibra|telecom|abono mensual)\b/.test(blob)) return 'internet'
  if (/\b(mantenimiento|reparacion|service tecnico|mano de obra)\b/.test(blob)) return 'maintenance'
  return null
}

export function isServiceDocumentType(value: unknown): boolean {
  return SERVICE_DOCUMENT_TYPE_PATTERN.test(normalizeText(value))
}

function rawBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function classifyLine(
  raw: ExtractedInvoiceLine,
  documentCategory: InvoiceDocumentClassification,
  normalized: Pick<
    NormalizedInvoiceLine,
    | 'originalDescription'
    | 'name'
    | 'category'
    | 'quantity'
    | 'packageCount'
    | 'unitsPerPackage'
    | 'contentPerUnit'
    | 'unitPrice'
    | 'amount'
    | 'unit'
  >,
): {
  classification: InvoiceLineClassification
  inventoryEligibility: InventoryEligibility
  ambiguities: string[]
} {
  const text = normalizeText(
    `${normalized.originalDescription} ${normalized.name} ${normalized.category ?? ''}`,
  )
  const ambiguities: string[] = []
  const isSummary = raw.is_summary === true || raw.es_subtotal === true
  const aiStockFlag = rawBoolean(raw.suitable_for_stock ?? raw.apto_para_stock)

  if (!text) {
    return { classification: 'ignored', inventoryEligibility: 'ineligible', ambiguities }
  }
  if (isSummary || FISCAL_PATTERN.test(text)) {
    return { classification: 'fiscal', inventoryEligibility: 'ineligible', ambiguities }
  }
  if (LOGISTICS_PATTERN.test(text) && !SERVICE_LINE_PATTERN.test(text)) {
    return { classification: 'logistics', inventoryEligibility: 'ineligible', ambiguities }
  }

  const consumptionUnit = isServiceConsumptionUnit(normalized.unit)
  const looksLikeServiceCharge =
    SERVICE_LINE_PATTERN.test(text) ||
    SERVICE_CONSUMPTION_IN_TEXT.test(text) ||
    consumptionUnit
  if (looksLikeServiceCharge && !FOOD_PATTERN.test(text)) {
    return { classification: 'service', inventoryEligibility: 'ineligible', ambiguities }
  }
  if (EQUIPMENT_PATTERN.test(text) && !SERVICE_LINE_PATTERN.test(text)) {
    return { classification: 'expense', inventoryEligibility: 'ineligible', ambiguities }
  }
  if (ADMIN_PATTERN.test(text) && !FOOD_PATTERN.test(text)) {
    return { classification: 'expense', inventoryEligibility: 'ineligible', ambiguities }
  }

  const clearPhysicalProduct =
    FOOD_PATTERN.test(text) ||
    FOOD_CATEGORY_PATTERN.test(normalizeText(normalized.category)) ||
    (STOCK_DOCUMENT_CATEGORIES.has(normalizeText(raw.category)) &&
      normalized.quantity != null &&
      normalized.unitPrice != null)

  if (documentCategory === 'service' && clearPhysicalProduct) {
    ambiguities.push('La línea parece física, pero el documento fue clasificado como servicio.')
    return {
      classification: 'pending_review',
      inventoryEligibility: 'pending_review',
      ambiguities,
    }
  }

  if (
    clearPhysicalProduct ||
    (documentCategory === 'gastronomic_merchandise' &&
      normalized.quantity != null &&
      normalized.unitPrice != null &&
      aiStockFlag !== false &&
      !consumptionUnit)
  ) {
    const packagingMentioned = PACKAGING_PATTERN.test(text) || (normalized.packageCount ?? 0) > 0
    const hasExplicitContent =
      normalized.contentPerUnit != null && normalized.contentPerUnit > 0
    if (
      packagingMentioned &&
      normalized.unitsPerPackage == null &&
      normalized.packageCount != null &&
      !hasExplicitContent
    ) {
      ambiguities.push('Falta confirmar cuántas unidades contiene cada envase o pack.')
      return {
        classification: 'stock',
        inventoryEligibility: 'pending_review',
        ambiguities,
      }
    }
    return { classification: 'stock', inventoryEligibility: 'eligible', ambiguities }
  }

  if (documentCategory === 'service' && !clearPhysicalProduct) {
    return { classification: 'service', inventoryEligibility: 'ineligible', ambiguities }
  }

  if (aiStockFlag === true) {
    ambiguities.push('Gemini indicó stock, pero no hay señales deterministas suficientes de mercadería.')
  } else {
    ambiguities.push('No se pudo determinar de forma segura el destino de la línea.')
  }
  return {
    classification: 'pending_review',
    inventoryEligibility: 'pending_review',
    ambiguities,
  }
}

export function resolveQuantityKind(
  classification: InvoiceLineClassification,
  unit: string | null,
): InvoiceQuantityKind {
  if (classification === 'stock') return 'inventory'
  if (isServiceConsumptionUnit(unit)) return 'service_consumption'
  if (classification === 'service') return 'charge'
  return 'none'
}

export function resolveDocumentClassification(
  proposed: InvoiceDocumentClassification,
  lines: NormalizedInvoiceLine[],
  context: { documentType?: string | null } = {},
): InvoiceDocumentClassification {
  const canonical = proposed === 'public_service' ? 'service' : proposed
  const meaningful = lines.filter((line) => line.classification !== 'ignored')
  const hasStock = meaningful.some((line) => line.classification === 'stock')
  const hasService = meaningful.some((line) => line.classification === 'service')
  const hasNonStock = meaningful.some((line) =>
    ['service', 'expense', 'logistics'].includes(line.classification),
  )
  const hasPending = meaningful.some((line) => line.classification === 'pending_review')

  if (hasStock && hasNonStock) return 'mixed'
  if (hasPending && canonical !== 'ambiguous') return 'ambiguous'
  if (!hasStock && hasService && !hasPending) return 'service'
  if (
    !hasStock &&
    !hasPending &&
    isServiceDocumentType(context.documentType) &&
    meaningful.length > 0
  ) {
    return 'service'
  }
  return canonical
}

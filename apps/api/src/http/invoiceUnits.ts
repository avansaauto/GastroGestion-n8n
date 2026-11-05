import { Decimal } from 'decimal.js'
import { InvoiceQueryError } from './invoiceQueryError.js'

const UNIT_ALIASES: Record<string, string> = {
  m3: 'm3',
  'm³': 'm3',
  'm^3': 'm3',
  l: 'l',
  lt: 'l',
  lts: 'l',
  litro: 'l',
  litros: 'l',
  ml: 'ml',
  mililitro: 'ml',
  mililitros: 'ml',
  cl: 'cl',
  centilitro: 'cl',
  centilitros: 'cl',
  kg: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogramo: 'kg',
  kilogramos: 'kg',
  g: 'g',
  gr: 'g',
  grs: 'g',
  gramo: 'g',
  gramos: 'g',
  mg: 'mg',
  miligramo: 'mg',
  miligramos: 'mg',
  unit: 'unit',
  docena: 'docena',
  docenas: 'docena',
  u: 'unit',
  un: 'unit',
  uni: 'unit',
  und: 'unit',
  unid: 'unit',
  unidad: 'unit',
  unidades: 'unit',
}

const PACKAGING_UNITS = new Set([
  'caja',
  'cajas',
  'pack',
  'packs',
  'bulto',
  'bultos',
  'barril',
  'barriles',
  'bidon',
  'bidones',
  'maple',
  'cajon',
  'cajones',
  'pallet',
  'palet',
  'pieza',
  'piezas',
  'lata',
  'latas',
  'bolsa',
  'bolsas',
  'botella',
  'botellas',
  'plancha',
  'planchas',
  'barra',
  'barras',
  'horma',
  'hormas',
  'bloque',
  'bloques',
])

const MONEY_TOLERANCE = new Decimal('0.05')
/**
 * Tope relativo del desvío peso × precio.
 * La holgura de redondeo del peso (media unidad del último decimal) no puede
 * tragarse más del 1 % del importe: en un peso chico, un centésimo de kilo
 * ya es una diferencia comercial y tiene que seguir en revisión.
 */
const WEIGHT_PRICE_RELATIVE_CEILING = new Decimal('0.01')

export type InventoryBaseUnit = 'g' | 'ml' | 'unit'

export type PresentationPhysicalSuggestion = {
  commercialQuantity: number
  commercialUnit: string | null
  physicalQuantity: number
  physicalUnit: InventoryBaseUnit
  /** Unidades base de inventario por 1 unidad comercial facturada. */
  conversionFactorPerCommercialUnit: number
  source: 'content' | 'units_and_content' | 'si_unit'
}

export type InvoiceLinePricingAnalysis = {
  priceBasis: 'commercial_unit' | 'weight' | 'ambiguous'
  commercialExpectedAmount: number | null
  weightExpectedAmount: number | null
  billedWeight: number | null
  billedWeightUnit: 'kg' | 'g' | null
  amountExplainedByCommercial: boolean
  amountExplainedByWeight: boolean
  warnings: string[]
}

export function isPackagingUnit(unit: string | null | undefined): boolean {
  const key = canonicalUnit(unit)
  if (key && PACKAGING_UNITS.has(key)) return true
  if (!unit?.trim()) return false
  return unitAliasCandidates(unit).some((candidate) => PACKAGING_UNITS.has(candidate))
}

function contentToBase(
  contentAmount: number,
  contentUnit: string | null,
): { quantity: number; unit: InventoryBaseUnit } | null {
  const canonical = canonicalUnit(contentUnit)
  if (!canonical || !Number.isFinite(contentAmount) || contentAmount <= 0) return null
  if (canonical === 'kg') return { quantity: contentAmount * 1000, unit: 'g' }
  if (canonical === 'g') return { quantity: contentAmount, unit: 'g' }
  if (canonical === 'mg') return { quantity: new Decimal(contentAmount).mul('0.001').toNumber(), unit: 'g' }
  if (canonical === 'l') return { quantity: contentAmount * 1000, unit: 'ml' }
  if (canonical === 'cl') return { quantity: contentAmount * 10, unit: 'ml' }
  if (canonical === 'ml') return { quantity: contentAmount, unit: 'ml' }
  if (canonical === 'unit') return { quantity: contentAmount, unit: 'unit' }
  if (canonical === 'docena') return { quantity: contentAmount * 12, unit: 'unit' }
  return null
}

/**
 * Sugiere cantidad física de inventario a partir de presentación comercial.
 * No modifica los valores originales de la factura.
 */
export function suggestPresentationPhysical(input: {
  quantity: number | null
  unit: string | null
  packageCount: number | null
  unitsPerPackage: number | null
  contentPerUnit: number | null
  contentUnit: string | null
  /** Peso/volumen facturado total (Cant. KG). Tiene prioridad sobre content aproximado. */
  billedWeight?: number | null
  billedWeightUnit?: string | null
}): PresentationPhysicalSuggestion | null {
  const commercialQuantity =
    input.packageCount != null && input.packageCount > 0
      ? input.packageCount
      : input.quantity != null && input.quantity > 0
        ? input.quantity
        : null
  if (commercialQuantity == null) return null

  const unitsPerPackage =
    input.unitsPerPackage != null && input.unitsPerPackage > 0 ? input.unitsPerPackage : 1

  // Peso real facturado (total) > contenido aproximado de la descripción.
  if (input.billedWeight != null && input.billedWeight > 0) {
    const billedBase = contentToBase(
      input.billedWeight,
      input.billedWeightUnit ?? 'kg',
    )
    if (billedBase) {
      const conversionFactorPerCommercialUnit = new Decimal(billedBase.quantity)
        .div(commercialQuantity)
        .toDecimalPlaces(6)
        .toNumber()
      return {
        commercialQuantity,
        commercialUnit: input.unit,
        physicalQuantity: billedBase.quantity,
        physicalUnit: billedBase.unit,
        conversionFactorPerCommercialUnit,
        source: 'content',
      }
    }
  }

  if (input.contentPerUnit != null && input.contentPerUnit > 0) {
    const base = contentToBase(input.contentPerUnit, input.contentUnit)
    if (!base) return null
    const physicalQuantity = new Decimal(commercialQuantity)
      .mul(unitsPerPackage)
      .mul(base.quantity)
      .toDecimalPlaces(6)
      .toNumber()
    const conversionFactorPerCommercialUnit = new Decimal(unitsPerPackage)
      .mul(base.quantity)
      .toDecimalPlaces(6)
      .toNumber()
    return {
      commercialQuantity,
      commercialUnit: input.unit,
      physicalQuantity,
      physicalUnit: base.unit,
      conversionFactorPerCommercialUnit,
      source: unitsPerPackage > 1 ? 'units_and_content' : 'content',
    }
  }

  const invoiceCanonical = canonicalUnit(input.unit)
  // uni/u/unidad sin contenido: no inventar masa ni tratar count como “física SI”.
  const measure = invoiceCanonical ? SI_MEASURE[invoiceCanonical] : null
  if (
    measure
    && measure.family !== 'count'
    && !isPackagingUnit(input.unit)
  ) {
    const base = contentToBase(commercialQuantity, input.unit)
    if (!base) return null
    return {
      commercialQuantity,
      commercialUnit: input.unit,
      physicalQuantity: base.quantity,
      physicalUnit: base.unit,
      conversionFactorPerCommercialUnit: new Decimal(base.quantity)
        .div(commercialQuantity)
        .toDecimalPlaces(6)
        .toNumber(),
      source: 'si_unit',
    }
  }

  return null
}

function moneyClose(expected: Decimal, actual: number | null): boolean {
  if (actual == null || !Number.isFinite(actual)) return false
  return expected.minus(actual).abs().lte(MONEY_TOLERANCE)
}

/** Decimales significativos del peso ya normalizado (8,88 → 2; 8,884 → 3; 9 → 0). */
function weightDecimalPlaces(weight: Decimal): number {
  const text = weight.toDecimalPlaces(6).toFixed(6).replace(/\.?0+$/, '')
  const dot = text.indexOf('.')
  if (dot < 0) return 0
  return Math.min(3, text.length - dot - 1)
}

/**
 * El importe cierra con peso × precio.
 * $0,05 cubre el redondeo a centavos.
 * Si el peso trae decimales, también se admite el redondeo de esa cifra:
 * media unidad del último decimal × precio por kg (8,88 kg y $8.213,95/kg
 * → hasta $41,07). Ese margen tiene que cumplirse en pesos y en proporción
 * al importe, y nunca por encima del 1 %. Un peso entero no recibe margen
 * extra. No se modifica el peso ni el precio para forzar el cierre.
 */
function weightAmountClose(
  weight: Decimal,
  unitPrice: Decimal,
  amount: number,
  discount: Decimal,
): boolean {
  const expected = weight.mul(unitPrice).minus(discount)
  const difference = expected.minus(amount).abs()
  if (difference.lte(MONEY_TOLERANCE)) return true
  const places = weightDecimalPlaces(weight)
  if (places <= 0 || !weight.abs().gt(0)) return false
  const halfStep = new Decimal(10).pow(-places).div(2)
  const monetaryLimit = halfStep.mul(unitPrice.abs())
  if (difference.gt(monetaryLimit)) return false
  const basis = Decimal.max(new Decimal(amount).abs(), expected.abs(), new Decimal('0.01'))
  const relative = difference.div(basis)
  const relativeLimit = Decimal.min(WEIGHT_PRICE_RELATIVE_CEILING, halfStep.div(weight.abs()))
  return relative.lte(relativeLimit)
}

/**
 * Distingue precio por unidad comercial vs precio por peso facturado.
 * No inventa pesos ni precios: solo interpreta lo ya extraído.
 */
export function analyzeInvoiceLinePricing(input: {
  quantity: number | null
  unit: string | null
  unitPrice: number | null
  amount: number | null
  discount?: number | null
  contentPerUnit: number | null
  contentUnit: string | null
  packageCount?: number | null
  billedWeight?: number | null
  billedWeightUnit?: string | null
}): InvoiceLinePricingAnalysis {
  const warnings: string[] = []
  const discount = input.discount ?? 0
  const commercialExpected =
    input.quantity != null && input.unitPrice != null
      ? new Decimal(input.quantity).mul(input.unitPrice).minus(discount)
      : null
  const amountExplainedByCommercial =
    commercialExpected != null && moneyClose(commercialExpected, input.amount)

  const contentCanonical = canonicalUnit(input.contentUnit)
  let billedWeight: number | null = null
  let billedWeightUnit: 'kg' | 'g' | null = null

  // Preferir peso/volumen facturado explícito (Cant. KG) sobre content × qty.
  if (input.billedWeight != null && input.billedWeight > 0) {
    const explicitUnit = canonicalUnit(input.billedWeightUnit) || 'kg'
    if (explicitUnit === 'kg') {
      billedWeight = input.billedWeight
      billedWeightUnit = 'kg'
    } else if (explicitUnit === 'g') {
      billedWeight = new Decimal(input.billedWeight).div(1000).toDecimalPlaces(6).toNumber()
      billedWeightUnit = 'kg'
    }
  }

  if (
    billedWeight == null
    && input.contentPerUnit != null
    && input.contentPerUnit > 0
    && (contentCanonical === 'kg' || contentCanonical === 'g')
  ) {
    const packages =
      input.packageCount != null && input.packageCount > 0
        ? input.packageCount
        : input.quantity != null && input.quantity > 0
          ? input.quantity
          : 1
    const weightInContentUnit = new Decimal(packages).mul(input.contentPerUnit)
    if (contentCanonical === 'kg') {
      billedWeight = weightInContentUnit.toDecimalPlaces(6).toNumber()
      billedWeightUnit = 'kg'
    } else {
      billedWeight = weightInContentUnit.div(1000).toDecimalPlaces(6).toNumber()
      billedWeightUnit = 'kg'
    }
  } else if (
    billedWeight == null
    && canonicalUnit(input.unit) === 'kg'
    && input.quantity != null
    && input.quantity > 0
  ) {
    billedWeight = input.quantity
    billedWeightUnit = 'kg'
  }

  const weightExpected =
    billedWeight != null && input.unitPrice != null
      ? new Decimal(billedWeight).mul(input.unitPrice).minus(discount)
      : null
  const amountExplainedByWeight =
    weightExpected != null
    && input.amount != null
    && billedWeight != null
    && input.unitPrice != null
    && weightAmountClose(
      new Decimal(billedWeight),
      new Decimal(input.unitPrice),
      input.amount,
      new Decimal(discount),
    )

  const packaging = isPackagingUnit(input.unit)
  let priceBasis: InvoiceLinePricingAnalysis['priceBasis'] = 'ambiguous'

  if (amountExplainedByWeight && !amountExplainedByCommercial) {
    // Ej. 1 plancha × $/kg con peso facturado: la cantidad comercial no explica el importe.
    priceBasis = 'weight'
    if (packaging) {
      warnings.push(
        'El precio unitario explica el importe por peso facturado, no por la unidad comercial (pieza/plancha/pack).',
      )
    }
  } else if (amountExplainedByCommercial) {
    // Incluye packs/barras cuyo precio es de la presentación (no $/kg), aunque exista peso de contenido.
    priceBasis = 'commercial_unit'
  } else if (amountExplainedByWeight) {
    priceBasis = 'weight'
  } else {
    priceBasis = 'ambiguous'
    if (commercialExpected != null && input.amount != null) {
      warnings.push(
        'Cantidad × precio no coincide con el importe; revisá peso facturado o precio unitario sin inventar valores.',
      )
    }
    if (weightExpected != null && input.amount != null && !amountExplainedByWeight) {
      warnings.push(
        'Peso facturado × precio no explica el importe exacto; se requiere revisión del peso o del precio.',
      )
    }
  }

  // No forzar ambiguous cuando qty=1 y precio = importe de la presentación
  // (barra/bolsa/pack): es comercial legítimo aunque el contenido esté en kg.
  // El caso $/kg real ya queda en priceBasis=weight cuando el importe
  // no cierra con cantidad comercial × precio.

  return {
    priceBasis,
    commercialExpectedAmount:
      commercialExpected == null ? null : commercialExpected.toDecimalPlaces(2).toNumber(),
    weightExpectedAmount:
      weightExpected == null ? null : weightExpected.toDecimalPlaces(2).toNumber(),
    billedWeight,
    billedWeightUnit,
    amountExplainedByCommercial,
    amountExplainedByWeight,
    warnings,
  }
}

type UnitFamily = 'volume' | 'mass' | 'count'

const SI_MEASURE: Record<string, { family: UnitFamily; toBase: Decimal }> = {
  l: { family: 'volume', toBase: new Decimal(1000) },
  cl: { family: 'volume', toBase: new Decimal(10) },
  ml: { family: 'volume', toBase: new Decimal(1) },
  m3: { family: 'volume', toBase: new Decimal(1_000_000) },
  kg: { family: 'mass', toBase: new Decimal(1000) },
  g: { family: 'mass', toBase: new Decimal(1) },
  mg: { family: 'mass', toBase: new Decimal('0.001') },
  unit: { family: 'count', toBase: new Decimal(1) },
  docena: { family: 'count', toBase: new Decimal(12) },
}

export type PhysicalConversionLookup =
  | { kind: 'known'; factor: Decimal }
  | { kind: 'incompatible' }
  | { kind: 'equivalence_required' }

function normalizeUnitKey(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function unitAliasCandidates(unit: string): string[] {
  const raw = normalizeUnitKey(unit)
  const glosses = [...raw.matchAll(/\(([^)]+)\)/g)].map((match) => normalizeUnitKey(match[1]))
  const stripped = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const tokens = stripped.split(/[\s/,]+/).filter(Boolean)
  return [...new Set([raw, stripped, ...tokens, ...glosses].filter(Boolean))]
}

export function canonicalUnit(unit: string | null | undefined): string {
  if (!unit?.trim()) return ''
  for (const key of unitAliasCandidates(unit)) {
    const alias = UNIT_ALIASES[key]
    if (alias) return alias
  }
  return unitAliasCandidates(unit).find((key) => !/[\s(]/.test(key)) ?? ''
}

export function unitsAreEquivalent(
  invoiceUnit: string | null | undefined,
  inventoryUnit: string | null | undefined,
): boolean {
  const left = canonicalUnit(invoiceUnit)
  const right = canonicalUnit(inventoryUnit)
  return Boolean(left && right && left === right)
}

export function lookupPhysicalConversion(
  invoiceUnit: string | null | undefined,
  inventoryUnit: string | null | undefined,
): PhysicalConversionLookup {
  const from = canonicalUnit(invoiceUnit)
  const to = canonicalUnit(inventoryUnit)
  if (!to) return { kind: 'incompatible' }
  // Sin unidad extraída: solo una equivalencia explícita, nunca una conversión SI inventada.
  if (!from) {
    if (to === 'g' || to === 'ml' || to === 'unit') return { kind: 'equivalence_required' }
    return { kind: 'incompatible' }
  }
  if (from === to) return { kind: 'known', factor: new Decimal(1) }
  if (PACKAGING_UNITS.has(from) || PACKAGING_UNITS.has(to)) {
    return { kind: 'equivalence_required' }
  }
  const fromMeasure = SI_MEASURE[from]
  const toMeasure = SI_MEASURE[to]
  if (fromMeasure?.family === 'count' && toMeasure?.family === 'count') {
    const factor = fromMeasure.toBase.div(toMeasure.toBase)
    if (!factor.isFinite() || factor.lte(0)) return { kind: 'incompatible' }
    return { kind: 'known', factor }
  }
  if (from === 'unit' || to === 'unit') {
    return { kind: 'equivalence_required' }
  }
  if (!fromMeasure || !toMeasure || fromMeasure.family !== toMeasure.family) {
    return { kind: 'incompatible' }
  }
  const factor = fromMeasure.toBase.div(toMeasure.toBase)
  if (!factor.isFinite() || factor.lte(0)) return { kind: 'incompatible' }
  return { kind: 'known', factor }
}

export function documentLineQuantity(line: {
  reviewed: { quantity: number | null }
  original: { quantity: number | null }
}): number | null {
  if (line.reviewed.quantity != null) return line.reviewed.quantity
  return line.original.quantity
}

export function documentLineUnit(line: {
  reviewed: { unit: string | null }
  original: { unit: string | null }
}): string | null {
  return line.reviewed.unit || line.original.unit
}

export function documentLineAmount(line: {
  reviewed: { amount: number | null }
  original: { amount: number | null }
}): number {
  return line.reviewed.amount ?? line.original.amount ?? 0
}

function throwConversionFailure(lookup: Exclude<PhysicalConversionLookup, { kind: 'known' }>): never {
  if (lookup.kind === 'equivalence_required') {
    throw new InvoiceQueryError(
      'Indicá cuántas unidades base del inventario equivalen a 1 unidad de la factura (caja, pack, pieza…).',
      'EQUIVALENCE_REQUIRED',
      422,
    )
  }
  throw new InvoiceQueryError(
    'No se puede convertir esa unidad de la factura a la unidad del inventario.',
    'INCOMPATIBLE_UNITS',
    422,
  )
}

function factorsMatch(known: Decimal, client: number): boolean {
  return known.toDecimalPlaces(6).eq(new Decimal(client).toDecimalPlaces(6))
}

function assertPositiveFactor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvoiceQueryError(
      'El factor de conversión debe ser un número mayor a cero.',
      'INVALID_CONVERSION',
      422,
    )
  }
  return new Decimal(value).toDecimalPlaces(6).toNumber()
}

export function resolveConversionFactor(input: {
  invoiceUnit: string | null
  inventoryUnit: string | null
  conversionFactor: number | null
}): number {
  const lookup = lookupPhysicalConversion(input.invoiceUnit, input.inventoryUnit)

  if (lookup.kind === 'equivalence_required') {
    if (input.conversionFactor == null) throwConversionFailure(lookup)
    return assertPositiveFactor(input.conversionFactor)
  }

  if (lookup.kind !== 'known') throwConversionFailure(lookup)

  if (input.conversionFactor != null) {
    const clientFactor = assertPositiveFactor(input.conversionFactor)
    if (!factorsMatch(lookup.factor, clientFactor)) {
      throw new InvoiceQueryError(
        'El factor de conversión no coincide con la conversión conocida entre esas unidades.',
        'INVALID_CONVERSION',
        422,
      )
    }
    return clientFactor
  }

  return lookup.factor.toDecimalPlaces(6).toNumber()
}

export function computePhysicalQuantity(invoiceQuantity: number, conversionFactor: number): number {
  if (!Number.isFinite(invoiceQuantity) || invoiceQuantity <= 0) {
    throw new InvoiceQueryError(
      'La cantidad de la línea no permite una equivalencia física.',
      'INVALID_QUANTITY',
      422,
    )
  }
  const physical = new Decimal(invoiceQuantity).mul(conversionFactor)
  if (!physical.isFinite() || physical.lte(0)) {
    throw new InvoiceQueryError(
      'La cantidad física equivalente no es válida.',
      'INVALID_CONVERSION',
      422,
    )
  }
  return physical.toDecimalPlaces(6).toNumber()
}

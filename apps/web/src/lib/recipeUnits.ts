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
  unit: 'unit',
  u: 'unit',
  un: 'unit',
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
])

type UnitFamily = 'volume' | 'mass' | 'count'

const SI_MEASURE: Record<string, { family: UnitFamily; toBase: number }> = {
  l: { family: 'volume', toBase: 1000 },
  ml: { family: 'volume', toBase: 1 },
  m3: { family: 'volume', toBase: 1_000_000 },
  kg: { family: 'mass', toBase: 1000 },
  g: { family: 'mass', toBase: 1 },
  unit: { family: 'count', toBase: 1 },
}

export type PhysicalConversionLookup =
  | { kind: 'known'; factor: number }
  | { kind: 'incompatible' }
  | { kind: 'equivalence_required' }

export type QuantityConversion =
  | { kind: 'ok'; quantity: number; baseUnit: string }
  | { kind: 'incompatible' }
  | { kind: 'equivalence_required' }
  | { kind: 'invalid' }

function normalizeUnitKey(unit: string) {
  return unit
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function unitAliasCandidates(unit: string) {
  const raw = normalizeUnitKey(unit)
  const glosses = [...raw.matchAll(/\(([^)]+)\)/g)].map((match) => normalizeUnitKey(match[1]))
  const stripped = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const tokens = stripped.split(/[\s/,]+/).filter(Boolean)
  return [...new Set([raw, stripped, ...tokens, ...glosses].filter(Boolean))]
}

export function canonicalUnit(unit: string | null | undefined) {
  if (!unit?.trim()) return ''
  for (const key of unitAliasCandidates(unit)) {
    const alias = UNIT_ALIASES[key]
    if (alias) return alias
  }
  return unitAliasCandidates(unit).find((key) => !/[\s(]/.test(key)) ?? ''
}

export function lookupPhysicalConversion(
  fromUnit: string | null | undefined,
  toUnit: string | null | undefined,
): PhysicalConversionLookup {
  const from = canonicalUnit(fromUnit)
  const to = canonicalUnit(toUnit)
  if (!from || !to) return { kind: 'incompatible' }
  if (from === to) return { kind: 'known', factor: 1 }
  if (PACKAGING_UNITS.has(from) || PACKAGING_UNITS.has(to)) {
    return { kind: 'equivalence_required' }
  }
  const fromMeasure = SI_MEASURE[from]
  const toMeasure = SI_MEASURE[to]
  if (!fromMeasure || !toMeasure || fromMeasure.family !== toMeasure.family) {
    return { kind: 'incompatible' }
  }
  const factor = fromMeasure.toBase / toMeasure.toBase
  if (!Number.isFinite(factor) || factor <= 0) return { kind: 'incompatible' }
  return { kind: 'known', factor }
}

function roundQuantity(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function convertQuantityToBase(
  quantity: number,
  fromUnit: string | null | undefined,
  baseUnit: string | null | undefined,
): QuantityConversion {
  if (!Number.isFinite(quantity) || !(quantity > 0)) return { kind: 'invalid' }
  const canonicalBase = canonicalUnit(baseUnit)
  if (!canonicalBase) return { kind: 'incompatible' }
  const lookup = lookupPhysicalConversion(fromUnit, canonicalBase)
  if (lookup.kind !== 'known') return lookup
  return {
    kind: 'ok',
    quantity: roundQuantity(quantity * lookup.factor),
    baseUnit: canonicalBase,
  }
}

export type RecipePresentationConversionInput = {
  quantity: number
  fromUnit: string | null | undefined
  baseUnit: string | null | undefined
  presentationUnit?: string | null
  conversionFactor?: number | null
  /** false → solo unidad comercial entera; null/true → también g/ml parcial. */
  divisible?: boolean | null
}

function isPresentationCountUnit(unit: string | null | undefined) {
  const key = canonicalUnit(unit)
  return key === 'unit'
}

/**
 * Convierte cantidad de receta a unidad base del insumo.
 * Con factor comercial (u → g/ml): 1 u × 330 = 330 ml; 60 ml queda en base.
 */
export function convertRecipeQuantityToBase(
  input: RecipePresentationConversionInput,
): QuantityConversion {
  if (!Number.isFinite(input.quantity) || !(input.quantity > 0)) return { kind: 'invalid' }
  const canonicalBase = canonicalUnit(input.baseUnit)
  if (!canonicalBase) return { kind: 'incompatible' }

  const from = canonicalUnit(input.fromUnit) || canonicalBase
  const factor = input.conversionFactor
  const hasFactor = factor != null && Number.isFinite(factor) && factor > 0
  const presentationIsUnit = isPresentationCountUnit(input.presentationUnit ?? 'u')
  const allowPartial = input.divisible !== false

  // Consumo en unidades comerciales con contenido medible → base física.
  if (hasFactor && presentationIsUnit && isPresentationCountUnit(from) && (canonicalBase === 'g' || canonicalBase === 'ml')) {
    if (Math.abs(input.quantity - Math.round(input.quantity)) >= 1e-9) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'ok',
      quantity: roundQuantity(input.quantity * Number(factor)),
      baseUnit: canonicalBase,
    }
  }

  // Parcial en g/ml sobre insumo con presentación.
  if (hasFactor && presentationIsUnit && (from === 'g' || from === 'kg' || from === 'ml' || from === 'l')) {
    if (!allowPartial) return { kind: 'incompatible' }
    return convertQuantityToBase(input.quantity, from, canonicalBase)
  }

  return convertQuantityToBase(input.quantity, from, canonicalBase)
}

export function inputUnitsForBase(baseUnit: string | null | undefined) {
  const canonical = canonicalUnit(baseUnit)
  if (canonical === 'l' || canonical === 'ml') {
    return [
      { value: 'ml', label: 'ml' },
      { value: 'l', label: 'l' },
    ]
  }
  if (canonical === 'g' || canonical === 'kg') {
    return [
      { value: 'g', label: 'g' },
      { value: 'kg', label: 'kg' },
    ]
  }
  if (canonical === 'unit') return [{ value: 'unit', label: 'u' }]
  if (canonical) return [{ value: canonical, label: canonical }]
  return []
}

export function inputUnitsForInventoryProduct(product: {
  baseUnit?: string | null
  presentationUnit?: string | null
  conversionFactor?: number | null
  divisible?: boolean | null
}) {
  const factor = product.conversionFactor
  const hasFactor = factor != null && Number.isFinite(factor) && factor > 0
  const presentationIsUnit = isPresentationCountUnit(product.presentationUnit ?? '')
  const base = canonicalUnit(product.baseUnit)
  const allowPartial = product.divisible !== false

  if (hasFactor && presentationIsUnit && (base === 'g' || base === 'ml')) {
    const units = [{ value: 'unit', label: 'u' }]
    if (allowPartial) {
      if (base === 'ml') {
        units.push({ value: 'ml', label: 'ml' }, { value: 'l', label: 'L' })
      } else {
        units.push({ value: 'g', label: 'g' }, { value: 'kg', label: 'kg' })
      }
    }
    return units
  }

  return inputUnitsForBase(product.baseUnit)
}

export function defaultInputUnit(
  baseUnit: string | null | undefined,
  product?: {
    presentationUnit?: string | null
    conversionFactor?: number | null
  },
) {
  const factor = product?.conversionFactor
  const hasFactor = factor != null && Number.isFinite(factor) && factor > 0
  if (hasFactor && isPresentationCountUnit(product?.presentationUnit ?? 'u')) {
    return 'unit'
  }
  return canonicalUnit(baseUnit) || inputUnitsForBase(baseUnit)[0]?.value || ''
}

export function formatRecipeQuantity(quantity: number, unit: string) {
  const amount = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 6 }).format(quantity)
  return `${amount} ${unit}`
}

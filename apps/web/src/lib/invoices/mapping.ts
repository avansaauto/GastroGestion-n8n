import type { InvoiceAnalysisLine, InvoiceStoredLine } from './types'

const EXCLUDED_CLASSIFICATIONS = new Set(['fiscal', 'service', 'ignored', 'expense', 'logistics'])
const EXCLUDED_QUANTITY_KINDS = new Set(['service_consumption', 'charge', 'none'])

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
  // Alineado con apps/api/src/http/invoiceUnits.ts
  'plancha',
  'planchas',
  'barra',
  'barras',
  'horma',
  'hormas',
  'bloque',
  'bloques',
])

type UnitFamily = 'volume' | 'mass' | 'count'

const SI_TO_BASE: Record<string, { family: UnitFamily; toBase: number }> = {
  l: { family: 'volume', toBase: 1000 },
  cl: { family: 'volume', toBase: 10 },
  ml: { family: 'volume', toBase: 1 },
  m3: { family: 'volume', toBase: 1_000_000 },
  kg: { family: 'mass', toBase: 1000 },
  g: { family: 'mass', toBase: 1 },
  mg: { family: 'mass', toBase: 0.001 },
  unit: { family: 'count', toBase: 1 },
  docena: { family: 'count', toBase: 12 },
}

export type PhysicalConversion =
  | { ok: true; factor: number }
  | { ok: false; code: 'INCOMPATIBLE_UNITS' | 'EQUIVALENCE_REQUIRED' }

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

export function resolvePhysicalConversion(
  invoiceUnit: string | null | undefined,
  inventoryUnit: string | null | undefined,
): PhysicalConversion {
  const from = canonicalUnit(invoiceUnit)
  const to = canonicalUnit(inventoryUnit)
  if (!to) return { ok: false, code: 'INCOMPATIBLE_UNITS' }
  // Sin unidad extraída: solo vale una equivalencia física explícita.
  if (!from) {
    if (to === 'g' || to === 'ml' || to === 'unit') return { ok: false, code: 'EQUIVALENCE_REQUIRED' }
    return { ok: false, code: 'INCOMPATIBLE_UNITS' }
  }
  if (from === to) return { ok: true, factor: 1 }
  if (PACKAGING_UNITS.has(from) || PACKAGING_UNITS.has(to)) {
    return { ok: false, code: 'EQUIVALENCE_REQUIRED' }
  }
  const fromMeasure = SI_TO_BASE[from]
  const toMeasure = SI_TO_BASE[to]
  if (fromMeasure?.family === 'count' && toMeasure?.family === 'count') {
    const factor = fromMeasure.toBase / toMeasure.toBase
    if (!Number.isFinite(factor) || factor <= 0) return { ok: false, code: 'INCOMPATIBLE_UNITS' }
    return { ok: true, factor: Number(factor.toFixed(6)) }
  }
  // "u"/"uni" comercial → g/ml: no es conversión SI; pedir/usar factor físico.
  if (from === 'unit' || to === 'unit') {
    return { ok: false, code: 'EQUIVALENCE_REQUIRED' }
  }
  if (!fromMeasure || !toMeasure || fromMeasure.family !== toMeasure.family) {
    return { ok: false, code: 'INCOMPATIBLE_UNITS' }
  }
  const factor = fromMeasure.toBase / toMeasure.toBase
  if (!Number.isFinite(factor) || factor <= 0) return { ok: false, code: 'INCOMPATIBLE_UNITS' }
  return { ok: true, factor: Number(factor.toFixed(6)) }
}

export function lineQuantity(line: InvoiceStoredLine): number | null {
  return line.reviewed.quantity ?? line.original.quantity
}

export function lineUnit(line: InvoiceStoredLine): string | null {
  return line.reviewed.unit || line.original.unit
}

export function lineDescription(line: InvoiceStoredLine): string {
  return line.reviewed.description || line.original.description || '—'
}

export function lineAmount(line: InvoiceStoredLine): number {
  return line.reviewed.amount ?? line.original.amount ?? 0
}

export const LINE_ASSOCIATION_MISSING =
  'No hay una línea guardada asociada. No se puede vincular ni recibir.'

export function storedLineForAnalysis(
  analysisLine: Pick<InvoiceAnalysisLine, 'id'>,
  stored: InvoiceStoredLine[],
): InvoiceStoredLine | undefined {
  const sourceLineId = analysisLine.id.trim()
  if (!sourceLineId) return undefined
  const matches = stored.filter((line) => line.sourceLineId === sourceLineId)
  return matches.length === 1 ? matches[0] : undefined
}

export function isInventoriableAnalysisLine(line: InvoiceAnalysisLine): boolean {
  // Solo eligible: pending_review de bonificación/relación comercial debe bloquear
  // stock hasta confirmar. Precio ambiguo con física conocida queda eligible vía API.
  if (line.inventoryEligibility !== 'eligible') return false
  if (EXCLUDED_CLASSIFICATIONS.has(line.classification)) return false
  if (EXCLUDED_QUANTITY_KINDS.has(line.quantityKind)) return false
  if ((line.amount ?? 0) < 0) return false
  return true
}

export function isInventoriableLine(line: InvoiceStoredLine): boolean {
  if (line.inventoryEligibility !== 'eligible') return false
  if (line.mappingStatus === 'not_applicable') return false
  if (line.classification && EXCLUDED_CLASSIFICATIONS.has(line.classification)) return false
  if (line.quantityKind && EXCLUDED_QUANTITY_KINDS.has(line.quantityKind)) return false
  if (lineAmount(line) < 0) return false
  return true
}

export function mappingSummary(lines: InvoiceStoredLine[]) {
  let mapped = 0
  let pending = 0
  let excluded = 0
  for (const line of lines) {
    if (!isInventoriableLine(line)) {
      excluded += 1
      continue
    }
    if (line.mappingStatus === 'mapped') mapped += 1
    else pending += 1
  }
  return { mapped, pending, excluded }
}

export function previewPhysicalQuantity(
  invoiceQuantity: number | null,
  conversionFactor: number,
): number | null {
  if (invoiceQuantity == null || invoiceQuantity <= 0 || !Number.isFinite(conversionFactor) || conversionFactor <= 0) {
    return null
  }
  return Number((invoiceQuantity * conversionFactor).toFixed(6))
}

export function conversionMessage(code: 'INCOMPATIBLE_UNITS' | 'EQUIVALENCE_REQUIRED'): string {
  if (code === 'EQUIVALENCE_REQUIRED') {
    return 'Indicá cuántas unidades base del inventario equivalen a 1 unidad de la factura (caja, pack, pieza…).'
  }
  return 'No se puede convertir esa unidad de la factura a la unidad del inventario.'
}

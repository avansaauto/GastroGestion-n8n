/**
 * Formulario universal «Crear insumo».
 *
 * Unidades de UI: u | g | kg | ml | L.
 * Unidades persistidas (CHECK inventory_products.base_unit): unit | g | ml.
 *
 * - g/kg → base g; ml/L → base ml; u sin contenido → base unit.
 * - u + contenido medible → base g|ml = unidades × contenido (permite consumo parcial).
 * No mezcla masa y volumen. No inventa costos.
 */

export const CREATE_STOCK_UNITS = [
  { value: 'u', label: 'Unidad (u)' },
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
  { value: 'ml', label: 'ml' },
  { value: 'L', label: 'L' },
] as const

export type CreateStockUnit = (typeof CREATE_STOCK_UNITS)[number]['value']

export const CREATE_CONTENT_UNITS = [
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
  { value: 'ml', label: 'ml' },
  { value: 'L', label: 'L' },
] as const

export type CreateContentUnit = (typeof CREATE_CONTENT_UNITS)[number]['value']

export type InventoryStoredBaseUnit = 'g' | 'ml' | 'unit'

export type ResolvedCreateInsumo = {
  baseUnit: InventoryStoredBaseUnit
  /** Cantidad física a registrar como stock inicial (ajuste), o null si vacío. */
  initialPhysical: number | null
  /** Stock mínimo en unidad base, o null si vacío. */
  minimumPhysical: number | null
  /** Contenido físico por 1 u (solo si se declaró); null si no aplica. */
  contentPerUnitPhysical: number | null
  contentBaseUnit: 'g' | 'ml' | null
  /**
   * Presentación comercial a persistir (mismo sentido que conversionFactor
   * de mapping memory de facturas). Null si no hay contenido por unidad.
   */
  presentationUnit: 'u' | null
  conversionFactor: number | null
}

export type ResolveCreateInsumoInput = {
  stockUnit: string
  initialStock: string
  minimumStock: string
  /** true cuando el usuario abre y completa «Contenido por unidad». */
  contentEnabled?: boolean
  contentQuantity?: string
  contentUnit?: string
}

type ResolveOk = { ok: true; value: ResolvedCreateInsumo }
type ResolveErr = { ok: false; error: string }

const STOCK_UNIT_SET = new Set<string>(CREATE_STOCK_UNITS.map((u) => u.value))
const CONTENT_UNIT_SET = new Set<string>(CREATE_CONTENT_UNITS.map((u) => u.value))

function roundPhysical(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function parseNonNegative(raw: string, fieldLabel: string): { ok: true; value: number | null } | ResolveErr {
  const trimmed = raw.trim().replace(',', '.')
  if (!trimmed) return { ok: true, value: null }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: `Indicá un ${fieldLabel} válido.` }
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: `Indicá un ${fieldLabel} válido.` }
  }
  return { ok: true, value }
}

function parsePositive(raw: string, fieldLabel: string): { ok: true; value: number } | ResolveErr {
  const parsed = parseNonNegative(raw, fieldLabel)
  if (!parsed.ok) return parsed
  if (parsed.value == null || parsed.value <= 0) {
    return { ok: false, error: `Indicá un ${fieldLabel} válido.` }
  }
  return { ok: true, value: parsed.value }
}

/** Factor hacia unidad base de inventario (g o ml). */
export function factorToStoredBase(unit: string): { base: 'g' | 'ml'; factor: number } | null {
  const key = unit.trim()
  if (key === 'g') return { base: 'g', factor: 1 }
  if (key === 'kg') return { base: 'g', factor: 1000 }
  if (key === 'ml') return { base: 'ml', factor: 1 }
  if (key === 'L' || key === 'l') return { base: 'ml', factor: 1000 }
  return null
}

export function showsContentPerUnitSection(stockUnit: string) {
  return stockUnit === 'u'
}

export function stockUnitLabel(stockUnit: string) {
  return CREATE_STOCK_UNITS.find((row) => row.value === stockUnit)?.label ?? stockUnit
}

/**
 * Convierte cantidad expresada en unidad de stock de UI → unidad física almacenada.
 * Para u sin contenido, la cantidad ya está en `unit`.
 */
export function quantityToStoredPhysical(
  quantity: number,
  stockUnit: string,
  content?: { quantity: number; unit: string } | null,
): { ok: true; baseUnit: InventoryStoredBaseUnit; physical: number; contentPerUnitPhysical: number | null; contentBaseUnit: 'g' | 'ml' | null }
  | ResolveErr {
  if (!STOCK_UNIT_SET.has(stockUnit) && stockUnit !== 'unit') {
    return { ok: false, error: 'Elegí una unidad de medida válida.' }
  }

  const normalizedStock = stockUnit === 'unit' ? 'u' : stockUnit

  if (normalizedStock === 'u') {
    if (!content) {
      return {
        ok: true,
        baseUnit: 'unit',
        physical: roundPhysical(quantity),
        contentPerUnitPhysical: null,
        contentBaseUnit: null,
      }
    }
    if (!CONTENT_UNIT_SET.has(content.unit) && content.unit !== 'l') {
      return { ok: false, error: 'Elegí una unidad de contenido válida (g, kg, ml o L).' }
    }
    const mapped = factorToStoredBase(content.unit)
    if (!mapped) {
      return { ok: false, error: 'Elegí una unidad de contenido válida (g, kg, ml o L).' }
    }
    if (!(content.quantity > 0)) {
      return { ok: false, error: 'Indicá la cantidad de contenido por unidad.' }
    }
    const contentPerUnitPhysical = roundPhysical(content.quantity * mapped.factor)
    return {
      ok: true,
      baseUnit: mapped.base,
      physical: roundPhysical(quantity * contentPerUnitPhysical),
      contentPerUnitPhysical,
      contentBaseUnit: mapped.base,
    }
  }

  const mapped = factorToStoredBase(normalizedStock)
  if (!mapped) {
    return { ok: false, error: 'Elegí una unidad de medida válida.' }
  }
  return {
    ok: true,
    baseUnit: mapped.base,
    physical: roundPhysical(quantity * mapped.factor),
    contentPerUnitPhysical: null,
    contentBaseUnit: null,
  }
}

export function resolveCreateInsumoQuantities(input: ResolveCreateInsumoInput): ResolveOk | ResolveErr {
  const stockUnit = input.stockUnit.trim()
  if (!STOCK_UNIT_SET.has(stockUnit)) {
    return { ok: false, error: 'Elegí una unidad de medida válida.' }
  }

  const initial = parseNonNegative(input.initialStock, 'stock inicial')
  if (!initial.ok) return initial
  const minimum = parseNonNegative(input.minimumStock, 'stock mínimo')
  if (!minimum.ok) return minimum

  let content: { quantity: number; unit: string } | null = null
  if (showsContentPerUnitSection(stockUnit) && input.contentEnabled) {
    const qty = parsePositive(input.contentQuantity ?? '', 'contenido por unidad')
    if (!qty.ok) return qty
    const unit = (input.contentUnit ?? '').trim() || 'ml'
    if (!CONTENT_UNIT_SET.has(unit)) {
      return { ok: false, error: 'Elegí una unidad de contenido válida (g, kg, ml o L).' }
    }
    content = { quantity: qty.value, unit }
  }

  // Resolver con cantidad 1 para conocer base; luego escalar initial/min.
  const probe = quantityToStoredPhysical(1, stockUnit, content)
  if (!probe.ok) return probe

  let initialPhysical: number | null = null
  if (initial.value != null) {
    const converted = quantityToStoredPhysical(initial.value, stockUnit, content)
    if (!converted.ok) return converted
    if (converted.baseUnit !== probe.baseUnit) {
      return { ok: false, error: 'No se puede mezclar masa y volumen en el mismo insumo.' }
    }
    initialPhysical = converted.physical
  }

  let minimumPhysical: number | null = null
  if (minimum.value != null) {
    const converted = quantityToStoredPhysical(minimum.value, stockUnit, content)
    if (!converted.ok) return converted
    if (converted.baseUnit !== probe.baseUnit) {
      return { ok: false, error: 'No se puede mezclar masa y volumen en el mismo insumo.' }
    }
    minimumPhysical = converted.physical
  }

  const hasPresentation = probe.contentPerUnitPhysical != null && probe.contentPerUnitPhysical > 0

  return {
    ok: true,
    value: {
      baseUnit: probe.baseUnit,
      initialPhysical,
      minimumPhysical,
      contentPerUnitPhysical: probe.contentPerUnitPhysical,
      contentBaseUnit: probe.contentBaseUnit,
      presentationUnit: hasPresentation ? 'u' : null,
      conversionFactor: hasPresentation ? probe.contentPerUnitPhysical : null,
    },
  }
}

/** Convierte cantidad en presentación comercial → unidad base usando el factor persistido. */
export function physicalFromPresentationUnits(
  presentationQuantity: number,
  conversionFactor: number | null | undefined,
): number | null {
  if (!Number.isFinite(presentationQuantity) || presentationQuantity === 0) return null
  if (conversionFactor == null || !(conversionFactor > 0)) return null
  return roundPhysical(presentationQuantity * conversionFactor)
}

export const INITIAL_STOCK_ADJUST_REASON = 'Stock inicial'

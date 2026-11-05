import { canonicalUnit } from './mapping'
import { formatMoney, formatQuantity, formatUnit } from './review'

export type ComprehensibleUnit = 'kg' | 'g' | 'L' | 'ml' | 'unidades'

const MASS_QUESTION = '¿Cuántos kg trae cada'
const VOLUME_QUESTION = '¿Cuántos litros contiene cada'
const COUNT_QUESTION = '¿Cuántas unidades trae cada'

function commercialNoun(unit: string | null | undefined): string {
  const canonical = canonicalUnit(unit)
  if (!canonical || canonical === 'unit') return 'unidad'
  const label = formatUnit(unit)
  if (label === 'u' || label === 'unidades' || label === '—') return 'unidad'
  return label
}

/** Pregunta de presentación. Null si la unidad del insumo no admite contenido. */
export function presentationQuestion(
  commercialUnit: string | null | undefined,
  baseUnit: string | null | undefined,
): string | null {
  const base = canonicalUnit(baseUnit)
  const noun = commercialNoun(commercialUnit)
  if (base === 'g' || base === 'kg') return `${MASS_QUESTION} ${noun}?`
  if (base === 'ml' || base === 'l') return `${VOLUME_QUESTION} ${noun}?`
  if (base === 'unit') return `${COUNT_QUESTION} ${noun}?`
  return null
}

export function parsePresentationAnswer(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.')
  if (!normalized) return null
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

/**
 * Convierte la respuesta de presentación a factor interno (unidades base por
 * cada unidad comercial). No se muestra ese número.
 */
export function factorFromPresentationAnswer(
  answer: number,
  baseUnit: string | null | undefined,
): number | null {
  if (!Number.isFinite(answer) || answer <= 0) return null
  const base = canonicalUnit(baseUnit)
  if (base === 'g' || base === 'ml') return Number((answer * 1000).toFixed(6))
  if (base === 'kg' || base === 'l' || base === 'unit') return Number(answer.toFixed(6))
  return null
}

export function comprehensibleQuantity(
  physical: number,
  baseUnit: string | null | undefined,
): { value: number; unit: ComprehensibleUnit } | null {
  if (!Number.isFinite(physical) || physical <= 0) return null
  const base = canonicalUnit(baseUnit)
  if (base === 'g') {
    if (physical >= 1000) return { value: physical / 1000, unit: 'kg' }
    return { value: physical, unit: 'g' }
  }
  if (base === 'kg') return { value: physical, unit: 'kg' }
  if (base === 'ml') {
    if (physical >= 1000) return { value: physical / 1000, unit: 'L' }
    return { value: physical, unit: 'ml' }
  }
  if (base === 'l') return { value: physical, unit: 'L' }
  if (base === 'unit') return { value: physical, unit: 'unidades' }
  return null
}

export function formatComprehensibleQuantity(
  physical: number,
  baseUnit: string | null | undefined,
): string | null {
  const shown = comprehensibleQuantity(physical, baseUnit)
  if (!shown) return null
  if (shown.unit === 'unidades' && shown.value === 1) return '1 unidad'
  return `${formatQuantity(shown.value)} ${shown.unit}`
}

export function physicalResultLabel(
  physical: number,
  baseUnit: string | null | undefined,
  lineAmount: number | null,
): string | null {
  const shown = comprehensibleQuantity(physical, baseUnit)
  const quantity = formatComprehensibleQuantity(physical, baseUnit)
  if (!shown || !quantity) return null
  if (lineAmount == null || !Number.isFinite(lineAmount) || lineAmount < 0) return quantity
  const perDisplay = lineAmount / shown.value
  if (!Number.isFinite(perDisplay)) return quantity
  const unit = shown.unit === 'unidades' ? 'unidad' : shown.unit
  return `${quantity} · ${formatMoney(perDisplay)}/${unit}`
}

/** Espejo de senda_assert_presentation_coherence / senda_normalize_presentation_unit. */

export type PresentationCoherenceInput = {
  baseUnit: string | null | undefined
  presentationUnit: string | null | undefined
  conversionFactor: number | null | undefined
  divisible: boolean | null | undefined
}

export function normalizePresentationUnit(unit: string | null | undefined): 'u' | string | null {
  const key = (unit ?? '').trim().toLowerCase()
  if (!key) return null
  if (['u', 'unit', 'unidad', 'unidades', 'un', 'unid'].includes(key)) return 'u'
  return key
}

export function assertPresentationCoherence(
  input: PresentationCoherenceInput,
): { ok: true } | { ok: false; code: 'INVALID_PRESENTATION' | 'INVALID_CONVERSION_FACTOR' } {
  const base = (input.baseUnit ?? '').trim().toLowerCase()
  const presentation = normalizePresentationUnit(input.presentationUnit)
  const factor = input.conversionFactor
  const divisible = input.divisible

  if (presentation == null && (factor == null || factor === undefined)) {
    if (divisible != null) {
      return { ok: false, code: 'INVALID_PRESENTATION' }
    }
    return { ok: true }
  }

  if (presentation == null || factor == null) {
    return { ok: false, code: 'INVALID_PRESENTATION' }
  }
  if (!(factor > 0) || !Number.isFinite(factor)) {
    return { ok: false, code: 'INVALID_CONVERSION_FACTOR' }
  }
  if (presentation !== 'u') {
    return { ok: false, code: 'INVALID_PRESENTATION' }
  }
  if (base !== 'g' && base !== 'ml') {
    return { ok: false, code: 'INVALID_PRESENTATION' }
  }
  return { ok: true }
}

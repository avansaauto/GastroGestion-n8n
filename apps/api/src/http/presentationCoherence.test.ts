import { describe, expect, it } from 'vitest'
import { assertPresentationCoherence, normalizePresentationUnit } from './presentationCoherence.js'

describe('normalizePresentationUnit', () => {
  it('normaliza sinónimos a u', () => {
    expect(normalizePresentationUnit('unidad')).toBe('u')
    expect(normalizePresentationUnit('UNIT')).toBe('u')
    expect(normalizePresentationUnit('')).toBeNull()
  })
})

describe('assertPresentationCoherence', () => {
  it('acepta sin presentación', () => {
    expect(assertPresentationCoherence({
      baseUnit: 'ml',
      presentationUnit: null,
      conversionFactor: null,
      divisible: null,
    })).toEqual({ ok: true })
  })

  it('acepta presentación completa sobre g/ml', () => {
    expect(assertPresentationCoherence({
      baseUnit: 'ml',
      presentationUnit: 'u',
      conversionFactor: 750,
      divisible: false,
    })).toEqual({ ok: true })
  })

  it('rechaza incompleto', () => {
    expect(assertPresentationCoherence({
      baseUnit: 'ml',
      presentationUnit: 'u',
      conversionFactor: null,
      divisible: false,
    }).ok).toBe(false)
  })

  it('rechaza divisible sin presentación', () => {
    expect(assertPresentationCoherence({
      baseUnit: 'ml',
      presentationUnit: null,
      conversionFactor: null,
      divisible: false,
    })).toEqual({ ok: false, code: 'INVALID_PRESENTATION' })
  })

  it('rechaza base unit', () => {
    expect(assertPresentationCoherence({
      baseUnit: 'unit',
      presentationUnit: 'u',
      conversionFactor: 1,
      divisible: true,
    })).toEqual({ ok: false, code: 'INVALID_PRESENTATION' })
  })

  it('rechaza factor no positivo', () => {
    expect(assertPresentationCoherence({
      baseUnit: 'g',
      presentationUnit: 'u',
      conversionFactor: 0,
      divisible: true,
    })).toEqual({ ok: false, code: 'INVALID_CONVERSION_FACTOR' })
  })
})

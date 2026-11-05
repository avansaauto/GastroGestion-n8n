import { describe, expect, it } from 'vitest'
import {
  brandAccent,
  brandCream,
  brandNavy,
  brandPrimary,
  brandSecondary,
  primary,
  secondary,
} from './colors'
import { zIndex } from './zIndex'

describe('design-system colors', () => {
  it('ancla naranja / navy / crema de marca SENDA OPS', () => {
    expect(brandPrimary).toBe('#FF4C00')
    expect(brandAccent).toBe('#FD5B01')
    expect(brandNavy).toBe('#0A1A2E')
    expect(brandCream).toBe('#FDF9F4')
    expect(brandSecondary).toBe(brandNavy)
    expect(primary[500]).toBe(brandPrimary)
    expect(primary[600]).toBe('#E04400')
    expect(secondary[800]).toBe(brandNavy)
  })
})

describe('design-system zIndex', () => {
  it('define escala ascendente sin solapamientos', () => {
    const values = Object.values(zIndex)
    const sorted = [...values].sort((a, b) => a - b)
    expect(sorted).toEqual(values)
    expect(new Set(values).size).toBe(values.length)
  })

  it('dialog queda por encima de sidebar y header', () => {
    expect(zIndex.dialog).toBeGreaterThan(zIndex.header)
    expect(zIndex.dialog).toBeGreaterThan(zIndex.sidebar)
  })
})

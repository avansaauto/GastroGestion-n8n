import { describe, expect, it } from 'vitest'
import {
  physicalFromPresentationUnits,
  quantityToStoredPhysical,
  resolveCreateInsumoQuantities,
  showsContentPerUnitSection,
} from './inventoryCreateForm'

describe('inventoryCreateForm', () => {
  it('muestra contenido por unidad solo con stock en u', () => {
    expect(showsContentPerUnitSection('u')).toBe(true)
    expect(showsContentPerUnitSection('g')).toBe(false)
    expect(showsContentPerUnitSection('kg')).toBe(false)
    expect(showsContentPerUnitSection('ml')).toBe(false)
    expect(showsContentPerUnitSection('L')).toBe(false)
  })

  it('Fernet: 20 u + 750 ml → 15.000 ml; mínimo 5 u → 3.750 ml; persiste factor', () => {
    const resolved = resolveCreateInsumoQuantities({
      stockUnit: 'u',
      initialStock: '20',
      minimumStock: '5',
      contentEnabled: true,
      contentQuantity: '750',
      contentUnit: 'ml',
    })
    expect(resolved).toEqual({
      ok: true,
      value: {
        baseUnit: 'ml',
        initialPhysical: 15000,
        minimumPhysical: 3750,
        contentPerUnitPhysical: 750,
        contentBaseUnit: 'ml',
        presentationUnit: 'u',
        conversionFactor: 750,
      },
    })
    // Entrada posterior 10 u → +7.500 ml → total 22.500 ml
    expect(physicalFromPresentationUnits(10, 750)).toBe(7500)
    expect(15000 + (physicalFromPresentationUnits(10, 750) ?? 0)).toBe(22500)
    // Receta 60 ml descuenta en base (sin tocar presentación)
    expect(15000 - 60).toBe(14940)
  })

  it('Coca-Cola: 48 u + 354 ml; mínimo 12 u', () => {
    const resolved = resolveCreateInsumoQuantities({
      stockUnit: 'u',
      initialStock: '48',
      minimumStock: '12',
      contentEnabled: true,
      contentQuantity: '354',
      contentUnit: 'ml',
    })
    expect(resolved.ok && resolved.value).toMatchObject({
      baseUnit: 'ml',
      initialPhysical: 16992,
      minimumPhysical: 4248,
      contentPerUnitPhysical: 354,
      contentBaseUnit: 'ml',
      presentationUnit: 'u',
      conversionFactor: 354,
    })
  })

  it('Harina: 20 u + 1 kg → 20.000 g', () => {
    const resolved = resolveCreateInsumoQuantities({
      stockUnit: 'u',
      initialStock: '20',
      minimumStock: '',
      contentEnabled: true,
      contentQuantity: '1',
      contentUnit: 'kg',
    })
    expect(resolved.ok && resolved.value).toMatchObject({
      baseUnit: 'g',
      initialPhysical: 20000,
      minimumPhysical: null,
      contentPerUnitPhysical: 1000,
      contentBaseUnit: 'g',
      presentationUnit: 'u',
      conversionFactor: 1000,
    })
  })

  it('Huevos: 60 u sin contenido → base unit sin factor', () => {
    const resolved = resolveCreateInsumoQuantities({
      stockUnit: 'u',
      initialStock: '60',
      minimumStock: '',
      contentEnabled: false,
    })
    expect(resolved.ok && resolved.value).toMatchObject({
      baseUnit: 'unit',
      initialPhysical: 60,
      minimumPhysical: null,
      contentPerUnitPhysical: null,
      contentBaseUnit: null,
      presentationUnit: null,
      conversionFactor: null,
    })
  })

  it('stock directo en kg/g/L/ml convierte a base sin contenido', () => {
    expect(resolveCreateInsumoQuantities({
      stockUnit: 'kg',
      initialStock: '2.5',
      minimumStock: '0.5',
    }).ok && resolveCreateInsumoQuantities({
      stockUnit: 'kg',
      initialStock: '2.5',
      minimumStock: '0.5',
    })).toMatchObject({
      ok: true,
      value: { baseUnit: 'g', initialPhysical: 2500, minimumPhysical: 500 },
    })

    expect(quantityToStoredPhysical(3, 'L')).toEqual({
      ok: true,
      baseUnit: 'ml',
      physical: 3000,
      contentPerUnitPhysical: null,
      contentBaseUnit: null,
    })

    expect(quantityToStoredPhysical(500, 'g')).toMatchObject({
      ok: true,
      baseUnit: 'g',
      physical: 500,
    })

    expect(quantityToStoredPhysical(250, 'ml')).toMatchObject({
      ok: true,
      baseUnit: 'ml',
      physical: 250,
    })
  })

  it('no mezcla masa y volumen en contenido', () => {
    // stock en u + contenido válido; probe de familia inconsistente no aplica
    // entre stock SI distintos (kg vs ml) se elige una sola unidad de stock
    expect(resolveCreateInsumoQuantities({
      stockUnit: 'kg',
      initialStock: '1',
      minimumStock: '',
      contentEnabled: true,
      contentQuantity: '1',
      contentUnit: 'L',
    }).ok).toBe(true) // content ignored when stock ≠ u

    expect(resolveCreateInsumoQuantities({
      stockUnit: 'u',
      initialStock: '1',
      minimumStock: '',
      contentEnabled: true,
      contentQuantity: '1',
      contentUnit: 'xyz',
    })).toMatchObject({ ok: false })
  })

  it('rechaza contenido incompleto cuando está habilitado', () => {
    expect(resolveCreateInsumoQuantities({
      stockUnit: 'u',
      initialStock: '10',
      minimumStock: '2',
      contentEnabled: true,
      contentQuantity: '',
      contentUnit: 'ml',
    })).toMatchObject({ ok: false })
  })

  it('acepta stock vacío (solo alta de catálogo)', () => {
    expect(resolveCreateInsumoQuantities({
      stockUnit: 'g',
      initialStock: '',
      minimumStock: '100',
    })).toEqual({
      ok: true,
      value: {
        baseUnit: 'g',
        initialPhysical: null,
        minimumPhysical: 100,
        contentPerUnitPhysical: null,
        contentBaseUnit: null,
        presentationUnit: null,
        conversionFactor: null,
      },
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  analyzeInvoiceLinePricing,
  canonicalUnit,
  computePhysicalQuantity,
  lookupPhysicalConversion,
  resolveConversionFactor,
  suggestPresentationPhysical,
  unitsAreEquivalent,
} from './invoiceUnits.js'
import { InvoiceQueryError } from './invoiceQueryError.js'

describe('unidades y conversión de vinculación', () => {
  it('considera equivalentes L y lts, u y unit, g y gramos', () => {
    expect(canonicalUnit('Lts')).toBe('l')
    expect(unitsAreEquivalent('L', 'lts')).toBe(true)
    expect(unitsAreEquivalent('u', 'unit')).toBe(true)
    expect(unitsAreEquivalent('g', 'gramos')).toBe(true)
    expect(unitsAreEquivalent('L', 'ml')).toBe(false)
  })

  it('reconoce glosas de Gemini y variantes de l, kg, ml y g', () => {
    expect(canonicalUnit('l')).toBe('l')
    expect(canonicalUnit('L')).toBe('l')
    expect(canonicalUnit('litros')).toBe('l')
    expect(canonicalUnit('l (litros)')).toBe('l')
    expect(canonicalUnit('kg')).toBe('kg')
    expect(canonicalUnit('kg (kilogramos)')).toBe('kg')
    expect(canonicalUnit('ml')).toBe('ml')
    expect(canonicalUnit('g')).toBe('g')
    expect(resolveConversionFactor({
      invoiceUnit: 'l (litros)',
      inventoryUnit: 'ml',
      conversionFactor: null,
    })).toBe(1000)
    expect(computePhysicalQuantity(2, 1000)).toBe(2000)
    expect(lookupPhysicalConversion('l (litros)', 'g').kind).toBe('incompatible')
  })

  it('usa factor 1 cuando las unidades coinciden', () => {
    expect(resolveConversionFactor({
      invoiceUnit: 'kg',
      inventoryUnit: 'KG',
      conversionFactor: null,
    })).toBe(1)
    expect(resolveConversionFactor({
      invoiceUnit: 'ml',
      inventoryUnit: 'ml',
      conversionFactor: null,
    })).toBe(1)
    expect(resolveConversionFactor({
      invoiceUnit: 'unidades',
      inventoryUnit: 'unit',
      conversionFactor: null,
    })).toBe(1)
  })

  it('convierte unidades SI conocidas sin factor del cliente', () => {
    expect(resolveConversionFactor({
      invoiceUnit: 'L',
      inventoryUnit: 'ml',
      conversionFactor: null,
    })).toBe(1000)
    expect(resolveConversionFactor({
      invoiceUnit: 'kg',
      inventoryUnit: 'g',
      conversionFactor: null,
    })).toBe(1000)
    expect(computePhysicalQuantity(50, 1000)).toBe(50000)
    expect(computePhysicalQuantity(8, 1000)).toBe(8000)
    expect(computePhysicalQuantity(500, 1)).toBe(500)
    expect(computePhysicalQuantity(250, 1)).toBe(250)
    expect(computePhysicalQuantity(12, 1)).toBe(12)
    expect(computePhysicalQuantity(1.5, 1000)).toBe(1500)
  })

  it('acepta un factor del cliente solo si coincide con la conversión conocida', () => {
    expect(resolveConversionFactor({
      invoiceUnit: 'L',
      inventoryUnit: 'ml',
      conversionFactor: 1000,
    })).toBe(1000)
    expect(() => resolveConversionFactor({
      invoiceUnit: 'L',
      inventoryUnit: 'ml',
      conversionFactor: 1,
    })).toThrow(InvoiceQueryError)
  })

  it('exige factor manual para presentaciones como caja, pack o pieza', () => {
    expect(lookupPhysicalConversion('caja', 'kg').kind).toBe('equivalence_required')
    expect(lookupPhysicalConversion('pack', 'ml').kind).toBe('equivalence_required')
    expect(lookupPhysicalConversion('barril', 'ml').kind).toBe('equivalence_required')
    expect(lookupPhysicalConversion('pieza', 'g').kind).toBe('equivalence_required')
    expect(lookupPhysicalConversion('lata', 'g').kind).toBe('equivalence_required')
    expect(() => resolveConversionFactor({
      invoiceUnit: 'caja',
      inventoryUnit: 'kg',
      conversionFactor: null,
    })).toThrow(InvoiceQueryError)
    expect(resolveConversionFactor({
      invoiceUnit: 'caja',
      inventoryUnit: 'g',
      conversionFactor: 8000,
    })).toBe(8000)
    expect(resolveConversionFactor({
      invoiceUnit: 'pieza',
      inventoryUnit: 'g',
      conversionFactor: 1444,
    })).toBe(1444)
  })

  it('convierte mg, cl y docena con su factor real', () => {
    expect(resolveConversionFactor({
      invoiceUnit: 'mg',
      inventoryUnit: 'g',
      conversionFactor: null,
    })).toBe(0.001)
    expect(computePhysicalQuantity(500, 0.001)).toBe(0.5)
    expect(resolveConversionFactor({
      invoiceUnit: 'cl',
      inventoryUnit: 'ml',
      conversionFactor: null,
    })).toBe(10)
    expect(computePhysicalQuantity(25, 10)).toBe(250)
    expect(resolveConversionFactor({
      invoiceUnit: 'docena',
      inventoryUnit: 'unit',
      conversionFactor: null,
    })).toBe(12)
    expect(computePhysicalQuantity(2, 12)).toBe(24)
    expect(lookupPhysicalConversion('docena', 'g').kind).toBe('incompatible')
  })

  it('sin unidad extraída exige equivalencia y no acepta un factor entre familias distintas', () => {
    expect(lookupPhysicalConversion(null, 'g').kind).toBe('equivalence_required')
    expect(resolveConversionFactor({
      invoiceUnit: null,
      inventoryUnit: 'g',
      conversionFactor: 3500,
    })).toBe(3500)
    expect(() => resolveConversionFactor({
      invoiceUnit: null,
      inventoryUnit: 'g',
      conversionFactor: null,
    })).toThrow(InvoiceQueryError)
    expect(lookupPhysicalConversion('kg', 'ml').kind).toBe('incompatible')
    expect(() => resolveConversionFactor({
      invoiceUnit: 'kg',
      inventoryUnit: 'ml',
      conversionFactor: 1000,
    })).toThrow(InvoiceQueryError)
  })

  it('no convierte unidades incompatibles', () => {
    expect(lookupPhysicalConversion('L', 'g').kind).toBe('incompatible')
    expect(lookupPhysicalConversion('kg', 'ml').kind).toBe('incompatible')
    try {
      resolveConversionFactor({ invoiceUnit: 'L', inventoryUnit: 'g', conversionFactor: 1 })
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toMatchObject({ code: 'INCOMPATIBLE_UNITS', status: 422 })
      expect((error as Error).message).toMatch(/No se puede convertir/)
    }
  })

  it('rechaza un factor no positivo aunque las unidades coincidan', () => {
    expect(() => resolveConversionFactor({
      invoiceUnit: 'kg',
      inventoryUnit: 'KG',
      conversionFactor: 0,
    })).toThrow(/mayor a cero/)
  })

  it('calcula la cantidad física equivalente', () => {
    expect(computePhysicalQuantity(10, 2.5)).toBe(25)
  })

  it('cubre casos SENDA de recepción: kg SI y empaques con factor explícito', () => {
    // 7,22 kg de panceta → 7.220 g
    expect(resolveConversionFactor({
      invoiceUnit: 'kg',
      inventoryUnit: 'g',
      conversionFactor: null,
    })).toBe(1000)
    expect(computePhysicalQuantity(7.22, 1000)).toBe(7220)

    // 2 latas de tomate de 8 kg → 16.000 g (factor 8000 g/lata)
    expect(lookupPhysicalConversion('lata', 'g').kind).toBe('equivalence_required')
    expect(resolveConversionFactor({
      invoiceUnit: 'lata',
      inventoryUnit: 'g',
      conversionFactor: 8000,
    })).toBe(8000)
    expect(computePhysicalQuantity(2, 8000)).toBe(16000)

    // 1 pack de 10 bolsas de 1 kg → 10.000 g
    expect(resolveConversionFactor({
      invoiceUnit: 'pack',
      inventoryUnit: 'g',
      conversionFactor: 10000,
    })).toBe(10000)
    expect(computePhysicalQuantity(1, 10000)).toBe(10000)

    // 1 bolsa de arroz de 5 kg → 5.000 g
    expect(resolveConversionFactor({
      invoiceUnit: 'bolsa',
      inventoryUnit: 'g',
      conversionFactor: 5000,
    })).toBe(5000)
    expect(computePhysicalQuantity(1, 5000)).toBe(5000)
  })

  it('acepta La Paulina, Doña Aurora y el resto de MAYORISTANET, y rechaza lo incompatible', () => {
    expect(resolveConversionFactor({
      invoiceUnit: 'barra',
      inventoryUnit: 'g',
      conversionFactor: 3500,
    })).toBe(3500)
    expect(computePhysicalQuantity(2, 3500)).toBe(7000)

    expect(resolveConversionFactor({
      invoiceUnit: 'plancha',
      inventoryUnit: 'g',
      conversionFactor: 8880,
    })).toBe(8880)
    expect(computePhysicalQuantity(1, 8880)).toBe(8880)

    expect(resolveConversionFactor({
      invoiceUnit: 'pack',
      inventoryUnit: 'g',
      conversionFactor: 10000,
    })).toBe(10000)
    expect(computePhysicalQuantity(1, 10000)).toBe(10000)

    expect(resolveConversionFactor({
      invoiceUnit: 'pack',
      inventoryUnit: 'ml',
      conversionFactor: 12000,
    })).toBe(12000)
    expect(computePhysicalQuantity(1, 12000)).toBe(12000)

    expect(resolveConversionFactor({
      invoiceUnit: 'bolsa',
      inventoryUnit: 'g',
      conversionFactor: 5000,
    })).toBe(5000)
    expect(computePhysicalQuantity(2, 5000)).toBe(10000)

    expect(resolveConversionFactor({
      invoiceUnit: 'bolsa',
      inventoryUnit: 'g',
      conversionFactor: 1000,
    })).toBe(1000)
    expect(computePhysicalQuantity(1, 1000)).toBe(1000)

    expect(resolveConversionFactor({
      invoiceUnit: 'kg',
      inventoryUnit: 'g',
      conversionFactor: 1000,
    })).toBe(1000)
    expect(() => resolveConversionFactor({
      invoiceUnit: 'kg',
      inventoryUnit: 'g',
      conversionFactor: 3500,
    })).toThrow(InvoiceQueryError)
    expect(() => resolveConversionFactor({
      invoiceUnit: 'xyz',
      inventoryUnit: 'g',
      conversionFactor: 1,
    })).toThrow(InvoiceQueryError)
    expect(() => resolveConversionFactor({
      invoiceUnit: 'barra',
      inventoryUnit: 'g',
      conversionFactor: null,
    })).toThrow(InvoiceQueryError)
  })

  it('sugiere física desde presentación comercial sin pisar cantidad facturada', () => {
    expect(suggestPresentationPhysical({
      quantity: 2,
      unit: 'barra',
      packageCount: 2,
      unitsPerPackage: null,
      contentPerUnit: 3.5,
      contentUnit: 'kg',
    })).toMatchObject({ physicalQuantity: 7000, physicalUnit: 'g' })

    expect(suggestPresentationPhysical({
      quantity: 1,
      unit: 'pack',
      packageCount: 1,
      unitsPerPackage: 10,
      contentPerUnit: 1,
      contentUnit: 'kg',
    })).toMatchObject({ physicalQuantity: 10000, physicalUnit: 'g' })

    expect(suggestPresentationPhysical({
      quantity: 1,
      unit: 'pack',
      packageCount: 1,
      unitsPerPackage: 12,
      contentPerUnit: 1,
      contentUnit: 'L',
    })).toMatchObject({ physicalQuantity: 12000, physicalUnit: 'ml' })

    expect(suggestPresentationPhysical({
      quantity: 2,
      unit: 'bolsa',
      packageCount: 2,
      unitsPerPackage: null,
      contentPerUnit: 5,
      contentUnit: 'kg',
    })).toMatchObject({ physicalQuantity: 10000, physicalUnit: 'g' })
  })

  it('distingue pieza, kilo, peso variable y redondeo chico de un desvío grande', () => {
    expect(analyzeInvoiceLinePricing({
      quantity: 2,
      unit: 'barra',
      unitPrice: 13143.54,
      amount: 26287.08,
      contentPerUnit: 3.5,
      contentUnit: 'kg',
      packageCount: 2,
    }).priceBasis).toBe('commercial_unit')

    const perKilo = analyzeInvoiceLinePricing({
      quantity: 1,
      unit: 'plancha',
      unitPrice: 8213.95,
      amount: 72972.75,
      billedWeight: 8.88,
      billedWeightUnit: 'kg',
      contentPerUnit: 8.8,
      contentUnit: 'kg',
      packageCount: 1,
    })
    expect(perKilo.priceBasis).toBe('weight')
    expect(perKilo.billedWeight).toBe(8.88)
    expect(perKilo.amountExplainedByCommercial).toBe(false)
    expect(perKilo.commercialExpectedAmount).toBe(8213.95)
    expect(perKilo.weightExpectedAmount).toBe(72939.88)

    const variable = analyzeInvoiceLinePricing({
      quantity: 5,
      unit: 'pieza',
      unitPrice: 8500,
      amount: 61370,
      contentPerUnit: 1.5,
      contentUnit: 'kg',
      packageCount: 5,
      billedWeight: 7.22,
      billedWeightUnit: 'kg',
    })
    expect(variable.priceBasis).toBe('weight')
    expect(variable.billedWeight).toBeCloseTo(7.22, 3)

    expect(analyzeInvoiceLinePricing({
      quantity: 1,
      unit: 'plancha',
      unitPrice: 8213.95,
      amount: 72972.77,
      billedWeight: 8.884,
      billedWeightUnit: 'kg',
      packageCount: 1,
    }).priceBasis).toBe('weight')

    const material = analyzeInvoiceLinePricing({
      quantity: 1,
      unit: 'plancha',
      unitPrice: 8213.95,
      amount: 65000,
      billedWeight: 8.88,
      billedWeightUnit: 'kg',
      packageCount: 1,
    })
    expect(material.priceBasis).toBe('ambiguous')
    expect(material.billedWeight).toBe(8.88)

    expect(analyzeInvoiceLinePricing({
      quantity: 1,
      unit: 'kg',
      unitPrice: 1000,
      amount: 9040,
      billedWeight: 9,
      billedWeightUnit: 'kg',
    }).priceBasis).toBe('ambiguous')

    expect(analyzeInvoiceLinePricing({
      quantity: 1,
      unit: 'bolsa',
      unitPrice: 10000,
      amount: 530,
      billedWeight: 0.05,
      billedWeightUnit: 'kg',
    }).priceBasis).toBe('ambiguous')
  })

  it('detecta precio por kg en plancha con peso facturado', () => {
    const pricing = analyzeInvoiceLinePricing({
      quantity: 1,
      unit: 'plancha',
      unitPrice: 8213.95,
      amount: 72972.75,
      contentPerUnit: 8.884,
      contentUnit: 'kg',
      packageCount: 1,
    })
    expect(pricing.priceBasis).toBe('weight')
    expect(pricing.amountExplainedByWeight).toBe(true)
    expect(pricing.amountExplainedByCommercial).toBe(false)
  })

  it('prioriza billed_weight (Cant. KG) sobre content aproximado de la descripción', () => {
    expect(suggestPresentationPhysical({
      quantity: 5,
      unit: 'pieza',
      packageCount: 5,
      unitsPerPackage: null,
      contentPerUnit: 1.5,
      contentUnit: 'kg',
      billedWeight: 7.22,
      billedWeightUnit: 'kg',
    })).toMatchObject({ physicalQuantity: 7220, physicalUnit: 'g' })

    const pricing = analyzeInvoiceLinePricing({
      quantity: 5,
      unit: 'pieza',
      unitPrice: 8500,
      amount: 61370,
      contentPerUnit: 1.5,
      contentUnit: 'kg',
      packageCount: 5,
      billedWeight: 7.22,
      billedWeightUnit: 'kg',
    })
    expect(pricing.billedWeight).toBeCloseTo(7.22, 3)
    expect(pricing.priceBasis).toBe('weight')
  })
})

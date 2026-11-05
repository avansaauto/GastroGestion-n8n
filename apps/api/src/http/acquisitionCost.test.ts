import { describe, expect, it } from 'vitest'
import { acquisitionValueForReceipt, resolveAcquisitionCost } from './acquisitionCost.js'

describe('costo unitario de adquisición', () => {
  it('convierte 100.000 ml a $180.000 en $1,80 por ml', () => {
    expect(resolveAcquisitionCost({
      netAcquisitionAmount: 180000,
      inventoryPhysicalQuantity: 100000,
    })).toMatchObject({
      kind: 'valid',
      unitCost: 1.8,
      netAcquisitionAmount: 180000,
      inventoryPhysicalQuantity: 100000,
    })
  })

  it('convierte 50 L netos a $1,65/ml usando la cantidad física completa', () => {
    const cost = resolveAcquisitionCost({
      netAcquisitionAmount: 82500,
      inventoryPhysicalQuantity: 50000,
      preserveCommercialReferenceCost: true,
    })
    expect(cost).toMatchObject({
      kind: 'valid',
      unitCost: 1.65,
      netAcquisitionAmount: 82500,
      inventoryPhysicalQuantity: 50000,
    })
    expect(cost.kind === 'valid' && cost.unitCost).not.toBe(82500 / 50)
  })

  it('convierte kilogramos a costo por gramo', () => {
    const cost = resolveAcquisitionCost({
      netAcquisitionAmount: 4000,
      inventoryPhysicalQuantity: 8000,
    })
    expect(cost).toMatchObject({ kind: 'valid', unitCost: 0.5, inventoryPhysicalQuantity: 8000 })
  })

  it('usa unidades físicas 1:1', () => {
    const cost = resolveAcquisitionCost({
      netAcquisitionAmount: 120,
      inventoryPhysicalQuantity: 12,
    })
    expect(cost).toMatchObject({ kind: 'valid', unitCost: 10, inventoryPhysicalQuantity: 12 })
  })

  it('asigna parciales sobre la línea completa y no supera el neto por redondeo', () => {
    const first = acquisitionValueForReceipt({
      netAcquisitionAmount: 82500,
      inventoryPhysicalQuantity: 50000,
      receivedQuantity: 20000,
    })
    const second = acquisitionValueForReceipt({
      netAcquisitionAmount: 82500,
      inventoryPhysicalQuantity: 50000,
      receivedQuantity: 30000,
      previouslyReceivedQuantity: 20000,
    })
    expect(first).toMatchObject({ kind: 'valid', allocatedAmount: 33000, unitCost: 1.65 })
    expect(second).toMatchObject({ kind: 'valid', allocatedAmount: 49500, unitCost: 1.65 })
    expect((first.allocatedAmount ?? 0) + (second.allocatedAmount ?? 0)).toBe(82500)

    const odd = [
      acquisitionValueForReceipt({
        netAcquisitionAmount: 100,
        inventoryPhysicalQuantity: 3,
        receivedQuantity: 1,
      }),
      acquisitionValueForReceipt({
        netAcquisitionAmount: 100,
        inventoryPhysicalQuantity: 3,
        receivedQuantity: 1,
        previouslyReceivedQuantity: 1,
      }),
      acquisitionValueForReceipt({
        netAcquisitionAmount: 100,
        inventoryPhysicalQuantity: 3,
        receivedQuantity: 1,
        previouslyReceivedQuantity: 2,
      }),
    ]
    const total = odd.reduce((sum, item) => sum + (item.allocatedAmount ?? 0), 0)
    expect(total).toBe(100)
    expect(Math.max(...odd.map((item) => item.allocatedAmount ?? 0))).toBeLessThanOrEqual(100)
  })

  it('trata la bonificación del 100% como costo de adquisición cero y conserva la referencia', () => {
    const cost = resolveAcquisitionCost({
      netAcquisitionAmount: 0,
      inventoryPhysicalQuantity: 50000,
      preserveCommercialReferenceCost: true,
    })
    expect(cost).toMatchObject({
      kind: 'full_bonus',
      unitCost: 0,
      netAcquisitionAmount: 0,
      preserveCommercialReferenceCost: true,
    })
    expect(acquisitionValueForReceipt({
      netAcquisitionAmount: 0,
      inventoryPhysicalQuantity: 50000,
      receivedQuantity: 20000,
    })).toMatchObject({ kind: 'full_bonus', allocatedAmount: 0, unitCost: 0 })
  })

  it('no inventa un costo si falta el neto comercial', () => {
    const cost = resolveAcquisitionCost({
      netAcquisitionAmount: null,
      inventoryPhysicalQuantity: 50000,
    })
    expect(cost).toMatchObject({ kind: 'indeterminate', unitCost: null, reason: 'missing_net' })
    expect(acquisitionValueForReceipt({
      netAcquisitionAmount: undefined,
      inventoryPhysicalQuantity: 50000,
      receivedQuantity: 1000,
    }).kind).toBe('indeterminate')
  })

  it('no usa reviewed_amount como neto de IVA', () => {
    const reviewedAmount = 82500
    const cost = resolveAcquisitionCost({
      netAcquisitionAmount: null,
      inventoryPhysicalQuantity: 50000,
    })
    expect(cost.kind).toBe('indeterminate')
    expect(cost.unitCost).not.toBe(reviewedAmount / 50000)
  })

  it('marca indeterminado un neto comercial negativo', () => {
    expect(resolveAcquisitionCost({
      netAcquisitionAmount: -100,
      inventoryPhysicalQuantity: 1000,
    })).toMatchObject({ kind: 'indeterminate', reason: 'negative_net', unitCost: null })
  })

  it('marca indeterminado una cantidad física cero o inválida', () => {
    expect(resolveAcquisitionCost({
      netAcquisitionAmount: 82500,
      inventoryPhysicalQuantity: 0,
    })).toMatchObject({ kind: 'indeterminate', reason: 'zero_physical' })
    expect(resolveAcquisitionCost({
      netAcquisitionAmount: 82500,
      inventoryPhysicalQuantity: Number.NaN,
    })).toMatchObject({ kind: 'indeterminate', reason: 'invalid_physical' })
  })

  it('redondea importes decimales a 2 y no se pasa del neto', () => {
    const cost = resolveAcquisitionCost({
      netAcquisitionAmount: 10.555,
      inventoryPhysicalQuantity: 3,
    })
    expect(cost.kind).toBe('valid')
    if (cost.kind !== 'valid') return
    expect(cost.netAcquisitionAmount).toBe(10.56)
    const first = acquisitionValueForReceipt({
      netAcquisitionAmount: 10.555,
      inventoryPhysicalQuantity: 3,
      receivedQuantity: 1,
    })
    const rest = acquisitionValueForReceipt({
      netAcquisitionAmount: 10.555,
      inventoryPhysicalQuantity: 3,
      receivedQuantity: 2,
      previouslyReceivedQuantity: 1,
    })
    expect((first.allocatedAmount ?? 0) + (rest.allocatedAmount ?? 0)).toBe(10.56)
  })

  it('deja indeterminadas las facturas antiguas sin información suficiente', () => {
    expect(resolveAcquisitionCost({
      netAcquisitionAmount: undefined,
      inventoryPhysicalQuantity: undefined,
    })).toMatchObject({ kind: 'indeterminate', reason: 'invalid_physical' })
    expect(resolveAcquisitionCost({
      netAcquisitionAmount: undefined,
      inventoryPhysicalQuantity: 2000,
    })).toMatchObject({ kind: 'indeterminate', reason: 'missing_net' })
  })
})

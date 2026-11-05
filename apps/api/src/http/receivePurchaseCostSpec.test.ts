import { describe, expect, it } from 'vitest'

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

function round8(value: number) {
  return Math.round(value * 1e8) / 1e8
}

/** Mismo redondeo que senda_set_inventory_purchase_cost (Paso 447). */
function installedCostUnit(purchaseCost: number, purchaseQuantity: number) {
  return round8(roundMoney(purchaseCost) / purchaseQuantity)
}

/** Redondeo intermedio prohibido: neto prorrateado a 2 decimales. */
function allocatedPartialCost(net: number, receivedQty: number, invoicedQty: number) {
  return roundMoney(net * (receivedQty / invoicedQty))
}

function skipStaleInvoice(
  effectiveAt: number,
  lastPurchaseAt: number | null,
  source: 'invoice' | 'manual',
) {
  if (source !== 'invoice' || lastPurchaseAt == null) return false
  return effectiveAt < lastPurchaseAt
}

function replayReceipt(
  existing: { lineId: string; quantity: number } | null,
  lineId: string,
  quantity: number,
) {
  if (!existing) return { replay: false as const }
  if (existing.lineId !== lineId || existing.quantity !== quantity) {
    return { conflict: true as const }
  }
  return { replay: true as const }
}

function remainingAfterReceive(invoiced: number, alreadyReceived: number, thisReceive: number) {
  const remaining = invoiced - alreadyReceived
  if (thisReceive > remaining) return { error: 'RECEIPT_EXCEEDS_INVOICED' as const }
  return { remaining: remaining - thisReceive, received: alreadyReceived + thisReceive }
}

describe('contrato aislado de recepción + costo', () => {
  const invoicedG = 10000
  const net = 200000
  const recipeG = 200

  it('10 kg a $200.000 quedan en $20/g también en un parcial de 3333 g', () => {
    const partialG = 3333
    const corrected = installedCostUnit(net, invoicedG)
    expect(corrected).toBe(20)
    expect(installedCostUnit(allocatedPartialCost(net, partialG, invoicedG), partialG)).toBe(20)
    expect(corrected * recipeG).toBe(4000)
    expect(installedCostUnit(net, partialG)).toBe(round8(net / partialG))
    expect(installedCostUnit(net, partialG)).not.toBe(20)
  })

  it('evita el redondeo intermedio cuando el neto no es múltiplo exacto', () => {
    const invoiced = 3
    const lineNet = 10
    const received = 1
    const leaked = installedCostUnit(allocatedPartialCost(lineNet, received, invoiced), received)
    const corrected = installedCostUnit(lineNet, invoiced)
    expect(corrected).toBe(round8(10 / 3))
    expect(leaked).toBe(3.33)
    expect(corrected).not.toBe(leaked)
    expect(roundMoney(corrected * invoiced)).toBe(10)
    expect(roundMoney(leaked * invoiced)).toBe(9.99)
  })

  it('el segundo parcial de la misma línea conserva $20/g', () => {
    const first = 3333
    const second = invoicedG - first
    expect(installedCostUnit(net, invoicedG)).toBe(20)
    expect(first + second).toBe(invoicedG)
    expect(installedCostUnit(net, invoicedG) * recipeG).toBe(4000)
  })

  it('respeta el RPC instalado: round(cost, 2) / qty a 8 decimales', () => {
    expect(installedCostUnit(200000.339, invoicedG)).toBe(round8(200000.34 / invoicedG))
    expect(installedCostUnit(0, invoicedG)).toBe(0)
  })

  it('misma fecha de factura no es stale; un manual posterior sí protege', () => {
    const midnight = Date.parse('2026-10-18T00:00:00.000Z')
    const laterSameDay = Date.parse('2026-10-18T15:32:00.000Z')
    expect(skipStaleInvoice(midnight, midnight, 'invoice')).toBe(false)
    expect(skipStaleInvoice(midnight, laterSameDay, 'invoice')).toBe(true)
    expect(skipStaleInvoice(laterSameDay, midnight, 'manual')).toBe(false)
    expect(skipStaleInvoice(midnight, laterSameDay, 'manual')).toBe(false)
  })

  it('repite la misma clave sin incremento; otra cantidad choca', () => {
    expect(replayReceipt(null, 'line-1', invoicedG)).toEqual({ replay: false })
    expect(replayReceipt({ lineId: 'line-1', quantity: invoicedG }, 'line-1', invoicedG)).toEqual({
      replay: true,
    })
    expect(replayReceipt({ lineId: 'line-1', quantity: invoicedG }, 'line-1', 4000)).toEqual({
      conflict: true,
    })
  })

  it('el stock usa la cantidad recibida, no la facturada', () => {
    expect(remainingAfterReceive(invoicedG, 0, 3333)).toEqual({ remaining: 6667, received: 3333 })
    expect(remainingAfterReceive(invoicedG, 3333, invoicedG)).toEqual({
      error: 'RECEIPT_EXCEEDS_INVOICED',
    })
  })
})

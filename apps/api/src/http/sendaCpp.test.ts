import { readFileSync } from 'node:fs'
import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { acquisitionValueForReceipt } from './acquisitionCost.js'

const sql = readFileSync(new URL('../../sql/proposed-senda-cpp.sql', import.meta.url), 'utf8')

function nextAverage(
  qtyBefore: number,
  avgBefore: number | null,
  received: number,
  amount: number,
): number {
  if (qtyBefore > 0 && avgBefore == null) {
    throw new Error('UNVALUED_STOCK')
  }
  if (qtyBefore > 0 && avgBefore != null) {
    return new Decimal(qtyBefore)
      .mul(avgBefore)
      .plus(amount)
      .div(new Decimal(qtyBefore).plus(received))
      .toDecimalPlaces(8, Decimal.ROUND_HALF_UP)
      .toNumber()
  }
  return new Decimal(amount).div(received).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toNumber()
}

describe('CPP', () => {
  it('pondera el stock anterior y deja el último precio aparte', () => {
    expect(nextAverage(0, null, 10000, 120000)).toBe(12)
    expect(nextAverage(10000, 12, 10000, 140000)).toBe(13)
    expect(new Decimal(13).mul(200).toNumber()).toBe(2600)
    expect(nextAverage(6000, 12, 10000, 140000)).toBe(13.25)
    expect(nextAverage(0, 9, 10, 50)).toBe(5)
    expect(() => nextAverage(1000, null, 1000, 2000)).toThrow(/UNVALUED_STOCK/)
  })

  it('cierra el importe de la línea en los tramos', () => {
    const first = acquisitionValueForReceipt({
      netAcquisitionAmount: 10,
      inventoryPhysicalQuantity: 3,
      receivedQuantity: 1,
      previouslyReceivedQuantity: 0,
    })
    const second = acquisitionValueForReceipt({
      netAcquisitionAmount: 10,
      inventoryPhysicalQuantity: 3,
      receivedQuantity: 2,
      previouslyReceivedQuantity: 1,
    })
    expect(first.kind).toBe('valid')
    expect(second.kind).toBe('valid')
    if (first.kind !== 'valid' || second.kind !== 'valid') return
    expect(first.allocatedAmount).toBe(3.33)
    expect(second.allocatedAmount).toBe(6.67)
    expect(new Decimal(first.allocatedAmount).plus(second.allocatedAmount).toNumber()).toBe(10)
  })

  it('la migración lee el saldo antes de sumarlo y no reescribe historial', () => {
    const costAt = sql.indexOf('senda_set_inventory_purchase_cost(jsonb_build_object')
    const qtyAt = sql.indexOf('quantity_on_hand + excluded.quantity_on_hand')
    const compensateAt = sql.indexOf('senda_cpp_compensate_receipt(')
    const adjustAt = sql.indexOf('senda_adjust_inventory_quantity(jsonb_build_object')
    expect(costAt).toBeGreaterThan(0)
    expect(qtyAt).toBeGreaterThan(costAt)
    expect(compensateAt).toBeGreaterThan(0)
    expect(adjustAt).toBeGreaterThan(compensateAt)
    expect(sql).toContain('order by rec.created_at desc, rec.id desc')
    const delStart = sql.indexOf('create or replace function public.senda_delete_purchase_invoice')
    const delEnd = sql.indexOf('comment on function public.senda_delete_purchase_invoice', delStart)
    const del = sql.slice(delStart, delEnd)
    const compStart = sql.indexOf('create or replace function public.senda_cpp_compensate_receipt')
    const compEnd = sql.indexOf('revoke all on function public.senda_cpp_compensate_receipt', compStart)
    const comp = sql.slice(compStart, compEnd)
    expect(del).not.toContain('v_restore_cost')
    expect(del.toLowerCase()).not.toContain('delete from public.inventory_cost_history')
    expect(comp.toLowerCase()).not.toContain('update public.inventory_cost_history')
    expect(comp.toLowerCase()).not.toContain('set quantity_on_hand')
    expect(sql).toContain('MANUAL_COST_WITH_ON_HAND')
    expect(sql).toContain('REVERSAL_LEDGER_MISMATCH')
    expect(sql).toContain('UNVALUED_STOCK')
    expect(sql).toContain('su costo histórico no se puede reconstruir')
    expect(sql).toContain('REVERSAL_COST_HISTORY_INCOMPLETE')
    expect(sql).toContain('quantity_on_hand_before')
    expect(sql).toContain('receipt_idempotency_key')
  })
})

export const WASTE_REASON_PREFIX = 'Merma:'

const WASTE_REASON = /^merma\b/i
const INVOICE_REVERSAL_REASON = /reversion por eliminacion de factura/i

export type InventoryMovementKind =
  | 'purchase'
  | 'sale'
  | 'sale_reversal'
  | 'opening'
  | 'waste'
  | 'invoice_reversal'
  | 'adjustment'
  | 'other'

export function isWasteReason(reason: string | null | undefined) {
  return WASTE_REASON.test(reason?.trim() ?? '')
}

export function isInvoiceReversalReason(reason: string | null | undefined) {
  return INVOICE_REVERSAL_REASON.test(reason?.trim() ?? '')
}

/** Motivo estable para una merma. El texto del operador queda después del prefijo. */
export function wasteReason(note: string): string | null {
  const stripped = note
    .trim()
    .replace(/^merma\s*:\s*/i, '')
    .replace(/^merma\s+/i, '')
    .trim()
  if (/^merma$/i.test(stripped) || stripped.length < 3) return null
  return `${WASTE_REASON_PREFIX} ${stripped}`
}

export function prepareInventoryAdjustment(input: {
  quantityDelta: number
  reason: string
  kind?: string | null
}): { quantity: number; reason: string } | { error: string; code: string } {
  const kind = input.kind?.trim() || 'correction'
  if (kind !== 'correction' && kind !== 'waste') {
    return { error: 'El tipo de movimiento no es válido.', code: 'INVALID_KIND' }
  }
  if (!Number.isFinite(input.quantityDelta) || input.quantityDelta === 0) {
    return { error: 'Indicá una cantidad distinta de cero.', code: 'INVALID_QUANTITY' }
  }
  if (kind === 'waste') {
    if (input.quantityDelta > 0) {
      return {
        error: 'Una merma descuenta stock. Indicá la cantidad perdida.',
        code: 'INVALID_QUANTITY',
      }
    }
    const reason = wasteReason(input.reason)
    if (!reason) {
      return {
        error: 'Describí la merma. No alcanza con la palabra merma.',
        code: 'INVALID_REASON',
      }
    }
    return { quantity: input.quantityDelta, reason }
  }
  const reason = input.reason.trim()
  if (reason.length < 3) {
    return { error: 'Indicá un motivo del ajuste.', code: 'INVALID_REASON' }
  }
  if (isWasteReason(reason)) {
    return {
      error: 'Una merma se registra con Registrar merma, no como corrección de inventario.',
      code: 'USE_WASTE_ACTION',
    }
  }
  return { quantity: input.quantityDelta, reason }
}

export function classifyInventoryMovement(input: {
  movementType: string | null | undefined
  reason?: string | null
  /** Cantidad del movimiento. Una merma real solo descuenta (qty < 0). */
  quantity?: number | null
}): { kind: InventoryMovementKind; label: string } {
  const type = input.movementType?.trim().toLowerCase() ?? ''
  if (type === 'purchase') return { kind: 'purchase', label: 'Compra' }
  if (type === 'sale') return { kind: 'sale', label: 'Consumo de venta' }
  if (type === 'sale_reversal') return { kind: 'sale_reversal', label: 'Reversión de venta' }
  if (type === 'opening') return { kind: 'opening', label: 'Apertura' }
  if (type === 'adjustment') {
    if (isInvoiceReversalReason(input.reason)) {
      return { kind: 'invoice_reversal', label: 'Anulación de compra' }
    }
    // Motivo histórico «merma» con cantidad positiva no es pérdida: es un ajuste.
    // Se conserva el motivo en detail; no se reescribe el movimiento.
    const quantity = input.quantity
    const isNegative = typeof quantity === 'number' && Number.isFinite(quantity) && quantity < 0
    if (isWasteReason(input.reason) && (quantity == null || isNegative)) {
      return { kind: 'waste', label: 'Merma' }
    }
    return { kind: 'adjustment', label: 'Ajuste' }
  }
  return { kind: 'other', label: 'Movimiento' }
}

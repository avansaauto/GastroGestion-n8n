import { Decimal } from 'decimal.js'

const MONEY_DP = 2
const UNIT_COST_DP = 8

export type AcquisitionCostKind = 'valid' | 'full_bonus' | 'indeterminate'

export type AcquisitionCostReason =
  | 'missing_net'
  | 'invalid_net'
  | 'negative_net'
  | 'zero_physical'
  | 'invalid_physical'

export type AcquisitionCostInput = {
  netAcquisitionAmount: number | null | undefined
  inventoryPhysicalQuantity: number | null | undefined
  preserveCommercialReferenceCost?: boolean
}

export type AcquisitionCost =
  | {
      kind: 'valid'
      unitCost: number
      netAcquisitionAmount: number
      inventoryPhysicalQuantity: number
      preserveCommercialReferenceCost: boolean
    }
  | {
      kind: 'full_bonus'
      unitCost: 0
      netAcquisitionAmount: 0
      inventoryPhysicalQuantity: number
      preserveCommercialReferenceCost: true
    }
  | {
      kind: 'indeterminate'
      unitCost: null
      netAcquisitionAmount: number | null
      inventoryPhysicalQuantity: number | null
      reason: AcquisitionCostReason
    }

export type AcquisitionReceiptValue = {
  kind: AcquisitionCostKind
  unitCost: number | null
  allocatedAmount: number | null
  reason?: AcquisitionCostReason
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function money(value: Decimal) {
  return value.toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP)
}

export function resolveAcquisitionCost(input: AcquisitionCostInput): AcquisitionCost {
  const physical = asFiniteNumber(input.inventoryPhysicalQuantity)
  const net = input.netAcquisitionAmount === undefined || input.netAcquisitionAmount === null
    ? null
    : asFiniteNumber(input.netAcquisitionAmount)
  const missingNet = input.netAcquisitionAmount === undefined || input.netAcquisitionAmount === null

  if (physical == null) {
    return {
      kind: 'indeterminate',
      unitCost: null,
      netAcquisitionAmount: missingNet ? null : net,
      inventoryPhysicalQuantity: null,
      reason: 'invalid_physical',
    }
  }
  if (physical <= 0) {
    return {
      kind: 'indeterminate',
      unitCost: null,
      netAcquisitionAmount: missingNet ? null : net,
      inventoryPhysicalQuantity: physical,
      reason: 'zero_physical',
    }
  }
  if (missingNet) {
    return {
      kind: 'indeterminate',
      unitCost: null,
      netAcquisitionAmount: null,
      inventoryPhysicalQuantity: physical,
      reason: 'missing_net',
    }
  }
  if (net == null) {
    return {
      kind: 'indeterminate',
      unitCost: null,
      netAcquisitionAmount: null,
      inventoryPhysicalQuantity: physical,
      reason: 'invalid_net',
    }
  }
  if (net < 0) {
    return {
      kind: 'indeterminate',
      unitCost: null,
      netAcquisitionAmount: net,
      inventoryPhysicalQuantity: physical,
      reason: 'negative_net',
    }
  }
  if (net === 0) {
    return {
      kind: 'full_bonus',
      unitCost: 0,
      netAcquisitionAmount: 0,
      inventoryPhysicalQuantity: physical,
      preserveCommercialReferenceCost: true,
    }
  }

  const quantity = new Decimal(physical)
  const amount = new Decimal(net)
  return {
    kind: 'valid',
    unitCost: amount.div(quantity).toDecimalPlaces(UNIT_COST_DP, Decimal.ROUND_HALF_UP).toNumber(),
    netAcquisitionAmount: money(amount).toNumber(),
    inventoryPhysicalQuantity: physical,
    preserveCommercialReferenceCost: input.preserveCommercialReferenceCost === true,
  }
}

export function acquisitionValueForReceipt(input: AcquisitionCostInput & {
  receivedQuantity: number
  previouslyReceivedQuantity?: number
}): AcquisitionReceiptValue {
  const cost = resolveAcquisitionCost(input)
  if (cost.kind === 'indeterminate') {
    return {
      kind: 'indeterminate',
      unitCost: null,
      allocatedAmount: null,
      reason: cost.reason,
    }
  }
  if (cost.kind === 'full_bonus') {
    return { kind: 'full_bonus', unitCost: 0, allocatedAmount: 0 }
  }

  const received = asFiniteNumber(input.receivedQuantity)
  const previous = asFiniteNumber(input.previouslyReceivedQuantity) ?? 0
  if (received == null || received <= 0 || previous < 0) {
    return {
      kind: 'indeterminate',
      unitCost: cost.unitCost,
      allocatedAmount: null,
      reason: 'invalid_physical',
    }
  }

  const physical = new Decimal(cost.inventoryPhysicalQuantity)
  const net = money(new Decimal(cost.netAcquisitionAmount))
  const unit = new Decimal(cost.unitCost)
  const prevQty = new Decimal(previous)
  const thisQty = new Decimal(received)

  if (prevQty.gte(physical)) {
    return { kind: 'valid', unitCost: cost.unitCost, allocatedAmount: 0 }
  }

  const remainingQty = physical.minus(prevQty)
  const cappedQty = Decimal.min(thisQty, remainingQty)
  const start = cumulativeAllocated(unit, prevQty, physical, net)
  const end = cumulativeAllocated(unit, prevQty.plus(cappedQty), physical, net)
  return {
    kind: 'valid',
    unitCost: cost.unitCost,
    allocatedAmount: money(end.minus(start)).toNumber(),
  }
}

function cumulativeAllocated(unit: Decimal, quantity: Decimal, physical: Decimal, net: Decimal) {
  if (quantity.lte(0)) return new Decimal(0)
  if (quantity.gte(physical)) return net
  return Decimal.min(money(unit.times(quantity)), net)
}

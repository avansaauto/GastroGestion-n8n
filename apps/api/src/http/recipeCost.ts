import { Decimal } from 'decimal.js'

const LINE_COST_DP = 8
const YIELD_COST_DP = 4

export type ConsumptionMode = 'none' | 'direct' | 'compound'

export type RecipeCostLineInput = {
  quantity: number
  unitCost: number | null
}

export type RecipeCostEstimate = {
  costPerYield: number | null
  costIncomplete: boolean
  lineCosts: Array<number | null>
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function consumptionModeFromComponentCount(count: number): ConsumptionMode {
  if (count <= 0) return 'none'
  if (count === 1) return 'direct'
  return 'compound'
}

export function estimateRecipeCost(input: {
  yieldQuantity: unknown
  lines: RecipeCostLineInput[]
}): RecipeCostEstimate {
  const lineCosts = input.lines.map((line) => {
    if (!(line.quantity > 0)) return null
    if (line.unitCost == null || !Number.isFinite(line.unitCost)) return null
    return new Decimal(line.quantity)
      .times(line.unitCost)
      .toDecimalPlaces(LINE_COST_DP, Decimal.ROUND_HALF_UP)
      .toNumber()
  })

  if (input.lines.length === 0) {
    return { costPerYield: 0, costIncomplete: false, lineCosts: [] }
  }

  const incomplete = lineCosts.some((cost) => cost == null)
  if (incomplete) {
    return { costPerYield: null, costIncomplete: true, lineCosts }
  }

  const yieldQuantity = asFiniteNumber(input.yieldQuantity)
  if (yieldQuantity == null || yieldQuantity <= 0) {
    return { costPerYield: null, costIncomplete: true, lineCosts }
  }

  const total = lineCosts.reduce((sum, cost) => sum.plus(cost ?? 0), new Decimal(0))
  return {
    costPerYield: total.div(yieldQuantity).toDecimalPlaces(YIELD_COST_DP, Decimal.ROUND_HALF_UP).toNumber(),
    costIncomplete: false,
    lineCosts,
  }
}

export function parseRecipeNumber(value: unknown): number | null {
  return asFiniteNumber(value)
}

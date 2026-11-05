import { Decimal } from 'decimal.js'
import { normalizeText } from './classification.js'
import type {
  FiscalReconciliation,
  NormalizedInvoiceDocument,
  NormalizedInvoiceLine,
} from './types.js'

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP })

const MONEY_TOLERANCE = new Decimal('0.05')

function money(value: Decimal): number {
  return value.toDecimalPlaces(2).toNumber()
}

function lineText(line: NormalizedInvoiceLine): string {
  return normalizeText(`${line.name} ${line.originalDescription}`)
}

function isDocumentTotalOrSubtotal(line: NormalizedInvoiceLine): boolean {
  return /^(subtotal|total|neto\s+gravado)\b/.test(lineText(line))
}

/** IVA principal: "IVA", "I.V.A.", "IVA 21%", no percepciones. */
export function isMainIvaLine(line: NormalizedInvoiceLine): boolean {
  const text = lineText(line)
  if (/percepcion|retencion|iibb|ingresos\s+brutos/.test(text)) return false
  return /^(i\.?\s*v\.?\s*a\.?)\b/.test(text) || /^impuesto\s+al\s+valor\s+agregado\b/.test(text)
}

function isOtherFiscalCharge(line: NormalizedInvoiceLine): boolean {
  if (line.classification !== 'fiscal' || line.amount == null) return false
  if (isDocumentTotalOrSubtotal(line)) return false
  return !isMainIvaLine(line)
}

export function reconcileFiscalAmounts(
  document: NormalizedInvoiceDocument,
): FiscalReconciliation {
  const ivaLines = document.lines.filter(
    (line) => line.classification === 'fiscal' && line.amount != null && isMainIvaLine(line),
  )
  const otherFiscalLines = document.lines.filter(isOtherFiscalCharge)
  const taxFromIvaLines = ivaLines.reduce(
    (total, line) => total.plus(line.amount ?? 0),
    new Decimal(0),
  )
  const otherTaxesFromFiscalLines = otherFiscalLines.reduce(
    (total, line) => total.plus(line.amount ?? 0),
    new Decimal(0),
  )
  const extractedTax = new Decimal(document.amounts.taxes)
  const extractedOtherTaxes = new Decimal(document.amounts.otherTaxes)
  const taxDifference = extractedTax.minus(taxFromIvaLines).abs()
  const otherTaxesDifference = extractedOtherTaxes.minus(otherTaxesFromFiscalLines).abs()
  const hasIvaEvidence = ivaLines.length > 0
  const hasOtherFiscalEvidence = otherFiscalLines.length > 0

  let totalFromExtractedHeader: Decimal | null = null
  let totalFromFiscalLines: Decimal | null = null
  if (document.amounts.subtotal != null) {
    const base = new Decimal(document.amounts.subtotal).minus(document.amounts.discounts)
    totalFromExtractedHeader = document.amounts.taxesIncluded
      ? base
      : base.plus(extractedTax).plus(extractedOtherTaxes)
    const taxForLines = hasIvaEvidence ? taxFromIvaLines : extractedTax
    const otherForLines = hasOtherFiscalEvidence ? otherTaxesFromFiscalLines : extractedOtherTaxes
    totalFromFiscalLines = document.amounts.taxesIncluded
      ? base
      : base.plus(taxForLines).plus(otherForLines)
  }

  const extractedHeaderVsTotal =
    totalFromExtractedHeader != null && document.amounts.total != null
      ? money(totalFromExtractedHeader.minus(document.amounts.total).abs())
      : null
  const fiscalLinesVsTotal =
    totalFromFiscalLines != null && document.amounts.total != null
      ? money(totalFromFiscalLines.minus(document.amounts.total).abs())
      : null

  const taxMatchesIvaLines = hasIvaEvidence
    ? taxDifference.lte(MONEY_TOLERANCE)
    : null
  const otherTaxesMatchPerceptionLines = hasOtherFiscalEvidence
    ? otherTaxesDifference.lte(MONEY_TOLERANCE)
    : null
  const headerExplainsTotal =
    extractedHeaderVsTotal != null
      ? new Decimal(extractedHeaderVsTotal).lte(MONEY_TOLERANCE)
      : null
  const fiscalLinesExplainTotal =
    fiscalLinesVsTotal != null
      ? new Decimal(fiscalLinesVsTotal).lte(MONEY_TOLERANCE)
      : null

  const taxMismatch = taxMatchesIvaLines === false
  const otherMismatch = otherTaxesMatchPerceptionLines === false
  const aggregateMismatch = taxMismatch || otherMismatch
  const totalCloses = headerExplainsTotal === true || fiscalLinesExplainTotal === true
  const totalFails =
    headerExplainsTotal === false &&
    (fiscalLinesExplainTotal === false || fiscalLinesExplainTotal == null)

  let origin: FiscalReconciliation['origin'] = null
  let totalStatus: FiscalReconciliation['totalStatus'] = 'not_applicable'
  let aggregatesStatus: FiscalReconciliation['aggregatesStatus'] = 'not_applicable'
  let status: FiscalReconciliation['status'] = 'consistent'

  if (document.amounts.total == null || document.amounts.subtotal == null) {
    totalStatus = 'not_applicable'
  } else if (totalCloses) {
    totalStatus = 'consistent'
  } else if (totalFails || headerExplainsTotal === false) {
    totalStatus = 'inconsistent'
  }

  if (!hasIvaEvidence && !hasOtherFiscalEvidence) {
    aggregatesStatus = 'not_applicable'
    if (totalStatus === 'inconsistent') {
      status = 'inconsistent'
      origin = 'unexplained_total'
    } else if (totalStatus === 'consistent') {
      status = 'consistent'
      origin = null
    } else {
      status = 'not_applicable'
    }
  } else if (aggregateMismatch) {
    aggregatesStatus = 'requires_review'
    if (taxMismatch && otherMismatch) origin = 'extracted_tax_and_other_taxes'
    else if (taxMismatch) origin = 'extracted_tax'
    else origin = 'extracted_other_taxes'

    if (totalCloses) {
      // Total cierra; la discrepancia es de clasificación/extracción de agregados.
      origin = 'aggregate_classification'
      status = 'requires_review'
      totalStatus = 'consistent'
    } else {
      status = 'inconsistent'
      if (headerExplainsTotal === false && !taxMismatch && !otherMismatch) {
        origin = 'unexplained_total'
      }
    }
  } else {
    aggregatesStatus = 'consistent'
    if (totalStatus === 'inconsistent') {
      status = 'inconsistent'
      origin = 'unexplained_total'
    } else {
      status = totalStatus === 'not_applicable' ? 'not_applicable' : 'consistent'
      origin = null
    }
  }

  return {
    extracted: {
      tax: money(extractedTax),
      otherTaxes: money(extractedOtherTaxes),
      total: document.amounts.total,
    },
    calculated: {
      taxFromIvaLines: money(taxFromIvaLines),
      otherTaxesFromFiscalLines: money(otherTaxesFromFiscalLines),
      totalFromExtractedHeader:
        totalFromExtractedHeader == null ? null : money(totalFromExtractedHeader),
      totalFromFiscalLines: totalFromFiscalLines == null ? null : money(totalFromFiscalLines),
    },
    differences: {
      tax: money(taxDifference),
      otherTaxes: money(otherTaxesDifference),
      extractedHeaderVsTotal,
      fiscalLinesVsTotal,
    },
    totalStatus,
    aggregatesStatus,
    checks: {
      taxMatchesIvaLines,
      otherTaxesMatchPerceptionLines,
      headerExplainsTotal,
      fiscalLinesExplainTotal,
    },
    origin,
    status,
  }
}

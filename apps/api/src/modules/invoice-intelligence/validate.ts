import { Decimal } from 'decimal.js'
import { analyzeInvoiceLinePricing } from '../../http/invoiceUnits.js'
import { reconcileFiscalAmounts } from './fiscalReconciliation.js'
import type {
  InvoiceCommercialInterpretation,
  InvoiceIssue,
  InvoiceValidation,
  NormalizedInvoiceDocument,
  NormalizedInvoiceLine,
} from './types.js'

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP })

const MONEY_TOLERANCE = new Decimal('0.05')

function decimal(value: number | null | undefined): Decimal {
  return new Decimal(value ?? 0)
}

function money(value: Decimal): number {
  return value.toDecimalPlaces(2).toNumber()
}

function issue(
  code: string,
  severity: InvoiceIssue['severity'],
  message: string,
  options: Partial<Omit<InvoiceIssue, 'code' | 'severity' | 'message'>> = {},
): InvoiceIssue {
  return {
    code,
    severity,
    message,
    blocksReview: severity === 'error',
    blocksReception: severity !== 'warning',
    ...options,
  }
}

function normalizeTaxId(value: string): string {
  return value.replace(/\D/g, '')
}

function looksLikeArgentineInvoiceNumber(value: string): boolean {
  const compact = value.trim().toUpperCase().replace(/\s+/g, '')
  return /^[A-E]-?\d{4}-?\d{8}$/.test(compact) || /^\d{4}-\d{8}$/.test(compact)
}

function looksLikeAuxiliaryIdentifier(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return /^\d{8,14}$/.test(digits) && !looksLikeArgentineInvoiceNumber(value)
}

function identifierCollision(documentNumber: string, identifiers: Array<string | null>): boolean {
  const normalized = documentNumber.replace(/\D/g, '')
  if (!normalized) return false
  return identifiers.some(
    (identifier) => identifier != null && identifier.replace(/\D/g, '') === normalized,
  )
}

export function isValidArgentineCuit(value: string): boolean {
  const digits = normalizeTaxId(value)
  if (!/^\d{11}$/.test(digits)) return false
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0)
  const remainder = 11 - (sum % 11)
  const verifier = remainder === 11 ? 0 : remainder === 10 ? 9 : remainder
  return verifier === Number(digits[10])
}

function validateLineMath(line: NormalizedInvoiceLine): InvoiceIssue[] {
  if (['fiscal', 'ignored'].includes(line.classification)) return []
  const issues: InvoiceIssue[] = []

  for (const field of line.missingFields) {
    issues.push(
      issue('LINE_FIELD_MISSING', 'pending', `Falta ${field} en "${line.name || 'línea'}".`, {
        field,
        lineId: line.id,
      }),
    )
  }
  for (const ambiguity of line.ambiguities) {
    issues.push(
      issue('LINE_REQUIRES_CONFIRMATION', 'pending', ambiguity, { lineId: line.id }),
    )
  }

  if (line.quantity != null && line.unitPrice != null && line.amount != null) {
    const pricing = analyzeInvoiceLinePricing({
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      amount: line.amount,
      discount: line.discount,
      contentPerUnit: line.contentPerUnit,
      contentUnit: line.contentUnit,
      billedWeight: line.billedWeight,
      billedWeightUnit: line.billedWeightUnit,
      packageCount: line.packageCount,
    })
    if (pricing.priceBasis === 'weight' && pricing.amountExplainedByWeight) {
      // Precio por kg (u otra masa): no exigir cantidad comercial × precio = importe.
    } else if (
      pricing.priceBasis === 'ambiguous'
      && pricing.billedWeight != null
      && pricing.commercialExpectedAmount != null
      && pricing.weightExpectedAmount != null
      && decimal(pricing.commercialExpectedAmount)
        .minus(pricing.weightExpectedAmount)
        .abs()
        .gt(MONEY_TOLERANCE)
    ) {
      // Ambigüedad real: unidad comercial vs peso facturado producen expectativas distintas.
      const commercialDiff = money(
        decimal(pricing.commercialExpectedAmount).minus(line.amount).abs(),
      )
      issues.push(
        issue(
          'LINE_PRICE_BASIS_REQUIRES_REVIEW',
          'pending',
          `No se pudo confirmar si el precio de "${line.name}" es por unidad comercial o por peso. Revisá peso o precio sin inventar valores.`,
          {
            lineId: line.id,
            difference: commercialDiff,
            blocksReception: true,
          },
        ),
      )
    } else {
      const expected = decimal(line.quantity)
        .times(line.unitPrice)
        .minus(line.discount ?? 0)
      const difference = expected.minus(line.amount).abs()
      if (difference.gt(MONEY_TOLERANCE)) {
        issues.push(
          issue(
            'LINE_AMOUNT_MISMATCH',
            'error',
            `Cantidad × precio no coincide con el importe de "${line.name}".`,
            {
              lineId: line.id,
              difference: money(difference),
            },
          ),
        )
      }
    }
  }

  if ((line.quantity ?? 0) < 0 && !/nota.*credito/i.test(String(line.raw.document_type ?? ''))) {
    issues.push(
      issue('NEGATIVE_QUANTITY', 'warning', `La cantidad de "${line.name}" es negativa.`, {
        lineId: line.id,
      }),
    )
  }
  if (line.inventoryEligibility === 'eligible' && (!line.unit || line.quantity == null)) {
    issues.push(
      issue(
        'INVENTORY_QUANTITY_INCOMPLETE',
        'pending',
        `La línea "${line.name}" necesita cantidad y unidad antes de una recepción.`,
        { lineId: line.id },
      ),
    )
  }
  return issues
}

function duplicateIssues(lines: NormalizedInvoiceLine[]): InvoiceIssue[] {
  const seen = new Map<string, NormalizedInvoiceLine>()
  const issues: InvoiceIssue[] = []
  for (const line of lines) {
    if (['fiscal', 'ignored'].includes(line.classification)) continue
    const key = [
      line.supplierSku?.toLowerCase() ?? '',
      line.originalDescription.toLowerCase(),
      line.quantity ?? '',
      line.amount ?? '',
    ].join('|')
    const previous = seen.get(key)
    if (previous) {
      issues.push(
        issue(
          'POSSIBLE_DUPLICATE_LINE',
          'warning',
          `Las líneas "${previous.name}" y "${line.name}" podrían estar duplicadas.`,
          { lineId: line.id },
        ),
      )
    } else {
      seen.set(key, line)
    }
  }
  return issues
}

export function validateInvoice(
  document: NormalizedInvoiceDocument,
  interpretation?: InvoiceCommercialInterpretation,
): InvoiceValidation {
  const issues: InvoiceIssue[] = []
  const extractedWarnings = [
    ...(Array.isArray(document.raw.warnings) ? document.raw.warnings : []),
    ...(Array.isArray(document.raw.advertencias) ? document.raw.advertencias : []),
  ]
  const doubtfulFields = [
    ...(Array.isArray(document.raw.doubtful_fields) ? document.raw.doubtful_fields : []),
    ...(Array.isArray(document.raw.campos_dudosos) ? document.raw.campos_dudosos : []),
  ]

  for (const warning of extractedWarnings) {
    if (typeof warning === 'string' && warning.trim()) {
      issues.push(issue('AI_EXTRACTION_WARNING', 'warning', warning.trim()))
    }
  }
  for (const field of doubtfulFields) {
    if (typeof field === 'string' && field.trim()) {
      issues.push(
        issue('AI_FIELD_DOUBTFUL', 'pending', `Gemini marcó "${field.trim()}" como dudoso.`, {
          field: field.trim(),
        }),
      )
    }
  }

  if (!document.supplier.name) {
    issues.push(issue('SUPPLIER_MISSING', 'error', 'Falta identificar al proveedor.', { field: 'supplier.name' }))
  }
  if (!document.supplier.taxId) {
    issues.push(issue('SUPPLIER_TAX_ID_MISSING', 'pending', 'Falta confirmar el CUIT del proveedor.', {
      field: 'supplier.taxId',
    }))
  } else if (!isValidArgentineCuit(document.supplier.taxId)) {
    issues.push(issue('SUPPLIER_TAX_ID_INVALID', 'warning', 'El CUIT del proveedor no supera la validación formal.', {
      field: 'supplier.taxId',
    }))
  }
  if (!document.document.type) {
    issues.push(issue('DOCUMENT_TYPE_MISSING', 'pending', 'Falta confirmar el tipo de comprobante.', {
      field: 'document.type',
    }))
  }
  if (!document.document.number) {
    issues.push(issue('DOCUMENT_NUMBER_MISSING', 'pending', 'Falta confirmar el número de comprobante.', {
      field: 'document.number',
    }))
  }
  if (!document.document.issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(document.document.issueDate)) {
    issues.push(issue('ISSUE_DATE_MISSING_OR_INVALID', 'pending', 'Falta confirmar una fecha de emisión válida.', {
      field: 'document.issueDate',
    }))
  }
  if (
    document.document.number &&
    (looksLikeAuxiliaryIdentifier(document.document.number) ||
      identifierCollision(document.document.number, [
        document.document.clientNumber,
        document.document.meterNumber,
        document.document.paymentCode,
        document.document.printNumber,
      ]))
  ) {
    issues.push(
      issue(
        'DOCUMENT_NUMBER_LOOKS_LIKE_IDENTIFIER',
        'warning',
        'El número de comprobante se parece a un identificador auxiliar (cliente, medidor, pago o impresión).',
        { field: 'document.number', blocksReception: false },
      ),
    )
  }
  if (
    document.document.issueDate &&
    document.document.dueDate &&
    document.document.issueDate === document.document.dueDate
  ) {
    issues.push(
      issue(
        'ISSUE_DATE_EQUALS_DUE_DATE',
        'warning',
        'La fecha de emisión coincide con el vencimiento; conviene confirmar que no se tomó la fecha de vencimiento.',
        { field: 'document.issueDate', blocksReception: false },
      ),
    )
  }
  if (document.document.currencyNeedsConfirmation) {
    issues.push(
      issue(
        'CURRENCY_REQUIRES_CONFIRMATION',
        'pending',
        `La moneda "${document.document.currency}" requiere confirmación.`,
        { field: 'document.currency' },
      ),
    )
  }
  if (document.amounts.subtotal == null) {
    issues.push(issue('SUBTOTAL_MISSING', 'error', 'Falta el subtotal del comprobante.', { field: 'amounts.subtotal' }))
  }
  if (document.amounts.total == null) {
    issues.push(issue('TOTAL_MISSING', 'error', 'Falta el total del comprobante.', { field: 'amounts.total' }))
  }
  if (document.lines.length === 0) {
    issues.push(issue('LINES_MISSING', 'error', 'El comprobante no contiene líneas interpretables.', {
      field: 'lines',
    }))
  }

  for (const line of document.lines) issues.push(...validateLineMath(line))
  issues.push(...duplicateIssues(document.lines))

  const commercialLines = document.lines.filter(
    (line) => !['fiscal', 'ignored'].includes(line.classification) && line.amount != null,
  )
  const linesSum = commercialLines.reduce((total, line) => total.plus(line.amount ?? 0), new Decimal(0))
  let linesVsSubtotal: number | null = null
  if (document.amounts.subtotal != null && commercialLines.length > 0) {
    const difference = linesSum.minus(document.amounts.subtotal).abs()
    linesVsSubtotal = money(difference)
    if (difference.gt(MONEY_TOLERANCE)) {
      issues.push(
        issue('LINES_SUBTOTAL_MISMATCH', 'error', 'La suma de líneas no coincide con el subtotal.', {
          difference: linesVsSubtotal,
        }),
      )
    }
  }

  const fiscalReconciliation = reconcileFiscalAmounts(document)
  let calculatedVsTotal = fiscalReconciliation.differences.extractedHeaderVsTotal

  // 1) Total final
  if (fiscalReconciliation.totalStatus === 'inconsistent') {
    issues.push(
      issue(
        'DOCUMENT_TOTAL_MISMATCH',
        'error',
        'Subtotal, descuentos e impuestos no explican el total informado.',
        { difference: calculatedVsTotal ?? fiscalReconciliation.differences.fiscalLinesVsTotal ?? undefined },
      ),
    )
  }

  // 2) IVA / percepciones (agregados internos) — sin afirmar inconsistencia del total si este cierra
  if (fiscalReconciliation.aggregatesStatus === 'requires_review') {
    const field =
      fiscalReconciliation.origin === 'extracted_tax'
        ? 'amounts.taxes'
        : fiscalReconciliation.origin === 'extracted_other_taxes'
          ? 'amounts.otherTaxes'
          : 'amounts.taxes'
    const difference =
      fiscalReconciliation.differences.otherTaxes || fiscalReconciliation.differences.tax
    if (fiscalReconciliation.totalStatus === 'consistent') {
      issues.push(
        issue(
          'FISCAL_AGGREGATE_CLASSIFICATION_MISMATCH',
          'warning',
          'El total del comprobante cierra, pero los agregados de IVA/percepciones no coinciden con las líneas fiscales clasificadas. Revisá la extracción o la clasificación; se conservaron los importes originales.',
          {
            field,
            difference,
            blocksReception: false,
          },
        ),
      )
    } else {
      issues.push(
        issue(
          'FISCAL_AGGREGATE_REQUIRES_REVIEW',
          'pending',
          'Los agregados extraídos no coinciden con las líneas fiscales. Se conservó el valor original y se informa el calculado para revisión.',
          {
            field,
            difference,
            blocksReception: true,
          },
        ),
      )
    }
  }

  if (document.classification === 'service') {
    if (!document.service?.billingPeriod && !document.service?.periodStart) {
      issues.push(
        issue(
          'SERVICE_PERIOD_MISSING',
          'warning',
          'No se identificó el período facturado. No se inventó un valor.',
          { field: 'service.billingPeriod', blocksReception: false },
        ),
      )
    }
    const inventoryQuantity = document.lines.reduce(
      (total, line) => total + line.inventoryPhysicalQuantity,
      0,
    )
    if (inventoryQuantity !== 0) {
      issues.push(
        issue(
          'SERVICE_INVENTORY_QUANTITY_NOT_ZERO',
          'error',
          'Una factura de servicios no debe proponer cantidad física de inventario.',
        ),
      )
    }
  }
  if (document.classification === 'ambiguous') {
    issues.push(
      issue('DOCUMENT_CLASSIFICATION_AMBIGUOUS', 'pending', 'La clasificación documental requiere confirmación.'),
    )
  }
  const contradiction = document.lines.some((line) =>
    line.ambiguities.some((ambiguity) => /documento fue clasificado/i.test(ambiguity)),
  )
  if (contradiction) {
    issues.push(
      issue(
        'DOCUMENT_LINE_CONTRADICTION',
        'pending',
        'Hay señales contradictorias entre la clasificación del documento y sus líneas.',
      ),
    )
  }

  if (interpretation) {
    for (const relation of interpretation.relations) {
      if (relation.status === 'proposed' || relation.status === 'requires_review') {
        issues.push(
          issue(
            relation.targetLineId
              ? 'COMMERCIAL_RELATION_REQUIRES_CONFIRMATION'
              : 'COMMERCIAL_ADJUSTMENT_UNALLOCATED',
            'pending',
            relation.targetLineId
              ? 'Una bonificación o descuento relacionado requiere confirmación.'
              : 'Existe un descuento o ajuste que no puede asignarse de forma segura.',
            { lineId: relation.adjustmentLineIds[0] },
          ),
        )
      }
      for (const warning of relation.warnings) {
        issues.push(
          issue('COMMERCIAL_INTERPRETATION_WARNING', 'warning', warning, {
            lineId: relation.adjustmentLineIds[0],
            blocksReception: false,
          }),
        )
      }
    }
    const unresolvedWithoutRelation = interpretation.lines.filter(
      (line) =>
        line.status === 'requires_review' &&
        !interpretation.relations.some((relation) =>
          [...relation.adjustmentLineIds, ...relation.candidateTargetLineIds].includes(line.lineId),
        ),
    )
    for (const line of unresolvedWithoutRelation) {
      issues.push(
        issue(
          line.operation === 'return'
            ? 'RETURN_REQUIRES_CONFIRMATION'
            : 'COMMERCIAL_OPERATION_REQUIRES_CONFIRMATION',
          'pending',
          line.operation === 'return'
            ? 'La devolución requiere confirmar su impacto físico.'
            : 'La interpretación comercial de una línea requiere confirmación.',
          { lineId: line.lineId },
        ),
      )
    }
  }

  const errors = issues.filter((item) => item.severity === 'error')
  const warnings = issues.filter((item) => item.severity === 'warning')
  const pendingConfirmations = issues.filter((item) => item.severity === 'pending')
  const status = errors.length > 0
    ? 'invalid'
    : pendingConfirmations.length > 0
      ? 'requires_review'
      : 'ready'
  const mathematicalCodes = new Set([
    'LINE_AMOUNT_MISMATCH',
    'LINES_SUBTOTAL_MISMATCH',
    'DOCUMENT_TOTAL_MISMATCH',
  ])
  const fiscalCodes = new Set([
    'SUPPLIER_MISSING',
    'SUPPLIER_TAX_ID_MISSING',
    'SUPPLIER_TAX_ID_INVALID',
    'DOCUMENT_TYPE_MISSING',
    'DOCUMENT_NUMBER_MISSING',
    'ISSUE_DATE_MISSING_OR_INVALID',
    'SUBTOTAL_MISSING',
    'TOTAL_MISSING',
    'CURRENCY_REQUIRES_CONFIRMATION',
    'FISCAL_AGGREGATE_REQUIRES_REVIEW',
    'FISCAL_AGGREGATE_CLASSIFICATION_MISMATCH',
  ])
  const mathematicalIssues = issues.filter((item) => mathematicalCodes.has(item.code))
  const fiscalIssues = issues.filter((item) => fiscalCodes.has(item.code))
  const fiscalDimensionStatus = (() => {
    if (fiscalReconciliation.totalStatus === 'inconsistent') return 'inconsistent' as const
    const fromIssues = fiscalIssues.some((item) => item.severity === 'error')
      ? 'inconsistent' as const
      : fiscalIssues.some((item) => item.severity === 'pending')
        ? 'requires_review' as const
        : fiscalIssues.some((item) => item.severity === 'warning')
          ? 'requires_review' as const
          : 'consistent' as const
    const fromReconciliation = fiscalReconciliation.status
    const rank = { inconsistent: 3, requires_review: 2, consistent: 1, not_applicable: 0 }
    return rank[fromReconciliation] >= rank[fromIssues] ? fromReconciliation : fromIssues
  })()
  const pendingInventory = document.lines.filter(
    (line) => line.inventoryEligibility === 'pending_review',
  )
  const hasInventoryLines = document.lines.some(
    (line) => line.classification === 'stock',
  )

  return {
    status,
    errors,
    warnings,
    pendingConfirmations,
    differences: { linesVsSubtotal, calculatedVsTotal },
    fiscalReconciliation,
    consistency:
      errors.length > 0
        ? 'inconsistent'
        : pendingConfirmations.length > 0
          ? 'undetermined'
          : 'consistent',
    dimensions: {
      mathematical: {
        status: mathematicalIssues.some((item) => item.severity === 'error')
          ? 'inconsistent'
          : 'consistent',
        issues: mathematicalIssues.map((item) => item.code),
      },
      fiscal: {
        status: fiscalDimensionStatus,
        issues: [
          ...fiscalIssues.map((item) => item.code),
          ...(fiscalReconciliation.status !== 'consistent' && fiscalReconciliation.status !== 'not_applicable'
            ? [fiscalReconciliation.origin ?? fiscalReconciliation.status]
            : []),
        ],
      },
      commercial: {
        status:
          interpretation?.consistency === 'inconsistent'
            ? 'inconsistent'
            : interpretation?.consistency === 'requires_review'
              ? 'requires_review'
              : 'consistent',
        issues: issues
          .filter((item) =>
            item.code.startsWith('COMMERCIAL_') || item.code.startsWith('RETURN_'),
          )
          .map((item) => item.code),
      },
      inventory: {
        status: !hasInventoryLines
          ? 'not_applicable'
          : pendingInventory.length > 0 || interpretation?.blocksReception
            ? 'requires_review'
            : 'consistent',
        issues: pendingInventory.map((line) => line.id),
      },
    },
    blocksReception:
      errors.length > 0 ||
      pendingConfirmations.some((item) => item.blocksReception) ||
      interpretation?.blocksReception === true,
    mathematicallyConsistent:
      mathematicalIssues.length === 0,
  }
}

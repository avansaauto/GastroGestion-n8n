import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  InvoiceAnalysisResult,
  InvoiceDocumentInput,
} from './types.js'

export const MAX_LOCAL_INVOICE_BYTES = 10 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, InvoiceDocumentInput['mimeType']> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export class InvoiceUploadError extends Error {
  constructor(
    message: string,
    public readonly code: 'EMPTY' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'INVALID_SIGNATURE',
  ) {
    super(message)
    this.name = 'InvoiceUploadError'
  }
}

export function detectInvoiceMimeFromSignature(
  buffer: Buffer,
): InvoiceDocumentInput['mimeType'] | null {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export function inspectInvoiceBuffer(
  buffer: Buffer,
  options: {
    filename?: string
    declaredMimeType?: string
    maxBytes?: number
  } = {},
): InvoiceDocumentInput {
  const maxBytes = options.maxBytes ?? MAX_LOCAL_INVOICE_BYTES
  if (buffer.length <= 0) {
    throw new InvoiceUploadError('El archivo está vacío.', 'EMPTY')
  }
  if (buffer.length > maxBytes) {
    throw new InvoiceUploadError('El archivo supera el máximo permitido de 10 MB.', 'TOO_LARGE')
  }

  const mimeFromSignature = detectInvoiceMimeFromSignature(buffer)
  const extension = path.extname(options.filename ?? '').toLowerCase()
  const mimeFromName = extension ? MIME_BY_EXTENSION[extension] : undefined
  if (mimeFromName && mimeFromName !== mimeFromSignature) {
    throw new InvoiceUploadError(
      'La firma del archivo no coincide con su extensión.',
      'INVALID_SIGNATURE',
    )
  }
  if (!mimeFromSignature) {
    throw new InvoiceUploadError(
      'El documento no es un PDF, JPEG, PNG o WebP válido.',
      'UNSUPPORTED_TYPE',
    )
  }

  const declared = options.declaredMimeType?.toLowerCase().split(';')[0]?.trim()
  if (declared && declared !== 'application/octet-stream' && declared !== mimeFromSignature) {
    throw new InvoiceUploadError(
      'La firma del archivo no coincide con el tipo declarado.',
      'INVALID_SIGNATURE',
    )
  }

  return {
    filename: options.filename ? path.basename(options.filename) : undefined,
    mimeType: mimeFromSignature,
    base64: buffer.toString('base64'),
  }
}

export async function readLocalInvoice(
  filePath: string,
): Promise<InvoiceDocumentInput & { absolutePath: string; size: number }> {
  const absolutePath = path.resolve(filePath)
  let fileStats
  try {
    fileStats = await stat(absolutePath)
  } catch {
    throw new Error(`No existe el archivo indicado: ${absolutePath}`)
  }
  if (!fileStats.isFile()) throw new Error('La ruta indicada no corresponde a un archivo.')
  if (fileStats.size <= 0) throw new Error('El archivo está vacío.')
  if (fileStats.size > MAX_LOCAL_INVOICE_BYTES) {
    throw new Error('El archivo supera el máximo permitido de 10 MB.')
  }

  const buffer = await readFile(absolutePath)
  let inspected
  try {
    inspected = inspectInvoiceBuffer(buffer, { filename: path.basename(absolutePath) })
  } catch (error) {
    throw error instanceof InvoiceUploadError ? new Error(error.message) : error
  }

  return {
    absolutePath,
    size: fileStats.size,
    filename: inspected.filename,
    mimeType: inspected.mimeType,
    base64: inspected.base64,
  }
}

export function formatInvoiceAnalysisSummary(result: InvoiceAnalysisResult): string {
  const interpretationByLine = new Map(
    result.interpretation.lines.map((line) => [line.lineId, line]),
  )
  const lines = result.document.lines.map((line, index) => {
    const interpretation = interpretationByLine.get(line.id)
    return [
      `${index + 1}. ${line.name || line.originalDescription || 'Sin descripción'}`,
      `   clase=${line.classification}`,
      `inventario=${line.inventoryEligibility}`,
      interpretation ? `operación=${interpretation.operation}` : null,
      interpretation ? `estado_comercial=${interpretation.status}` : null,
      interpretation ? `movimiento_físico=${interpretation.physical.movement}` : null,
      `cantidad=${line.quantity ?? 'pendiente'} ${line.unit ?? ''}`.trimEnd(),
      `tipo_cantidad=${line.quantityKind}`,
      `cantidad_física=${line.inventoryPhysicalQuantity}`,
      `importe=${line.amount ?? 'pendiente'}`,
      line.ambiguities.length ? `ambigüedades=${line.ambiguities.join('; ')}` : null,
    ].filter(Boolean).join(' · ')
  })
  const relations = result.interpretation.relations.map((relation) =>
    `Relación ${relation.type} (${relation.status}): bruto=${relation.grossAmount ?? 'pendiente'} bonificación=${relation.bonusAmount} neto=${relation.netAcquisitionAmount ?? 'pendiente'} porcentaje=${relation.bonusPercentage ?? 'pendiente'}% cantidad_física=${relation.proposedPhysicalQuantity ?? 'pendiente'} ${relation.unit ?? ''}`.trimEnd(),
  )
  const issueLines = [
    ...result.validation.errors.map((item) => `ERROR ${item.code}: ${item.message}`),
    ...result.validation.warnings.map((item) => `ADVERTENCIA ${item.code}: ${item.message}`),
    ...result.validation.pendingConfirmations.map(
      (item) => `PENDIENTE ${item.code}: ${item.message}`,
    ),
  ]

  return [
    'SENDA OPS — resultado de lectura',
    `Modelo: ${result.metadata.provider}/${result.metadata.model}`,
    `Duración: ${result.metadata.processingTimeMs} ms`,
    `Proveedor: ${result.document.supplier.name ?? 'pendiente'}`,
    `CUIT: ${result.document.supplier.taxId ?? 'pendiente'}`,
    `Comprobante: ${result.document.document.type ?? 'pendiente'} ${result.document.document.number ?? ''}`.trimEnd(),
    `Fecha: ${result.document.document.issueDate ?? 'pendiente'}`,
    `Vencimiento: ${result.document.document.dueDate ?? 'no informado'}`,
    `Clasificación: ${result.document.classification}`,
    result.document.service
      ? `Servicio: tipo=${result.document.service.type} período=${result.document.service.billingPeriod ?? result.document.service.periodStart ?? 'no informado'} consumo_real=${result.document.service.actualConsumption ? `${result.document.service.actualConsumption.quantity} ${result.document.service.actualConsumption.unit}` : 'no informado'} consumo_facturado=${result.document.service.billedConsumption ? `${result.document.service.billedConsumption.quantity} ${result.document.service.billedConsumption.unit}` : 'no informado'} cantidad_física_inventario=${result.document.service.inventoryPhysicalQuantity}`
      : null,
    `Estado de revisión: ${result.document.reviewStatus}`,
    `Líneas: ${result.document.lines.length}`,
    ...lines,
    ...(relations.length ? ['Relaciones comerciales:', ...relations] : []),
    `Importes: subtotal=${result.document.amounts.subtotal ?? 'pendiente'} impuestos=${result.document.amounts.taxes} otros=${result.document.amounts.otherTaxes} descuentos=${result.document.amounts.discounts} total=${result.document.amounts.total ?? 'pendiente'} ${result.document.document.currency}`,
    `Diferencias: líneas/subtotal=${result.validation.differences.linesVsSubtotal ?? 'indeterminada'} total=${result.validation.differences.calculatedVsTotal ?? 'indeterminada'}`,
    `Inventario: elegibles=${result.inventorySummary.eligibleLines} pendientes=${result.inventorySummary.pendingLines} ofrecer_recepción=${result.inventorySummary.shouldOfferFutureReceipt ? 'sí' : 'no'}`,
    `Consistencia: ${result.validation.consistency}; recepción bloqueada=${result.validation.blocksReception ? 'sí' : 'no'}`,
    issueLines.length ? 'Observaciones:' : 'Observaciones: ninguna',
    ...issueLines,
    'Nota: este resultado requiere comparación humana con el documento original.',
  ].filter((line): line is string => line != null).join('\n')
}

export async function saveLocalAnalysisResult(
  result: InvoiceAnalysisResult,
  sourceFilename: string,
  outputRoot = path.resolve('.local/invoice-analysis'),
): Promise<string> {
  await mkdir(outputRoot, { recursive: true })
  const safeBase =
    path.basename(sourceFilename, path.extname(sourceFilename))
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'invoice'
  const outputPath = path.join(outputRoot, `${safeBase}-${Date.now()}.json`)
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return outputPath
}

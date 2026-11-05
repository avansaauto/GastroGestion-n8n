import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeExtractedInvoice } from './analyze.js'
import {
  InvoiceUploadError,
  MAX_LOCAL_INVOICE_BYTES,
  formatInvoiceAnalysisSummary,
  inspectInvoiceBuffer,
  readLocalInvoice,
  saveLocalAnalysisResult,
} from './localInvoiceTool.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'senda-invoice-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('herramienta local de facturas', () => {
  it('detecta la firma real y rechaza MIME o extensión falsos', () => {
    const pdf = Buffer.from('%PDF-1.4\nfixture')
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

    expect(inspectInvoiceBuffer(pdf, { filename: 'factura.pdf' }).mimeType).toBe('application/pdf')
    expect(() => inspectInvoiceBuffer(jpeg, { filename: 'factura.pdf' })).toThrow(InvoiceUploadError)
    expect(() => inspectInvoiceBuffer(Buffer.alloc(12), { maxBytes: 8 })).toThrow(/10 MB/)
  })

  it('lee un PDF válido y prepara base64 sin persistirlo', async () => {
    const directory = await temporaryDirectory()
    const invoicePath = path.join(directory, 'factura.pdf')
    await writeFile(invoicePath, Buffer.from('%PDF-1.4\nfixture local'))

    const input = await readLocalInvoice(invoicePath)

    expect(input.mimeType).toBe('application/pdf')
    expect(input.filename).toBe('factura.pdf')
    expect(Buffer.from(input.base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('rechaza archivos inexistentes, formatos falsos y archivos mayores a 10 MB', async () => {
    const directory = await temporaryDirectory()
    await expect(readLocalInvoice(path.join(directory, 'no-existe.pdf'))).rejects.toThrow(/No existe/)

    const falsePdf = path.join(directory, 'falso.pdf')
    await writeFile(falsePdf, 'no es pdf')
    await expect(readLocalInvoice(falsePdf)).rejects.toThrow(/no coincide/)

    const largePdf = path.join(directory, 'grande.pdf')
    await writeFile(largePdf, '%PDF-')
    await truncate(largePdf, MAX_LOCAL_INVOICE_BYTES + 1)
    await expect(readLocalInvoice(largePdf)).rejects.toThrow(/10 MB/)
  })

  it('resume datos relevantes sin incluir el documento crudo o base64', () => {
    const result = analyzeExtractedInvoice({
      supplier_name: 'Proveedor Demo',
      supplier_tax_id: '30-12345678-1',
      document_type: 'Factura A',
      document_number: '0001-00000001',
      issue_date: '2026-10-01',
      main_category: 'gastronomic_merchandise',
      subtotal: 10,
      total: 10,
      lines: [{ description_original: 'Harina', quantity: 1, unit: 'kg', unit_price: 10, amount: 10 }],
    })

    const summary = formatInvoiceAnalysisSummary(result)

    expect(summary).toContain('Proveedor Demo')
    expect(summary).toContain('clase=stock')
    expect(summary).not.toContain('"raw"')
    expect(summary).not.toContain('base64')
  })

  it('guarda el JSON solo cuando se invoca la función opcional', async () => {
    const directory = await temporaryDirectory()
    const result = analyzeExtractedInvoice({
      supplier_name: 'Proveedor Demo',
      subtotal: 0,
      total: 0,
      lines: [],
    })

    const outputPath = await saveLocalAnalysisResult(result, '../factura privada.pdf', directory)
    const saved = JSON.parse(await readFile(outputPath, 'utf8'))

    expect(path.dirname(outputPath)).toBe(directory)
    expect(path.basename(outputPath)).toMatch(/^factura-privada-\d+\.json$/)
    expect(saved.metadata.promptVersion).toBe('senda-invoice-v3-billed-weight')
  })
})

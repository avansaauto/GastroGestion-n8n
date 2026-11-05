import { INVOICE_ACCEPT, INVOICE_EXTENSIONS, INVOICE_MAX_BYTES } from './constants'
import type { SelectedInvoiceFile } from './types'

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export type InvoiceFileErrorCode = 'INVALID_TYPE' | 'TOO_LARGE' | 'EMPTY'

export type InvoiceFileValidation =
  | { ok: true; selected: Omit<SelectedInvoiceFile, 'file'> & { type: string } }
  | { ok: false; code: InvoiceFileErrorCode; message: string }

function extensionOf(name: string) {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

export function resolvedInvoiceMime(name: string, type: string) {
  const declared = type.toLowerCase().split(';')[0]?.trim()
  if (declared && INVOICE_ACCEPT.includes(declared as (typeof INVOICE_ACCEPT)[number])) {
    return declared
  }
  return MIME_BY_EXTENSION[extensionOf(name)] ?? ''
}

export function validateInvoiceFile(input: {
  name: string
  type: string
  size: number
}): InvoiceFileValidation {
  if (input.size <= 0) {
    return { ok: false, code: 'EMPTY', message: 'El archivo está vacío.' }
  }
  if (input.size > INVOICE_MAX_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: 'El archivo supera el máximo permitido de 10 MB.',
    }
  }
  const mime = resolvedInvoiceMime(input.name, input.type)
  const extension = extensionOf(input.name)
  if (!mime || (extension && !INVOICE_EXTENSIONS.includes(extension as (typeof INVOICE_EXTENSIONS)[number]))) {
    return {
      ok: false,
      code: 'INVALID_TYPE',
      message: 'Usá un PDF, JPG, PNG o WebP.',
    }
  }
  return {
    ok: true,
    selected: { name: input.name, type: mime, size: input.size },
  }
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatFileKind(name: string, type: string) {
  const mime = resolvedInvoiceMime(name, type)
  if (mime === 'application/pdf') return 'PDF'
  if (mime === 'image/jpeg') return 'JPEG'
  if (mime === 'image/png') return 'PNG'
  if (mime === 'image/webp') return 'WebP'
  return 'Archivo'
}

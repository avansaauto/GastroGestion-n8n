import type { SupabaseClient } from '@supabase/supabase-js'
import { InvoiceQueryError } from './invoiceQueryError.js'
import { InvoiceSaveError } from './invoiceSaveError.js'
import { INVOICE_SAVE_STRATEGY } from './invoiceSaveStrategy.js'

export const INVOICE_SIGNED_URL_TTL_SECONDS = 120

/** Configuración prevista del bucket. No se crea desde la API. */
export const INVOICE_STORAGE_BUCKET_CONFIG = {
  id: INVOICE_SAVE_STRATEGY.storageBucket,
  public: false,
  fileSizeLimit: 10 * 1024 * 1024,
  allowedMimeTypes: [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
  ],
} as const

export function invoiceStorageBucket(): string {
  const fromEnv = process.env.INVOICE_STORAGE_BUCKET?.trim()
  return fromEnv || INVOICE_SAVE_STRATEGY.storageBucket
}

export function extensionFromMime(mimeType: string): string {
  switch (mimeType) {
    case 'application/pdf':
      return 'pdf'
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}

export async function uploadInvoiceObject(
  admin: SupabaseClient,
  input: {
    path: string
    bytes: Buffer
    contentType: string
  },
): Promise<{ bucket: string; path: string }> {
  const bucket = invoiceStorageBucket()
  const { error } = await admin.storage.from(bucket).upload(input.path, input.bytes, {
    contentType: input.contentType,
    upsert: true,
  })
  if (!error) return { bucket, path: input.path }

  const message = error.message ?? ''
  if (/bucket|not found|does not exist/i.test(message)) {
    throw new InvoiceSaveError(
      'El almacenamiento de facturas no está configurado.',
      'INVOICE_STORAGE_NOT_CONFIGURED',
      503,
    )
  }
  throw new InvoiceSaveError(
    'No se pudo guardar el archivo original.',
    'UPLOAD_FAILED',
    503,
  )
}

export function contentTypeFromStoragePath(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'pdf':
      return 'application/pdf'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    default:
      return null
  }
}

export async function createInvoiceSignedUrl(
  admin: SupabaseClient,
  path: string,
  expiresInSeconds = INVOICE_SIGNED_URL_TTL_SECONDS,
): Promise<{ url: string; expiresInSeconds: number }> {
  const bucket = invoiceStorageBucket()
  const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, expiresInSeconds)
  if (error || !data?.signedUrl) {
    throw new InvoiceQueryError(
      'No se pudo generar el enlace al documento original.',
      'SIGNED_URL_FAILED',
      503,
    )
  }
  return { url: data.signedUrl, expiresInSeconds }
}

export const INVOICE_MAX_BYTES = 10 * 1024 * 1024
/** Alineado al HTTP del backend (250 s) más un margen para el proxy de Vite. */
export const INVOICE_ANALYZE_TIMEOUT_MS = 260_000
/** Subida + RPC; más corto que el análisis de Gemini. */
export const INVOICE_SAVE_TIMEOUT_MS = 120_000
/** RPC de recepción de una línea. */
export const INVOICE_RECEIVE_TIMEOUT_MS = 60_000

export const INVOICE_ACCEPT = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

export const INVOICE_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'] as const

export const INVOICE_ACCEPT_ATTR = [
  ...INVOICE_ACCEPT,
  ...INVOICE_EXTENSIONS,
].join(',')

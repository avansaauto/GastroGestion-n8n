import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AuthenticatedRequest } from './auth.js'

export const INVOICE_ANALYZE_MAX_REQUESTS = 10
export const INVOICE_ANALYZE_WINDOW_MS = 15 * 60 * 1000

type RateLimitStore = Map<string, number[]>

export function createInvoiceAnalyzeRateLimit(options: {
  maxRequests?: number
  windowMs?: number
  store?: RateLimitStore
} = {}): RequestHandler {
  const maxRequests = options.maxRequests ?? INVOICE_ANALYZE_MAX_REQUESTS
  const windowMs = options.windowMs ?? INVOICE_ANALYZE_WINDOW_MS
  const store = options.store ?? new Map<string, number[]>()

  return function invoiceAnalyzeRateLimit(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    const userId = (request as AuthenticatedRequest).user?.id
    if (!userId) {
      response.status(401).json({ error: 'No autenticado.', code: 'UNAUTHENTICATED' })
      return
    }

    const now = Date.now()
    const recent = (store.get(userId) ?? []).filter((timestamp) => now - timestamp < windowMs)
    if (recent.length >= maxRequests) {
      store.set(userId, recent)
      response.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)))
      response.status(429).json({
        error: 'Se alcanzó el límite de análisis de facturas. Probá más tarde.',
        code: 'RATE_LIMITED',
      })
      return
    }

    recent.push(now)
    store.set(userId, recent)
    next()
  }
}

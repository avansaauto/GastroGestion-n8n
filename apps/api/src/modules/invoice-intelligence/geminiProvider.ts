import {
  InvoiceAiResponseError,
  extractGeminiText,
  parseGeminiJson,
} from './geminiJson.js'
import { INVOICE_EXTRACTION_PROMPT } from './prompt.js'
import type {
  AiExtractionResult,
  AiUsage,
  InvoiceAiProvider,
  InvoiceDocumentInput,
} from './types.js'

const GEMINI_API_VERSION = 'v1beta'
const DEFAULT_MODEL = 'gemini-3.5-flash-lite'
const DEFAULT_FALLBACK_MODEL = 'gemini-3.8-flash'
const DEFAULT_TIMEOUT_MS = 120_000
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
])

type FetchLike = typeof fetch

export type InvoiceAiProviderErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_INPUT'
  | 'AUTHENTICATION_FAILED'
  | 'REQUEST_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_RESPONSE'

/** Campos seguros para diagnóstico; nunca incluir API keys ni contenido de facturas. */
export type InvoiceAiProviderErrorMeta = {
  httpStatus?: number
  providerStatus?: string
  model?: string
}

export class InvoiceAiProviderError extends Error {
  constructor(
    message: string,
    public readonly code: InvoiceAiProviderErrorCode,
    public readonly meta: InvoiceAiProviderErrorMeta = {},
  ) {
    super(message)
    this.name = 'InvoiceAiProviderError'
  }
}

function providerStatusFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const error = (body as { error?: { status?: unknown; code?: unknown } }).error
  if (!error || typeof error !== 'object') return undefined
  if (typeof error.status === 'string' && error.status.trim()) return error.status.trim()
  if (typeof error.code === 'number') return String(error.code)
  if (typeof error.code === 'string' && error.code.trim()) return error.code.trim()
  return undefined
}

async function readProviderErrorMeta(
  response: Response,
  model: string,
): Promise<InvoiceAiProviderErrorMeta> {
  const meta: InvoiceAiProviderErrorMeta = {
    httpStatus: response.status,
    model,
  }
  try {
    const body = await response.json() as unknown
    const providerStatus = providerStatusFromBody(body)
    if (providerStatus) meta.providerStatus = providerStatus
  } catch {
    // Cuerpo no JSON: no hay más metadatos seguros.
  }
  return meta
}

export type GeminiProviderConfig = {
  apiKey: string
  model: string
  fallbackModel: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

function modelUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${encodeURIComponent(model)}:generateContent`
}

function cleanBase64(value: string): string {
  return value.replace(/^data:.*?;base64,/, '').replace(/\s/g, '').trim()
}

function isRecoverableHttpStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500
}

function assertExtractionShape(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvoiceAiProviderError(
      'Gemini no devolvió un objeto de factura.',
      'INVALID_RESPONSE',
    )
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.lines) && !Array.isArray(record.items)) {
    throw new InvoiceAiProviderError(
      'La respuesta de Gemini no contiene el listado de líneas.',
      'INVALID_RESPONSE',
    )
  }
}

function usageFrom(payload: unknown): AiUsage | undefined {
  const usage = (payload as {
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      totalTokenCount?: number
    }
  }).usageMetadata
  if (!usage) return undefined
  return {
    promptTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
  }
}

export class GeminiInvoiceProvider implements InvoiceAiProvider {
  private readonly fetchImpl: FetchLike
  private readonly apiKey: string

  constructor(private readonly config: GeminiProviderConfig) {
    this.apiKey = config.apiKey.trim()
    if (!this.apiKey) {
      throw new InvoiceAiProviderError(
        'Falta configurar GEMINI_API_KEY en el backend.',
        'NOT_CONFIGURED',
      )
    }
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async extract(input: InvoiceDocumentInput): Promise<AiExtractionResult> {
    const data = cleanBase64(input.base64)
    if (!data || !SUPPORTED_MIME_TYPES.has(input.mimeType)) {
      throw new InvoiceAiProviderError(
        'El documento debe ser un PDF, PNG, JPEG o WebP válido.',
        'INVALID_INPUT',
      )
    }

    const models = [...new Set([this.config.model, this.config.fallbackModel].filter(Boolean))]
    let lastError: unknown

    for (const model of models) {
      try {
        const response = await this.fetchImpl(modelUrl(model), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: INVOICE_EXTRACTION_PROMPT },
                { inlineData: { mimeType: input.mimeType, data } },
              ],
            }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
            },
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        })

        if (response.status === 401 || response.status === 403) {
          const meta = await readProviderErrorMeta(response, model)
          throw new InvoiceAiProviderError(
            'Gemini rechazó la configuración de autenticación.',
            'AUTHENTICATION_FAILED',
            meta,
          )
        }
        if (!response.ok) {
          const meta = await readProviderErrorMeta(response, model)
          if (isRecoverableHttpStatus(response.status)) {
            lastError = new InvoiceAiProviderError(
              `Gemini respondió con estado recuperable ${response.status}.`,
              'PROVIDER_UNAVAILABLE',
              meta,
            )
            continue
          }
          throw new InvoiceAiProviderError(
            `Gemini rechazó la solicitud con estado ${response.status}.`,
            'REQUEST_REJECTED',
            meta,
          )
        }

        const payload = await response.json() as unknown
        const { text, finishReason } = extractGeminiText(payload)
        if (!text || finishReason === 'MAX_TOKENS') {
          lastError = new InvoiceAiProviderError(
            'Gemini devolvió una respuesta vacía o incompleta.',
            'INVALID_RESPONSE',
            { model, providerStatus: finishReason ?? 'EMPTY' },
          )
          continue
        }

        const extracted = parseGeminiJson(text)
        assertExtractionShape(extracted)
        return {
          extracted,
          provider: 'gemini',
          model,
          usage: usageFrom(payload),
        }
      } catch (error) {
        if (error instanceof InvoiceAiResponseError) {
          lastError = new InvoiceAiProviderError(error.message, 'INVALID_RESPONSE', { model })
          continue
        }
        if (
          error instanceof InvoiceAiProviderError &&
          ['AUTHENTICATION_FAILED', 'REQUEST_REJECTED', 'INVALID_INPUT'].includes(error.code)
        ) {
          throw error
        }
        lastError = error
      }
    }

    if (lastError instanceof InvoiceAiProviderError) {
      throw new InvoiceAiProviderError(
        `No se pudo obtener una extracción válida de Gemini: ${lastError.message}`,
        lastError.code === 'INVALID_RESPONSE' ? 'INVALID_RESPONSE' : 'PROVIDER_UNAVAILABLE',
        lastError.meta,
      )
    }

    throw new InvoiceAiProviderError(
      lastError instanceof Error
        ? `No se pudo obtener una extracción válida de Gemini: ${lastError.message}`
        : 'Gemini no está disponible.',
      'PROVIDER_UNAVAILABLE',
    )
  }
}

export const DEFAULT_GEMINI_TIMEOUT_MS = DEFAULT_TIMEOUT_MS

export function createGeminiInvoiceProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: FetchLike } = {},
): GeminiInvoiceProvider {
  const timeoutMs = Number(env.GEMINI_TIMEOUT_MS)
  return new GeminiInvoiceProvider({
    apiKey: (env.GEMINI_API_KEY ?? '').trim(),
    model: (env.GEMINI_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    fallbackModel: (env.GEMINI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL).trim() || DEFAULT_FALLBACK_MODEL,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  })
}

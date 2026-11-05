import { describe, expect, it, vi } from 'vitest'
import {
  GeminiInvoiceProvider,
  InvoiceAiProviderError,
} from './geminiProvider.js'

function geminiResponse(
  extracted: unknown,
  options: { finishReason?: string; status?: number } = {},
): Response {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: { parts: [{ text: JSON.stringify(extracted) }] },
        finishReason: options.finishReason ?? 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    }),
    {
      status: options.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

const validExtraction = {
  supplier_name: 'Proveedor Demo',
  subtotal: 10,
  total: 10,
  lines: [{ description_original: 'Harina', quantity: 1, unit_price: 10, amount: 10 }],
}

function provider(fetchImpl: typeof fetch) {
  return new GeminiInvoiceProvider({
    apiKey: 'test-key-never-logged',
    model: 'primary-model',
    fallbackModel: 'fallback-model',
    timeoutMs: 100,
    fetchImpl,
  })
}

const input = {
  base64: 'JVBERi0xLjQK',
  mimeType: 'application/pdf' as const,
}

describe('GeminiInvoiceProvider', () => {
  it('envía el MIME y base64 como inlineData y usa el modelo principal', async () => {
    const fetchMock = vi.fn(async () => geminiResponse(validExtraction)) as unknown as typeof fetch

    const result = await provider(fetchMock).extract(input)

    expect(result.model).toBe('primary-model')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetchMock).mock.calls[0]
    expect(String(url)).toContain('/models/primary-model:generateContent')
    const body = JSON.parse(String(init?.body))
    expect(body.contents[0].parts[1].inlineData).toEqual({
      mimeType: 'application/pdf',
      data: input.base64,
    })
  })

  it('envía imágenes con su MIME sin transformar el contenido', async () => {
    const fetchMock = vi.fn(async () => geminiResponse(validExtraction)) as unknown as typeof fetch
    const imageInput = {
      base64: 'iVBORw0KGgo=',
      mimeType: 'image/png' as const,
    }

    await provider(fetchMock).extract(imageInput)

    const [, init] = vi.mocked(fetchMock).mock.calls[0]
    const body = JSON.parse(String(init?.body))
    expect(body.contents[0].parts[1].inlineData).toEqual({
      mimeType: 'image/png',
      data: imageInput.base64,
    })
  })

  it('usa fallback después de un error HTTP recuperable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(geminiResponse(validExtraction)) as unknown as typeof fetch

    const result = await provider(fetchMock).extract(input)

    expect(result.model).toBe('fallback-model')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('trata un timeout de red como recuperable y prueba el fallback', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('Tiempo agotado', 'TimeoutError'))
      .mockResolvedValueOnce(geminiResponse(validExtraction)) as unknown as typeof fetch

    const result = await provider(fetchMock).extract(input)

    expect(result.model).toBe('fallback-model')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('no usa fallback cuando Gemini rechaza la solicitud con un 400', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response('', { status: 400 })) as unknown as typeof fetch

    await expect(provider(fetchMock).extract(input)).rejects.toMatchObject({
      code: 'REQUEST_REJECTED',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('no usa fallback ante errores de autenticación', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response(
        JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'denied' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch

    await expect(provider(fetchMock).extract(input)).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      meta: {
        httpStatus: 403,
        providerStatus: 'PERMISSION_DENIED',
        model: 'primary-model',
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('usa fallback ante una respuesta truncada', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(geminiResponse(validExtraction, { finishReason: 'MAX_TOKENS' }))
      .mockResolvedValueOnce(geminiResponse(validExtraction)) as unknown as typeof fetch

    const result = await provider(fetchMock).extract(input)

    expect(result.model).toBe('fallback-model')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rechaza una respuesta estructuralmente incompleta si ambos modelos fallan', async () => {
    const fetchMock = vi.fn()
      .mockImplementation(async () =>
        geminiResponse({ supplier_name: 'Sin líneas' }),
      ) as unknown as typeof fetch

    await expect(provider(fetchMock).extract(input)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falla antes de la red cuando no hay API key', () => {
    expect(
      () =>
        new GeminiInvoiceProvider({
          apiKey: '',
          model: 'primary-model',
          fallbackModel: 'fallback-model',
        }),
    ).toThrowError(InvoiceAiProviderError)
  })
})

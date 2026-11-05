export class InvoiceAiResponseError extends Error {
  constructor(
    message: string,
    public readonly code: 'EMPTY_RESPONSE' | 'INVALID_JSON' | 'INCOMPLETE_RESPONSE',
  ) {
    super(message)
    this.name = 'InvoiceAiResponseError'
  }
}

export function cleanGeminiJsonText(text: string): string {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()
}

function looksTruncated(text: string): boolean {
  let inString = false
  let escaped = false
  const stack: string[] = []

  for (const char of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && inString) {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') stack.push('}')
    if (char === '[') stack.push(']')
    if (char === '}' || char === ']') {
      if (stack.pop() !== char) return true
    }
  }

  return inString || stack.length > 0
}

export function parseGeminiJson(text: string): unknown {
  const clean = cleanGeminiJsonText(text)
  if (!clean) {
    throw new InvoiceAiResponseError('Gemini devolvió una respuesta vacía.', 'EMPTY_RESPONSE')
  }

  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  const candidate = start >= 0 && end >= start ? clean.slice(start, end + 1) : clean

  if (looksTruncated(candidate) || end < start) {
    throw new InvoiceAiResponseError(
      'La respuesta de Gemini está incompleta; no se reparó automáticamente.',
      'INCOMPLETE_RESPONSE',
    )
  }

  try {
    return JSON.parse(candidate)
  } catch {
    throw new InvoiceAiResponseError('Gemini devolvió JSON inválido.', 'INVALID_JSON')
  }
}

export function extractGeminiText(payload: unknown): {
  text: string
  finishReason: string | null
} {
  const response = payload as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
      finishReason?: string
    }>
  }
  const candidate = response.candidates?.[0]
  return {
    text: candidate?.content?.parts?.map((part) => part.text || '').join('') || '',
    finishReason: candidate?.finishReason ? String(candidate.finishReason) : null,
  }
}

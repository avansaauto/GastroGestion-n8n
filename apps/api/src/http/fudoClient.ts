const AUTH_URL = 'https://auth.fu.do/api'
const PRODUCTS_URL = 'https://api.fu.do/v1alpha1/products'
const PAGE_SIZE = 100
const MAX_PAGES = 40

export type FudoCatalogItem = {
  externalProductId: string
  name: string
  active: boolean
}

export class FudoClientError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_CREDENTIALS' | 'FUDO_UNAVAILABLE' | 'INCOMPLETE_CATALOG',
    public readonly status: number,
  ) {
    super(message)
    this.name = 'FudoClientError'
  }
}

type FetchLike = typeof fetch

function text(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return ''
}

export function parseFudoProductPage(payload: unknown): {
  products: FudoCatalogItem[]
  nextUrl: string | null
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { products: [], nextUrl: null }
  }
  const record = payload as Record<string, unknown>
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.products)
      ? record.products
      : []
  const products: FudoCatalogItem[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const attributes = row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
      ? row.attributes as Record<string, unknown>
      : row
    const externalProductId = text(row.id ?? attributes.id ?? attributes.product_id ?? row.product_id)
    const name = text(attributes.name ?? row.name)
    if (!externalProductId || !name) continue
    const active = attributes.active === undefined && row.active === undefined
      ? true
      : attributes.active === true || row.active === true
    products.push({ externalProductId, name, active })
  }
  const links = record.links && typeof record.links === 'object' && !Array.isArray(record.links)
    ? record.links as Record<string, unknown>
    : {}
  return { products, nextUrl: safeFudoNextUrl(links.next) }
}

export function safeFudoNextUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'api.fu.do') return null
    return url.toString()
  } catch {
    return null
  }
}

async function readToken(response: Response): Promise<string | null> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const token = payload?.token ?? payload?.access_token
  return typeof token === 'string' && token.trim() ? token.trim() : null
}

export async function authenticateFudo(input: {
  apiKey: string
  apiSecret: string
  fetchImpl?: FetchLike
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret }),
    })
  } catch {
    throw new FudoClientError('No se pudo contactar a Fudo.', 'FUDO_UNAVAILABLE', 502)
  }
  if (response.status === 401 || response.status === 403) {
    throw new FudoClientError('Fudo rechazó las credenciales.', 'INVALID_CREDENTIALS', 422)
  }
  if (!response.ok) {
    throw new FudoClientError('Fudo no respondió correctamente.', 'FUDO_UNAVAILABLE', 502)
  }
  const token = await readToken(response)
  if (!token) {
    throw new FudoClientError('Fudo no devolvió una sesión válida.', 'FUDO_UNAVAILABLE', 502)
  }
}

export async function pullFudoCatalog(input: {
  apiKey: string
  apiSecret: string
  fetchImpl?: FetchLike
}): Promise<{ products: FudoCatalogItem[]; complete: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret }),
    })
  } catch {
    throw new FudoClientError('No se pudo contactar a Fudo.', 'FUDO_UNAVAILABLE', 502)
  }
  if (response.status === 401 || response.status === 403) {
    throw new FudoClientError('Fudo rechazó las credenciales.', 'INVALID_CREDENTIALS', 422)
  }
  if (!response.ok) {
    throw new FudoClientError('Fudo no respondió correctamente.', 'FUDO_UNAVAILABLE', 502)
  }
  const token = await readToken(response)
  if (!token) {
    throw new FudoClientError('Fudo no devolvió una sesión válida.', 'FUDO_UNAVAILABLE', 502)
  }

  const products: FudoCatalogItem[] = []
  const seen = new Set<string>()
  let nextUrl: string | null = `${PRODUCTS_URL}?page[size]=${PAGE_SIZE}&page[number]=1`
  let pages = 0
  let complete = true

  while (nextUrl) {
    pages += 1
    if (pages > MAX_PAGES) {
      complete = false
      break
    }
    let pageResponse: Response
    try {
      pageResponse = await fetchImpl(nextUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
    } catch {
      throw new FudoClientError('No se pudo leer el catálogo de Fudo.', 'FUDO_UNAVAILABLE', 502)
    }
    if (pageResponse.status === 401 || pageResponse.status === 403) {
      throw new FudoClientError('La sesión de Fudo no es válida.', 'INVALID_CREDENTIALS', 422)
    }
    if (!pageResponse.ok) {
      throw new FudoClientError('No se pudo leer el catálogo de Fudo.', 'FUDO_UNAVAILABLE', 502)
    }
    const payload = await pageResponse.json().catch(() => null)
    const page = parseFudoProductPage(payload)
    for (const product of page.products) {
      if (seen.has(product.externalProductId)) continue
      seen.add(product.externalProductId)
      products.push(product)
    }
    if (page.nextUrl && page.nextUrl !== nextUrl) {
      nextUrl = page.nextUrl
      continue
    }
    if (page.products.length >= PAGE_SIZE && nextUrl) {
      const current: URL = new URL(nextUrl)
      const pageNumber = Number(current.searchParams.get('page[number]') || '1')
      if (!Number.isInteger(pageNumber)) {
        complete = false
        break
      }
      current.searchParams.set('page[number]', String(pageNumber + 1))
      nextUrl = current.toString()
      continue
    }
    nextUrl = null
  }

  return { products, complete }
}

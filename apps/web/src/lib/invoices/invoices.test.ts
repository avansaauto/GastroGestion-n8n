import { describe, expect, it, vi } from 'vitest'

const getSession = vi.hoisted(() => vi.fn(async () => ({
  data: { session: { access_token: 'session-token' } },
  error: null,
})))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession,
    },
  },
  isSupabaseConfigured: true,
}))

import {
  analyzeInvoice,
  analyzeInvoiceJob,
  buildInvoiceSaveFormData,
  getInvoice,
  InvoiceApiError,
  listCatalogMappingMemories,
  listCatalogProducts,
  listInvoiceProducts,
  listInvoices,
  listPendingReceptions,
  lookupInvoiceDuplicate,
  mapInvoiceHttpError,
  mapInvoiceLine,
  mapInvoiceQueryHttpError,
  mapInvoiceCancelHttpError,
  mapInvoiceReceiveHttpError,
  mapInvoiceSaveHttpError,
  receiveInvoiceLine,
  saveInvoice,
} from './api'
import { INVOICE_MAX_BYTES } from './constants'
import { validateInvoiceFile } from './file'
import { applyCommercialReview } from './commercialReview'
import {
  beginAnalyze,
  beginIntakeRetry,
  beginSave,
  canAnalyze,
  canRetryIntake,
  canSaveInvoice,
  clearInvoiceFile,
  failAnalyze,
  failSave,
  initialInvoiceFlow,
  selectInvoiceFile,
  setAcceptFiscalInconsistency,
  hydrateReviewMapping,
  resetReviewMapping,
  setLocalDecision,
  setReviewMappingProduct,
  acceptReviewMappingSuggestion,
  saveBlockedReason,
  setReviewReceivedDisplay,
  succeedAnalyze,
  succeedSave,
} from './flow'
import {
  bonusQuestion,
  displayedFiscalStatus,
  fiscalReviewNotes,
  formatUnit,
  lineDescription,
  localDecisionsFromPayload,
  needsFiscalAcceptance,
  partitionReviewLines,
  toCommercialDecisionPayload,
  toCommercialRelationDecisions,
} from './review'
import {
  canonicalUnit,
  isInventoriableAnalysisLine,
  isInventoriableLine,
  mappingSummary,
  previewPhysicalQuantity,
  resolvePhysicalConversion,
  storedLineForAnalysis,
} from './mapping'
import {
  invoiceListCounts,
  invoiceMatchesFilter,
  invoicesForScope,
  invoicesListPath,
  visibleInvoiceList,
} from './invoiceListFilter'
import { applyInvoiceReceiveResult, INVOICE_STATUS_LABEL, invoiceStatusTone } from './invoiceReceiveState'
import {
  createMemoryAttemptStore,
  markReceiveAttemptResolved,
  prepareReceiveAttempt,
  readReceiveAttempt,
  receiveAttemptKey,
} from './receiveAttempt'
import { receiveStateLabel, receiveVisualState, submitReceiveLine } from './receiveSubmit'
import { displayToPhysical, formatDisplayQuantity, formatInventoryUnit, parseDisplayQuantity, physicalToDisplay } from './receptionUnits'
import { formatPendingInventoryQuantity } from './reviewIntake'
import { cycleHighlight, filterCatalogProducts, mappingPickerKeyAction, mappingPickerTriggerLabel } from './mappingPicker'
import {
  canEditReviewReceived,
  initialReviewReceivedDrafts,
  reviewReceivedRemainingLabel,
  reviewReceivedView,
} from './reviewReceived'
import {
  emptyReviewMappingDraft,
  hydrateReviewMappingDrafts,
  reviewMappingPhysicalLabel,
} from './reviewMapping'
import {
  inventoryCopy,
  reviewInventorySummary,
  reviewLineVisual,
} from './reviewSummary'
import {
  ALREADY_REGISTERED_MESSAGE,
  intakeOutcomeSummary,
  planReviewIntake,
  reviewIntakeBlockReason,
  saveThenApplyIntake,
  summarizeIntake,
} from './reviewIntake'
import type { ConfirmedMappingMemory } from './invoiceMemory'
import type { InvoiceAnalysisLine, InvoiceDetail, InvoiceListItem, InvoiceMapResult, InvoiceReceiveResult, InvoiceStoredLine } from './types'
import {
  baseInvoiceResult,
  bonusInvoiceResult,
  confirmedBonusInvoiceResult,
  savedInvoiceResult,
  serviceInvoiceConsistentResult,
  serviceInvoiceResult,
  signedInvoiceResult,
} from './fixtures'

function stubBrowserCrypto(uuid: `${string}-${string}-${string}-${string}-${string}`) {
  let calls = 0
  const cryptoObj = {
    randomUUID() {
      if (this !== cryptoObj) {
        throw new TypeError("'randomUUID' called on an object that does not implement interface Crypto.")
      }
      calls += 1
      return uuid
    },
  }
  vi.stubGlobal('crypto', cryptoObj)
  return {
    get calls() {
      return calls
    },
  }
}

function fakeFile(name: string, type: string, size = 2048): File {
  const blob = new Blob([new Uint8Array(Math.max(size, 1))], { type })
  return Object.assign(blob, { name, lastModified: Date.now() }) as File
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function storedLine(overrides: Partial<InvoiceStoredLine> = {}): InvoiceStoredLine {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sourceLineId: 'line-1',
    sourceIndex: 0,
    original: { description: 'PILSEN', quantity: 50, unit: 'L', unitPrice: 10, amount: 500 },
    reviewed: { description: 'PILSEN', quantity: 50, unit: 'L', unitPrice: 10, amount: 500 },
    classification: 'stock',
    inventoryEligibility: 'eligible',
    mappingStatus: 'unmapped',
    quantityKind: 'inventory',
    inventoryPhysicalQuantity: 0,
    inventoryProductId: null,
    inventoryProduct: null,
    ...overrides,
  }
}

describe('validación de archivo de factura', () => {
  it('acepta un PDF válido', () => {
    const result = validateInvoiceFile({ name: 'factura.pdf', type: 'application/pdf', size: 1200 })
    expect(result.ok).toBe(true)
  })

  it('rechaza un formato inválido', () => {
    const result = validateInvoiceFile({ name: 'notas.txt', type: 'text/plain', size: 1200 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_TYPE')
  })

  it('rechaza un archivo demasiado grande', () => {
    const result = validateInvoiceFile({
      name: 'factura.pdf',
      type: 'application/pdf',
      size: INVOICE_MAX_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TOO_LARGE')
  })
})

describe('flujo de carga', () => {
  it('permite reemplazar o quitar el archivo antes de analizar', () => {
    let state = selectInvoiceFile(initialInvoiceFlow, fakeFile('uno.pdf', 'application/pdf'))
    expect(state.file?.name).toBe('uno.pdf')
    state = selectInvoiceFile(state, fakeFile('dos.jpg', 'image/jpeg'))
    expect(state.file?.name).toBe('dos.jpg')
    expect(state.result).toBeNull()
    state = clearInvoiceFile()
    expect(state.file).toBeNull()
  })

  it('ignora un segundo análisis mientras el primero está en curso', () => {
    const selected = selectInvoiceFile(initialInvoiceFlow, fakeFile('factura.pdf', 'application/pdf'))
    const first = beginAnalyze(selected)
    expect(first?.status).toBe('analyzing')
    expect(canAnalyze(first!)).toBe(false)
    expect(beginAnalyze(first!)).toBeNull()
  })
})

describe('cliente HTTP de facturas', () => {
  it('envía multipart con campo file y timeout largo', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData
      expect(body.get('file')).toBeTruthy()
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer token-test')
      return new Response(JSON.stringify({ data: baseInvoiceResult() }), { status: 200 })
    }) as unknown as typeof fetch

    const data = await analyzeInvoice(fakeFile('factura.pdf', 'application/pdf'), {
      fetchImpl,
      accessToken: 'token-test',
    })
    expect(data.document.classification).toBe('gastronomic_merchandise')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, 'UNAUTHENTICATED', 'La sesión expiró o no es válida.'],
    [403, 'FORBIDDEN', 'No tenés autorización para analizar facturas.'],
    [429, 'RATE_LIMITED', 'Se alcanzó el límite de análisis. Probá más tarde.'],
    [502, 'PROVIDER_INVALID_RESPONSE', 'No se pudo completar la lectura del documento.'],
    [504, 'PROVIDER_TIMEOUT', 'El análisis superó el tiempo de espera.'],
  ] as const)('mapea el error %s', (status, code, message) => {
    const error = mapInvoiceHttpError(status, { error: 'interno', code })
    expect(error).toBeInstanceOf(InvoiceApiError)
    expect(error.status).toBe(status)
    expect(error.message).toBe(message)
    expect(error.message).not.toMatch(/interno|GEMINI/i)
  })

  it('convierte un aborto en timeout sin reintentar', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      if (init?.signal?.aborted) throw error
      throw error
    }) as unknown as typeof fetch

    await expect(analyzeInvoice(fakeFile('factura.pdf', 'application/pdf'), {
      fetchImpl,
      accessToken: 'token-test',
      timeoutMs: 1,
    })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', status: 504 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('crea un trabajo con locationId y espera queued, processing y ready', async () => {
    const locationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const jobId = '6e9f849a-631d-4859-9ca6-b54d45172d33'
    const statuses = ['processing', 'ready']
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer token-test')
      if (init?.method === 'POST') {
        const body = init.body as FormData
        expect(String(url)).toBe('/api/invoices/analysis-jobs')
        expect(body.get('locationId')).toBe(locationId)
        expect(body.get('file')).toBeTruthy()
        return jsonResponse({ data: { jobId, status: 'queued' } }, 202)
      }
      expect(String(url)).toBe(`/api/invoices/analysis-jobs/${jobId}`)
      expect(init?.method).toBe('GET')
      const status = statuses.shift()
      if (status === 'ready') {
        return jsonResponse({ data: { jobId, status, result: baseInvoiceResult() } })
      }
      return jsonResponse({ data: { jobId, status } })
    }) as unknown as typeof fetch

    const result = await analyzeInvoiceJob(fakeFile('factura.pdf', 'application/pdf'), locationId, {
      fetchImpl,
      accessToken: 'token-test',
      pollIntervalMs: 0,
    })

    expect(result.document.classification).toBe('gastronomic_merchandise')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const posts = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
  })

  it('traduce un trabajo failed y no sigue consultando', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ data: { jobId: 'job-failed', status: 'queued' } }, 202)
      }
      return jsonResponse({
        data: { jobId: 'job-failed', status: 'failed', failureCode: 'INVALID_EXTRACTION' },
      })
    }) as unknown as typeof fetch

    await expect(analyzeInvoiceJob(fakeFile('factura.pdf', 'application/pdf'), 'loc-1', {
      fetchImpl,
      accessToken: 'token-test',
      pollIntervalMs: 0,
    })).rejects.toMatchObject({
      code: 'INVALID_EXTRACTION',
      message: 'La extracción no tiene una estructura utilizable.',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('corta el sondeo al superar el tiempo de espera', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ data: { jobId: 'job-slow', status: 'queued' } }, 202)
      }
      return jsonResponse({ data: { jobId: 'job-slow', status: 'processing' } })
    }) as unknown as typeof fetch

    await expect(analyzeInvoiceJob(fakeFile('factura.pdf', 'application/pdf'), 'loc-1', {
      fetchImpl,
      accessToken: 'token-test',
      pollIntervalMs: 5,
      timeoutMs: 30,
    })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', status: 504 })
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('cancela el sondeo sin seguir consultando', async () => {
    const controller = new AbortController()
    let gets = 0
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ data: { jobId: 'job-cancel', status: 'queued' } }, 202)
      }
      gets += 1
      controller.abort()
      return jsonResponse({ data: { jobId: 'job-cancel', status: 'processing' } })
    }) as unknown as typeof fetch

    await expect(analyzeInvoiceJob(fakeFile('factura.pdf', 'application/pdf'), 'loc-1', {
      fetchImpl,
      accessToken: 'token-test',
      pollIntervalMs: 0,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' })
    expect(gets).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('toma el JWT de la sesión vigente en cada solicitud', async () => {
    getSession.mockClear()
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer session-token')
      if (init?.method === 'POST') {
        return jsonResponse({ data: { jobId: 'job-session', status: 'processing' } }, 202)
      }
      return jsonResponse({ data: { jobId: 'job-session', status: 'ready', result: baseInvoiceResult() } })
    }) as unknown as typeof fetch

    await analyzeInvoiceJob(fakeFile('factura.pdf', 'application/pdf'), 'loc-1', {
      fetchImpl,
      pollIntervalMs: 0,
    })
    expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('consulta el listado autenticado', async () => {
    const locationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain('/api/invoices?')
      expect(String(url)).toContain(`locationId=${locationId}`)
      expect(String(url)).not.toContain('organizationId')
      expect(init?.method ?? 'GET').toBe('GET')
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer token-test')
      return new Response(JSON.stringify({
        data: [{
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          supplierName: 'LUPULO SRL',
          documentDate: '2026-10-01',
          documentNumber: '0001-00006046',
          documentType: 'invoice',
          status: 'reviewed',
          currency: 'ARS',
          total: 1500.5,
          locationId: 'loc-1',
          organizationId: 'org-1',
          pendingConfiguration: true,
          pendingReceive: false,
        }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const data = await listInvoices(locationId, { fetchImpl, accessToken: 'token-test' })
    expect(data[0]?.supplierName).toBe('LUPULO SRL')
    expect(data[0]?.total).toBe(1500.5)
    expect(data[0]?.pendingConfiguration).toBe(true)
    expect(data[0]?.pendingReceive).toBe(false)
  })

  it('no lista facturas sin un local autorizado', async () => {
    await expect(listInvoices('  ')).rejects.toMatchObject({
      code: 'LOCATION_ID_INVALID',
      status: 400,
    })
  })

  it('consulta recepciones pendientes con JWT, locationId y nextCursor, sin organizationId', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/api\/invoices\/pending-receptions\?/)
      expect(String(url)).toContain('locationId=cccccccc-cccc-4ccc-8ccc-cccccccccccc')
      expect(String(url)).toContain('cursor=line-9')
      expect(String(url)).not.toContain('organizationId')
      expect(init?.method ?? 'GET').toBe('GET')
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer token-test')
      return new Response(JSON.stringify({
        data: [{
          invoiceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          lineId: '11111111-1111-4111-8111-111111111111',
          supplierName: 'LUPULO SRL',
          documentNumber: '0001-00006046',
          documentDate: '2026-10-01',
          locationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          ingredientId: 'prod-1',
          ingredientName: 'Cerveza Pilsen',
          baseUnit: 'ml',
          invoicedQuantity: 100000,
          receivedQuantity: 50000,
          remainingQuantity: 50000,
        }],
        nextCursor: '11111111-1111-4111-8111-111111111111',
      }), { status: 200 })
    }) as unknown as typeof fetch

    const page = await listPendingReceptions('cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
      cursor: 'line-9',
      fetchImpl,
      accessToken: 'token-test',
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.ingredientName).toBe('Cerveza Pilsen')
    expect(page.items[0]?.remainingQuantity).toBe(50000)
    expect(page.nextCursor).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('conserva nextCursor en una página parcial y no consulta sin local', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        invoiceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        lineId: 'line-1',
        supplierName: 'LUPULO SRL',
        documentNumber: '0001-00006046',
        documentDate: '2026-10-01',
        locationId: 'loc-a',
        ingredientId: 'prod-1',
        ingredientName: 'Pilsen',
        baseUnit: 'ml',
        invoicedQuantity: 100000,
        receivedQuantity: 0,
        remainingQuantity: 100000,
      }],
      nextCursor: 'line-1',
    }), { status: 200 })) as unknown as typeof fetch

    const page = await listPendingReceptions('loc-a', { fetchImpl, accessToken: 'token-test' })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBe('line-1')
    await expect(listPendingReceptions('  ', { fetchImpl, accessToken: 'token-test' }))
      .rejects.toMatchObject({ code: 'LOCATION_ID_INVALID', status: 400 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('mapea error de consulta de recepciones pendientes', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: 'No tenés autorización para consultar facturas.',
      code: 'FORBIDDEN',
    }), { status: 403 })) as unknown as typeof fetch

    await expect(listPendingReceptions('loc-a', { fetchImpl, accessToken: 'token-test' }))
      .rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
        message: 'No tenés autorización para consultar facturas.',
      })
  })

  it('consulta duplicados con JWT, locationId y hash, sin organizationId', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/api\/invoices\/duplicates\?/)
      expect(String(url)).toContain('locationId=cccccccc-cccc-4ccc-8ccc-cccccccccccc')
      expect(String(url)).toContain(`fileSha256=${'ab'.repeat(32)}`)
      expect(String(url)).not.toContain('organizationId')
      expect(init?.method ?? 'GET').toBe('GET')
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer token-test')
      return new Response(JSON.stringify({
        data: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          supplierName: 'LUPULO SRL',
          documentNumber: '00007-00006046',
          documentDate: '2026-10-01',
          status: 'reviewed',
          locationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const match = await lookupInvoiceDuplicate({
      locationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      fileSha256: 'ab'.repeat(32),
    }, { fetchImpl, accessToken: 'token-test' })
    expect(match?.supplierName).toBe('LUPULO SRL')
    expect(JSON.stringify(match)).not.toMatch(/fileSha256|storage_object_path|integrityToken/i)
  })

  it('acepta data null cuando no hay duplicado visible', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: null }), { status: 200 })) as unknown as typeof fetch
    await expect(lookupInvoiceDuplicate({
      locationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      issuerTaxId: '30714329401',
      voucherType: 'A',
      pointOfSale: '00007',
      voucherNumber: '00006046',
    }, { fetchImpl, accessToken: 'token-test' })).resolves.toBeNull()
  })

  it('consulta el detalle autenticado y mapea 404 sin filtrar otra org', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/api/invoices/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      return new Response(JSON.stringify({ error: 'No se encontró la factura.', code: 'NOT_FOUND' }), { status: 404 })
    }) as unknown as typeof fetch

    await expect(getInvoice('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
      fetchImpl,
      accessToken: 'token-test',
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'No se encontró la factura.' })
  })

  it('mapea errores de consulta sin filtrar internos', () => {
    const error = mapInvoiceQueryHttpError(401, { error: 'interno', code: 'UNAUTHENTICATED' })
    expect(error.message).toBe('La sesión expiró o no es válida.')
    expect(error.message).not.toMatch(/interno|service_role/i)
  })

  it('consulta productos y envía la vinculación autenticada', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/products')) {
        return new Response(JSON.stringify({
          data: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Cerveza Pilsen', baseUnit: 'L' }],
        }), { status: 200 })
      }
      expect(init?.method).toBe('POST')
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer token-test')
      const body = JSON.parse(String(init?.body)) as { organizationId?: string; actorUserId?: string }
      expect(body).not.toHaveProperty('organizationId')
      expect(body).not.toHaveProperty('actorUserId')
      return new Response(JSON.stringify({
        data: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          mappingStatus: 'mapped',
          inventoryProductId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          inventoryPhysicalQuantity: 50,
          inventoryProduct: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Cerveza Pilsen', baseUnit: 'L' },
          unmappedLineCount: 7,
        },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const products = await listInvoiceProducts('fe8b3702-dea1-4e89-b86c-76ae42d700fc', {
      fetchImpl,
      accessToken: 'token-test',
    })
    expect(products[0]?.name).toBe('Cerveza Pilsen')
    const mapped = await mapInvoiceLine(
      'fe8b3702-dea1-4e89-b86c-76ae42d700fc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { inventoryProductId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', conversionFactor: 1 },
      { fetchImpl, accessToken: 'token-test' },
    )
    expect(mapped.mappingStatus).toBe('mapped')
    expect(mapped.unmappedLineCount).toBe(7)
  })

  it('acepta un catálogo vacío y un error de carga de insumos', async () => {
    const empty = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(listInvoiceProducts('fe8b3702-dea1-4e89-b86c-76ae42d700fc', {
      fetchImpl: empty,
      accessToken: 'token-test',
    })).resolves.toEqual([])

    const failed = mapInvoiceQueryHttpError(500, {
      error: 'No se pudieron consultar los productos.',
      code: 'LOOKUP_FAILED',
    })
    expect(failed.message).toBe('No se pudieron consultar los productos.')
    expect(failed.code).toBe('LOOKUP_FAILED')
  })

  it('consulta insumos y memorias del local con JWT, sin catálogo de otra organización', async () => {
    const locationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const product = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: 'PRUEBA SENDA — Líquido',
      baseUnit: 'ml',
      organizationId: 'org-1',
      active: true,
    }
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer token-test')
      if (String(url).includes('/catalog/products')) {
        expect(String(url)).toContain(`locationId=${locationId}`)
        expect(String(url)).not.toContain('organizationId=org-2')
        return new Response(JSON.stringify({ data: [product] }), { status: 200 })
      }
      expect(String(url)).toContain('/catalog/mapping-memories')
      expect(String(url)).toContain(`locationId=${locationId}`)
      expect(String(url)).toContain('issuerTaxId=30712345679')
      return new Response(JSON.stringify({
        data: [{
          descriptionNormalized: 'pilsen',
          inventoryProductId: product.id,
          inventoryProduct: { id: product.id, name: product.name, baseUnit: product.baseUnit },
          conversionFactor: 1000,
        }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(listCatalogProducts(locationId, {
      fetchImpl,
      accessToken: 'token-test',
    })).resolves.toEqual([product])
    await expect(listCatalogMappingMemories(locationId, '30712345679', {
      fetchImpl,
      accessToken: 'token-test',
    })).resolves.toMatchObject([{ inventoryProductId: product.id }])

    const forbidden = vi.fn(async () => new Response(JSON.stringify({
      error: 'El local no existe o no pertenece a tu organización.',
      code: 'FORBIDDEN',
    }), { status: 403 })) as unknown as typeof fetch
    await expect(listCatalogProducts(locationId, {
      fetchImpl: forbidden,
      accessToken: 'token-test',
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })
})

describe('revisión de resultados', () => {
  it('describe mercadería inventariable sin ofrecer recepción', () => {
    const copy = inventoryCopy(baseInvoiceResult())
    expect(copy.title).toMatch(/recepción al guardar/i)
    expect(copy.body).toMatch(/efectivamente recibido/i)
    expect(copy.body).not.toMatch(/no está disponible todavía/i)
    expect(copy.showReception).toBe(false)
  })

  it('reconstruye decisiones locales desde el payload guardado', () => {
    expect(localDecisionsFromPayload([
      { relationId: 'relation-line-bonus', decision: 'confirm' } as never,
    ])).toEqual({ 'relation-line-bonus': 'confirm' })
  })

  it('excluye fiscales y descuentos de la vinculación de stock', () => {
    const stock = storedLine({ classification: 'stock', inventoryEligibility: 'eligible', mappingStatus: 'unmapped' })
    const fiscal = storedLine({ classification: 'fiscal', inventoryEligibility: 'ineligible', mappingStatus: 'not_applicable' })
    const discount = storedLine({ original: { ...storedLine().original, amount: -82500 }, reviewed: { ...storedLine().reviewed, amount: -82500 } })
    expect(isInventoriableLine(stock)).toBe(true)
    expect(isInventoriableLine(fiscal)).toBe(false)
    expect(isInventoriableLine(discount)).toBe(false)
    expect(mappingSummary([stock, fiscal, discount])).toEqual({ mapped: 0, pending: 1, excluded: 2 })
    expect(previewPhysicalQuantity(2, 12.5)).toBe(25)
  })

  it('convierte unidades SI conocidas y bloquea presentaciones sin equivalencia', () => {
    expect(resolvePhysicalConversion('L', 'ml')).toEqual({ ok: true, factor: 1000 })
    expect(resolvePhysicalConversion('kg', 'g')).toEqual({ ok: true, factor: 1000 })
    expect(resolvePhysicalConversion('ml', 'ml')).toEqual({ ok: true, factor: 1 })
    expect(resolvePhysicalConversion('g', 'g')).toEqual({ ok: true, factor: 1 })
    expect(resolvePhysicalConversion('unidades', 'unit')).toEqual({ ok: true, factor: 1 })
    expect(previewPhysicalQuantity(50, 1000)).toBe(50000)
    expect(previewPhysicalQuantity(8, 1000)).toBe(8000)
    expect(previewPhysicalQuantity(1.5, 1000)).toBe(1500)
    expect(resolvePhysicalConversion('L', 'g')).toEqual({ ok: false, code: 'INCOMPATIBLE_UNITS' })
    expect(resolvePhysicalConversion('caja', 'kg')).toEqual({ ok: false, code: 'EQUIVALENCE_REQUIRED' })
    expect(resolvePhysicalConversion('pack', 'ml')).toEqual({ ok: false, code: 'EQUIVALENCE_REQUIRED' })
    expect(resolvePhysicalConversion('mg', 'g')).toEqual({ ok: true, factor: 0.001 })
    expect(resolvePhysicalConversion('cl', 'ml')).toEqual({ ok: true, factor: 10 })
    expect(resolvePhysicalConversion('docena', 'unit')).toEqual({ ok: true, factor: 12 })
    expect(resolvePhysicalConversion('docena', 'g')).toEqual({ ok: false, code: 'INCOMPATIBLE_UNITS' })
    expect(resolvePhysicalConversion(null, 'g')).toEqual({ ok: false, code: 'EQUIVALENCE_REQUIRED' })
    expect(resolvePhysicalConversion('kg', 'ml')).toEqual({ ok: false, code: 'INCOMPATIBLE_UNITS' })
    expect(canonicalUnit('l')).toBe('l')
    expect(canonicalUnit('L')).toBe('l')
    expect(canonicalUnit('litros')).toBe('l')
    expect(canonicalUnit('l (litros)')).toBe('l')
    expect(canonicalUnit('kg')).toBe('kg')
    expect(canonicalUnit('kg (kilogramos)')).toBe('kg')
    expect(canonicalUnit('ml')).toBe('ml')
    expect(canonicalUnit('g')).toBe('g')
    expect(resolvePhysicalConversion('l (litros)', 'ml')).toEqual({ ok: true, factor: 1000 })
    expect(previewPhysicalQuantity(2, 1000)).toBe(2000)
    expect(formatUnit('l (litros)')).toBe('L')
    expect(storedLineForAnalysis(baseInvoiceResult().document.lines[0], [
      storedLine({ sourceLineId: 'line-harina', sourceIndex: 0 }),
    ])?.sourceLineId).toBe('line-harina')
  })

  it('asocia conceptos solo por sourceLineId y nunca por índice o descripción', () => {
    const oilA: InvoiceAnalysisLine = {
      id: 'line-oil-a',
      sourceIndex: 0,
      originalDescription: 'Aceite',
      name: 'Aceite',
      supplierSku: null,
      quantity: 10,
      unit: 'L',
      unitPrice: 100,
      amount: 1000,
      classification: 'stock',
      inventoryEligibility: 'eligible',
      quantityKind: 'inventory',
      inventoryPhysicalQuantity: 10,
      missingFields: [],
      ambiguities: [],
    }
    const oilB: InvoiceAnalysisLine = {
      ...oilA,
      id: 'line-oil-b',
      sourceIndex: 1,
    }
    const storedA = storedLine({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sourceLineId: 'line-oil-a',
      sourceIndex: 1,
    })
    const storedB = storedLine({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sourceLineId: 'line-oil-b',
      sourceIndex: 0,
    })
    const reordered = [storedB, storedA]

    expect(storedLineForAnalysis(oilA, reordered)?.id).toBe(storedA.id)
    expect(storedLineForAnalysis(oilB, reordered)?.id).toBe(storedB.id)
    expect(storedLineForAnalysis(oilA, [storedB])?.id).toBeUndefined()
    expect(storedLineForAnalysis(oilA, [
      storedLine({ id: storedB.id, sourceLineId: 'line-missing', sourceIndex: oilA.sourceIndex }),
    ])).toBeUndefined()
    expect(storedLineForAnalysis({ id: 'line-missing' }, reordered)).toBeUndefined()
    expect(storedLineForAnalysis(oilA, [
      storedLine({ id: storedA.id, sourceLineId: 'line-oil-a' }),
      storedLine({ id: storedB.id, sourceLineId: 'line-oil-a' }),
    ])).toBeUndefined()
    expect(isInventoriableAnalysisLine(oilA)).toBe(true)
    expect(isInventoriableAnalysisLine({ ...oilA, classification: 'fiscal', inventoryEligibility: 'ineligible' })).toBe(false)
  })

  it('arma la pregunta de bonificación pendiente', () => {
    expect(bonusQuestion(bonusInvoiceResult.interpretation.relations[0], bonusInvoiceResult)).toBe(
      'PILSEN figura con 50 L facturados y una bonificación del 100%.',
    )
    const decisions = toCommercialRelationDecisions(bonusInvoiceResult, {
      'relation-line-bonus': 'confirm',
    })
    expect(decisions).toEqual([{
      adjustmentSourceIndex: 1,
      targetSourceIndex: 0,
      decision: 'confirm',
      type: 'bonus',
    }])
  })

  it('trata una factura de servicios sin stock', () => {
    const copy = inventoryCopy(serviceInvoiceResult)
    expect(serviceInvoiceResult.document.classification).toBe('service')
    expect(copy.showReception).toBe(false)
    expect(copy.body).toMatch(/servicios/i)
    expect(serviceInvoiceResult.document.lines[0].quantityKind).toBe('service_consumption')
    expect(serviceInvoiceResult.document.lines[0].inventoryPhysicalQuantity).toBe(0)
  })

  it('muestra la diferencia fiscal de $2 como revisión', () => {
    const notes = fiscalReviewNotes(serviceInvoiceResult)
    expect(displayedFiscalStatus(serviceInvoiceResult)).toBe('requires_review')
    expect(notes.join(' ')).toMatch(/total del comprobante cierra/i)
    expect(notes.join(' ')).toMatch(/IVA|percepciones/i)
    expect(notes.join(' ')).toMatch(/importes originales|valor original/i)
  })

  it('no oculta un fiscal consistente cuando el comprobante cierra', () => {
    expect(displayedFiscalStatus(serviceInvoiceConsistentResult)).toBe('consistent')
    expect(fiscalReviewNotes(serviceInvoiceConsistentResult).join(' ')).not.toMatch(/valor original/i)
  })

  it('no degrada Consistente por ruido de dimensión (CUIT) si la conciliación cierra', () => {
    const noisy = structuredClone(serviceInvoiceConsistentResult)
    noisy.validation.dimensions.fiscal = {
      status: 'requires_review',
      issues: ['SUPPLIER_TAX_ID_INVALID'],
    }
    noisy.validation.fiscalReconciliation = {
      ...noisy.validation.fiscalReconciliation!,
      status: 'consistent',
      totalStatus: 'consistent',
    }
    expect(displayedFiscalStatus(noisy)).toBe('consistent')
  })

  it('unifica unidades argentinas y evita duplicar la descripción', () => {
    expect(formatUnit('m3')).toBe('m³')
    expect(formatUnit('kwh')).toBe('kWh')
    expect(lineDescription(serviceInvoiceResult.document.lines[0]).detail).toBeNull()
    expect(partitionReviewLines(serviceInvoiceResult.document.lines).concepts).toHaveLength(1)
  })

  it('arma un payload de decisión que no reescribe importes', () => {
    const payload = toCommercialDecisionPayload(bonusInvoiceResult, {
      'relation-line-bonus': 'confirm',
    })
    expect(payload).toEqual([{
      relationId: 'relation-line-bonus',
      decision: 'confirm',
      type: 'bonus',
      targetLineId: 'line-pilsen',
      adjustmentLineIds: ['line-bonus'],
      proposedPhysicalQuantity: 50,
      unit: 'L',
      bonusAmount: 82500,
      grossAmount: 82500,
      netAcquisitionAmount: 0,
      originalAdjustmentAmounts: [
        { lineId: 'line-bonus', amount: -82500, unitPrice: -82500, quantity: 1 },
      ],
    }])
  })

  it('conserva un error de análisis para reintento manual', () => {
    const selected = selectInvoiceFile(initialInvoiceFlow, fakeFile('factura.pdf', 'application/pdf'))
    const failed = failAnalyze(beginAnalyze(selected)!, {
      message: 'El análisis superó el tiempo de espera.',
      status: 504,
      code: 'PROVIDER_TIMEOUT',
    })
    expect(failed.status).toBe('failed')
    expect(failed.file?.name).toBe('factura.pdf')
    expect(canAnalyze(failed)).toBe(true)
    expect(succeedAnalyze(failed, baseInvoiceResult()).status).toBe('review')
  })

  it('marca la decisión comercial como local', () => {
    const next = setLocalDecision(succeedAnalyze(initialInvoiceFlow, bonusInvoiceResult), 'relation-line-bonus', 'reject')
    expect(next.localDecisions['relation-line-bonus']).toBe('reject')
    expect(next.result?.interpretation.relations[0]?.status).toBe('rejected')
    expect(next.result?.document.lines[0]?.inventoryEligibility).toBe('eligible')
    expect(next.result?.document.lines[1]?.inventoryEligibility).toBe('ineligible')
  })
})

describe('cantidad recibida en la revisión inicial', () => {
  function twoLitreLine(overrides: Partial<InvoiceAnalysisLine> = {}): InvoiceAnalysisLine {
    return {
      id: 'line-liquid',
      sourceIndex: 0,
      originalDescription: 'PRUEBA SENDA — Líquido',
      name: 'PRUEBA SENDA — Líquido',
      supplierSku: null,
      quantity: 2,
      unit: 'L',
      unitPrice: 10,
      amount: 20,
      classification: 'stock',
      inventoryEligibility: 'eligible',
      quantityKind: 'inventory',
      inventoryPhysicalQuantity: 2,
      missingFields: [],
      ambiguities: [],
      ...overrides,
    }
  }

  function twoLitreResult() {
    const line = twoLitreLine()
    return signedInvoiceResult({
      document: {
        ...baseInvoiceResult().document,
        lines: [line],
      },
    })
  }

  function reviewedTwoLitres() {
    const selected = selectInvoiceFile(initialInvoiceFlow, fakeFile('factura.pdf', 'application/pdf'))
    return succeedAnalyze(beginAnalyze(selected)!, twoLitreResult())
  }

  it('inicializa 2 L como recibido 2 L y calcula el pendiente al editar', () => {
    const line = twoLitreLine()
    expect(initialReviewReceivedDrafts([line])).toEqual({ 'line-liquid': '2' })
    expect(reviewReceivedView(line)?.received).toBe(2)
    expect(reviewReceivedView(line)?.remaining).toBe(0)
    expect(reviewReceivedView(line)?.showRemaining).toBe(false)

    const comma = reviewReceivedView(line, '0,8')
    expect(comma).toMatchObject({ received: 0.8, remaining: 1.2, error: null, showRemaining: true })
    expect(reviewReceivedRemainingLabel(comma!)).toBe('Pendiente: 1,2 L')

    const dot = reviewReceivedView(line, '0.8')
    expect(dot).toMatchObject({ received: 0.8, remaining: 1.2, error: null })

    const none = reviewReceivedView(line, '0')
    expect(none).toMatchObject({ received: 0, remaining: 2, error: null, showRemaining: true })
    expect(reviewReceivedRemainingLabel(none!)).toBe('Pendiente: 2 L')
  })

  it('rechaza negativos y cantidades superiores a lo facturado', () => {
    const line = twoLitreLine()
    expect(reviewReceivedView(line, '-1')).toMatchObject({
      received: null,
      remaining: null,
      error: 'Indicá una cantidad válida.',
    })
    expect(reviewReceivedView(line, '3')).toMatchObject({
      received: null,
      remaining: null,
      error: 'La cantidad supera lo facturado.',
    })
    expect(reviewReceivedView(line, 'abc')).toMatchObject({ error: 'Indicá una cantidad válida.' })
  })

  it('no altera cantidad facturada, precio, importe ni corrections al editar recibido', () => {
    const reviewed = reviewedTwoLitres()
    const line = reviewed.result!.document.lines[0]
    const next = setReviewReceivedDisplay(reviewed, 'line-liquid', '0,8')
    expect(next.receivedDrafts['line-liquid']).toBe('0,8')
    expect(next.result!.document.lines[0]).toEqual(line)
    expect(next.result!.document.lines[0]?.quantity).toBe(2)
    expect(next.result!.document.lines[0]?.unitPrice).toBe(10)
    expect(next.result!.document.lines[0]?.amount).toBe(20)
    expect(next.originalSnapshot!.document.lines[0]?.quantity).toBe(2)
    expect(next.corrections).toEqual({})
  })

  it('conserva el recibido al decidir una relación comercial', () => {
    const selected = selectInvoiceFile(initialInvoiceFlow, fakeFile('factura.pdf', 'application/pdf'))
    const reviewed = succeedAnalyze(beginAnalyze(selected)!, signedInvoiceResult({
      ...bonusInvoiceResult,
      metadata: signedInvoiceResult().metadata,
    }))
    expect(setReviewReceivedDisplay(reviewed, 'line-pilsen', '0,8').receivedDrafts['line-pilsen']).toBeUndefined()
    const decided = setLocalDecision(reviewed, 'relation-line-bonus', 'confirm')
    expect(decided.result!.document.lines[0]?.inventoryEligibility).toBe('eligible')
    expect(decided.receivedDrafts['line-pilsen']).toBe('50')
    const edited = setReviewReceivedDisplay(decided, 'line-pilsen', '0,8')
    expect(edited.receivedDrafts['line-pilsen']).toBe('0,8')
    expect(edited.localDecisions['relation-line-bonus']).toBe('confirm')
    expect(edited.corrections).toEqual({})
    expect(edited.result!.document.lines[0]?.quantity).toBe(50)
    expect(edited.result!.document.lines[0]?.amount).toBe(82500)
    expect(edited.result!.document.lines[0]?.unitPrice).toBe(1650)
    expect(edited.originalSnapshot!.document.lines[0]?.amount).toBe(82500)
  })

  it('no inicializa recibido en impuestos ni líneas no inventariables', () => {
    expect(initialReviewReceivedDrafts(bonusInvoiceResult.document.lines)).toEqual({})
    expect(initialReviewReceivedDrafts(confirmedBonusInvoiceResult.document.lines)).toEqual({ 'line-pilsen': '50' })
    expect(reviewReceivedView(bonusInvoiceResult.document.lines[1]!)).toBeNull()
  })
})

describe('Paso 386 claridad de cantidades', () => {
  const pilsen = confirmedBonusInvoiceResult.document.lines[0]!
  const bonusLine = bonusInvoiceResult.document.lines[0]!
  const adjustment = bonusInvoiceResult.document.lines[1]!

  it('100 L facturados y 50 L recibidos dejan pendiente 50 L', () => {
    const line = { ...pilsen, quantity: 100, amount: 165000, inventoryPhysicalQuantity: 100 }
    const view = reviewReceivedView(line, '50')
    expect(view).toMatchObject({ invoiced: 100, received: 50, remaining: 50, showRemaining: true, unit: 'L' })
    expect(reviewReceivedRemainingLabel(view!)).toBe('Pendiente: 50 L')
    expect(line.unitPrice).toBe(1650)
    expect(line.amount).toBe(165000)
  })

  it('50 L facturados y 20 L recibidos dejan pendiente 30 L', () => {
    const view = reviewReceivedView(pilsen, '20')
    expect(view).toMatchObject({ invoiced: 50, received: 20, remaining: 30, showRemaining: true })
    expect(reviewReceivedRemainingLabel(view!)).toBe('Pendiente: 30 L')
    expect(pilsen.unitPrice).toBe(1650)
    expect(pilsen.amount).toBe(82500)
  })

  it('recepción completa no muestra pendiente', () => {
    const view = reviewReceivedView(pilsen, '50')
    expect(view).toMatchObject({ received: 50, remaining: 0, showRemaining: false, error: null })
    expect(reviewReceivedRemainingLabel(view!)).toBe('Pendiente: 0 L')
    expect(view?.showRemaining).toBe(false)
  })

  it('recibido 0 deja pendiente el total facturado', () => {
    const view = reviewReceivedView(pilsen, '0')
    expect(view).toMatchObject({ received: 0, remaining: 50, showRemaining: true })
    expect(reviewReceivedRemainingLabel(view!)).toBe('Pendiente: 50 L')
  })

  it('bonificación propuesta queda pendiente y no habilita recepción', () => {
    expect(reviewLineVisual(bonusLine)).toMatchObject({
      kind: 'commercial_pending',
      label: 'Revisión comercial',
      tone: 'warning',
    })
    expect(canEditReviewReceived(bonusLine)).toBe(false)
    expect(reviewReceivedView(bonusLine)).toBeNull()
    const copy = reviewInventorySummary(bonusInvoiceResult, { mappingAvailable: true })
    expect(copy.title).toBe('Revisión comercial pendiente')
    expect(copy.body).toMatch(/confirmala o rechazala/i)
    expect(copy.body).not.toMatch(/efectivamente recibido/i)
    expect(copy.body).not.toMatch(/no está disponible todavía/i)
    expect(copy.stats).toEqual([
      { key: 'merchandise', label: 'Mercadería', count: 1 },
      { key: 'commercial', label: 'Revisión comercial', count: 1 },
    ])
  })

  it('bonificación confirmada habilita recepción y pide insumo', () => {
    expect(reviewLineVisual(pilsen, { mappingAvailable: true })).toMatchObject({
      kind: 'unmapped',
      label: 'Sin insumo',
      tone: 'warning',
    })
    expect(reviewLineVisual(pilsen, {
      mappingAvailable: true,
      mappingDraft: { inventoryProductId: 'prod-1', approximateAccepted: false },
    })).toMatchObject({ kind: 'eligible', label: 'Habilitada', tone: 'success' })
    expect(canEditReviewReceived(pilsen)).toBe(true)
    const copy = reviewInventorySummary(confirmedBonusInvoiceResult, {
      mappingAvailable: true,
      receivedDrafts: { 'line-pilsen': '50' },
    })
    expect(copy.title).toBe('Recepción al guardar')
    expect(copy.body).toMatch(/efectivamente recibido al guardar/i)
    expect(copy.body).toMatch(/1 línea requiere vinculación a un insumo/i)
    expect(copy.stats.find((stat) => stat.key === 'partial')).toBeUndefined()
    expect(copy.stats).toEqual([
      { key: 'merchandise', label: 'Mercadería', count: 1 },
      { key: 'unmapped', label: 'Sin insumo', count: 1 },
    ])
  })

  it('ajuste negativo no tiene campo recibido y no sugiere mercadería', () => {
    expect(reviewLineVisual(adjustment)).toMatchObject({
      kind: 'adjustment',
      label: 'Ajuste (sin stock)',
    })
    expect(canEditReviewReceived(adjustment)).toBe(false)
    expect(reviewReceivedView(adjustment)).toBeNull()
    const onlyAdjustment = {
      ...bonusInvoiceResult,
      document: { ...bonusInvoiceResult.document, lines: [adjustment] },
      interpretation: { ...bonusInvoiceResult.interpretation, relations: [] },
      inventory: {
        eligibleLines: 0,
        pendingLines: 0,
        receptionBlocked: false,
        shouldOfferFutureReceipt: false,
      },
    }
    const copy = reviewInventorySummary(onlyAdjustment)
    expect(copy.title).toBe('Sin mercadería para recibir')
    expect(copy.body).toMatch(/solo tiene ajustes/i)
    expect(copy.body).not.toMatch(/efectivamente recibido/i)
  })

  it('precio e importe fiscal no cambian al calcular el pendiente', () => {
    const view = reviewReceivedView(pilsen, '20')
    expect(view?.received).toBe(20)
    expect(pilsen.unitPrice).toBe(1650)
    expect(pilsen.amount).toBe(82500)
    expect(pilsen.quantity).toBe(50)
  })

  it('una recepción parcial aparece en el resumen compacto', () => {
    const copy = reviewInventorySummary(confirmedBonusInvoiceResult, {
      mappingAvailable: true,
      receivedDrafts: { 'line-pilsen': '20' },
    })
    expect(copy.stats).toEqual([
      { key: 'merchandise', label: 'Mercadería', count: 1 },
      { key: 'partial', label: 'Recepción parcial', count: 1 },
      { key: 'unmapped', label: 'Sin insumo', count: 1 },
    ])
    expect(copy.body).toMatch(/efectivamente recibido/i)
  })
})

describe('insumo en la revisión inicial', () => {
  const PRODUCT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const OTHER_PRODUCT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

  function pilsenMemory(overrides: Partial<ConfirmedMappingMemory> = {}): ConfirmedMappingMemory {
    return {
      descriptionNormalized: 'pilsen',
      inventoryProductId: PRODUCT_ID,
      inventoryProduct: { id: PRODUCT_ID, name: 'Cerveza Pilsen', baseUnit: 'ml' },
      conversionFactor: 1000,
      ...overrides,
    }
  }

  function liquidLine(overrides: Partial<InvoiceAnalysisLine> = {}): InvoiceAnalysisLine {
    return {
      id: 'line-liquid',
      sourceIndex: 0,
      originalDescription: 'PRUEBA SENDA — Líquido',
      name: 'PRUEBA SENDA — Líquido',
      supplierSku: null,
      quantity: 2,
      unit: 'L',
      unitPrice: 10,
      amount: 20,
      classification: 'stock',
      inventoryEligibility: 'eligible',
      quantityKind: 'inventory',
      inventoryPhysicalQuantity: 2,
      missingFields: [],
      ambiguities: [],
      ...overrides,
    }
  }

  function reviewedBonus() {
    const selected = selectInvoiceFile(initialInvoiceFlow, fakeFile('factura.pdf', 'application/pdf'))
    return setLocalDecision(succeedAnalyze(beginAnalyze(selected)!, signedInvoiceResult({
      ...bonusInvoiceResult,
      metadata: signedInvoiceResult().metadata,
    })), 'relation-line-bonus', 'confirm')
  }

  it('preselecciona una coincidencia exacta confirmada por sourceLineId', () => {
    const hydrated = hydrateReviewMappingDrafts(confirmedBonusInvoiceResult.document.lines, [pilsenMemory()])
    expect(hydrated.drafts['line-pilsen']).toEqual({
      inventoryProductId: PRODUCT_ID,
      approximateAccepted: false,
      conversionFactor: null,
      action: 'link_existing',
      createIntent: null,
    })
    expect(hydrated.suggestions['line-pilsen']).toMatchObject({ kind: 'exact', inventoryProductId: PRODUCT_ID })
    expect(hydrated.drafts['line-bonus']).toBeUndefined()
  })

  it('no autovincula una coincidencia exacta si la unidad base no es compatible', () => {
    const line = confirmedBonusInvoiceResult.document.lines[0]!
    const hydrated = hydrateReviewMappingDrafts([line], [
      pilsenMemory({ inventoryProduct: { id: PRODUCT_ID, name: 'Harina', baseUnit: 'g' } }),
    ])
    expect(hydrated.suggestions[line.id]?.kind).toBe('exact')
    expect(hydrated.drafts[line.id]?.action).toBe('pending')
    expect(hydrated.drafts[line.id]?.inventoryProductId).toBe('')
  })

  it('con coincidencia aproximada no vincula ni crea solo', () => {
    const line = { ...confirmedBonusInvoiceResult.document.lines[0]!, name: 'PILSEN RUBIA' }
    const hydrated = hydrateReviewMappingDrafts([line], [pilsenMemory()])
    expect(hydrated.suggestions[line.id]).toMatchObject({ kind: 'approximate', inventoryProductId: PRODUCT_ID })
    expect(hydrated.drafts[line.id]?.action).toBe('pending')
    expect(hydrated.drafts[line.id]?.createIntent).toBeNull()
    expect(hydrated.drafts[line.id]?.inventoryProductId).toBe('')
  })

  it('sin memoria propone crear insumo con factor desde cantidad física analizada', () => {
    const line = {
      ...confirmedBonusInvoiceResult.document.lines[0]!,
      id: 'line-paulina',
      name: 'Queso Mozzarella P/Fetear La Paulina Barra x 3,5 Kg',
      originalDescription: 'Queso Mozzarella P/Fetear La Paulina Barra x 3,5 Kg',
      quantity: 1,
      unit: 'barra',
      inventoryPhysicalQuantity: 3500,
      amount: 26287.08,
    }
    const hydrated = hydrateReviewMappingDrafts([line], [])
    expect(hydrated.drafts[line.id]).toMatchObject({
      action: 'create',
      conversionFactor: 3500,
      createIntent: {
        name: 'Queso Mozzarella P/Fetear La Paulina Barra x 3,5 Kg',
        baseUnit: 'g',
      },
    })
  })

  it('convierte plancha/barra a g con factor (no INCOMPATIBLE en web)', () => {
    const flour = { id: OTHER_PRODUCT_ID, baseUnit: 'g' as const }
    expect(reviewMappingPhysicalLabel(
      liquidLine({ unit: 'plancha', quantity: 1, inventoryPhysicalQuantity: 8884 }),
      flour,
      8884,
    )).toBe('8,884 kg')
    expect(reviewMappingPhysicalLabel(
      liquidLine({ unit: 'barra', quantity: 1, inventoryPhysicalQuantity: 3500 }),
      flour,
      3500,
    )).toBe('3,5 kg')
  })

  it('permite seleccionar un insumo a mano y dejar la línea sin vincular', () => {
    const reviewed = reviewedBonus()
    const none = hydrateReviewMapping(reviewed, [])
    expect(none.mappingDrafts['line-pilsen']?.action).toBe('create')
    expect(none.mappingSuggestions['line-pilsen']).toBeNull()

    const manual = setReviewMappingProduct(none, 'line-pilsen', OTHER_PRODUCT_ID)
    expect(manual.mappingDrafts['line-pilsen']?.inventoryProductId).toBe(OTHER_PRODUCT_ID)
    expect(manual.corrections).toEqual({})
    expect(manual.result!.document.lines[0]).toEqual(reviewed.result!.document.lines[0])

    const cleared = setReviewMappingProduct(manual, 'line-pilsen', '')
    expect(cleared.mappingDrafts['line-pilsen']?.action).toBe('create')
    expect(cleared.mappingDrafts['line-pilsen']?.createIntent?.name).toBeTruthy()
  })

  it('confirma una sugerencia aproximada sin guardar todavía', () => {
    const line = { ...confirmedBonusInvoiceResult.document.lines[0]!, name: 'PILSEN RUBIA' }
    const selected = selectInvoiceFile(initialInvoiceFlow, fakeFile('factura.pdf', 'application/pdf'))
    const reviewed = succeedAnalyze(beginAnalyze(selected)!, signedInvoiceResult({
      ...confirmedBonusInvoiceResult,
      document: { ...confirmedBonusInvoiceResult.document, lines: [line, confirmedBonusInvoiceResult.document.lines[1]!] },
      metadata: signedInvoiceResult().metadata,
    }))
    const hydrated = hydrateReviewMapping(reviewed, [pilsenMemory()])
    expect(hydrated.mappingDrafts['line-pilsen']?.inventoryProductId).toBe('')
    const accepted = acceptReviewMappingSuggestion(hydrated, 'line-pilsen')
    expect(accepted.mappingDrafts['line-pilsen']).toEqual({
      inventoryProductId: PRODUCT_ID,
      approximateAccepted: true,
      conversionFactor: 1000,
      action: 'link_existing',
      createIntent: null,
    })
  })

  it('convierte 2 L a 2.000 ml y bloquea unidades incompatibles o sin equivalencia', () => {
    const liquid = { id: PRODUCT_ID, baseUnit: 'ml' }
    const flour = { id: OTHER_PRODUCT_ID, baseUnit: 'g' }
    expect(reviewMappingPhysicalLabel(liquidLine(), liquid)).toBe('2 L')
    expect(reviewMappingPhysicalLabel(liquidLine({ unit: 'l (litros)' }), liquid)).toBe('2 L')
    expect(reviewMappingPhysicalLabel(liquidLine({ unit: 'kg' }), liquid)).toBe(
      'No se puede convertir esa unidad de la factura a la unidad del inventario.',
    )
    expect(reviewMappingPhysicalLabel(liquidLine({ unit: 'caja' }), flour)).toBe(
      '¿Cuántos kg trae cada caja?',
    )
    expect(reviewMappingPhysicalLabel(liquidLine({ unit: 'caja' }), flour, 8000)).toBe('16 kg')
    expect(reviewMappingPhysicalLabel(liquidLine(), null)).toBeNull()

    const boxed = hydrateReviewMappingDrafts(
      [liquidLine({ id: 'line-box', name: 'PILSEN', originalDescription: 'PILSEN', unit: 'caja' })],
      [pilsenMemory()],
    )
    expect(boxed.suggestions['line-box']?.kind).toBe('exact')
    expect(boxed.drafts['line-box']).toEqual({
      inventoryProductId: PRODUCT_ID,
      approximateAccepted: false,
      conversionFactor: 1000,
      action: 'link_existing',
      createIntent: null,
    })
  })

  it('reinicia los borradores al cambiar de organización o local', () => {
    const hydrated = hydrateReviewMapping(reviewedBonus(), [pilsenMemory()])
    expect(hydrated.mappingDrafts['line-pilsen']?.inventoryProductId).toBe(PRODUCT_ID)
    const reset = resetReviewMapping(hydrated)
    expect(reset.mappingDrafts).toEqual({})
    expect(reset.mappingSuggestions).toEqual({})
    const otherLocation = hydrateReviewMapping(reset, [])
    expect(otherLocation.mappingDrafts['line-pilsen']?.action).toBe('create')
    expect(otherLocation.mappingDrafts['line-pilsen']?.createIntent?.name).toMatch(/PILSEN/i)
    expect(otherLocation.receivedDrafts).toEqual(hydrated.receivedDrafts)
  })

  it('conserva una selección manual al rehidratar y no la mezcla con corrections', () => {
    const reviewed = setReviewMappingProduct(reviewedBonus(), 'line-pilsen', OTHER_PRODUCT_ID)
    const next = hydrateReviewMapping(reviewed, [pilsenMemory()])
    expect(next.mappingDrafts['line-pilsen']?.inventoryProductId).toBe(OTHER_PRODUCT_ID)
    expect(next.mappingSuggestions['line-pilsen']?.kind).toBe('exact')
    expect(next.corrections).toEqual({})
  })
})

describe('guardado de factura', () => {
  function reviewedState(result = signedInvoiceResult()) {
    const selected = selectInvoiceFile(initialInvoiceFlow, fakeFile('factura.pdf', 'application/pdf'))
    return succeedAnalyze(beginAnalyze(selected)!, result)
  }

  it('congela el snapshot original y conserva el archivo durante la revisión', () => {
    const result = signedInvoiceResult()
    const reviewed = reviewedState(result)
    reviewed.result!.metadata.integrityToken = 'mutado'
    expect(reviewed.file?.name).toBe('factura.pdf')
    expect(reviewed.originalSnapshot?.metadata.integrityToken).toBe('integrity-token-test')
    expect(reviewed.originalSnapshot?.document.header.number).toBe('0001-00000001')
  })

  it('arma multipart con los campos del contrato y sin actor ni organización', () => {
    const snapshot = signedInvoiceResult()
    const body = buildInvoiceSaveFormData({
      file: fakeFile('factura.pdf', 'application/pdf'),
      locationId: 'loc-1',
      integrityToken: 'integrity-token-test',
      originalSnapshot: snapshot,
      corrections: {},
      commercialDecisions: toCommercialDecisionPayload(bonusInvoiceResult, {
        'relation-line-bonus': 'confirm',
      }),
      acceptFiscalInconsistency: true,
    })
    expect(body.get('locationId')).toBe('loc-1')
    expect(body.get('integrityToken')).toBe('integrity-token-test')
    expect(body.get('originalSnapshot')).toBe(JSON.stringify(snapshot))
    expect(body.get('corrections')).toBe('{}')
    expect(JSON.parse(String(body.get('commercialDecisions')))).toHaveLength(1)
    expect(body.get('acceptFiscalInconsistency')).toBe('true')
    expect(body.get('file')).toBeTruthy()
    expect(body.get('organizationId')).toBeNull()
    expect(body.get('actor_user_id')).toBeNull()
    expect(body.get('mappingDrafts')).toBeNull()
    expect(body.get('receivedDrafts')).toBeNull()
    expect(body.get('organization_id')).toBeNull()
  })

  it('envía POST /api/invoices con Authorization y no confirma sin data.id', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/api\/invoices$/)
      expect(init?.method).toBe('POST')
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer token-test')
      const body = init?.body as FormData
      expect(body.get('actor_user_id')).toBeNull()
      expect(body.get('organizationId')).toBeNull()
      return new Response(JSON.stringify({ data: savedInvoiceResult() }), { status: 200 })
    }) as unknown as typeof fetch

    const saved = await saveInvoice({
      file: fakeFile('factura.pdf', 'application/pdf'),
      locationId: 'loc-1',
      integrityToken: 'integrity-token-test',
      originalSnapshot: signedInvoiceResult(),
      commercialDecisions: [],
    }, { fetchImpl, accessToken: 'token-test' })
    expect(saved.id).toBe('doc-saved-1')
    expect(saved.status).toBe('reviewed')
  })

  it('informa buscar en Facturas si el guardado es NETWORK o SAVE_TIMEOUT', async () => {
    const aborting = vi.fn(async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }) as unknown as typeof fetch
    await expect(saveInvoice({
      file: fakeFile('factura.pdf', 'application/pdf'),
      locationId: 'loc-1',
      integrityToken: 'integrity-token-test',
      originalSnapshot: signedInvoiceResult(),
      commercialDecisions: [],
    }, { fetchImpl: aborting, accessToken: 'token-test', timeoutMs: 1 })).rejects.toMatchObject({
      code: 'SAVE_TIMEOUT',
      status: 504,
      message: expect.stringMatching(/Buscá el comprobante en Facturas/),
    })

    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(saveInvoice({
      file: fakeFile('factura.pdf', 'application/pdf'),
      locationId: 'loc-1',
      integrityToken: 'integrity-token-test',
      originalSnapshot: signedInvoiceResult(),
      commercialDecisions: [],
    }, { fetchImpl: failing, accessToken: 'token-test' })).rejects.toMatchObject({
      code: 'NETWORK',
      status: 0,
      message: expect.stringMatching(/No se registró recepción automática/),
    })
  })

  it('no trata como éxito una respuesta 200 sin id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch
    await expect(saveInvoice({
      file: fakeFile('factura.pdf', 'application/pdf'),
      locationId: 'loc-1',
      integrityToken: 'integrity-token-test',
      originalSnapshot: signedInvoiceResult(),
      commercialDecisions: [],
    }, { fetchImpl, accessToken: 'token-test' })).rejects.toMatchObject({
      code: 'SAVE_INVALID_RESPONSE',
    })
  })

  it.each([
    [409, 'DUPLICATE_DOCUMENT', 'Este comprobante ya está registrado.'],
    [503, 'INVOICE_STORAGE_NOT_CONFIGURED', 'El almacenamiento de facturas no está configurado.'],
    [401, 'UNAUTHENTICATED', 'La sesión expiró o no es válida.'],
    [422, 'SAVE_NOT_ALLOWED_NO_INVENTORY', 'Este documento no tiene productos de inventario para guardar.'],
    [422, 'FISCAL_INCONSISTENCY_REQUIRES_ACCEPTANCE', 'La diferencia fiscal requiere confirmación explícita.'],
  ] as const)('mapea el error de guardado %s %s', (status, code, message) => {
    const error = mapInvoiceSaveHttpError(status, { error: 'interno', code })
    expect(error.message).toBe(message)
    expect(error.code).toBe(code)
    expect(error.message).not.toMatch(/interno|GEMINI/i)
  })

  it('conserva el mensaje de bonificación pendiente del backend', () => {
    const error = mapInvoiceSaveHttpError(422, {
      error: 'Confirmá o rechazá la bonificación de PILSEN antes de guardar.',
      code: 'COMMERCIAL_RELATION_UNRESOLVED',
    })
    expect(error.message).toBe('Confirmá o rechazá la bonificación de PILSEN antes de guardar.')
    expect(error.code).toBe('COMMERCIAL_RELATION_UNRESOLVED')
  })

  it('bloquea el guardado de Lúpulo hasta confirmar o rechazar la bonificación', () => {
    const pending = reviewedState(signedInvoiceResult({
      ...bonusInvoiceResult,
      metadata: signedInvoiceResult().metadata,
    }))
    expect(canSaveInvoice(pending, 'loc-1')).toBe(false)
    expect(saveBlockedReason(pending, 'loc-1', false)).toBe(
      'Confirmá o rechazá la bonificación de PILSEN antes de guardar.',
    )
    expect(pending.result?.document.lines[0]?.inventoryEligibility).toBe('pending_review')

    const confirmed = setLocalDecision(pending, 'relation-line-bonus', 'confirm')
    expect(confirmed.result?.document.lines[0]?.inventoryEligibility).toBe('eligible')
    expect(confirmed.result?.document.lines[1]?.inventoryEligibility).toBe('ineligible')
    expect(confirmed.result?.interpretation.relations[0]?.status).toBe('confirmed')
    expect(confirmed.originalSnapshot?.document.lines[0]?.inventoryEligibility).toBe('pending_review')
    expect(confirmed.originalSnapshot?.document.lines[0]?.amount).toBe(82500)
    expect(canSaveInvoice(confirmed, 'loc-1')).toBe(true)
    expect(saveBlockedReason(confirmed, 'loc-1', false)).toBeNull()

    const rejected = setLocalDecision(pending, 'relation-line-bonus', 'reject')
    expect(rejected.result?.interpretation.relations[0]?.status).toBe('rejected')
    expect(rejected.result?.document.lines[0]?.inventoryEligibility).toBe('eligible')
    expect(rejected.result?.document.lines[1]?.inventoryEligibility).toBe('ineligible')
    expect(canSaveInvoice(rejected, 'loc-1')).toBe(true)
  })

  it('no confirma automáticamente una relación ambigua', () => {
    const ambiguous = signedInvoiceResult({
      ...bonusInvoiceResult,
      metadata: signedInvoiceResult().metadata,
      interpretation: {
        ...bonusInvoiceResult.interpretation,
        relations: [{
          ...bonusInvoiceResult.interpretation.relations[0]!,
          targetLineId: null,
          candidateTargetLineIds: ['line-pilsen', 'line-ipa'],
          status: 'requires_review',
        }],
      },
    })
    const applied = applyCommercialReview(ambiguous, { 'relation-line-bonus': 'confirm' })
    expect(applied.interpretation.relations[0]?.status).toBe('requires_review')
    expect(applied.document.lines[0]?.inventoryEligibility).toBe('pending_review')
    const reviewed = reviewedState(ambiguous)
    const attempted = setLocalDecision(reviewed, 'relation-line-bonus', 'confirm')
    expect(canSaveInvoice(attempted, 'loc-1')).toBe(false)
    expect(saveBlockedReason(attempted, 'loc-1', false)).toMatch(/más de un producto candidato/)
  })

  it('no ofrece guardar un servicio ni un análisis sin token', () => {
    expect(canSaveInvoice(reviewedState(serviceInvoiceResult), 'loc-1')).toBe(false)
    expect(canSaveInvoice(reviewedState(baseInvoiceResult()), 'loc-1')).toBe(false)
    expect(canSaveInvoice(reviewedState(), '')).toBe(false)
    expect(canSaveInvoice(reviewedState(), 'loc-1')).toBe(true)
  })

  it('exige aceptación explícita cuando el fiscal es inconsistente', () => {
    const inconsistent = signedInvoiceResult({
      validation: {
        ...signedInvoiceResult().validation,
        fiscalReconciliation: {
          ...signedInvoiceResult().validation.fiscalReconciliation,
          status: 'inconsistent',
        },
        dimensions: {
          ...signedInvoiceResult().validation.dimensions,
          fiscal: { status: 'inconsistent', issues: [] },
        },
      },
    })
    expect(needsFiscalAcceptance(inconsistent)).toBe(true)
    const reviewed = reviewedState(inconsistent)
    expect(canSaveInvoice(reviewed, 'loc-1')).toBe(false)
    expect(canSaveInvoice(setAcceptFiscalInconsistency(reviewed, true), 'loc-1')).toBe(true)
  })

  it('ignora un segundo guardado mientras el primero está en curso', () => {
    const reviewed = reviewedState()
    const first = beginSave(reviewed, 'loc-1')
    expect(first?.saveStatus).toBe('saving')
    expect(beginSave(first!, 'loc-1')).toBeNull()
    expect(canSaveInvoice(first!, 'loc-1')).toBe(false)
  })

  it('conserva correcciones locales si el backend rechaza el guardado', () => {
    const decided = setLocalDecision(reviewedState(signedInvoiceResult({
      ...bonusInvoiceResult,
      metadata: signedInvoiceResult().metadata,
    })), 'relation-line-bonus', 'confirm')
    const failed = failSave(beginSave(decided, 'loc-1')!, {
      message: 'Este comprobante ya está registrado.',
      status: 409,
      code: 'DUPLICATE_DOCUMENT',
    })
    expect(failed.saveStatus).toBe('failed')
    expect(failed.localDecisions['relation-line-bonus']).toBe('confirm')
    expect(failed.originalSnapshot).toBeTruthy()
    expect(failed.result).toBeTruthy()
    expect(failed.file?.name).toBe('factura.pdf')
    expect(canSaveInvoice(failed, 'loc-1')).toBe(true)
  })

  it('conserva el id solo después de una respuesta del backend', () => {
    const saving = beginSave(reviewedState(), 'loc-1')!
    expect(saving.savedDocument).toBeNull()
    const saved = succeedSave(saving, savedInvoiceResult({ idempotent: true }))
    expect(saved.saveStatus).toBe('saved')
    expect(saved.savedDocument?.id).toBe('doc-saved-1')
    expect(beginSave(saved, 'loc-1')).toBeNull()
  })

  it('bloquea el guardado si la cantidad recibida es inválida', () => {
    const reviewed = reviewedState()
    const invalid = setReviewReceivedDisplay(reviewed, 'line-harina', 'abc')
    expect(canSaveInvoice(invalid, 'loc-1')).toBe(false)
    expect(reviewIntakeBlockReason(invalid.result!.document.lines, invalid.receivedDrafts)).toMatch(/cantidad válida/)
  })
})

describe('ingesta al guardar', () => {
  const PRODUCT = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    name: 'PRUEBA SENDA — Líquido',
    baseUnit: 'ml',
    organizationId: 'org-1',
    active: true,
  }
  const STORED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const OTHER_STORED_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function liquidLine(overrides: Partial<InvoiceAnalysisLine> = {}): InvoiceAnalysisLine {
    return {
      id: 'line-liquid',
      sourceIndex: 0,
      originalDescription: 'PRUEBA SENDA — Líquido',
      name: 'PRUEBA SENDA — Líquido',
      supplierSku: null,
      quantity: 2,
      unit: 'L',
      unitPrice: 10,
      amount: 20,
      classification: 'stock',
      inventoryEligibility: 'eligible',
      quantityKind: 'inventory',
      inventoryPhysicalQuantity: 2,
      missingFields: [],
      ambiguities: [],
      ...overrides,
    }
  }

  function flourLine(): InvoiceAnalysisLine {
    return {
      id: 'line-flour',
      sourceIndex: 1,
      originalDescription: 'Harina',
      name: 'Harina',
      supplierSku: null,
      quantity: 10,
      unit: 'kg',
      unitPrice: 100,
      amount: 1000,
      classification: 'stock',
      inventoryEligibility: 'eligible',
      quantityKind: 'inventory',
      inventoryPhysicalQuantity: 10,
      missingFields: [],
      ambiguities: [],
    }
  }

  function analysis(...lines: InvoiceAnalysisLine[]) {
    return signedInvoiceResult({
      document: { ...baseInvoiceResult().document, lines },
      inventory: { eligibleLines: lines.length, pendingLines: 0, receptionBlocked: false, shouldOfferFutureReceipt: true },
    })
  }

  function storedFor(line: InvoiceAnalysisLine, overrides: Partial<InvoiceStoredLine> = {}): InvoiceStoredLine {
    return storedLine({
      id: STORED_ID,
      sourceLineId: line.id,
      original: { description: line.name, quantity: line.quantity, unit: line.unit, unitPrice: line.unitPrice, amount: line.amount },
      reviewed: { description: line.name, quantity: line.quantity, unit: line.unit, unitPrice: line.unitPrice, amount: line.amount },
      invoicedQuantity: 0,
      receivedQuantity: 0,
      remainingQuantity: 0,
      ...overrides,
    })
  }

  function detail(lines: InvoiceStoredLine[]): InvoiceDetail {
    return {
      id: 'doc-saved-1',
      status: 'reviewed',
      locationId: 'loc-1',
      organizationId: 'org-1',
      supplierName: 'Alimentos Demo SA',
      issuerTaxId: '30-12345678-1',
      documentDate: '2026-08-01',
      documentNumber: '0001-00000001',
      documentType: 'invoice',
      classification: 'gastronomic_merchandise',
      currency: 'ARS',
      eligibleLineCount: lines.length,
      unmappedLineCount: lines.filter((line) => line.mappingStatus !== 'mapped').length,
      fiscalDifferenceAccepted: false,
      originalAnalysis: null,
      reviewedAnalysis: null,
      corrections: {},
      commercialDecisions: [],
      lines,
      file: null,
    }
  }

  function mapResult(sourceLineId: string, physical = 2000): InvoiceMapResult {
    return {
      id: STORED_ID,
      sourceLineId,
      mappingStatus: 'mapped',
      inventoryProductId: PRODUCT.id,
      inventoryPhysicalQuantity: physical,
      inventoryProduct: PRODUCT,
      unmappedLineCount: 0,
    }
  }

  function receipt(quantity: number, invoiced = 2000, idempotent = false): InvoiceReceiveResult {
    return {
      id: 'receipt-1',
      purchaseDocumentId: 'doc-saved-1',
      purchaseDocumentLineId: STORED_ID,
      quantity,
      invoicedQuantity: invoiced,
      receivedQuantity: quantity,
      remainingQuantity: invoiced - quantity,
      documentStatus: invoiced - quantity <= 0 ? 'received' : 'reviewed',
      inventoryMovementId: 'mov-1',
      idempotent,
    }
  }

  function mappedDraft(overrides: Partial<{
    inventoryProductId: string
    conversionFactor: number | null
    action: 'link_existing' | 'create' | 'reactivate' | 'pending'
  }> = {}) {
    return {
      inventoryProductId: PRODUCT.id,
      approximateAccepted: false,
      conversionFactor: null as number | null,
      action: 'link_existing' as const,
      createIntent: null,
      ...overrides,
    }
  }

  it('planifica coincidencia exacta, parcial, cero, sin insumo, empaque y factor manual', () => {
    const liquid = liquidLine()
    const boxed = liquidLine({ id: 'line-box', unit: 'caja', name: 'Caja' })
    const flour = { ...PRODUCT, id: 'flour-1', name: 'Tomate', baseUnit: 'g' }
    expect(planReviewIntake([liquid], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT])[0]).toMatchObject({
      action: 'map_and_receive',
      physicalReceive: 2000,
    })
    expect(planReviewIntake([liquid], { 'line-liquid': '0,8' }, { 'line-liquid': mappedDraft() }, [PRODUCT])[0]).toMatchObject({
      action: 'map_and_receive',
      physicalReceive: 800,
    })
    expect(planReviewIntake([liquid], { 'line-liquid': '0' }, { 'line-liquid': mappedDraft() }, [PRODUCT])[0]).toMatchObject({
      action: 'map_only',
      physicalReceive: null,
    })
    expect(planReviewIntake([liquid], { 'line-liquid': '2' }, { 'line-liquid': emptyReviewMappingDraft() }, [PRODUCT])[0].action).toBe('pending_mapping')
    expect(planReviewIntake([boxed], { 'line-box': '1' }, { 'line-box': mappedDraft({ inventoryProductId: flour.id }) }, [flour])[0].action).toBe('conversion_invalid')
    expect(planReviewIntake(
      [boxed],
      { 'line-box': '2' },
      { 'line-box': mappedDraft({ inventoryProductId: flour.id, conversionFactor: 8000 }) },
      [flour],
    )[0]).toMatchObject({
      action: 'map_and_receive',
      physicalReceive: 16000,
      conversionFactor: 8000,
    })
  })

  it('recibe 2 L como 2.000 ml y no vuelve a guardar el PDF', async () => {
    const line = liquidLine()
    const saveInvoiceFn = vi.fn(async () => savedInvoiceResult())
    const getInvoiceFn = vi.fn(async () => detail([storedFor(line)]))
    const mapFn = vi.fn(async () => mapResult('line-liquid', 2000))
    const receiveFn = vi.fn(async () => receipt(2000))
    const first = await saveThenApplyIntake({
      planned: planReviewIntake(
        [line],
        { 'line-liquid': '2' },
        { 'line-liquid': { inventoryProductId: PRODUCT.id, approximateAccepted: false } },
        [PRODUCT],
      ),
      saveInvoice: saveInvoiceFn,
      ports: {
        getInvoice: getInvoiceFn,
        mapInvoiceLine: mapFn,
        receiveInvoiceLine: receiveFn,
        store: createMemoryAttemptStore(),
        createKey: () => 'key-full',
      },
    })
    expect(first.summary.kind).toBe('complete')
    expect(first.lines[0]?.status).toBe('received')
    expect(receiveFn).toHaveBeenCalledWith('doc-saved-1', STORED_ID, {
      quantity: 2000,
      idempotencyKey: 'key-full',
    })
    expect(saveInvoiceFn).toHaveBeenCalledTimes(1)

    const planned = planReviewIntake([line], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT])
    const retry = await saveThenApplyIntake({
      savedDocument: first.saved,
      previous: first.lines,
      planned,
      saveInvoice: saveInvoiceFn,
      ports: {
        getInvoice: getInvoiceFn,
        mapInvoiceLine: mapFn,
        receiveInvoiceLine: receiveFn,
        store: createMemoryAttemptStore(),
        createKey: () => 'key-retry',
      },
    })
    expect(saveInvoiceFn).toHaveBeenCalledTimes(1)
    expect(receiveFn).toHaveBeenCalledTimes(1)
    expect(retry.lines[0]?.status).toBe('received')
  })

  it('recibe 0,8 L como 800 ml y deja pendiente el resto', async () => {
    const line = liquidLine()
    const outcome = await saveThenApplyIntake({
      planned: planReviewIntake([line], { 'line-liquid': '0,8' }, { 'line-liquid': mappedDraft() }, [PRODUCT]),
      saveInvoice: async () => savedInvoiceResult(),
      ports: {
        getInvoice: async () => detail([storedFor(line)]),
        mapInvoiceLine: async () => mapResult('line-liquid', 2000),
        receiveInvoiceLine: async (_invoice, _line, input) => receipt(input.quantity, 2000),
        store: createMemoryAttemptStore(),
        createKey: () => 'key-partial',
      },
    })
    expect(outcome.lines[0]).toMatchObject({ status: 'partial', physicalQuantity: 800, remainingQuantity: 1200 })
    expect(outcome.summary.kind).toBe('partial')
  })

  it('vincula con cantidad cero y no registra recepción', async () => {
    const line = liquidLine()
    const receiveFn = vi.fn()
    const outcome = await saveThenApplyIntake({
      planned: planReviewIntake([line], { 'line-liquid': '0' }, { 'line-liquid': mappedDraft() }, [PRODUCT]),
      saveInvoice: async () => savedInvoiceResult(),
      ports: {
        getInvoice: async () => detail([storedFor(line)]),
        mapInvoiceLine: async () => mapResult('line-liquid', 2000),
        receiveInvoiceLine: receiveFn,
      },
    })
    expect(outcome.lines[0]?.status).toBe('mapped')
    expect(receiveFn).not.toHaveBeenCalled()
    expect(outcome.summary.title).toBe('Operación incompleta')
    expect(outcome.summary.body).toMatch(/sin ingreso de stock/)
  })

  it('mezcla una línea recibida y otra pendiente de insumo', async () => {
    const liquid = liquidLine()
    const flour = flourLine()
    const receiveFn = vi.fn(async () => receipt(2000))
    const outcome = await saveThenApplyIntake({
      planned: planReviewIntake(
        [liquid, flour],
        { 'line-liquid': '2', 'line-flour': '10' },
        { 'line-liquid': mappedDraft(), 'line-flour': emptyReviewMappingDraft() },
        [PRODUCT],
      ),
      saveInvoice: async () => savedInvoiceResult(),
      ports: {
        getInvoice: async () => detail([storedFor(liquid), storedFor(flour, { id: OTHER_STORED_ID })]),
        mapInvoiceLine: async () => mapResult('line-liquid', 2000),
        receiveInvoiceLine: receiveFn,
        store: createMemoryAttemptStore(),
        createKey: () => 'key-mix',
      },
    })
    expect(outcome.lines.map((line) => line.status)).toEqual(['received', 'pending_mapping'])
    expect(receiveFn).toHaveBeenCalledTimes(1)
    expect(outcome.summary.kind).toBe('pending_mapping')
    expect(summarizeIntake(outcome.lines).title).toBe('Operación incompleta')
    expect(summarizeIntake(outcome.lines).body).toMatch(/vinculación/)
  })

  it('no mueve stock si la conversión es incompatible', async () => {
    const boxed = liquidLine({ unit: 'caja', name: 'Caja' })
    const mapFn = vi.fn()
    const receiveFn = vi.fn()
    const outcome = await saveThenApplyIntake({
      planned: planReviewIntake([boxed], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT]),
      saveInvoice: async () => savedInvoiceResult(),
      ports: {
        getInvoice: async () => detail([storedFor(boxed)]),
        mapInvoiceLine: mapFn,
        receiveInvoiceLine: receiveFn,
      },
    })
    expect(outcome.lines[0]?.status).toBe('conversion_invalid')
    expect(mapFn).not.toHaveBeenCalled()
    expect(receiveFn).not.toHaveBeenCalled()
  })

  it('marca asociación fallida si el sourceLineId no coincide', async () => {
    const line = liquidLine()
    const outcome = await saveThenApplyIntake({
      planned: planReviewIntake([line], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT]),
      saveInvoice: async () => savedInvoiceResult(),
      ports: {
        getInvoice: async () => detail([storedFor(line, { sourceLineId: 'line-otra' })]),
        mapInvoiceLine: vi.fn(),
        receiveInvoiceLine: vi.fn(),
      },
    })
    expect(outcome.lines[0]?.status).toBe('association_failed')
    expect(outcome.lines[0]?.retryable).toBe(true)
    expect(outcome.summary.kind).toBe('errors')
  })

  it('conserva el documento si falla la consulta después de guardar', async () => {
    const line = liquidLine()
    const saveInvoiceFn = vi.fn(async () => savedInvoiceResult())
    const planned = planReviewIntake([line], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT])
    const first = await saveThenApplyIntake({
      planned,
      saveInvoice: saveInvoiceFn,
      ports: {
        getInvoice: async () => {
          throw new InvoiceApiError('No se encontraron las líneas.', 500, 'LOOKUP_FAILED')
        },
        mapInvoiceLine: vi.fn(),
        receiveInvoiceLine: vi.fn(),
      },
    })
    expect(first.saved.id).toBe('doc-saved-1')
    expect(first.lines[0]?.status).toBe('load_failed')
    expect(first.lines[0]?.retryable).toBe(true)
    expect(saveInvoiceFn).toHaveBeenCalledTimes(1)

    const receiveFn = vi.fn(async () => receipt(2000))
    const retry = await saveThenApplyIntake({
      savedDocument: first.saved,
      previous: first.lines,
      planned,
      saveInvoice: saveInvoiceFn,
      ports: {
        getInvoice: async () => detail([storedFor(line)]),
        mapInvoiceLine: async () => mapResult('line-liquid', 2000),
        receiveInvoiceLine: receiveFn,
        store: createMemoryAttemptStore(),
        createKey: () => 'key-after-load',
      },
    })
    expect(saveInvoiceFn).toHaveBeenCalledTimes(1)
    expect(retry.lines[0]?.status).toBe('received')
    expect(receiveFn).toHaveBeenCalledTimes(1)
  })

  it('conserva la clave si el resultado de recepción es incerto y no duplica al reintentar', async () => {
    const line = liquidLine()
    const store = createMemoryAttemptStore()
    const planned = planReviewIntake([line], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT])
    const receiveFn = vi.fn()
      .mockRejectedValueOnce(new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK'))
      .mockResolvedValueOnce(receipt(2000, 2000, true))
    const first = await saveThenApplyIntake({
      planned,
      saveInvoice: async () => savedInvoiceResult(),
      ports: {
        getInvoice: async () => detail([storedFor(line)]),
        mapInvoiceLine: async () => mapResult('line-liquid', 2000),
        receiveInvoiceLine: receiveFn,
        store,
        createKey: () => 'key-uncertain',
      },
    })
    expect(first.lines[0]?.status).toBe('receive_uncertain')
    expect(first.lines[0]?.retryable).toBe(true)
    expect(first.summary.kind).toBe('errors')

    const retry = await saveThenApplyIntake({
      savedDocument: first.saved,
      previous: first.lines,
      planned,
      saveInvoice: async () => savedInvoiceResult({ id: 'doc-should-not-save' }),
      ports: {
        getInvoice: async () => detail([storedFor(line, {
          mappingStatus: 'mapped',
          inventoryProductId: PRODUCT.id,
          inventoryPhysicalQuantity: 2000,
          remainingQuantity: 2000,
        })]),
        mapInvoiceLine: vi.fn(async () => mapResult('line-liquid', 2000)),
        receiveInvoiceLine: receiveFn,
        store,
        createKey: () => 'key-should-not-use',
      },
    })
    expect(receiveFn).toHaveBeenNthCalledWith(1, 'doc-saved-1', STORED_ID, {
      quantity: 2000,
      idempotencyKey: 'key-uncertain',
    })
    expect(receiveFn).toHaveBeenNthCalledWith(2, 'doc-saved-1', STORED_ID, {
      quantity: 2000,
      idempotencyKey: 'key-uncertain',
    })
    expect(retry.lines[0]?.status).toBe('received')
    expect(retry.summary.kind).toBe('complete')
  })

  it('no llama recepción si la línea ya no tiene pendiente', async () => {
    const line = liquidLine()
    const receiveFn = vi.fn()
    const outcome = await saveThenApplyIntake({
      planned: planReviewIntake([line], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT]),
      saveInvoice: async () => savedInvoiceResult(),
      ports: {
        getInvoice: async () => detail([storedFor(line, {
          mappingStatus: 'mapped',
          inventoryProductId: PRODUCT.id,
          inventoryPhysicalQuantity: 2000,
          invoicedQuantity: 2000,
          receivedQuantity: 2000,
          remainingQuantity: 0,
        })]),
        mapInvoiceLine: vi.fn(),
        receiveInvoiceLine: receiveFn,
      },
    })
    expect(receiveFn).not.toHaveBeenCalled()
    expect(outcome.lines[0]?.status).toBe('received')
  })

  it('no ejecuta GET, map ni receive si el documento ya estaba registrado', async () => {
    const line = liquidLine()
    const saveInvoiceFn = vi.fn(async () => savedInvoiceResult({
      id: 'fe8b3702-dea1-4e89-b86c-76ae42d700fc',
      idempotent: true,
    }))
    const getInvoiceFn = vi.fn()
    const mapFn = vi.fn()
    const receiveFn = vi.fn()
    const createKey = vi.fn(() => 'key-replay')
    const outcome = await saveThenApplyIntake({
      planned: planReviewIntake([line], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT]),
      saveInvoice: saveInvoiceFn,
      ports: {
        getInvoice: getInvoiceFn,
        mapInvoiceLine: mapFn,
        receiveInvoiceLine: receiveFn,
        store: createMemoryAttemptStore(),
        createKey,
      },
    })
    expect(saveInvoiceFn).toHaveBeenCalledTimes(1)
    expect(getInvoiceFn).not.toHaveBeenCalled()
    expect(mapFn).not.toHaveBeenCalled()
    expect(receiveFn).not.toHaveBeenCalled()
    expect(createKey).not.toHaveBeenCalled()
    expect(outcome.lines).toEqual([])
    expect(outcome.summary.kind).toBe('already_registered')
    expect(outcome.summary.body).toBe(ALREADY_REGISTERED_MESSAGE)
    expect(outcome.summary.title).not.toMatch(/recepción completa/)
  })

  it('tampoco recibe si el replay tiene líneas pendientes de insumo', async () => {
    const liquid = liquidLine()
    const flour = flourLine()
    const receiveFn = vi.fn()
    const outcome = await saveThenApplyIntake({
      planned: planReviewIntake(
        [liquid, flour],
        { 'line-liquid': '2', 'line-flour': '10' },
        { 'line-liquid': mappedDraft(), 'line-flour': emptyReviewMappingDraft() },
        [PRODUCT],
      ),
      saveInvoice: async () => savedInvoiceResult({ idempotent: true }),
      ports: {
        getInvoice: vi.fn(async () => detail([storedFor(liquid), storedFor(flour, { id: OTHER_STORED_ID })])),
        mapInvoiceLine: vi.fn(),
        receiveInvoiceLine: receiveFn,
        createKey: () => 'key-should-not-use',
      },
    })
    expect(receiveFn).not.toHaveBeenCalled()
    expect(outcome.summary.kind).toBe('already_registered')
    expect(outcome.lines).toEqual([])
  })

  it('no inicia intake si el guardado responde 409 DUPLICATE_DOCUMENT', async () => {
    const getInvoiceFn = vi.fn()
    const mapFn = vi.fn()
    const receiveFn = vi.fn()
    await expect(saveThenApplyIntake({
      planned: planReviewIntake([liquidLine()], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT]),
      saveInvoice: async () => {
        throw new InvoiceApiError('Este comprobante ya está registrado.', 409, 'DUPLICATE_DOCUMENT')
      },
      ports: {
        getInvoice: getInvoiceFn,
        mapInvoiceLine: mapFn,
        receiveInvoiceLine: receiveFn,
      },
    })).rejects.toMatchObject({ code: 'DUPLICATE_DOCUMENT', status: 409 })
    expect(getInvoiceFn).not.toHaveBeenCalled()
    expect(mapFn).not.toHaveBeenCalled()
    expect(receiveFn).not.toHaveBeenCalled()
  })

  it.each([
    ['NETWORK', 0, 'No se pudo conectar con el servidor. Buscá el comprobante en Facturas; si ya está, abrilo desde el detalle. No se registró recepción automática.'],
    ['SAVE_TIMEOUT', 504, 'El guardado superó el tiempo de espera. Buscá el comprobante en Facturas; si ya está, abrilo desde el detalle. No se registró recepción automática.'],
  ] as const)('no inicia intake si el guardado es incierto (%s)', async (code, status, message) => {
    const getInvoiceFn = vi.fn()
    const receiveFn = vi.fn()
    await expect(saveThenApplyIntake({
      planned: planReviewIntake([liquidLine()], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT]),
      saveInvoice: async () => {
        throw new InvoiceApiError(message, status, code)
      },
      ports: {
        getInvoice: getInvoiceFn,
        mapInvoiceLine: vi.fn(),
        receiveInvoiceLine: receiveFn,
      },
    })).rejects.toMatchObject({ code, status })
    expect(getInvoiceFn).not.toHaveBeenCalled()
    expect(receiveFn).not.toHaveBeenCalled()
  })

  it('no resume intake de un documento preexistente aunque haya savedDocument', async () => {
    const getInvoiceFn = vi.fn()
    const receiveFn = vi.fn()
    const outcome = await saveThenApplyIntake({
      savedDocument: savedInvoiceResult({ idempotent: true }),
      planned: planReviewIntake([liquidLine()], { 'line-liquid': '2' }, { 'line-liquid': mappedDraft() }, [PRODUCT]),
      saveInvoice: async () => savedInvoiceResult({ id: 'doc-should-not-save' }),
      ports: {
        getInvoice: getInvoiceFn,
        mapInvoiceLine: vi.fn(),
        receiveInvoiceLine: receiveFn,
        createKey: () => 'key-should-not-use',
      },
    })
    expect(getInvoiceFn).not.toHaveBeenCalled()
    expect(receiveFn).not.toHaveBeenCalled()
    expect(outcome.summary.kind).toBe('already_registered')
  })

  it('prioriza Factura ya registrada aunque haya líneas de recepción en memoria', () => {
    const summary = intakeOutcomeSummary({
      saved: savedInvoiceResult({ idempotent: true }),
      intakeLines: [{
        sourceLineId: 'line-liquid',
        label: 'Golden Ale',
        status: 'received',
        message: 'Recepción completa registrada.',
        retryable: false,
      }],
    })
    expect(summary?.kind).toBe('already_registered')
    expect(summary?.title).toBe('Factura ya registrada')
    expect(summary?.body).toBe(ALREADY_REGISTERED_MESSAGE)
    expect(summary?.title).not.toMatch(/recepción completa/)
  })

  it('ignora un segundo beginSave y permite reintentar solo lo pendiente', () => {
    const reviewed = succeedAnalyze(
      beginAnalyze(selectInvoiceFile(initialInvoiceFlow, fakeFile('factura.pdf', 'application/pdf')))!,
      analysis(liquidLine()),
    )
    const first = beginSave(reviewed, 'loc-1')
    expect(first?.saveStatus).toBe('saving')
    expect(beginSave(first!, 'loc-1')).toBeNull()
    const finished = succeedSave(first!, savedInvoiceResult())
    finished.intakeLines = [{
      sourceLineId: 'line-liquid',
      label: 'PRUEBA SENDA — Líquido',
      status: 'receive_uncertain',
      message: 'Red inestable',
      retryable: true,
    }]
    expect(canRetryIntake(finished)).toBe(true)
    expect(beginSave(finished, 'loc-1')).toBeNull()
    expect(beginIntakeRetry(finished)?.saveStatus).toBe('saving')
    expect(beginIntakeRetry(first!)).toBeNull()
    const replayed = succeedSave(first!, savedInvoiceResult({ idempotent: true }))
    replayed.intakeLines = finished.intakeLines
    expect(canRetryIntake(replayed)).toBe(false)
    expect(beginIntakeRetry(replayed)).toBeNull()
  })
})

describe('unidades de recepción', () => {
  it('muestra litros y kilos y convierte exactamente a unidades físicas', () => {
    expect(physicalToDisplay(100000, 'ml')).toBe(100)
    expect(displayToPhysical(100, 'ml')).toBe(100000)
    expect(physicalToDisplay(2500, 'g')).toBe(2.5)
    expect(displayToPhysical(2.5, 'g')).toBe(2500)
    expect(physicalToDisplay(12, 'unit')).toBe(12)
    expect(displayToPhysical(12, 'unit')).toBe(12)
    // 2 kg facturados / 1 kg recibido → quedan 1000 g = 1 kg (no "1000 unidades")
    expect(formatPendingInventoryQuantity(1000, 'g')).toBe('1 kg')
    expect(formatPendingInventoryQuantity(2000, 'g')).toBe('2 kg')
    expect(formatPendingInventoryQuantity(1000, 'g')).not.toMatch(/unidades/i)
    expect(formatInventoryUnit('ml')).toBe('L')
    expect(formatInventoryUnit('g')).toBe('kg')
    expect(formatInventoryUnit('unit')).toBe('u')
    expect(formatDisplayQuantity(100000, 'ml', (value) => String(value))).toBe('100 L')
    expect(parseDisplayQuantity('40,5')).toBe(40.5)
    expect(parseDisplayQuantity('0,8')).toBe(0.8)
    expect(parseDisplayQuantity('0.8')).toBe(0.8)
    expect(parseDisplayQuantity('1,2')).toBe(1.2)
    expect(parseDisplayQuantity('')).toBeNull()
    expect(parseDisplayQuantity('0')).toBeNull()
    expect(parseDisplayQuantity('0', { allowZero: true })).toBe(0)
    expect(parseDisplayQuantity('abc')).toBeNull()
    expect(parseDisplayQuantity('0,8 L')).toBeNull()
  })

  it('no altera la cantidad física facturada al convertir para mostrar', () => {
    const line = storedLine({
      inventoryPhysicalQuantity: 100000,
      invoicedQuantity: 100000,
      inventoryProduct: { id: 'p1', name: 'Cerveza', baseUnit: 'ml' },
    })
    expect(physicalToDisplay(line.invoicedQuantity, line.inventoryProduct?.baseUnit)).toBe(100)
    expect(line.inventoryPhysicalQuantity).toBe(100000)
    expect(line.invoicedQuantity).toBe(100000)
  })
})

describe('intentos de recepción', () => {
  it('falla si se extrae randomUUID y genera la clave con el receptor Crypto', () => {
    const store = createMemoryAttemptStore()
    const cryptoStub = stubBrowserCrypto('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    try {
      const detached = globalThis.crypto.randomUUID
      expect(() => detached()).toThrow(
        "'randomUUID' called on an object that does not implement interface Crypto.",
      )

      const first = prepareReceiveAttempt({
        invoiceId: 'inv-1',
        lineId: 'line-1',
        quantity: 800,
        store,
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      expect(first.reused).toBe(false)
      expect(first.attempt.idempotencyKey).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      expect(cryptoStub.calls).toBe(1)

      const retry = prepareReceiveAttempt({
        invoiceId: 'inv-1',
        lineId: 'line-1',
        quantity: 800,
        store,
      })
      expect(retry).toEqual({ ok: true, reused: true, attempt: first.attempt })
      expect(cryptoStub.calls).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('genera una clave por intento y reutiliza la pendiente en reintentos', () => {
    const store = createMemoryAttemptStore()
    const first = prepareReceiveAttempt({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      quantity: 40000,
      store,
      createKey: () => 'key-a',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.reused).toBe(false)
    const retry = prepareReceiveAttempt({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      quantity: 40000,
      store,
      createKey: () => 'key-b',
    })
    expect(retry).toEqual({ ok: true, reused: true, attempt: first.attempt })
    expect(JSON.parse(store.getItem(receiveAttemptKey('inv-1', 'line-1')) || '{}')).not.toHaveProperty('accessToken')
  })

  it('advierte si cambia la cantidad con un intento pendiente y no reutiliza una clave resuelta', () => {
    const store = createMemoryAttemptStore()
    prepareReceiveAttempt({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      quantity: 40000,
      store,
      createKey: () => 'key-a',
    })
    const changed = prepareReceiveAttempt({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      quantity: 50000,
      store,
      createKey: () => 'key-b',
    })
    expect(changed.ok).toBe(false)
    if (changed.ok) return
    expect(changed.reason).toBe('pending_different_quantity')
    expect(changed.attempt.idempotencyKey).toBe('key-a')

    markReceiveAttemptResolved('inv-1', 'line-1', store)
    const next = prepareReceiveAttempt({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      quantity: 40000,
      store,
      createKey: () => 'key-c',
    })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.attempt.idempotencyKey).toBe('key-c')
    expect(readReceiveAttempt('inv-1', 'line-1', store)?.status).toBe('pending')
  })
})

describe('cliente HTTP de recepción', () => {
  const result: InvoiceReceiveResult = {
    id: 'receipt-1',
    purchaseDocumentId: 'inv-1',
    purchaseDocumentLineId: 'line-1',
    quantity: 40000,
    invoicedQuantity: 100000,
    receivedQuantity: 40000,
    remainingQuantity: 60000,
    documentStatus: 'reviewed',
    inventoryMovementId: 'mov-1',
    idempotent: false,
  }

  it('envía POST autenticado con quantity e idempotencyKey, sin actor ni org', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/api\/invoices\/inv-1\/lines\/line-1\/receive$/)
      expect(init?.method).toBe('POST')
      expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer token-test')
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toEqual({ quantity: 40000, idempotencyKey: 'key-a' })
      expect(body).not.toHaveProperty('actorUserId')
      expect(body).not.toHaveProperty('organizationId')
      expect(body).not.toHaveProperty('actor_user_id')
      return new Response(JSON.stringify({ data: result }), { status: 200 })
    }) as unknown as typeof fetch

    const saved = await receiveInvoiceLine('inv-1', 'line-1', {
      quantity: 40000,
      idempotencyKey: 'key-a',
    }, { fetchImpl, accessToken: 'token-test' })
    expect(saved.receivedQuantity).toBe(40000)
    expect(saved.remainingQuantity).toBe(60000)
  })

  it('convierte un aborto en timeout y un fallo de red en NETWORK', async () => {
    const aborting = vi.fn(async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }) as unknown as typeof fetch
    await expect(receiveInvoiceLine('inv-1', 'line-1', {
      quantity: 1,
      idempotencyKey: 'key-a',
    }, { fetchImpl: aborting, accessToken: 'token-test', timeoutMs: 1 })).rejects.toMatchObject({
      code: 'RECEIVE_TIMEOUT',
      status: 504,
    })

    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(receiveInvoiceLine('inv-1', 'line-1', {
      quantity: 1,
      idempotencyKey: 'key-a',
    }, { fetchImpl: failing, accessToken: 'token-test' })).rejects.toMatchObject({
      code: 'NETWORK',
      status: 0,
    })
  })

  it.each([
    [409, 'IDEMPOTENCY_CONFLICT', 'Esa confirmación ya se usó con otros datos.'],
    [422, 'RECEIPT_EXCEEDS_INVOICED', 'La cantidad supera lo pendiente de esta línea.'],
    [422, 'LINE_NOT_MAPPED', 'La línea no está vinculada a un insumo.'],
    [422, 'INVALID_QUANTITY', 'Indicá una cantidad física mayor a cero.'],
    [422, 'UNVALUED_STOCK', 'Hay stock sin costo promedio. Cargá el costo inicial de ese insumo en Inventario antes de recibir esta compra. No se modificó el inventario.'],
    [401, 'UNAUTHENTICATED', 'La sesión expiró o no es válida.'],
  ] as const)('mapea el error de recepción %s %s', (status, code, message) => {
    const error = mapInvoiceReceiveHttpError(status, { error: 'interno', code })
    expect(error.message).toBe(message)
    expect(error.code).toBe(code)
    expect(error.message).not.toMatch(/interno|service_role/i)
  })

  it.each([
    [422, 'INVOICE_RECEIVED_REVERSAL_UNAVAILABLE', 'Esta factura ya fue recibida. Anularla requeriría revertir stock y costos; esa operación todavía no está habilitada. No se oculta ni se borra.'],
    [422, 'CANCEL_HAS_RECEIPTS', 'Esta factura ya tiene recepciones de stock. Anularla dejaría movimientos de inventario sin compensar. No se anula ni se borra.'],
    [403, 'FORBIDDEN', 'No tenés autorización para anular esta factura.'],
  ] as const)('mapea el error de anulación %s %s', (status, code, message) => {
    const error = mapInvoiceCancelHttpError(status, { error: 'interno', code })
    expect(error.message).toBe(message)
    expect(error.code).toBe(code)
    expect(error.message).not.toMatch(/interno|service_role/i)
  })
})

describe('envío de recepción', () => {
  const receiveResult = (overrides: Partial<InvoiceReceiveResult> = {}): InvoiceReceiveResult => ({
    id: 'receipt-1',
    purchaseDocumentId: 'inv-1',
    purchaseDocumentLineId: 'line-1',
    quantity: 40000,
    invoicedQuantity: 100000,
    receivedQuantity: 40000,
    remainingQuantity: 60000,
    documentStatus: 'reviewed',
    inventoryMovementId: 'mov-1',
    idempotent: false,
    ...overrides,
  })

  it('acepta 0,8 y 0.8 litros como 800 ml y 1,2 litros como 1.200 ml', async () => {
    const store = createMemoryAttemptStore()
    const receiveLine = vi.fn(async (_invoiceId, _lineId, input) => receiveResult({
      quantity: input.quantity,
      receivedQuantity: input.quantity,
      remainingQuantity: 2000 - input.quantity,
      invoicedQuantity: 2000,
    }))
    const comma = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 2000,
      unit: 'ml',
      displayValue: '0,8',
      store,
      receiveLine,
      createKey: () => 'key-comma',
    })
    expect(comma).toMatchObject({ kind: 'success' })
    expect(receiveLine).toHaveBeenCalledWith('inv-1', 'line-1', {
      quantity: 800,
      idempotencyKey: 'key-comma',
    })

    const dot = await submitReceiveLine({
      invoiceId: 'inv-2',
      lineId: 'line-2',
      remaining: 2000,
      unit: 'ml',
      displayValue: '0.8',
      store,
      receiveLine,
      createKey: () => 'key-dot',
    })
    expect(dot).toMatchObject({ kind: 'success' })
    expect(receiveLine).toHaveBeenCalledWith('inv-2', 'line-2', {
      quantity: 800,
      idempotencyKey: 'key-dot',
    })

    const rest = await submitReceiveLine({
      invoiceId: 'inv-3',
      lineId: 'line-3',
      remaining: 2000,
      unit: 'ml',
      displayValue: '1,2',
      store,
      receiveLine,
      createKey: () => 'key-rest',
    })
    expect(rest).toMatchObject({ kind: 'success' })
    expect(receiveLine).toHaveBeenCalledWith('inv-3', 'line-3', {
      quantity: 1200,
      idempotencyKey: 'key-rest',
    })
  })

  it('rechaza 3 L cuando quedan 2 L y no llama al servidor', async () => {
    const store = createMemoryAttemptStore()
    const receiveLine = vi.fn(async () => receiveResult())
    expect(await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 2000,
      unit: 'ml',
      displayValue: '3',
      store,
      receiveLine,
    })).toMatchObject({
      kind: 'validation',
      message: 'La cantidad supera lo pendiente de esta línea.',
    })
    expect(receiveLine).not.toHaveBeenCalled()
  })

  it('muestra el error de API sin perder la idempotencia', async () => {
    const store = createMemoryAttemptStore()
    const receiveLine = vi.fn().mockRejectedValue(
      new InvoiceApiError('No tenés autorización para recibir mercadería de esta factura.', 403, 'FORBIDDEN'),
    )
    const outcome = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 2000,
      unit: 'ml',
      displayValue: '0,8',
      store,
      receiveLine,
      createKey: () => 'key-forbidden',
    })
    expect(outcome).toMatchObject({
      kind: 'error',
      message: 'No tenés autorización para recibir mercadería de esta factura.',
    })
    expect(readReceiveAttempt('inv-1', 'line-1', store)).toMatchObject({
      status: 'pending',
      idempotencyKey: 'key-forbidden',
      quantity: 800,
    })
  })

  it('convierte la cantidad mostrada a mililitros y registra una recepción parcial', async () => {
    const store = createMemoryAttemptStore()
    const receiveLine = vi.fn(async () => receiveResult())
    const outcome = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 100000,
      unit: 'ml',
      displayValue: '40',
      store,
      receiveLine,
      createKey: () => 'key-a',
    })
    expect(outcome.kind).toBe('success')
    expect(receiveLine).toHaveBeenCalledWith('inv-1', 'line-1', {
      quantity: 40000,
      idempotencyKey: 'key-a',
    })
    expect(readReceiveAttempt('inv-1', 'line-1', store)?.status).toBe('resolved')
  })

  it('completa la línea cuando el servidor devuelve remaining 0', async () => {
    const store = createMemoryAttemptStore()
    const outcome = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 60000,
      unit: 'ml',
      displayValue: '60',
      store,
      receiveLine: async () => receiveResult({
        quantity: 60000,
        receivedQuantity: 100000,
        remainingQuantity: 0,
        documentStatus: 'received',
      }),
      createKey: () => 'key-complete',
    })
    expect(outcome.kind).toBe('success')
    if (outcome.kind !== 'success') return
    expect(outcome.result.documentStatus).toBe('received')
    expect(outcome.result.remainingQuantity).toBe(0)
  })

  it('valida cantidad inválida y excedente sin llamar al servidor', async () => {
    const store = createMemoryAttemptStore()
    const receiveLine = vi.fn(async () => receiveResult())
    expect(await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 100000,
      unit: 'ml',
      displayValue: '0',
      store,
      receiveLine,
    })).toMatchObject({ kind: 'validation', message: 'Indicá una cantidad mayor a cero.' })
    expect(await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 2000,
      unit: 'ml',
      displayValue: 'abc',
      store,
      receiveLine,
    })).toMatchObject({ kind: 'validation', message: 'Indicá una cantidad mayor a cero.' })
    expect(await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 40000,
      unit: 'ml',
      displayValue: '50',
      store,
      receiveLine,
    })).toMatchObject({ kind: 'validation', message: 'La cantidad supera lo pendiente de esta línea.' })
    expect(receiveLine).not.toHaveBeenCalled()
  })

  it('no genera un UUID nuevo al reintentar un resultado incierto', async () => {
    const store = createMemoryAttemptStore()
    const cryptoStub = stubBrowserCrypto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const receiveLine = vi.fn()
      .mockRejectedValueOnce(new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK'))
      .mockResolvedValueOnce(receiveResult({ idempotent: true }))

    try {
      const first = await submitReceiveLine({
        invoiceId: 'inv-1',
        lineId: 'line-1',
        remaining: 2000,
        unit: 'ml',
        displayValue: '0,8',
        store,
        receiveLine,
      })
      expect(first.kind).toBe('uncertain')
      expect(cryptoStub.calls).toBe(1)
      expect(readReceiveAttempt('inv-1', 'line-1', store)?.idempotencyKey).toBe(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      )

      const retry = await submitReceiveLine({
        invoiceId: 'inv-1',
        lineId: 'line-1',
        remaining: 2000,
        unit: 'ml',
        displayValue: '0,8',
        store,
        receiveLine,
      })
      expect(retry.kind).toBe('success')
      expect(cryptoStub.calls).toBe(1)
      expect(receiveLine.mock.calls[1]?.[2].idempotencyKey).toBe(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reutiliza la clave pendiente en error de red y no regenera ante 409', async () => {
    const store = createMemoryAttemptStore()
    const receiveLine = vi.fn()
      .mockRejectedValueOnce(new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK'))
      .mockRejectedValueOnce(new InvoiceApiError('Esa confirmación ya se usó con otros datos.', 409, 'IDEMPOTENCY_CONFLICT'))
      .mockResolvedValueOnce(receiveResult({ idempotent: true }))

    const first = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 100000,
      unit: 'ml',
      displayValue: '40',
      store,
      receiveLine,
      createKey: () => 'key-a',
    })
    expect(first.kind).toBe('uncertain')
    expect(readReceiveAttempt('inv-1', 'line-1', store)?.idempotencyKey).toBe('key-a')

    const conflict = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 100000,
      unit: 'ml',
      displayValue: '40',
      store,
      receiveLine,
      createKey: () => 'key-b',
    })
    expect(conflict.kind).toBe('conflict')
    expect(receiveLine.mock.calls[1]?.[2]).toEqual({ quantity: 40000, idempotencyKey: 'key-a' })
    expect(readReceiveAttempt('inv-1', 'line-1', store)?.status).toBe('pending')

    const retry = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 100000,
      unit: 'ml',
      displayValue: '40',
      store,
      receiveLine,
      createKey: () => 'key-c',
    })
    expect(retry.kind).toBe('success')
    expect(receiveLine.mock.calls[2]?.[2].idempotencyKey).toBe('key-a')
  })

  it('ignora un segundo envío simultáneo de la misma operación', async () => {
    const store = createMemoryAttemptStore()
    let release: () => void = () => undefined
    let started: () => void = () => undefined
    const pending = new Promise<InvoiceReceiveResult>((resolve) => {
      release = () => resolve(receiveResult())
    })
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const receiveLine = vi.fn(async () => {
      started()
      return pending
    })
    const first = submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 100000,
      unit: 'ml',
      displayValue: '40',
      store,
      receiveLine,
      createKey: () => 'key-a',
    })
    await startedPromise
    const second = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 100000,
      unit: 'ml',
      displayValue: '40',
      store,
      receiveLine,
      createKey: () => 'key-a',
    })
    expect(second.kind).toBe('ignored')
    expect(receiveLine).toHaveBeenCalledTimes(1)
    release()
    expect((await first).kind).toBe('success')
  })

  it('ignora un segundo clic mientras sending está activo', async () => {
    const store = createMemoryAttemptStore()
    const receiveLine = vi.fn(async () => receiveResult())
    expect(await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 2000,
      unit: 'ml',
      displayValue: '0,8',
      sending: true,
      store,
      receiveLine,
    })).toEqual({ kind: 'ignored' })
    expect(receiveLine).not.toHaveBeenCalled()
  })
})

describe('actualización del detalle tras recibir', () => {
  function detail(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
    return {
      id: 'inv-1',
      status: 'reviewed',
      locationId: 'loc-1',
      organizationId: 'org-1',
      supplierName: 'LUPULO SRL',
      issuerTaxId: null,
      documentDate: '2026-10-01',
      documentNumber: '0001-00000001',
      documentType: 'invoice',
      classification: 'gastronomic_merchandise',
      currency: 'ARS',
      eligibleLineCount: 1,
      unmappedLineCount: 0,
      fiscalDifferenceAccepted: false,
      originalAnalysis: null,
      reviewedAnalysis: null,
      corrections: {},
      commercialDecisions: [],
      file: null,
      lines: [storedLine({
        mappingStatus: 'mapped',
        inventoryPhysicalQuantity: 100000,
        invoicedQuantity: 100000,
        receivedQuantity: 0,
        remainingQuantity: 100000,
        inventoryProductId: 'p1',
        inventoryProduct: { id: 'p1', name: 'Cerveza Pilsen', baseUnit: 'ml' },
      })],
      ...overrides,
    }
  }

  it('usa cantidades y estado del servidor y no duplica si idempotent es true', () => {
    const result: InvoiceReceiveResult = {
      id: 'receipt-1',
      purchaseDocumentId: 'inv-1',
      purchaseDocumentLineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      quantity: 40000,
      invoicedQuantity: 100000,
      receivedQuantity: 40000,
      remainingQuantity: 60000,
      documentStatus: 'reviewed',
      inventoryMovementId: 'mov-1',
      idempotent: true,
    }
    const once = applyInvoiceReceiveResult(detail(), result)
    const twice = applyInvoiceReceiveResult(once, result)
    expect(once.lines[0]?.receivedQuantity).toBe(40000)
    expect(twice.lines[0]?.receivedQuantity).toBe(40000)
    expect(twice.lines[0]?.remainingQuantity).toBe(60000)
    expect(twice.lines[0]?.inventoryPhysicalQuantity).toBe(100000)
    expect(twice.status).toBe('reviewed')
  })

  it('distingue Revisada y Recibida en la cabecera', () => {
    expect(INVOICE_STATUS_LABEL.reviewed).toBe('Revisada')
    expect(INVOICE_STATUS_LABEL.received).toBe('Recibida')
    expect(invoiceStatusTone('reviewed')).toBe('warning')
    expect(invoiceStatusTone('received')).toBe('success')
  })

  it('pasa la factura a Recibida cuando el servidor lo confirma', () => {
    const next = applyInvoiceReceiveResult(detail(), {
      id: 'receipt-2',
      purchaseDocumentId: 'inv-1',
      purchaseDocumentLineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      quantity: 100000,
      invoicedQuantity: 100000,
      receivedQuantity: 100000,
      remainingQuantity: 0,
      documentStatus: 'received',
      inventoryMovementId: 'mov-2',
      idempotent: false,
    })
    expect(next.status).toBe('received')
    expect(next.lines[0]?.remainingQuantity).toBe(0)
  })

  it('distingue estados visuales de línea', () => {
    expect(receiveStateLabel(receiveVisualState(storedLine({
      mappingStatus: 'unmapped',
      configurationStatus: 'pending_configuration',
    })))).toBe('Pendiente de configuración')
    expect(receiveStateLabel(receiveVisualState(storedLine({
      mappingStatus: 'mapped',
      receivedQuantity: 0,
      remainingQuantity: 100000,
    })))).toBe('Sin recibir')
    expect(receiveStateLabel(receiveVisualState(storedLine({
      mappingStatus: 'mapped',
      receivedQuantity: 40000,
      remainingQuantity: 60000,
    })))).toBe('Recibido parcial')
    expect(receiveStateLabel(receiveVisualState(storedLine({
      mappingStatus: 'mapped',
      receivedQuantity: 100000,
      remainingQuantity: 0,
    })))).toBe('Recibido')
  })
})

describe('filtros del listado de facturas', () => {
  function item(overrides: Partial<InvoiceListItem> = {}): InvoiceListItem {
    return {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      supplierName: 'LUPULO SRL',
      documentDate: '2026-10-01',
      documentNumber: '0001-00006046',
      documentType: 'invoice',
      status: 'reviewed',
      currency: 'ARS',
      total: 1500.5,
      locationId: 'loc-1',
      organizationId: 'org-1',
      pendingConfiguration: false,
      pendingReceive: false,
      ...overrides,
    }
  }

  it('clasifica sin mapear, mapeada sin recibir, parcial, ambos pendientes y recibida', () => {
    const unmapped = item({ pendingConfiguration: true, pendingReceive: false })
    const mappedPending = item({ id: 'b', pendingConfiguration: false, pendingReceive: true })
    const both = item({ id: 'c', pendingConfiguration: true, pendingReceive: true })
    const received = item({ id: 'd', status: 'received', pendingConfiguration: false, pendingReceive: false })
    expect(invoiceMatchesFilter(unmapped, 'to_map')).toBe(true)
    expect(invoiceMatchesFilter(unmapped, 'to_receive')).toBe(false)
    expect(invoiceMatchesFilter(mappedPending, 'to_receive')).toBe(true)
    expect(invoiceMatchesFilter(mappedPending, 'to_map')).toBe(false)
    expect(invoiceMatchesFilter(both, 'to_map')).toBe(true)
    expect(invoiceMatchesFilter(both, 'to_receive')).toBe(true)
    expect(invoiceMatchesFilter(received, 'received')).toBe(true)
    expect(invoiceMatchesFilter(received, 'to_receive')).toBe(false)
    expect(invoiceMatchesFilter(item({ status: 'reviewed', pendingReceive: false }), 'to_receive')).toBe(false)
  })

  it('cuenta sobre la búsqueda y no hace excluyentes Por vincular y Por recibir', () => {
    const rows = [
      item({ supplierName: 'LUPULO SRL', pendingConfiguration: true, pendingReceive: true }),
      item({ id: 'b', supplierName: 'MetroGAS', status: 'received' }),
      item({ id: 'c', supplierName: 'LUPULO SRL', pendingReceive: true }),
    ]
    const lupulo = visibleInvoiceList(rows, 'lupulo', 'all')
    expect(lupulo.counts).toEqual({ all: 2, to_map: 1, to_receive: 2, received: 0 })
    expect(visibleInvoiceList(rows, 'lupulo', 'to_map').rows).toHaveLength(1)
    expect(visibleInvoiceList(rows, 'lupulo', 'to_receive').rows).toHaveLength(2)
    expect(invoiceListCounts(rows).received).toBe(1)
  })

  it('consulta el listado por local y descarta resultados de otro alcance', () => {
    expect(invoicesListPath('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toBe(
      '/api/invoices?locationId=cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    )
    expect(invoicesListPath('loc-a')).not.toContain('organizationId')
    expect(invoicesForScope('loc-a', 'loc-b', [item({ supplierName: 'LUPULO SRL' })])).toEqual([])
    expect(invoicesForScope('loc-a', 'loc-a', [item({ supplierName: 'LUPULO SRL' })]).map((row) => row.supplierName))
      .toEqual(['LUPULO SRL'])
  })
})

describe('selector compacto de insumos', () => {
  const products = [
    { id: 'p-liquid', name: 'PRUEBA SENDA — Líquido', baseUnit: 'ml' as const },
    { id: 'p-flour', name: 'Harina 000', baseUnit: 'g' as const },
  ]

  it('filtra por nombre y etiqueta el disparador', () => {
    expect(filterCatalogProducts(products, 'hari')).toEqual([products[1]])
    expect(filterCatalogProducts(products, '  ')).toEqual(products)
    expect(mappingPickerTriggerLabel(null, false)).toBe('Seleccionar insumo')
    expect(mappingPickerTriggerLabel(null, true)).toBe('Cargando insumos…')
    expect(mappingPickerTriggerLabel(products[0]!, false)).toBe('PRUEBA SENDA — Líquido')
  })

  it('abre, recorre, selecciona y cierra con teclado', () => {
    expect(mappingPickerKeyAction('ArrowDown', false)).toBe('open')
    expect(mappingPickerKeyAction('Enter', false)).toBe('open')
    expect(mappingPickerKeyAction(' ', false)).toBe('open')
    expect(mappingPickerKeyAction('Escape', false)).toBe('ignore')
    expect(mappingPickerKeyAction('Escape', true)).toBe('close')
    expect(mappingPickerKeyAction('ArrowDown', true)).toBe('next')
    expect(mappingPickerKeyAction('ArrowUp', true)).toBe('prev')
    expect(mappingPickerKeyAction('Enter', true)).toBe('select')
    expect(cycleHighlight(0, 1, 2)).toBe(1)
    expect(cycleHighlight(1, 1, 2)).toBe(0)
    expect(cycleHighlight(0, -1, 2)).toBe(1)
  })
})



import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express, { type RequestHandler } from 'express'
import request from 'supertest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import { InvoiceAiProviderError, type InvoiceAiProvider } from '../modules/invoice-intelligence/index.js'
import type { OperationsRepository } from '../services/operationsRepository.js'
import { createInvoicesRouter, type InvoiceIntegritySigner } from './invoices.js'
import {
  verifyInvoiceIntegrity,
  type InvoiceIntegritySnapshot,
} from '../http/invoiceIntegrity.js'
import { InvoiceQueryError } from '../http/invoiceQueryError.js'
import type { InvoiceQueryPort } from '../http/invoiceQuery.js'
import type { InvoiceMapPort } from '../http/invoiceMap.js'
import type { InvoiceReceivePort, InvoiceReceiveResult } from '../http/invoiceReceive.js'
import type { InvoiceCancelPort, InvoiceCancelResult } from '../http/invoiceCancel.js'

type FixtureCases = Record<string, Record<string, unknown>>

const invoiceFixtures = JSON.parse(
  readFileSync(new URL('../modules/invoice-intelligence/fixtures/invoice-cases.json', import.meta.url), 'utf8'),
) as FixtureCases
const commercialFixtures = JSON.parse(
  readFileSync(new URL('../modules/invoice-intelligence/fixtures/commercial-cases.json', import.meta.url), 'utf8'),
) as FixtureCases
const serviceFixtures = JSON.parse(
  readFileSync(new URL('../modules/invoice-intelligence/fixtures/service-cases.json', import.meta.url), 'utf8'),
) as FixtureCases

const PDF = Buffer.from('%PDF-1.4\nfixture')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00])

const authenticated: RequestHandler = (request, _response, next) => {
  const req = request as AuthenticatedRequest
  req.user = { id: 'test-user' } as AuthenticatedRequest['user']
  req.supabase = {} as SupabaseClient
  next()
}

function providerReturning(extracted: unknown): InvoiceAiProvider {
  return {
    extract: vi.fn(async () => ({
      extracted,
      provider: 'fake-ai',
      model: 'fixture-model',
    })),
  }
}

function repository(organizations: Record<string, unknown>[] | 'throw' = [{ id: 'org-1' }]) {
  return {
    listOrganizations: vi.fn().mockImplementation(async () => {
      if (organizations === 'throw') throw new Error('db')
      return organizations
    }),
  } as unknown as Pick<OperationsRepository, 'listOrganizations'>
}

function testApp(options: {
  provider?: InvoiceAiProvider
  organizations?: Record<string, unknown>[] | 'throw'
  maxFileBytes?: number
  auth?: RequestHandler
  integrity?: InvoiceIntegritySigner | null
  query?: InvoiceQueryPort
  map?: InvoiceMapPort
  receive?: InvoiceReceivePort
  cancel?: InvoiceCancelPort
  getAdmin?: () => SupabaseClient
} = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/invoices', createInvoicesRouter({
    auth: options.auth ?? authenticated,
    repository: repository(options.organizations),
    provider: options.provider ?? providerReturning(invoiceFixtures.foodInvoice),
    maxFileBytes: options.maxFileBytes,
    maxRequests: 20,
    integrity: options.integrity ?? null,
    query: options.query,
    map: options.map,
    receive: options.receive,
    cancel: options.cancel,
    getAdmin: options.getAdmin,
  }))
  return app
}

describe('POST /api/invoices/analyze', () => {
  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp())
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(401)
    expect(response.body.code).toBeUndefined()
    expect(response.body.error).toMatch(/autenticado/i)
    expect(JSON.stringify(response.body)).not.toMatch(/GEMINI|base64/i)
  })

  it('rechaza un usuario autenticado sin membresía', async () => {
    const fakeProvider = providerReturning(invoiceFixtures.foodInvoice)
    const response = await request(testApp({ organizations: [], provider: fakeProvider }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' })
    expect(fakeProvider.extract).not.toHaveBeenCalled()
  })

  it('analiza un PDF válido sin persistir ni confirmar movimientos', async () => {
    const response = await request(testApp())
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(200)
    expect(response.body.data.document.classification).toBe('gastronomic_merchandise')
    expect(response.body.data.document.lines[0]).toMatchObject({
      id: expect.stringMatching(/^line-/),
      originalDescription: 'Harina 000 bolsa 25 kg',
      quantity: 2,
      unit: 'u',
      unitPrice: 100,
      amount: 200,
    })
    expect(response.body.data.document.amounts).toMatchObject({
      taxes: 42,
      total: 242,
      subtotal: 200,
    })
    expect(response.body.data.inventory.shouldOfferFutureReceipt).toBe(true)
    expect(response.body.data.metadata.fileSha256).toBe(
      createHash('sha256').update(PDF).digest('hex'),
    )
    expect(response.body.data.metadata.fileSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(response.body)).not.toContain('base64')
    expect(JSON.stringify(response.body)).not.toContain('"raw"')
  })

  it('rechaza un archivo inválido', async () => {
    const fakeProvider = providerReturning(invoiceFixtures.foodInvoice)
    const response = await request(testApp({ provider: fakeProvider }))
      .post('/api/invoices/analyze')
      .attach('file', Buffer.from('no es un documento'), 'factura.bin')

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('UNSUPPORTED_TYPE')
    expect(fakeProvider.extract).not.toHaveBeenCalled()
  })

  it('rechaza un archivo demasiado grande', async () => {
    const fakeProvider = providerReturning(invoiceFixtures.foodInvoice)
    const oversized = Buffer.concat([PDF, Buffer.alloc(80, 0x41)])
    const response = await request(testApp({ provider: fakeProvider, maxFileBytes: 40 }))
      .post('/api/invoices/analyze')
      .attach('file', oversized, 'factura.pdf')

    expect(response.status).toBe(413)
    expect(response.body.code).toBe('FILE_TOO_LARGE')
    expect(fakeProvider.extract).not.toHaveBeenCalled()
  })

  it('rechaza un JPEG enviado como PDF', async () => {
    const fakeProvider = providerReturning(invoiceFixtures.foodInvoice)
    const response = await request(testApp({ provider: fakeProvider }))
      .post('/api/invoices/analyze')
      .attach('file', JPEG, { filename: 'factura.pdf', contentType: 'application/pdf' })

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('INVALID_SIGNATURE')
    expect(fakeProvider.extract).not.toHaveBeenCalled()
  })

  it('traduce un error del proveedor sin filtrar detalles internos', async () => {
    const provider: InvoiceAiProvider = {
      extract: vi.fn(async () => {
        throw new InvoiceAiProviderError('Gemini key sk-secret falló', 'INVALID_RESPONSE')
      }),
    }
    const response = await request(testApp({ provider }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(502)
    expect(response.body).toEqual({
      error: 'El proveedor devolvió una respuesta incompleta o inválida.',
      code: 'PROVIDER_INVALID_RESPONSE',
    })
    expect(JSON.stringify(response.body)).not.toMatch(/sk-secret|GEMINI_API_KEY/i)
  })

  it('traduce rechazo de autenticación del proveedor a 502 sin filtrar secretos', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const provider: InvoiceAiProvider = {
      extract: vi.fn(async () => {
        throw new InvoiceAiProviderError(
          'Gemini rechazó la configuración de autenticación.',
          'AUTHENTICATION_FAILED',
          {
            httpStatus: 403,
            providerStatus: 'PERMISSION_DENIED',
            model: 'gemini-3.5-flash-lite',
          },
        )
      }),
    }
    const response = await request(testApp({ provider }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(502)
    expect(response.body).toEqual({
      error: 'El proveedor rechazó el análisis.',
      code: 'PROVIDER_REJECTED',
    })
    expect(JSON.stringify(response.body)).not.toMatch(/GEMINI_API_KEY|AIza|sk-secret/i)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"providerStatus":"PERMISSION_DENIED"'))
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('AIza'))).toBe(false)
    errorSpy.mockRestore()
  })

  it('traduce un timeout del proveedor', async () => {
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    const provider: InvoiceAiProvider = {
      extract: vi.fn(async () => {
        throw timeout
      }),
    }
    const response = await request(testApp({ provider }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(504)
    expect(response.body.code).toBe('PROVIDER_TIMEOUT')
  })

  it('devuelve una bonificación pendiente sin confirmarla', async () => {
    const response = await request(testApp({
      provider: providerReturning(commercialFixtures.pilsenFullBonus),
    }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(200)
    expect(response.body.data.interpretation.relations.length).toBeGreaterThan(0)
    expect(response.body.data.interpretation.relations[0].type).toBe('bonus')
    expect(response.body.data.interpretation.relations[0].status).not.toBe('confirmed')
    expect(response.body.data.inventory.shouldOfferFutureReceipt).toBe(false)
    expect(
      response.body.data.validation.pendingConfirmations.some(
        (item: { code: string }) => item.code === 'COMMERCIAL_RELATION_REQUIRES_CONFIRMATION',
      ),
    ).toBe(true)
  })

  it('calcula el SHA-256 de los bytes recibidos y no de un hash del cliente', async () => {
    const pdfHash = createHash('sha256').update(PDF).digest('hex')
    const jpegHash = createHash('sha256').update(JPEG).digest('hex')
    const pdfResponse = await request(testApp())
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')
    const jpegResponse = await request(testApp())
      .post('/api/invoices/analyze')
      .attach('file', JPEG, 'factura.jpg')

    expect(pdfResponse.body.data.metadata.fileSha256).toBe(pdfHash)
    expect(jpegResponse.body.data.metadata.fileSha256).toBe(jpegHash)
    expect(pdfHash).not.toBe(jpegHash)
    expect(pdfResponse.body).not.toHaveProperty(['data', 'metadata', 'clientHash'])
  })

  it('devuelve un servicio sin stock ni recepción', async () => {
    const response = await request(testApp({
      provider: providerReturning(serviceFixtures.metrogasReference),
    }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(200)
    expect(response.body.data.document.classification).toBe('service')
    expect(response.body.data.document.lines.every(
      (line: { inventoryEligibility: string }) => line.inventoryEligibility === 'ineligible',
    )).toBe(true)
    expect(response.body.data.inventory).toMatchObject({
      eligibleLines: 0,
      shouldOfferFutureReceipt: false,
    })
  })

  it('emite un token HMAC sin exponer el secreto', async () => {
    const secret = 'route-integrity-secret'
    const response = await request(testApp({ integrity: { secret } }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.metadata.integrityToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(data.metadata.snapshotSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(data.metadata.integrityExpiresAt).toMatch(/T/)
    expect(JSON.stringify(response.body)).not.toContain(secret)
    const claims = verifyInvoiceIntegrity({
      token: data.metadata.integrityToken,
      userId: 'test-user',
      fileSha256: data.metadata.fileSha256,
      snapshot: data as InvoiceIntegritySnapshot,
      secret,
    })
    expect(claims.sub).toBe('test-user')
    expect(claims.fileSha256).toBe(data.metadata.fileSha256)
  })

  it('no adjunta token si la integridad está desactivada (compatibilidad)', async () => {
    const response = await request(testApp({ integrity: null }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(200)
    expect(response.body.data.metadata.fileSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(response.body.data.metadata.integrityToken).toBeUndefined()
  })
})

describe('POST /api/invoices', () => {
  const SECRET = 'test-save-secret'
  const NOW = new Date('2026-10-14T15:00:00.000Z')

  function saveAuth(supabase: SupabaseClient): RequestHandler {
    return (request, _response, next) => {
      const req = request as AuthenticatedRequest
      req.user = { id: 'test-user' } as AuthenticatedRequest['user']
      req.supabase = supabase
      next()
    }
  }

  it('exige HMAC para persistir', async () => {
    const response = await request(testApp({ integrity: null }))
      .post('/api/invoices')
      .field('locationId', 'loc-1')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(503)
    expect(response.body.code).toBe('SECRET_MISSING')
  })

  it('guarda con actor de getUser y RPC admin', async () => {
    const analyzed = await request(testApp({
      integrity: { secret: SECRET, now: () => NOW },
    }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')

    expect(analyzed.status).toBe(200)
    const snapshot = analyzed.body.data
    const upload = vi.fn(async () => ({ error: null }))
    const rpc = vi.fn(async (_name: string, args: { p: { actor_user_id: string } }) => {
      expect(args.p.actor_user_id).toBe('test-user')
      return { data: 'saved-id', error: null }
    })
    const supabase = {
      from(table: string) {
        return {
          select() {
            return {
              eq() {
                if (table === 'locations') {
                  return { maybeSingle: async () => ({ data: { id: 'loc-1', organization_id: 'org-1' }, error: null }) }
                }
                if (table === 'organizations') {
                  return { maybeSingle: async () => ({ data: { invoice_fiscal_tolerances: null }, error: null }) }
                }
                return { data: [], error: null, maybeSingle: async () => ({ data: null, error: null }) }
              },
            }
          },
        }
      },
    } as unknown as SupabaseClient

    const app = express()
    app.use('/api/invoices', createInvoicesRouter({
      auth: saveAuth(supabase),
      repository: repository(),
      provider: providerReturning(invoiceFixtures.foodInvoice),
      integrity: { secret: SECRET, now: () => NOW },
      getAdmin: () => ({ storage: { from: () => ({ upload }) }, rpc }) as unknown as SupabaseClient,
      saveNow: () => NOW,
      maxRequests: 20,
    }))

    const response = await request(app)
      .post('/api/invoices')
      .field('locationId', 'loc-1')
      .field('integrityToken', snapshot.metadata.integrityToken)
      .field('originalSnapshot', JSON.stringify(snapshot))
      .field('commercialDecisions', '[]')
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'saved-id',
      status: 'reviewed',
      idempotent: false,
    })
    expect(rpc).toHaveBeenCalledOnce()
    expect(upload).toHaveBeenCalledOnce()
  })

  it('no expone el error de PostgreSQL al cliente cuando el RPC falla', async () => {
    const analyzed = await request(testApp({
      integrity: { secret: SECRET, now: () => NOW },
    }))
      .post('/api/invoices/analyze')
      .attach('file', PDF, 'factura.pdf')
    expect(analyzed.status).toBe(200)
    const snapshot = analyzed.body.data
    const logs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
      logs.push(String(value))
    })
    const upload = vi.fn(async () => ({ error: null }))
    const rpc = vi.fn(async () => ({
      data: null,
      error: {
        code: 'P0001',
        message: 'DRAFT_REQUIRES_STORAGE_PATH',
        details: 'trigger purchase_documents_before_write',
        hint: 'path must match org/invoices/sha.ext',
      },
    }))
    const supabase = {
      from(table: string) {
        return {
          select() {
            return {
              eq() {
                if (table === 'locations') {
                  return { maybeSingle: async () => ({ data: { id: 'loc-1', organization_id: 'org-1' }, error: null }) }
                }
                if (table === 'organizations') {
                  return { maybeSingle: async () => ({ data: { invoice_fiscal_tolerances: null }, error: null }) }
                }
                return { data: [], error: null, maybeSingle: async () => ({ data: null, error: null }) }
              },
            }
          },
        }
      },
    } as unknown as SupabaseClient

    try {
      const app = express()
      app.use('/api/invoices', createInvoicesRouter({
        auth: saveAuth(supabase),
        repository: repository(),
        provider: providerReturning(invoiceFixtures.foodInvoice),
        integrity: { secret: SECRET, now: () => NOW },
        getAdmin: () => ({ storage: { from: () => ({ upload }) }, rpc }) as unknown as SupabaseClient,
        saveNow: () => NOW,
        maxRequests: 20,
      }))
      const response = await request(app)
        .post('/api/invoices')
        .field('locationId', 'loc-1')
        .field('integrityToken', snapshot.metadata.integrityToken)
        .field('originalSnapshot', JSON.stringify(snapshot))
        .field('commercialDecisions', '[]')
        .attach('file', PDF, 'factura.pdf')

      expect(response.status).toBe(500)
      expect(response.body).toEqual({
        error: 'No se pudo guardar la factura.',
        code: 'SAVE_FAILED',
      })
      expect(JSON.stringify(response.body)).not.toMatch(/P0001|DRAFT_REQUIRES_STORAGE_PATH|PostgreSQL/i)
      expect(logs.some((line) => {
        const parsed = JSON.parse(line) as { operation?: string; code?: string; message?: string }
        return parsed.operation === 'senda_save_purchase_invoice'
          && parsed.code === 'P0001'
          && parsed.message === 'DRAFT_REQUIRES_STORAGE_PATH'
      })).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

const OWN_DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOREIGN_DOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function queryPort(overrides: Partial<InvoiceQueryPort> = {}): InvoiceQueryPort {
  return {
    listSavedInvoices: vi.fn().mockResolvedValue([]),
    lookupDuplicateInvoice: vi.fn().mockResolvedValue(null),
    listPendingReceptions: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSavedInvoice: vi.fn().mockRejectedValue(new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)),
    getSavedInvoiceFile: vi.fn().mockRejectedValue(new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)),
    ...overrides,
  }
}

describe('GET /api/invoices', () => {
  const locationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp()).get('/api/invoices').query({ locationId })
    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/autenticado/i)
    expect(JSON.stringify(response.body)).not.toMatch(/service_role|GEMINI/i)
  })

  it('rechaza el listado si falta un local autorizado', async () => {
    const query = queryPort({
      listSavedInvoices: vi.fn().mockRejectedValue(
        new InvoiceQueryError('El identificador del local no es válido.', 'LOCATION_ID_INVALID', 400),
      ),
    })
    const response = await request(testApp({ query })).get('/api/invoices')
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('LOCATION_ID_INVALID')
    expect(query.listSavedInvoices).toHaveBeenCalledWith(expect.objectContaining({
      locationId: '',
    }))
  })

  it('exige un local accesible y no autoriza por organizationId', async () => {
    const query = queryPort({
      listSavedInvoices: vi.fn().mockRejectedValue(
        new InvoiceQueryError('El local no existe o no pertenece a tu organización.', 'FORBIDDEN', 403),
      ),
    })
    const response = await request(testApp({ query })).get('/api/invoices').query({
      locationId,
      organizationId: 'should-not-authorize',
    })
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('FORBIDDEN')
    expect(query.listSavedInvoices).toHaveBeenCalledWith(expect.objectContaining({
      locationId,
    }))
    expect(query.listSavedInvoices).not.toHaveBeenCalledWith(expect.objectContaining({
      organizationId: expect.anything(),
    }))
  })

  it('lista facturas del local autorizado y no incluye las de otra organización', async () => {
    const query = queryPort({
      listSavedInvoices: vi.fn().mockResolvedValue([{
        id: OWN_DOC,
        supplierName: 'LUPULO SRL',
        documentDate: '2026-10-01',
        documentNumber: '0001-00006046',
        documentType: 'invoice',
        status: 'reviewed',
        currency: 'ARS',
        total: 1500.5,
        locationId,
        organizationId: 'org-1',
        pendingConfiguration: true,
        pendingReceive: false,
        hasReceipts: false,
      }]),
    })
    const response = await request(testApp({ query })).get('/api/invoices').query({
      locationId,
      organizationId: 'org-foreign',
    })
    expect(response.status).toBe(200)
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      supplierName: 'LUPULO SRL',
      documentNumber: '0001-00006046',
      total: 1500.5,
      status: 'reviewed',
      pendingConfiguration: true,
      pendingReceive: false,
      locationId,
    })
    expect(query.listSavedInvoices).toHaveBeenCalledWith(expect.objectContaining({
      locationId,
    }))
    expect(JSON.stringify(response.body)).not.toContain(FOREIGN_DOC)
    expect(JSON.stringify(response.body)).not.toMatch(/service_role|storage_object_path/i)
  })
})

describe('GET /api/invoices/duplicates', () => {
  const locationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const fileSha256 = 'ab'.repeat(32)

  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp()).get('/api/invoices/duplicates').query({
      locationId,
      fileSha256,
    })
    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/autenticado/i)
  })

  it('no interpreta duplicates como un id de factura', async () => {
    const query = queryPort()
    const response = await request(testApp({ query })).get('/api/invoices/duplicates').query({
      locationId,
      fileSha256,
    })
    expect(response.status).toBe(200)
    expect(query.getSavedInvoice).not.toHaveBeenCalled()
    expect(query.lookupDuplicateInvoice).toHaveBeenCalled()
  })

  it('devuelve la coincidencia mínima por hash', async () => {
    const query = queryPort({
      lookupDuplicateInvoice: vi.fn().mockResolvedValue({
        id: OWN_DOC,
        supplierName: 'LUPULO SRL',
        documentNumber: '00007-00006046',
        documentDate: '2026-10-01',
        status: 'reviewed',
        locationId,
      }),
    })
    const response = await request(testApp({ query })).get('/api/invoices/duplicates').query({
      locationId,
      fileSha256,
      organizationId: 'should-not-authorize',
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      data: {
        id: OWN_DOC,
        supplierName: 'LUPULO SRL',
        documentNumber: '00007-00006046',
        documentDate: '2026-10-01',
        status: 'reviewed',
        locationId,
      },
    })
    expect(query.lookupDuplicateInvoice).toHaveBeenCalledWith(expect.objectContaining({
      locationId,
      fileSha256,
    }))
    expect(query.lookupDuplicateInvoice).not.toHaveBeenCalledWith(expect.objectContaining({
      organizationId: expect.anything(),
    }))
    expect(JSON.stringify(response.body)).not.toMatch(/fileSha256|storage_object_path|integrityToken|service_role/i)
  })

  it('responde data null si no hay coincidencia visible', async () => {
    const query = queryPort()
    const response = await request(testApp({ query })).get('/api/invoices/duplicates').query({
      locationId,
      issuerTaxId: '30-71432940-1',
      voucherType: 'A',
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: null })
  })

  it('propaga hash inválido y local no autorizado', async () => {
    const invalid = queryPort({
      lookupDuplicateInvoice: vi.fn().mockRejectedValue(
        new InvoiceQueryError('El hash del archivo no es un SHA-256 válido.', 'HASH_INVALID', 400),
      ),
    })
    const invalidResponse = await request(testApp({ query: invalid })).get('/api/invoices/duplicates').query({
      locationId,
      fileSha256: 'abc',
    })
    expect(invalidResponse.status).toBe(400)
    expect(invalidResponse.body.code).toBe('HASH_INVALID')

    const forbidden = queryPort({
      lookupDuplicateInvoice: vi.fn().mockRejectedValue(
        new InvoiceQueryError('El local no existe o no pertenece a tu organización.', 'FORBIDDEN', 403),
      ),
    })
    const forbiddenResponse = await request(testApp({ query: forbidden })).get('/api/invoices/duplicates').query({
      locationId,
      fileSha256,
    })
    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.body.code).toBe('FORBIDDEN')
  })
})

describe('GET /api/invoices/pending-receptions', () => {
  const locationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const lineId = '11111111-1111-4111-8111-111111111111'

  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp()).get('/api/invoices/pending-receptions').query({
      locationId,
    })
    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/autenticado/i)
    expect(JSON.stringify(response.body)).not.toMatch(/service_role|GEMINI/i)
  })

  it('no interpreta pending-receptions como un id de factura', async () => {
    const query = queryPort()
    const response = await request(testApp({ query })).get('/api/invoices/pending-receptions').query({
      locationId,
    })
    expect(response.status).toBe(200)
    expect(query.getSavedInvoice).not.toHaveBeenCalled()
    expect(query.listPendingReceptions).toHaveBeenCalled()
  })

  it('exige un local accesible y no autoriza por organizationId', async () => {
    const query = queryPort({
      listPendingReceptions: vi.fn().mockRejectedValue(
        new InvoiceQueryError('El local no existe o no pertenece a tu organización.', 'FORBIDDEN', 403),
      ),
    })
    const response = await request(testApp({ query })).get('/api/invoices/pending-receptions').query({
      locationId,
      organizationId: 'should-not-authorize',
    })
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('FORBIDDEN')
    expect(query.listPendingReceptions).toHaveBeenCalledWith(expect.objectContaining({
      locationId,
    }))
    expect(query.listPendingReceptions).not.toHaveBeenCalledWith(expect.objectContaining({
      organizationId: expect.anything(),
    }))
  })

  it('devuelve líneas pendientes con cursor y sin datos sensibles', async () => {
    const query = queryPort({
      listPendingReceptions: vi.fn().mockResolvedValue({
        items: [{
          invoiceId: OWN_DOC,
          lineId,
          supplierName: 'LUPULO SRL',
          documentNumber: '0001-00006046',
          documentDate: '2026-10-01',
          locationId,
          ingredientId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          ingredientName: 'Cerveza Pilsen',
          baseUnit: 'ml',
          invoicedQuantity: 100000,
          receivedQuantity: 50000,
          remainingQuantity: 50000,
        }],
        nextCursor: lineId,
      }),
    })
    const response = await request(testApp({ query })).get('/api/invoices/pending-receptions').query({
      locationId,
      limit: '50',
      organizationId: 'org-foreign',
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      data: [{
        invoiceId: OWN_DOC,
        lineId,
        supplierName: 'LUPULO SRL',
        documentNumber: '0001-00006046',
        documentDate: '2026-10-01',
        locationId,
        ingredientId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        ingredientName: 'Cerveza Pilsen',
        baseUnit: 'ml',
        invoicedQuantity: 100000,
        receivedQuantity: 50000,
        remainingQuantity: 50000,
      }],
      nextCursor: lineId,
    })
    expect(JSON.stringify(response.body)).not.toMatch(
      /fileSha256|storage_object_path|integrityToken|original_analysis|reviewed_analysis|service_role/i,
    )
  })
})

describe('GET /api/invoices/:id', () => {
  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp()).get(`/api/invoices/${OWN_DOC}`)
    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/autenticado/i)
  })

  it('no expone el detalle de una factura de otra organización', async () => {
    const query = queryPort()
    const response = await request(testApp({ query })).get(`/api/invoices/${FOREIGN_DOC}`)
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' })
    expect(query.getSavedInvoice).toHaveBeenCalledWith(expect.objectContaining({ id: FOREIGN_DOC }))
    expect(JSON.stringify(response.body)).not.toMatch(/LUPULO|service_role/i)
  })

  it('devuelve original y revisado por separado con URL firmada de corta duración', async () => {
    const query = queryPort({
      getSavedInvoice: vi.fn().mockResolvedValue({
        id: OWN_DOC,
        status: 'reviewed',
        locationId: 'loc-1',
        organizationId: 'org-1',
        supplierName: 'LUPULO SRL',
        issuerTaxId: '30712345679',
        documentDate: '2026-10-01',
        documentNumber: '0001-00006046',
        documentType: 'invoice',
        classification: 'gastronomic_merchandise',
        currency: 'ARS',
        eligibleLineCount: 8,
        unmappedLineCount: 8,
        fiscalDifferenceAccepted: false,
        originalAnalysis: { document: { amounts: { total: 1490 } } },
        reviewedAnalysis: { document: { amounts: { total: 1500.5 } } },
        corrections: {},
        commercialDecisions: [{ relationId: 'relation-1', decision: 'confirm' }],
        lines: [],
        file: {
          url: 'https://storage.example/sign/invoice-documents/file.pdf?token=short',
          expiresAt: '2026-10-14T18:02:00.000Z',
          expiresInSeconds: 120,
          contentType: 'application/pdf',
        },
      }),
    })
    const response = await request(testApp({ query })).get(`/api/invoices/${OWN_DOC}`)
    expect(response.status).toBe(200)
    expect(response.body.data.originalAnalysis.document.amounts.total).toBe(1490)
    expect(response.body.data.reviewedAnalysis.document.amounts.total).toBe(1500.5)
    expect(response.body.data.file.expiresInSeconds).toBe(120)
    expect(response.body.data.file.url).toContain('token=short')
    expect(JSON.stringify(response.body)).not.toMatch(/service_role|storage_object_path/i)
  })

  it('no firma el PDF si la factura no es visible por RLS', async () => {
    const query = queryPort()
    const response = await request(testApp({ query })).get(`/api/invoices/${FOREIGN_DOC}/file`)
    expect(response.status).toBe(404)
    expect(query.getSavedInvoiceFile).toHaveBeenCalledWith(expect.objectContaining({ id: FOREIGN_DOC }))
    expect(JSON.stringify(response.body)).not.toMatch(/token=|service_role/i)
  })
})

const LINE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PRODUCT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function mapPort(overrides: Partial<InvoiceMapPort> = {}): InvoiceMapPort {
  return {
    listInvoiceProducts: vi.fn().mockResolvedValue([]),
    listCatalogProducts: vi.fn().mockResolvedValue([]),
    listCatalogMappingMemories: vi.fn().mockResolvedValue([]),
    mapInvoiceLine: vi.fn().mockRejectedValue(new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)),
    ...overrides,
  }
}

const LOCATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('GET /api/invoices/catalog/products', () => {
  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp()).get(`/api/invoices/catalog/products?locationId=${LOCATION_ID}`)
    expect(response.status).toBe(401)
  })

  it('no lista el catálogo de un local de otra organización', async () => {
    const mapping = mapPort({
      listCatalogProducts: vi.fn().mockRejectedValue(
        new InvoiceQueryError('El local no existe o no pertenece a tu organización.', 'FORBIDDEN', 403),
      ),
    })
    const response = await request(testApp({ map: mapping })).get(
      `/api/invoices/catalog/products?locationId=${LOCATION_ID}`,
    )
    expect(response.status).toBe(403)
    expect(mapping.listCatalogProducts).toHaveBeenCalledWith(expect.objectContaining({
      locationId: LOCATION_ID,
    }))
    expect(JSON.stringify(response.body)).not.toMatch(/service_role/)
  })

  it('devuelve insumos del local autorizado', async () => {
    const mapping = mapPort({
      listCatalogProducts: vi.fn().mockResolvedValue([
        { id: PRODUCT_ID, name: 'PRUEBA SENDA — Líquido', baseUnit: 'ml', organizationId: 'org-1', active: true },
      ]),
    })
    const response = await request(testApp({ map: mapping })).get(
      `/api/invoices/catalog/products?locationId=${LOCATION_ID}`,
    )
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual([
      { id: PRODUCT_ID, name: 'PRUEBA SENDA — Líquido', baseUnit: 'ml', organizationId: 'org-1', active: true },
    ])
  })
})

describe('GET /api/invoices/catalog/mapping-memories', () => {
  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp()).get(
      `/api/invoices/catalog/mapping-memories?locationId=${LOCATION_ID}`,
    )
    expect(response.status).toBe(401)
  })

  it('no lee memorias de un local de otra organización', async () => {
    const mapping = mapPort({
      listCatalogMappingMemories: vi.fn().mockRejectedValue(
        new InvoiceQueryError('El local no existe o no pertenece a tu organización.', 'FORBIDDEN', 403),
      ),
    })
    const response = await request(testApp({ map: mapping })).get(
      `/api/invoices/catalog/mapping-memories?locationId=${LOCATION_ID}&issuerTaxId=30712345679`,
    )
    expect(response.status).toBe(403)
    expect(mapping.listCatalogMappingMemories).toHaveBeenCalledWith(expect.objectContaining({
      locationId: LOCATION_ID,
    }))
    expect(JSON.stringify(response.body)).not.toMatch(/service_role/)
  })

  it('consulta memorias con el CUIT del análisis y el local del JWT', async () => {
    const mapping = mapPort({
      listCatalogMappingMemories: vi.fn().mockResolvedValue([
        {
          descriptionNormalized: 'pilsen',
          inventoryProductId: PRODUCT_ID,
          inventoryProduct: { id: PRODUCT_ID, name: 'Cerveza Pilsen', baseUnit: 'ml' },
          conversionFactor: 1000,
        },
      ]),
    })
    const response = await request(testApp({ map: mapping })).get(
      `/api/invoices/catalog/mapping-memories?locationId=${LOCATION_ID}&issuerTaxId=30-71234567-9`,
    )
    expect(response.status).toBe(200)
    expect(mapping.listCatalogMappingMemories).toHaveBeenCalledWith(expect.objectContaining({
      locationId: LOCATION_ID,
      issuerTaxId: '30-71234567-9',
    }))
    expect(response.body.data[0].kind).toBeUndefined()
    expect(response.body.data[0].inventoryProductId).toBe(PRODUCT_ID)
  })
})

describe('GET /api/invoices/:id/products', () => {
  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp()).get(`/api/invoices/${OWN_DOC}/products`)
    expect(response.status).toBe(401)
  })

  it('no lista productos de una factura de otra organización', async () => {
    const mapping = mapPort({
      listInvoiceProducts: vi.fn().mockRejectedValue(
        new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404),
      ),
    })
    const response = await request(testApp({ map: mapping })).get(`/api/invoices/${FOREIGN_DOC}/products`)
    expect(response.status).toBe(404)
    expect(mapping.listInvoiceProducts).toHaveBeenCalledWith(expect.objectContaining({ documentId: FOREIGN_DOC }))
  })

  it('devuelve insumos reales de la organización de la factura', async () => {
    const mapping = mapPort({
      listInvoiceProducts: vi.fn().mockResolvedValue([
        { id: PRODUCT_ID, name: 'Golden Ale', baseUnit: 'l', organizationId: 'org-1', active: true },
      ]),
    })
    const response = await request(testApp({ map: mapping })).get(`/api/invoices/${OWN_DOC}/products`)
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual([
      { id: PRODUCT_ID, name: 'Golden Ale', baseUnit: 'l', organizationId: 'org-1', active: true },
    ])
  })

  it('propaga un error de carga del catálogo', async () => {
    const mapping = mapPort({
      listInvoiceProducts: vi.fn().mockRejectedValue(
        new InvoiceQueryError('No se pudieron consultar los productos.', 'LOOKUP_FAILED', 500),
      ),
    })
    const response = await request(testApp({ map: mapping })).get(`/api/invoices/${OWN_DOC}/products`)
    expect(response.status).toBe(500)
    expect(response.body.code).toBe('LOOKUP_FAILED')
  })
})

describe('POST /api/invoices/:id/lines/:lineId/map', () => {
  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp())
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/map`)
      .send({ inventoryProductId: PRODUCT_ID })
    expect(response.status).toBe(401)
  })

  it('vincula con el actor autenticado e ignora organización del body', async () => {
    const mapping = mapPort({
      mapInvoiceLine: vi.fn().mockResolvedValue({
        id: LINE_ID,
        sourceLineId: 'line-1',
        mappingStatus: 'mapped',
        inventoryProductId: PRODUCT_ID,
        inventoryPhysicalQuantity: 10,
        inventoryProduct: { id: PRODUCT_ID, name: 'Pilsen', baseUnit: 'L', organizationId: 'org-1', active: true },
        unmappedLineCount: 7,
      }),
    })
    const response = await request(testApp({
      map: mapping,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/map`)
      .send({
        inventoryProductId: PRODUCT_ID,
        conversionFactor: 1,
        organizationId: 'org-ajena',
        actorUserId: 'user-forjado',
      })
    expect(response.status).toBe(200)
    expect(response.body.data.mappingStatus).toBe('mapped')
    expect(mapping.mapInvoiceLine).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      documentId: OWN_DOC,
      lineId: LINE_ID,
      inventoryProductId: PRODUCT_ID,
      conversionFactor: 1,
    }))
    expect(mapping.mapInvoiceLine).not.toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-ajena',
    }))
    expect(JSON.stringify(response.body)).not.toMatch(/service_role|inventory_movements/)
  })
})

const IDEMPOTENCY_KEY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function receiveResult(overrides: Partial<InvoiceReceiveResult> = {}): InvoiceReceiveResult {
  return {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    purchaseDocumentId: OWN_DOC,
    purchaseDocumentLineId: LINE_ID,
    quantity: 40000,
    invoicedQuantity: 100000,
    receivedQuantity: 40000,
    remainingQuantity: 60000,
    documentStatus: 'reviewed',
    inventoryMovementId: '99999999-9999-4999-8999-999999999999',
    idempotent: false,
    ...overrides,
  }
}

function receivePort(overrides: Partial<InvoiceReceivePort> = {}): InvoiceReceivePort {
  return {
    receiveInvoiceLine: vi.fn().mockRejectedValue(
      new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404),
    ),
    ...overrides,
  }
}

describe('POST /api/invoices/:id/lines/:lineId/receive', () => {
  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp())
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/receive`)
      .send({ quantity: 40000, idempotencyKey: IDEMPOTENCY_KEY })
    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/autenticado/i)
    expect(JSON.stringify(response.body)).not.toMatch(/service_role/i)
  })

  it('oculta una factura inaccesible', async () => {
    const receive = receivePort()
    const response = await request(testApp({
      receive,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${FOREIGN_DOC}/lines/${LINE_ID}/receive`)
      .send({ quantity: 40000, idempotencyKey: IDEMPOTENCY_KEY })
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('NOT_FOUND')
    expect(receive.receiveInvoiceLine).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      documentId: FOREIGN_DOC,
    }))
  })

  it('recibe con el actor autenticado e ignora actor y organización del body', async () => {
    const receive = receivePort({
      receiveInvoiceLine: vi.fn().mockResolvedValue(receiveResult()),
    })
    const response = await request(testApp({
      receive,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/receive`)
      .send({
        quantity: 40000,
        idempotencyKey: IDEMPOTENCY_KEY,
        organizationId: 'org-ajena',
        actorUserId: 'user-forjado',
      })
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      quantity: 40000,
      receivedQuantity: 40000,
      remainingQuantity: 60000,
      documentStatus: 'reviewed',
      idempotent: false,
    })
    expect(receive.receiveInvoiceLine).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      documentId: OWN_DOC,
      lineId: LINE_ID,
      quantity: 40000,
      idempotencyKey: IDEMPOTENCY_KEY,
    }))
    expect(receive.receiveInvoiceLine).not.toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-forjado',
    }))
    expect(JSON.stringify(response.body)).not.toMatch(/service_role|user-forjado|org-ajena/)
  })

  it('conserva cantidad pendiente en una recepción parcial', async () => {
    const receive = receivePort({
      receiveInvoiceLine: vi.fn().mockResolvedValue(receiveResult({ remainingQuantity: 60000 })),
    })
    const response = await request(testApp({
      receive,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/receive`)
      .send({ quantity: 40000, idempotencyKey: IDEMPOTENCY_KEY })
    expect(response.status).toBe(200)
    expect(response.body.data.remainingQuantity).toBe(60000)
    expect(response.body.data.documentStatus).toBe('reviewed')
  })

  it('refleja received cuando la línea cierra la factura', async () => {
    const receive = receivePort({
      receiveInvoiceLine: vi.fn().mockResolvedValue(receiveResult({
        quantity: 100000,
        receivedQuantity: 100000,
        remainingQuantity: 0,
        documentStatus: 'received',
      })),
    })
    const response = await request(testApp({
      receive,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/receive`)
      .send({ quantity: 100000, idempotencyKey: IDEMPOTENCY_KEY })
    expect(response.status).toBe(200)
    expect(response.body.data.documentStatus).toBe('received')
    expect(response.body.data.remainingQuantity).toBe(0)
  })

  it('reintenta con la misma clave sin duplicar', async () => {
    const receive = receivePort({
      receiveInvoiceLine: vi.fn().mockResolvedValue(receiveResult({ idempotent: true })),
    })
    const response = await request(testApp({
      receive,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/receive`)
      .send({ quantity: 40000, idempotencyKey: IDEMPOTENCY_KEY })
    expect(response.status).toBe(200)
    expect(response.body.data.idempotent).toBe(true)
    expect(response.body.data.receivedQuantity).toBe(40000)
  })

  it('rechaza la misma clave con datos distintos', async () => {
    const receive = receivePort({
      receiveInvoiceLine: vi.fn().mockRejectedValue(
        new InvoiceQueryError('Esa confirmación ya se usó con otros datos.', 'IDEMPOTENCY_CONFLICT', 409),
      ),
    })
    const response = await request(testApp({
      receive,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/receive`)
      .send({ quantity: 10000, idempotencyKey: IDEMPOTENCY_KEY })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(JSON.stringify(response.body)).not.toMatch(/P0001|service_role/)
  })

  it('rechaza una cantidad superior al pendiente', async () => {
    const receive = receivePort({
      receiveInvoiceLine: vi.fn().mockRejectedValue(
        new InvoiceQueryError('La cantidad supera lo pendiente de esta línea.', 'RECEIPT_EXCEEDS_INVOICED', 422),
      ),
    })
    const response = await request(testApp({
      receive,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/receive`)
      .send({ quantity: 200000, idempotencyKey: IDEMPOTENCY_KEY })
    expect(response.status).toBe(422)
    expect(response.body.code).toBe('RECEIPT_EXCEEDS_INVOICED')
  })

  it('rechaza cantidad cero o negativa', async () => {
    const receive = receivePort({
      receiveInvoiceLine: vi.fn().mockRejectedValue(
        new InvoiceQueryError('Indicá una cantidad física mayor a cero.', 'INVALID_QUANTITY', 422),
      ),
    })
    const zero = await request(testApp({
      receive,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/receive`)
      .send({ quantity: 0, idempotencyKey: IDEMPOTENCY_KEY })
    const negative = await request(testApp({
      receive,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/lines/${LINE_ID}/receive`)
      .send({ quantity: -1, idempotencyKey: IDEMPOTENCY_KEY })
    expect(zero.status).toBe(422)
    expect(zero.body.code).toBe('INVALID_QUANTITY')
    expect(negative.status).toBe(422)
    expect(negative.body.code).toBe('INVALID_QUANTITY')
  })
})

function cancelPort(overrides: Partial<InvoiceCancelPort> = {}): InvoiceCancelPort {
  return {
    cancelPurchaseInvoice: vi.fn().mockRejectedValue(
      new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404),
    ),
    ...overrides,
  }
}

function cancelResult(overrides: Partial<InvoiceCancelResult> = {}): InvoiceCancelResult {
  return {
    id: OWN_DOC,
    status: 'cancelled',
    replay: false,
    ...overrides,
  }
}

describe('POST /api/invoices/:id/cancel', () => {
  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp())
      .post(`/api/invoices/${OWN_DOC}/cancel`)
      .send({})
    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/autenticado/i)
    expect(JSON.stringify(response.body)).not.toMatch(/service_role/i)
  })

  it('oculta una factura inaccesible', async () => {
    const cancel = cancelPort()
    const response = await request(testApp({
      cancel,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/cancel`)
      .send({})
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('NOT_FOUND')
    expect(cancel.cancelPurchaseInvoice).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      documentId: OWN_DOC,
    }))
  })

  it('anula con el actor autenticado e ignora actor y organización del body', async () => {
    const cancel = cancelPort({
      cancelPurchaseInvoice: vi.fn().mockResolvedValue(cancelResult()),
    })
    const response = await request(testApp({
      cancel,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/cancel`)
      .send({
        organizationId: 'org-ajena',
        actorUserId: 'user-forjado',
      })
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      id: OWN_DOC,
      status: 'cancelled',
      replay: false,
    })
    expect(cancel.cancelPurchaseInvoice).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      documentId: OWN_DOC,
    }))
    expect(cancel.cancelPurchaseInvoice).not.toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-forjado',
    }))
    expect(JSON.stringify(response.body)).not.toMatch(/service_role|user-forjado|org-ajena/)
  })

  it('reintenta una anulación ya aplicada', async () => {
    const cancel = cancelPort({
      cancelPurchaseInvoice: vi.fn().mockResolvedValue(cancelResult({ replay: true })),
    })
    const response = await request(testApp({
      cancel,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/cancel`)
      .send({})
    expect(response.status).toBe(200)
    expect(response.body.data.replay).toBe(true)
  })

  it('bloquea una factura recibida sin fingir éxito', async () => {
    const cancel = cancelPort({
      cancelPurchaseInvoice: vi.fn().mockRejectedValue(
        new InvoiceQueryError(
          'Esta factura ya fue recibida. Anularla requeriría revertir stock y costos; esa operación todavía no está habilitada. No se oculta ni se borra.',
          'INVOICE_RECEIVED_REVERSAL_UNAVAILABLE',
          422,
        ),
      ),
    })
    const response = await request(testApp({
      cancel,
      getAdmin: () => ({}) as SupabaseClient,
    }))
      .post(`/api/invoices/${OWN_DOC}/cancel`)
      .send({})
    expect(response.status).toBe(422)
    expect(response.body.code).toBe('INVOICE_RECEIVED_REVERSAL_UNAVAILABLE')
  })

  it('pide service_role si falta el admin', async () => {
    const cancel = cancelPort({
      cancelPurchaseInvoice: vi.fn().mockResolvedValue(cancelResult()),
    })
    const response = await request(testApp({ cancel }))
      .post(`/api/invoices/${OWN_DOC}/cancel`)
      .send({})
    expect(response.status).toBe(503)
    expect(response.body.code).toBe('SERVICE_ROLE_MISSING')
    expect(cancel.cancelPurchaseInvoice).not.toHaveBeenCalled()
  })
})

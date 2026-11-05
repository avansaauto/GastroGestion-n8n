import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type RequestHandler } from 'express'
import request from 'supertest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import { sha256Hex } from './fileHash.js'
import { verifyInvoiceIntegrity } from './invoiceIntegrity.js'
import { createInvoicesRouter } from '../routes/invoices.js'

const invoiceCases = JSON.parse(readFileSync(
  new URL('../modules/invoice-intelligence/fixtures/invoice-cases.json', import.meta.url),
  'utf8',
)) as { foodInvoice: Record<string, unknown> }
const commercialCases = JSON.parse(readFileSync(
  new URL('../modules/invoice-intelligence/fixtures/commercial-cases.json', import.meta.url),
  'utf8',
)) as { bonusWithFreight: Record<string, unknown> }
const FOOD = invoiceCases.foodInvoice
const BONUS = commercialCases.bonusWithFreight
const INTEGRITY = 'test-job-integrity-secret'

const PDF = Buffer.from('%PDF-1.4\nfixture')
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LOC_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LOC_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ORG_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ORG_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const CLIENT_ORG = '11111111-1111-4111-8111-111111111111'
const SECRET = 'super-secret-token'

const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.local')

let directory = ''
const callbackTokens = new Map<string, string>()

function locationClient(
  rows: Record<string, { organizationId: string } | 'error'>,
): SupabaseClient {
  return {
    from(table: string) {
      if (table !== 'locations') throw new Error(`tabla inesperada: ${table}`)
      return {
        select() {
          return {
            eq(_column: string, value: string) {
              return {
                async maybeSingle() {
                  const row = rows[value]
                  if (row === 'error') return { data: null, error: { message: 'db' } }
                  if (!row) return { data: null, error: null }
                  return { data: { id: value, organization_id: row.organizationId }, error: null }
                },
              }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

function authAs(client: SupabaseClient): RequestHandler {
  return (req, _response, next) => {
    const authenticated = req as AuthenticatedRequest
    authenticated.user = {
      id: req.header('x-test-user') || USER_A,
    } as AuthenticatedRequest['user']
    authenticated.supabase = client
    next()
  }
}

function buildApp(options: {
  client?: SupabaseClient
  maxFileBytes?: number
  now?: () => Date
  ttlMs?: number
  callbackTokenTtlMs?: number
  integrity?: { secret: string; now?: () => Date } | null
} = {}) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api/invoices', createInvoicesRouter({
    auth: authAs(options.client ?? locationClient({
      [LOC_1]: { organizationId: ORG_1 },
      [LOC_2]: { organizationId: ORG_2 },
    })),
    repository: {
      listOrganizations: async () => {
        throw new Error('el trabajo no debe listar organizaciones')
      },
    },
    maxRequests: 40,
    maxFileBytes: options.maxFileBytes,
    integrity: options.integrity === undefined ? null : options.integrity,
    analysisJobsDirectory: directory,
    analysisJobsNow: options.now,
    analysisJobTtlMs: options.ttlMs,
    callbackTokenTtlMs: options.callbackTokenTtlMs,
    n8nWebhook: null,
    onAnalysisCallbackToken: (delivery) => {
      callbackTokens.set(delivery.jobId, delivery.callbackToken)
    },
  }))
  return app
}

function postJob(
  app: ReturnType<typeof buildApp>,
  input: { locationId?: string; file?: Buffer; filename?: string; userId?: string; fields?: Record<string, string> } = {},
) {
  const filename = input.filename ?? 'factura.pdf'
  const file = input.file ?? PDF
  let call = request(app).post('/api/invoices/analysis-jobs')
  if (input.userId) call = call.set('x-test-user', input.userId)
  call = call.field('locationId', input.locationId ?? LOC_1)
  for (const [key, value] of Object.entries(input.fields ?? {})) call = call.field(key, value)
  return call.attach('file', file, filename)
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else found.push(full)
    }
  }
  await walk(root)
  return found
}

beforeEach(async () => {
  callbackTokens.clear()
  await mkdir(parent, { recursive: true })
  directory = await mkdtemp(path.join(parent, 'jobs-'))
})

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('trabajos de análisis de facturas', () => {
  it('crea un trabajo en la sucursal autorizada e ignora la organización enviada por el cliente', async () => {
    const response = await postJob(buildApp(), {
      fields: { organizationId: CLIENT_ORG, actor_user_id: USER_B },
    })

    expect(response.status).toBe(202)
    expect(Object.keys(response.body.data).sort()).toEqual(['jobId', 'status'])
    expect(response.body.data.status).toBe('queued')
    expect(response.body.data.jobId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(response.body)).not.toContain(CLIENT_ORG)
    expect(JSON.stringify(response.body)).not.toContain(directory)

    const stored = JSON.parse(await readFile(path.join(directory, 'jobs', response.body.data.jobId, 'job.json'), 'utf8'))
    expect(stored.organizationId).toBe(ORG_1)
    expect(stored.locationId).toBe(LOC_1)
    expect(stored.userId).toBe(USER_A)
    expect(stored.fileSha256).toBe(sha256Hex(PDF))
  })

  it('rechaza un usuario no autenticado', async () => {
    const response = await request(createApp())
      .post('/api/invoices/analysis-jobs')
      .field('locationId', LOC_1)
      .attach('file', PDF, 'factura.pdf')

    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/autenticado/i)
    expect(JSON.stringify(response.body)).not.toContain(SECRET)
  })

  it('rechaza una sucursal inexistente, no autorizada o mal formada', async () => {
    const missing = await postJob(buildApp(), {
      locationId: '99999999-9999-4999-8999-999999999999',
    })
    expect(missing.status).toBe(403)
    expect(missing.body.code).toBe('FORBIDDEN')

    const malformed = await postJob(buildApp(), { locationId: '../etc/passwd' })
    expect(malformed.status).toBe(400)
    expect(malformed.body.code).toBe('INVALID_LOCATION')

    const failed = await postJob(buildApp({
      client: locationClient({ [LOC_1]: 'error' }),
    }))
    expect(failed.status).toBe(500)
    expect(failed.body.code).toBe('LOCATION_LOOKUP_FAILED')
    expect(JSON.stringify(failed.body)).not.toContain('db')
  })

  it('rechaza un archivo inválido', async () => {
    const response = await postJob(buildApp(), {
      file: Buffer.from('hola'),
      filename: 'nota.txt',
    })

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('UNSUPPORTED_TYPE')
  })

  it('rechaza un archivo demasiado grande', async () => {
    const response = await postJob(buildApp({ maxFileBytes: 40 }), {
      file: Buffer.alloc(80, 0x25),
      filename: 'grande.pdf',
    })

    expect(response.status).toBe(413)
    expect(response.body.code).toBe('FILE_TOO_LARGE')
  })

  it('permite al propietario consultar el estado', async () => {
    const app = buildApp()
    const created = await postJob(app)
    const response = await request(app).get(`/api/invoices/analysis-jobs/${created.body.data.jobId}`)

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      jobId: created.body.data.jobId,
      status: 'queued',
      locationId: LOC_1,
      organizationId: ORG_1,
    })
    expect(JSON.stringify(response.body)).not.toContain('document.bin')
    expect(JSON.stringify(response.body)).not.toContain(directory)
  })

  it('no entrega el trabajo a otro usuario', async () => {
    const app = buildApp()
    const created = await postJob(app)
    const response = await request(app)
      .get(`/api/invoices/analysis-jobs/${created.body.data.jobId}`)
      .set('x-test-user', USER_B)

    expect(response.status).toBe(404)
    expect(response.body.code).toBe('JOB_NOT_FOUND')
    expect(JSON.stringify(response.body)).not.toContain(ORG_1)
    expect(JSON.stringify(response.body)).not.toContain(created.body.data.jobId)
  })

  it('reutiliza el trabajo en curso del mismo usuario, sucursal y archivo', async () => {
    const app = buildApp()
    const first = await postJob(app)
    const second = await postJob(app)

    expect(second.status).toBe(202)
    expect(second.body.data.jobId).toBe(first.body.data.jobId)
    expect(await readdir(path.join(directory, 'jobs'))).toEqual([first.body.data.jobId])
  })

  it('crea otro trabajo si el mismo archivo va a otra sucursal', async () => {
    const app = buildApp()
    const first = await postJob(app, { locationId: LOC_1 })
    const second = await postJob(app, { locationId: LOC_2 })

    expect(first.body.data.jobId).not.toBe(second.body.data.jobId)
    expect(await readdir(path.join(directory, 'jobs'))).toHaveLength(2)
    const secondJob = JSON.parse(await readFile(
      path.join(directory, 'jobs', second.body.data.jobId, 'job.json'),
      'utf8',
    ))
    expect(secondJob.locationId).toBe(LOC_2)
    expect(secondJob.organizationId).toBe(ORG_2)
  })

  it('guarda metadatos sin rutas, secretos ni el nombre original', async () => {
    const response = await postJob(buildApp(), {
      filename: `../../${SECRET}.pdf`,
      fields: {
        integrityToken: SECRET,
        service_role: 'service-role-secret',
        organizationId: CLIENT_ORG,
      },
    })
    const jobId = response.body.data.jobId as string
    const files = await filesUnder(directory)
    const names = files.map((file) => path.basename(file))

    expect(names).not.toContain(`${SECRET}.pdf`)
    expect(names.every((name) => !name.includes('..'))).toBe(true)
    expect(names).toContain('document.bin')
    expect(names).toContain('job.json')

    const metadataPath = path.join(directory, 'jobs', jobId, 'job.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(metadata).sort()).toEqual([
      'byteSize',
      'callbackTokenExpiresAt',
      'callbackTokenHash',
      'createdAt',
      'delivery',
      'expiresAt',
      'extractionSha256',
      'failureCode',
      'fileSha256',
      'id',
      'locationId',
      'mediaType',
      'organizationId',
      'status',
      'updatedAt',
      'userId',
      'v',
    ])
    const published = `${JSON.stringify(metadata)}\n${await readFile(metadataPath, 'utf8')}`
    expect(published).not.toContain(callbackTokens.get(jobId))
    expect(published).not.toContain(SECRET)
    expect(published).not.toContain('service-role-secret')
    expect(published).not.toContain('Bearer')
    expect(published).not.toContain(directory)
    expect(await readFile(path.join(directory, 'jobs', jobId, 'document.bin'))).toEqual(PDF)
  })

  it('recupera el trabajo desde el directorio después de crear otro repositorio', async () => {
    const first = buildApp()
    const created = await postJob(first)
    const restarted = buildApp()
    const response = await request(restarted).get(`/api/invoices/analysis-jobs/${created.body.data.jobId}`)

    expect(response.status).toBe(200)
    expect(response.body.data.jobId).toBe(created.body.data.jobId)
    expect(response.body.data.status).toBe('queued')
    expect(await readFile(path.join(directory, 'jobs', created.body.data.jobId, 'document.bin'))).toEqual(PDF)
  })

  it('borra un trabajo vencido en la consulta siguiente', async () => {
    let clock = new Date('2026-10-21T15:00:00.000Z')
    const app = buildApp({
      now: () => clock,
      ttlMs: 1000,
    })
    const created = await postJob(app)
    clock = new Date(clock.getTime() + 1000)
    const response = await request(app).get(`/api/invoices/analysis-jobs/${created.body.data.jobId}`)

    expect(response.status).toBe(404)
    expect(response.body.code).toBe('JOB_NOT_FOUND')
    await expect(readdir(path.join(directory, 'jobs'))).resolves.toEqual([])
  })
})

function postResult(
  app: ReturnType<typeof buildApp>,
  jobId: string,
  token: string | undefined,
  body: unknown,
) {
  const call = request(app).post(`/api/invoices/analysis-jobs/${jobId}/result`)
  if (token) call.set('Authorization', `Bearer ${token}`)
  return call.send(body as object)
}

describe('devolución del análisis', () => {
  it('acepta el JSON de extracción y lo deja listo para la revisión', async () => {
    const app = buildApp({ integrity: { secret: INTEGRITY, now: () => new Date('2026-10-21T15:00:00.000Z') } })
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    const token = callbackTokens.get(jobId) ?? ''
    const response = await postResult(app, jobId, token, FOOD)

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ jobId, status: 'ready' })
    expect(JSON.stringify(response.body)).not.toContain(token)
    expect(JSON.stringify(response.body)).not.toContain('integrityToken')

    const stored = await readFile(path.join(directory, 'jobs', jobId, 'job.json'), 'utf8')
    expect(stored).not.toContain(token)
    expect(JSON.parse(stored).organizationId).toBe(ORG_1)
    expect(JSON.parse(stored).locationId).toBe(LOC_1)
  })

  it('rechaza un token incorrecto', async () => {
    const app = buildApp()
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    const response = await postResult(app, jobId, 'a'.repeat(43), FOOD)

    expect(response.status).toBe(401)
    expect(response.body.code).toBe('CALLBACK_TOKEN_INVALID')
    expect(JSON.stringify(response.body)).not.toContain('a'.repeat(43))
    const viewed = await request(app).get(`/api/invoices/analysis-jobs/${jobId}`)
    expect(viewed.body.data.status).toBe('queued')
  })

  it('rechaza un token vencido sin borrar el trabajo', async () => {
    let clock = new Date('2026-10-21T15:00:00.000Z')
    const app = buildApp({
      now: () => clock,
      callbackTokenTtlMs: 1000,
    })
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    const token = callbackTokens.get(jobId) ?? ''
    clock = new Date(clock.getTime() + 1000)
    const response = await postResult(app, jobId, token, FOOD)

    expect(response.status).toBe(401)
    expect(response.body.code).toBe('CALLBACK_TOKEN_EXPIRED')
    const viewed = await request(app).get(`/api/invoices/analysis-jobs/${jobId}`)
    expect(viewed.body.data.status).toBe('queued')
  })

  it('rechaza un trabajo inexistente', async () => {
    const response = await postResult(
      buildApp(),
      '12121212-1212-4121-8121-121212121212',
      'b'.repeat(43),
      FOOD,
    )

    expect(response.status).toBe(404)
    expect(response.body.code).toBe('JOB_NOT_FOUND')
  })

  it('marca failed cuando la extracción no se puede procesar', async () => {
    const app = buildApp()
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    const response = await postResult(app, jobId, callbackTokens.get(jobId), { supplier_name: 'Demo' })

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('INVALID_EXTRACTION')
    const viewed = await request(app).get(`/api/invoices/analysis-jobs/${jobId}`)
    expect(viewed.body.data.status).toBe('failed')
    expect(viewed.body.data.failureCode).toBe('INVALID_EXTRACTION')
    expect(viewed.body.data.result).toBeUndefined()
  })

  it('deja ready una factura con advertencias comerciales', async () => {
    const app = buildApp({ integrity: { secret: INTEGRITY } })
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    const response = await postResult(app, jobId, callbackTokens.get(jobId), BONUS)

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('ready')
    const viewed = await request(app).get(`/api/invoices/analysis-jobs/${jobId}`)
    expect(viewed.body.data.status).toBe('ready')
    expect(viewed.body.data.result.interpretation.relations.length).toBeGreaterThan(0)
  })

  it('repite el mismo callback sin cambiar el resultado', async () => {
    const app = buildApp({ integrity: { secret: INTEGRITY, now: () => new Date('2026-10-21T15:00:00.000Z') } })
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    const token = callbackTokens.get(jobId)
    await postResult(app, jobId, token, FOOD)
    const before = await request(app).get(`/api/invoices/analysis-jobs/${jobId}`)
    const repeated = await postResult(app, jobId, token, FOOD)
    const after = await request(app).get(`/api/invoices/analysis-jobs/${jobId}`)

    expect(repeated.status).toBe(200)
    expect(repeated.body.data).toEqual({ jobId, status: 'ready' })
    expect(after.body.data.result).toEqual(before.body.data.result)
  })

  it('no deja que dos callbacks simultáneos completen resultados distintos', async () => {
    const app = buildApp({ integrity: { secret: INTEGRITY } })
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    const token = callbackTokens.get(jobId)
    const firstExtraction = { ...FOOD, document_number: '0002-00000010' }
    const secondExtraction = { ...FOOD, document_number: '0002-00000999' }
    const [first, second] = await Promise.all([
      postResult(app, jobId, token, firstExtraction),
      postResult(app, jobId, token, secondExtraction),
    ])
    const responses = [first, second]
    expect(responses.map((item) => item.status).sort()).toEqual([200, 409])
    const winner = first.status === 200 ? firstExtraction : secondExtraction
    const loser = first.status === 200 ? secondExtraction : firstExtraction
    const viewed = await request(app).get(`/api/invoices/analysis-jobs/${jobId}`)
    expect(viewed.body.data.status).toBe('ready')
    expect(viewed.body.data.result.document.header.number).toBe(winner.document_number)
    expect(viewed.body.data.result.document.header.number).not.toBe(loser.document_number)
  })

  it('rechaza una organización o sucursal enviada por n8n', async () => {
    const app = buildApp()
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    const response = await postResult(app, jobId, callbackTokens.get(jobId), {
      ...FOOD,
      organizationId: CLIENT_ORG,
      locationId: LOC_2,
      actor_user_id: USER_B,
    })

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('CLIENT_DESTINATION')
    const metadata = JSON.parse(await readFile(path.join(directory, 'jobs', jobId, 'job.json'), 'utf8'))
    expect(metadata.status).toBe('queued')
    expect(metadata.organizationId).toBe(ORG_1)
    expect(metadata.locationId).toBe(LOC_1)
    expect(metadata.userId).toBe(USER_A)
  })

  it('devuelve al propietario el resultado firmado para el usuario y el archivo originales', async () => {
    const app = buildApp({ integrity: { secret: INTEGRITY, now: () => new Date('2026-10-21T15:00:00.000Z') } })
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    await postResult(app, jobId, callbackTokens.get(jobId), FOOD)
    const viewed = await request(app).get(`/api/invoices/analysis-jobs/${jobId}`)
    const result = viewed.body.data.result

    expect(viewed.status).toBe(200)
    expect(result.metadata.fileSha256).toBe(sha256Hex(PDF))
    expect(result.metadata.integrityToken).toEqual(expect.any(String))
    expect(verifyInvoiceIntegrity({
      token: result.metadata.integrityToken,
      userId: USER_A,
      fileSha256: sha256Hex(PDF),
      snapshot: result,
      secret: INTEGRITY,
      now: new Date('2026-10-21T15:30:00.000Z'),
    }).sub).toBe(USER_A)
    expect(JSON.stringify(viewed.body)).not.toContain(callbackTokens.get(jobId))
    expect(JSON.stringify(viewed.body)).not.toContain('callbackToken')
    expect(JSON.stringify(viewed.body)).not.toContain(directory)
  })

  it('no entrega el resultado a otro usuario', async () => {
    const app = buildApp({ integrity: { secret: INTEGRITY } })
    const created = await postJob(app)
    const jobId = created.body.data.jobId as string
    await postResult(app, jobId, callbackTokens.get(jobId), FOOD)
    const owner = await request(app).get(`/api/invoices/analysis-jobs/${jobId}`)
    const response = await request(app)
      .get(`/api/invoices/analysis-jobs/${jobId}`)
      .set('x-test-user', USER_B)

    expect(response.status).toBe(404)
    expect(response.body.code).toBe('JOB_NOT_FOUND')
    expect(JSON.stringify(response.body)).not.toContain(owner.body.data.result.metadata.integrityToken)
    expect(JSON.stringify(response.body)).not.toContain('Harina')
  })

  it('conserva el resultado después de reiniciar el repositorio', async () => {
    const first = buildApp({ integrity: { secret: INTEGRITY, now: () => new Date('2026-10-21T15:00:00.000Z') } })
    const created = await postJob(first)
    const jobId = created.body.data.jobId as string
    await postResult(first, jobId, callbackTokens.get(jobId), FOOD)
    const restarted = buildApp({ integrity: { secret: INTEGRITY, now: () => new Date('2026-10-21T15:00:00.000Z') } })
    const response = await request(restarted).get(`/api/invoices/analysis-jobs/${jobId}`)

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('ready')
    expect(response.body.data.result.document.header.number).toBe('0002-00000010')
    expect(verifyInvoiceIntegrity({
      token: response.body.data.result.metadata.integrityToken,
      userId: USER_A,
      fileSha256: sha256Hex(PDF),
      snapshot: response.body.data.result,
      secret: INTEGRITY,
      now: new Date('2026-10-21T16:00:00.000Z'),
    }).fileSha256).toBe(sha256Hex(PDF))
  })
})

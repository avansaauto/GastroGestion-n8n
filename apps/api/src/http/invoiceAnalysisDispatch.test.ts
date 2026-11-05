import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type RequestHandler } from 'express'
import request from 'supertest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import { sha256Hex } from './fileHash.js'
import {
  dispatchInvoiceAnalysisJob,
  n8nInvoiceWebhookFromEnv,
  parseN8nWebhookUrl,
  type N8nInvoiceWebhookConfig,
} from './invoiceAnalysisDispatch.js'
import { InvoiceAnalysisJobError, submitInvoiceAnalysisResult } from './invoiceAnalysisJob.js'
import {
  ANALYSIS_JOB_ACTIVE_WINDOW_MS,
  STALE_UNKNOWN_DISPATCH_MS,
  createFileInvoiceAnalysisJobStore,
  type InvoiceAnalysisJobStore,
} from './invoiceAnalysisJobStore.js'
import { createInvoicesRouter } from '../routes/invoices.js'

const invoiceCases = JSON.parse(readFileSync(
  new URL('../modules/invoice-intelligence/fixtures/invoice-cases.json', import.meta.url),
  'utf8',
)) as { foodInvoice: Record<string, unknown> }
const FOOD = invoiceCases.foodInvoice
const PDF = Buffer.from('%PDF-1.4\nfixture')
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ORGANIZATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const WEBHOOK_URL = 'https://senda.example.n8n.cloud/webhook/facturas'
const WEBHOOK_SECRET = 'n8n-webhook-secret-test'

const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.local')
let directory = ''

beforeEach(async () => {
  await mkdtemp(path.join(parent, 'dispatch-')).then((created) => {
    directory = created
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('envío de trabajos de análisis a n8n', () => {
  it('envía el archivo, el trabajo y el token de callback', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const seen: Array<{ url: string; init: RequestInit }> = []
    const outcome = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(async (url, init) => {
        seen.push({ url: String(url), init: init ?? {} })
        return new Response('ok', { status: 200 })
      }),
    })
    const form = await readDispatch(seen[0])

    expect(outcome.kind).toBe('accepted')
    expect(outcome.job?.status).toBe('processing')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(WEBHOOK_URL)
    expect(form.jobId).toBe(created.job.id)
    expect(form.callbackToken).toBe(created.callbackToken)
    expect(form.bytes.equals(PDF)).toBe(true)
    expect(form.name).toBe('document.pdf')
    expect(form.type).toBe('application/pdf')
    expect(form.keys.sort()).toEqual(['callbackToken', 'file', 'jobId'])
    expect(new Headers(seen[0]?.init.headers).get('authorization')).toBe(`Bearer ${WEBHOOK_SECRET}`)
  })

  it('no llama a la red si la URL falta o no es un webhook HTTPS fijo', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const fetchImpl = vi.fn()
    const rejected = [
      null,
      'http://senda.example.n8n.cloud/webhook/facturas',
      'https://user:secret@senda.example.n8n.cloud/webhook/facturas',
      'https://127.0.0.1/webhook/facturas',
      'https://[::1]/webhook/facturas',
      'https://localhost/webhook/facturas',
      'https://facturas.local/webhook',
      'https://2130706433/webhook',
      'https://senda.example.n8n.cloud/webhook/facturas?token=secret',
      'https://senda.example.n8n.cloud:8443/webhook/facturas',
    ]
    for (const url of rejected) {
      const outcome = await dispatchInvoiceAnalysisJob({
        store,
        jobId: created.job.id,
        callbackToken: created.callbackToken!,
        webhook: url === null ? null : webhook(fetchImpl, { url }),
      })
      expect(outcome.kind === 'not_configured' || outcome.kind === 'invalid_url').toBe(true)
    }
    expect(parseN8nWebhookUrl(WEBHOOK_URL)?.toString()).toBe(WEBHOOK_URL)
    expect(n8nInvoiceWebhookFromEnv({})).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await store.getForUser(created.job.id, USER))?.status).toBe('queued')
    expect((await store.getForUser(created.job.id, USER))?.delivery).toBe('not_sent')
  })

  it('trata un corte ambiguo como envío desconocido y no lo reintenta', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const errors = captureErrors()
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed ${WEBHOOK_SECRET} ${created.callbackToken}`)
    })
    const first = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl),
    })
    const second = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl),
    })

    expect(first.kind).toBe('unknown')
    expect(first.job?.status).toBe('processing')
    expect(first.job?.delivery).toBe('unknown')
    expect(first.job?.failureCode).toBeNull()
    expect(second.kind).toBe('skipped')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(errors.join('\n')).toContain('WEBHOOK_UNAVAILABLE')
    expect(errors.join('\n')).toContain('TypeError')
    expect(errors.join('\n')).not.toContain(WEBHOOK_SECRET)
    expect(errors.join('\n')).not.toContain(created.callbackToken)
    expect(errors.join('\n')).not.toContain('fetch failed')
    errors.restore()
  })

  it('no reintenta un timeout, conserva el callback y no lo deja en queued', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const errors = captureErrors()
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      const error = new Error(`timed out ${WEBHOOK_SECRET} ${created.callbackToken}`)
      error.name = 'TimeoutError'
      throw error
    })
    const outcome = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl, { timeoutMs: 1000 }),
    })
    const repeated = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl, { timeoutMs: 1000 }),
    })

    expect(outcome.kind).toBe('unknown')
    expect(outcome.job?.status).toBe('processing')
    expect(outcome.job?.delivery).toBe('unknown')
    expect(outcome.job?.failureCode).toBeNull()
    expect(outcome.job?.id).toBe(created.job.id)
    expect(repeated.kind).toBe('skipped')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await store.replaceCallbackToken(created.job.id)).toBeNull()
    expect(errors.join('\n')).toContain('WEBHOOK_TIMEOUT')
    expect(errors.join('\n')).toContain('TimeoutError')
    expect(errors.join('\n')).not.toContain(WEBHOOK_SECRET)
    expect(errors.join('\n')).not.toContain(created.callbackToken)
    expect(errors.join('\n')).not.toContain('timed out')
    errors.restore()

    const late = await submitInvoiceAnalysisResult({
      jobId: created.job.id,
      authorizationHeader: `Bearer ${created.callbackToken}`,
      body: FOOD,
      store,
      integrity: null,
    })
    expect(late).toEqual({ jobId: created.job.id, status: 'ready' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reintenta el mismo trabajo si la conexión no llegó a establecerse', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const errors = captureErrors()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw transportError(WEBHOOK_SECRET)
      return new Response('ok', { status: 200 })
    })
    const retried = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl),
    })
    const form = await readDispatch({ url: WEBHOOK_URL, init: fetchImpl.mock.calls[1]?.[1] ?? {} })

    expect(retried.kind).toBe('accepted')
    expect(retried.job?.id).toBe(created.job.id)
    expect(retried.job?.status).toBe('processing')
    expect(calls).toBe(2)
    expect(form.callbackToken).toBe(created.callbackToken)
    expect(form.jobId).toBe(created.job.id)
    expect(errors.join('\n')).toContain('WEBHOOK_TRANSPORT')
    expect(errors.join('\n')).toContain('ECONNREFUSED')
    expect(errors.join('\n')).not.toContain(WEBHOOK_SECRET)
    expect(errors.join('\n')).not.toContain(created.callbackToken)
    errors.restore()

    const callback = await submitInvoiceAnalysisResult({
      jobId: created.job.id,
      authorizationHeader: `Bearer ${created.callbackToken}`,
      body: FOOD,
      store,
      integrity: null,
    })
    expect(callback.status).toBe('ready')
  })

  it('deja el mismo trabajo sin enviar si la red falla dos veces y permite un reintento posterior', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const fetchImpl = vi.fn(async () => {
      throw transportError()
    })
    const exhausted = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl),
    })
    expect(exhausted.kind).toBe('unavailable')
    expect(exhausted.job?.id).toBe(created.job.id)
    expect(exhausted.job?.status).toBe('queued')
    expect(exhausted.job?.delivery).toBe('not_sent')
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const resumed = await store.resumeUnsentDispatch(created.job.id)
    expect(resumed?.job.id).toBe(created.job.id)
    expect(resumed?.token).toBeTruthy()
    expect(resumed?.token).not.toBe(created.callbackToken)
    const accepted = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: resumed!.token,
      webhook: webhook(async () => new Response('ok', { status: 200 })),
      alreadyClaimed: true,
    })
    expect(accepted.kind).toBe('accepted')
    expect(accepted.job?.status).toBe('processing')
    await expect(submitInvoiceAnalysisResult({
      jobId: created.job.id,
      authorizationHeader: `Bearer ${created.callbackToken}`,
      body: FOOD,
      store,
      integrity: null,
    })).rejects.toMatchObject({ code: 'CALLBACK_TOKEN_INVALID' })
    const callback = await submitInvoiceAnalysisResult({
      jobId: created.job.id,
      authorizationHeader: `Bearer ${resumed!.token}`,
      body: FOOD,
      store,
      integrity: null,
    })
    expect(callback).toEqual({ jobId: created.job.id, status: 'ready' })
  })

  it('registra el rechazo HTTP sin reintentar ni reabrir el trabajo', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const errors = captureErrors()
    const fetchImpl = vi.fn(async () => new Response(WEBHOOK_SECRET, { status: 401 }))
    const rejected = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl),
    })
    const again = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl),
    })

    expect(rejected.kind).toBe('rejected')
    expect(rejected.job?.status).toBe('failed')
    expect(rejected.job?.delivery).toBe('rejected')
    expect(rejected.job?.failureCode).toBe('DISPATCH_REJECTED')
    expect(again.kind).toBe('skipped')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(errors.join('\n')).toContain('WEBHOOK_REJECTED')
    expect(errors.join('\n')).toContain('"status":401')
    expect(errors.join('\n')).not.toContain(WEBHOOK_SECRET)
    expect(errors.join('\n')).not.toContain(created.callbackToken)
    errors.restore()
  })

  it('si el reintento agota el tiempo, no vuelve a enviar y el callback original sigue valiendo', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw transportError()
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    })
    const outcome = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl),
    })

    expect(outcome.kind).toBe('unknown')
    expect(outcome.job?.status).toBe('processing')
    expect(outcome.job?.delivery).toBe('unknown')
    expect(calls).toBe(2)
    expect(await store.resumeUnsentDispatch(created.job.id)).toBeNull()
    expect(await store.replaceCallbackToken(created.job.id)).toBeNull()
    const late = await submitInvoiceAnalysisResult({
      jobId: created.job.id,
      authorizationHeader: `Bearer ${created.callbackToken}`,
      body: FOOD,
      store,
      integrity: null,
    })
    expect(late).toEqual({ jobId: created.job.id, status: 'ready' })
    expect(calls).toBe(2)
  })

  it('no repite un corte de conexión que pudo haber entregado el archivo', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const fetchImpl = vi.fn(async () => {
      throw resetError()
    })
    const outcome = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(fetchImpl),
    })

    expect(outcome.kind).toBe('unknown')
    expect(outcome.job?.status).toBe('processing')
    expect(outcome.job?.delivery).toBe('unknown')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await store.resumeUnsentDispatch(created.job.id)).toBeNull()
  })

  it('promueve un envío desconocido vencido sin disparar otro webhook', async () => {
    let clock = new Date('2026-10-24T15:38:56.000Z')
    const store = createFileInvoiceAnalysisJobStore({ directory, now: () => clock })
    const created = await enqueue(store)
    expect(await store.claimDispatch(created.job.id)).toBe('claimed')
    clock = new Date(clock.getTime() + 10_000)
    expect((await store.getForUser(created.job.id, USER))?.status).toBe('queued')

    clock = new Date(Date.parse('2026-10-24T15:38:56.000Z') + STALE_UNKNOWN_DISPATCH_MS)
    const promoted = await store.getForUser(created.job.id, USER)
    expect(promoted?.status).toBe('processing')
    expect(promoted?.delivery).toBe('unknown')
    expect(promoted?.id).toBe(created.job.id)
    const reused = await store.enqueue({
      userId: USER,
      organizationId: ORGANIZATION,
      locationId: LOCATION,
      fileSha256: sha256Hex(PDF),
      byteSize: PDF.length,
      mediaType: 'application/pdf',
      bytes: PDF,
    })
    expect(reused.callbackToken).toBeNull()
    expect(reused.job.id).toBe(created.job.id)
    expect(reused.job.status).toBe('processing')
    expect(await store.resumeUnsentDispatch(created.job.id)).toBeNull()

    const late = await submitInvoiceAnalysisResult({
      jobId: created.job.id,
      authorizationHeader: `Bearer ${created.callbackToken}`,
      body: FOOD,
      store,
      integrity: null,
    })
    expect(late).toEqual({ jobId: created.job.id, status: 'ready' })
  })

  it('un análisis viejo no bloquea una carga nueva y el callback anterior sigue valiendo', async () => {
    let clock = new Date('2026-10-24T15:38:56.000Z')
    const store = createFileInvoiceAnalysisJobStore({ directory, now: () => clock })
    const created = await enqueue(store)
    expect(await store.claimDispatch(created.job.id)).toBe('claimed')
    clock = new Date(clock.getTime() + ANALYSIS_JOB_ACTIVE_WINDOW_MS)
    const next = await store.enqueue({
      userId: USER,
      organizationId: ORGANIZATION,
      locationId: LOCATION,
      fileSha256: sha256Hex(PDF),
      byteSize: PDF.length,
      mediaType: 'application/pdf',
      bytes: PDF,
    })
    expect(next.callbackToken).toBeTruthy()
    expect(next.job.id).not.toBe(created.job.id)
    expect(next.job.status).toBe('queued')
    const late = await submitInvoiceAnalysisResult({
      jobId: created.job.id,
      authorizationHeader: `Bearer ${created.callbackToken}`,
      body: FOOD,
      store,
      integrity: null,
    })
    expect(late).toEqual({ jobId: created.job.id, status: 'ready' })
    expect((await store.getForUser(next.job.id, USER))?.status).toBe('queued')
  })

  it('una carga nueva reintenta solo si el envío anterior no salió', async () => {
    const tokens: string[] = []
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls <= 2) throw transportError()
      return new Response('ok', { status: 200 })
    })
    const app = analysisApp(fetchImpl, (token) => {
      tokens.push(token)
    })
    const file = Buffer.from('%PDF-1.4\nmisma-factura')

    const first = await request(app)
      .post('/api/invoices/analysis-jobs')
      .field('locationId', LOCATION)
      .attach('file', file, 'factura.pdf')
    const second = await request(app)
      .post('/api/invoices/analysis-jobs')
      .field('locationId', LOCATION)
      .attach('file', file, 'factura.pdf')

    expect(first.status).toBe(202)
    expect(first.body.data.status).toBe('queued')
    expect(second.status).toBe(202)
    expect(second.body.data).toEqual({ jobId: first.body.data.jobId, status: 'processing' })
    expect(calls).toBe(3)
    expect(tokens).toHaveLength(2)
    expect(tokens[1]).not.toBe(tokens[0])
    await expect(submitInvoiceAnalysisResult({
      jobId: first.body.data.jobId,
      authorizationHeader: `Bearer ${tokens[0]}`,
      body: FOOD,
      store: storeAt(directory),
      integrity: null,
    })).rejects.toMatchObject({ code: 'CALLBACK_TOKEN_INVALID' })
    const callback = await submitInvoiceAnalysisResult({
      jobId: first.body.data.jobId,
      authorizationHeader: `Bearer ${tokens[1]}`,
      body: FOOD,
      store: storeAt(directory),
      integrity: null,
    })
    expect(callback).toEqual({ jobId: first.body.data.jobId, status: 'ready' })
    expect(calls).toBe(3)
  })

  it('una carga nueva no repite un envío que agotó el tiempo', async () => {
    const tokens: string[] = []
    const fetchImpl = vi.fn(async () => {
      const error = new Error(`timed out ${WEBHOOK_SECRET}`)
      error.name = 'TimeoutError'
      throw error
    })
    const app = analysisApp(fetchImpl, (token) => {
      tokens.push(token)
    })
    const file = Buffer.from('%PDF-1.4\nfactura-timeout')

    const first = await request(app)
      .post('/api/invoices/analysis-jobs')
      .field('locationId', LOCATION)
      .attach('file', file, 'factura.pdf')
    const second = await request(app)
      .post('/api/invoices/analysis-jobs')
      .field('locationId', LOCATION)
      .attach('file', file, 'factura.pdf')

    expect(first.status).toBe(202)
    expect(first.body.data.status).toBe('processing')
    expect(second.body.data).toEqual({
      jobId: first.body.data.jobId,
      status: 'processing',
      reused: true,
    })
    expect(first.body.data.reused).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(tokens).toEqual([expect.any(String)])

    const callback = await submitInvoiceAnalysisResult({
      jobId: first.body.data.jobId,
      authorizationHeader: `Bearer ${tokens[0]}`,
      body: FOOD,
      store: storeAt(directory),
      integrity: null,
    })
    expect(callback).toEqual({ jobId: first.body.data.jobId, status: 'ready' })
    const viewed = await request(app).get(`/api/invoices/analysis-jobs/${first.body.data.jobId}`)
    expect(viewed.body.data.status).toBe('ready')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('no envía nada al reconstruir el almacén y permite un token nuevo', async () => {
    const firstStore = storeAt(directory)
    const created = await enqueue(firstStore)
    const restarted = storeAt(directory)
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    expect(fetchImpl).not.toHaveBeenCalled()

    const rotated = await restarted.replaceCallbackToken(created.job.id)
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(submitInvoiceAnalysisResult({
      jobId: created.job.id,
      authorizationHeader: `Bearer ${created.callbackToken}`,
      body: FOOD,
      store: restarted,
      integrity: null,
    })).rejects.toBeInstanceOf(InvoiceAnalysisJobError)

    const sent = await dispatchInvoiceAnalysisJob({
      store: restarted,
      jobId: created.job.id,
      callbackToken: rotated!.token,
      webhook: webhook(fetchImpl),
    })
    expect(sent.kind).toBe('accepted')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('impide dos envíos simultáneos del mismo trabajo', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = vi.fn(async () => {
      await gate
      return new Response('ok', { status: 200 })
    })
    const config = webhook(fetchImpl)
    const first = dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: config,
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const second = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: config,
    })
    release?.()
    const accepted = await first

    expect(second.kind).toBe('skipped')
    expect(accepted.kind).toBe('accepted')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('conserva ready si el callback llega antes de cerrar el HTTP', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const outcome = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(async (_url, init) => {
        const form = init?.body as FormData
        await submitInvoiceAnalysisResult({
          jobId: String(form.get('jobId')),
          authorizationHeader: `Bearer ${String(form.get('callbackToken'))}`,
          body: FOOD,
          store,
          integrity: null,
        })
        return new Response('ok', { status: 200 })
      }),
    })

    expect(outcome.kind).toBe('accepted')
    expect(outcome.job?.status).toBe('ready')
    expect((await store.getForUser(created.job.id, USER))?.status).toBe('ready')
  })

  it('no expone el secreto del webhook ni el token en la respuesta o los logs', async () => {
    const store = storeAt(directory)
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((message) => {
      errors.push(String(message))
    })
    const created = await enqueue(store)
    await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(async () => new Response(WEBHOOK_SECRET, { status: 503 })),
    })
    const sent: FormData[] = []
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/invoices', createInvoicesRouter({
      auth: authAs(),
      repository: { listOrganizations: async () => { throw new Error('no listar') } },
      maxRequests: 20,
      integrity: null,
      analysisJobsDirectory: directory,
      n8nWebhook: webhook(async (_url, init) => {
        sent.push(init?.body as FormData)
        return new Response('ok', { status: 200 })
      }),
      onAnalysisCallbackToken: () => undefined,
    }))
    const response = await request(app)
      .post('/api/invoices/analysis-jobs')
      .field('locationId', LOCATION)
      .attach('file', Buffer.from('%PDF-1.4\nroute'), 'factura-secreta.pdf')
    const metadata = await readFile(path.join(directory, 'jobs', created.job.id, 'job.json'), 'utf8')
    const routeForm = sent[0]
    const published = `${JSON.stringify(response.body)}\n${errors.join('\n')}\n${metadata}\n${routeForm ? [...routeForm.keys()].join(',') : ''}`

    expect(response.status).toBe(202)
    expect(response.body.data).toEqual({ jobId: expect.any(String), status: 'processing' })
    expect(routeForm?.get('organizationId')).toBeNull()
    expect(routeForm?.get('locationId')).toBeNull()
    expect(routeForm?.get('userId')).toBeNull()
    expect(published).not.toContain(WEBHOOK_SECRET)
    expect(published).not.toContain(created.callbackToken)
    expect(published).not.toContain('factura-secreta.pdf')
    spy.mockRestore()
  })

  it('pasa de queued a processing, failed o ready sin reabrir un resultado', async () => {
    const store = storeAt(directory)
    const created = await enqueue(store)
    const accepted = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: created.callbackToken!,
      webhook: webhook(async () => new Response('ok', { status: 202 })),
    })
    expect(accepted.job?.status).toBe('processing')
    expect(accepted.job?.delivery).toBe('accepted')

    const fetchImpl = vi.fn(async () => new Response('no', { status: 401 }))
    const recovered = await store.replaceCallbackToken(created.job.id)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(recovered?.job.status).toBe('queued')
    expect(recovered?.job.delivery).toBe('not_sent')

    const rejected = await dispatchInvoiceAnalysisJob({
      store,
      jobId: created.job.id,
      callbackToken: recovered!.token,
      webhook: webhook(fetchImpl),
    })
    expect(rejected.job?.status).toBe('failed')
    expect(rejected.job?.failureCode).toBe('DISPATCH_REJECTED')
    expect(await store.replaceCallbackToken(created.job.id)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const oversized = await enqueue(store, Buffer.from('%PDF-1.4\notro'))
    const tooLarge = await dispatchInvoiceAnalysisJob({
      store,
      jobId: oversized.job.id,
      callbackToken: oversized.callbackToken!,
      webhook: webhook(fetchImpl, { maxBytes: 4 }),
    })
    expect(tooLarge.kind).toBe('rejected')
    expect(tooLarge.job?.status).toBe('failed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

function storeAt(root: string): InvoiceAnalysisJobStore {
  return createFileInvoiceAnalysisJobStore({ directory: root })
}

async function enqueue(store: InvoiceAnalysisJobStore, bytes: Buffer = PDF) {
  const created = await store.enqueue({
    userId: USER,
    organizationId: ORGANIZATION,
    locationId: LOCATION,
    fileSha256: sha256Hex(bytes),
    byteSize: bytes.length,
    mediaType: 'application/pdf',
    bytes,
  })
  if (!created.callbackToken) throw new Error('se esperaba un trabajo nuevo')
  return { job: created.job, callbackToken: created.callbackToken }
}

function webhook(
  fetchImpl: NonNullable<N8nInvoiceWebhookConfig['fetchImpl']>,
  overrides: Partial<N8nInvoiceWebhookConfig> = {},
): N8nInvoiceWebhookConfig {
  return {
    url: WEBHOOK_URL,
    secret: WEBHOOK_SECRET,
    timeoutMs: 30_000,
    maxBytes: 1024,
    fetchImpl,
    ...overrides,
  }
}

async function readDispatch(call: { url: string; init: RequestInit } | undefined) {
  const form = call?.init.body as FormData
  const file = form.get('file')
  if (!(file instanceof Blob)) throw new Error('falta el archivo')
  return {
    keys: [...form.keys()],
    jobId: form.get('jobId'),
    callbackToken: form.get('callbackToken'),
    bytes: Buffer.from(await file.arrayBuffer()),
    name: 'name' in file ? String(file.name) : '',
    type: file.type,
  }
}

function analysisApp(
  fetchImpl: NonNullable<N8nInvoiceWebhookConfig['fetchImpl']>,
  onToken: (token: string) => void,
) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api/invoices', createInvoicesRouter({
    auth: authAs(),
    repository: { listOrganizations: async () => { throw new Error('no listar') } },
    maxRequests: 20,
    integrity: null,
    analysisJobsDirectory: directory,
    n8nWebhook: webhook(fetchImpl),
    onAnalysisCallbackToken: (delivery) => {
      onToken(delivery.callbackToken)
    },
  }))
  return app
}

function transportError(secret = '') {
  const cause = Object.assign(new Error(`connect ${secret}`), { code: 'ECONNREFUSED' })
  return Object.assign(new TypeError(`fetch failed ${secret}`), { cause })
}

function resetError() {
  const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

function captureErrors() {
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errors.push(String(message))
  })
  return Object.assign(errors, { restore: () => spy.mockRestore() })
}

function authAs(): RequestHandler {
  return (req, _response, next) => {
    const authenticated = req as AuthenticatedRequest
    authenticated.user = { id: USER } as AuthenticatedRequest['user']
    authenticated.supabase = {
      from(table: string) {
        if (table !== 'locations') throw new Error(`tabla inesperada: ${table}`)
        return {
          select() {
            return {
              eq(_column: string, value: string) {
                return {
                  async maybeSingle() {
                    if (value !== LOCATION) return { data: null, error: null }
                    return { data: { id: value, organization_id: ORGANIZATION }, error: null }
                  },
                }
              },
            }
          },
        }
      },
    } as unknown as SupabaseClient
    next()
  }
}

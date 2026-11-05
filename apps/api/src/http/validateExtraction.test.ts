import { readFileSync } from 'node:fs'
import express, { type RequestHandler } from 'express'
import request from 'supertest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import { createInvoicesRouter } from '../routes/invoices.js'
import { validateExtractedInvoice } from './validateExtraction.js'

const fixture = JSON.parse(
  readFileSync(
    new URL('../modules/invoice-intelligence/fixtures/mayoristanet-0012-00611278.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>

const authenticated: RequestHandler = (req, _response, next) => {
  const scoped = req as AuthenticatedRequest
  scoped.user = { id: 'test-user' } as AuthenticatedRequest['user']
  scoped.supabase = { from: vi.fn(), rpc: vi.fn() } as unknown as SupabaseClient
  next()
}

function app() {
  const server = express()
  server.use(express.json())
  server.use('/api/invoices', createInvoicesRouter({
    auth: authenticated,
    integrity: null,
    maxRequests: 20,
  }))
  return server
}

function lineByName(lines: Array<{ name: string }>, name: string) {
  return lines.find((line) => line.name.includes(name))
}

describe('POST /api/invoices/validate-extraction', () => {
  it('rechaza un usuario no autenticado sin consultar datos', async () => {
    const response = await request(createApp())
      .post('/api/invoices/validate-extraction')
      .send(fixture)

    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/autenticado/i)
  })

  it('normaliza las siete líneas y convierte presentaciones y pesos variables', async () => {
    const response = await request(app()).post('/api/invoices/validate-extraction').send(fixture)

    expect(response.status).toBe(200)
    const lines = response.body.data.document.lines as Array<{
      name: string
      inventoryPhysicalQuantity: number
      inventoryEligibility: string
    }>
    expect(lines).toHaveLength(7)
    expect(lineByName(lines, 'Panceta')?.inventoryPhysicalQuantity).toBeCloseTo(7220, 3)
    expect(lineByName(lines, 'Doña Aurora')?.inventoryPhysicalQuantity).toBeCloseTo(18190, 3)
    expect(lineByName(lines, 'La Paulina')?.inventoryPhysicalQuantity).toBe(3500)
    expect(lineByName(lines, 'Arroz Parboil')?.inventoryPhysicalQuantity).toBe(5000)
    expect(lineByName(lines, 'Tomate Triturado')?.inventoryPhysicalQuantity).toBe(16000)
    expect(lineByName(lines, 'Pan Rallado')?.inventoryPhysicalQuantity).toBe(10000)
    expect(lineByName(lines, 'Aros de Cebolla')?.inventoryPhysicalQuantity).toBe(10000)
    expect(lines.every((line) => line.inventoryEligibility === 'eligible')).toBe(true)
    expect(JSON.stringify(response.body)).not.toMatch(/integrityToken|fileSha256/)
    expect(response.body.data.metadata.provider).toBe('external')
    expect(response.body.data.eligibility).toMatchObject({
      documentDecision: 'blocked',
      definitive: 'undetermined',
      autoApprovable: false,
    })
    expect(response.body.data.eligibility.unresolvedContext).toContain('organization')
    expect(response.body.data.eligibility.unresolvedContext).toContain('exact_product_links')
  })

  it('rechaza un JSON inválido o sin líneas', async () => {
    const missing = await request(app()).post('/api/invoices/validate-extraction').send({
      supplier_name: 'MAYORISTANET.COM S.A.',
      total: 1,
    })
    expect(missing.status).toBe(422)
    expect(missing.body.code).toBe('INVALID_EXTRACTION')

    const notObject = await request(app()).post('/api/invoices/validate-extraction').send([fixture])
    expect(notObject.status).toBe(422)
    expect(notObject.body.code).toBe('INVALID_EXTRACTION')
  })

  it('repite la misma extracción sin escribir ni cambiar el resultado', async () => {
    const from = vi.fn()
    const rpc = vi.fn()
    const auth: RequestHandler = (req, _response, next) => {
      const scoped = req as AuthenticatedRequest
      scoped.user = { id: 'test-user' } as AuthenticatedRequest['user']
      scoped.supabase = { from, rpc } as unknown as SupabaseClient
      next()
    }
    const server = express()
    server.use(express.json())
    server.use('/api/invoices', createInvoicesRouter({ auth, integrity: null, maxRequests: 20 }))

    const first = await request(server).post('/api/invoices/validate-extraction').send(fixture)
    const second = await request(server).post('/api/invoices/validate-extraction').send(fixture)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.data.document).toEqual(first.body.data.document)
    expect(second.body.data.validation).toEqual(first.body.data.validation)
    expect(from).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('no da por cerrada la conciliación si las líneas superan el subtotal en 10000 y no hay ajuste', async () => {
    const payload = structuredClone(fixture) as {
      subtotal: number
      discounts: number
      lines: Array<Record<string, unknown>>
    }
    const aros = payload.lines.find((line) => String(line.name).includes('Aros de Cebolla'))!
    aros.unit_price = 121543.36
    aros.amount = 121543.36
    payload.subtotal = 417212.19
    payload.discounts = 0

    const result = validateExtractedInvoice(payload)
    const lineSum = result.document.lines.reduce((total, line) => total + (line.amount ?? 0), 0)

    expect(lineSum).toBeCloseTo(427212.19, 2)
    expect(result.document.amounts.subtotal).toBe(417212.19)
    expect(result.document.amounts.discounts).toBe(0)
    expect(result.validation.differences.linesVsSubtotal).toBe(10000)
    expect(result.validation.errors.some((item) => item.code === 'LINES_SUBTOTAL_MISMATCH')).toBe(true)
    expect(result.validation.status).not.toBe('consistent')
    expect(result.validation.blocksReception).toBe(true)
    expect(result.interpretation.relations).toEqual([])
    expect(result.validation.fiscalReconciliation.totalStatus).toBe('consistent')
    expect(result.document.lines.find((line) => line.name.includes('Panceta'))?.inventoryPhysicalQuantity).toBeCloseTo(7220, 3)
    expect(result.document.lines.find((line) => line.name.includes('Doña Aurora'))?.inventoryPhysicalQuantity).toBeCloseTo(18190, 3)
  })
})

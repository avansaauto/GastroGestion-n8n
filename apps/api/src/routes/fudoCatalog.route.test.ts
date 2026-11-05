import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

describe('rutas de producción', () => {
  it('expone /api/health', async () => {
    const response = await request(createApp()).get('/api/health')
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
    expect(response.body.service).toBe('senda-ops-api')
    expect(JSON.stringify(response.body)).not.toMatch(/eyJ|service_role|pepper/i)
  })

  it('registra el catálogo Fudo sin JWT de usuario', async () => {
    const previous = process.env.INTEGRATION_AUTH_PEPPER
    delete process.env.INTEGRATION_AUTH_PEPPER
    const response = await request(createApp())
      .post('/api/integrations/fudo/catalog')
      .send({ products: [{ product_id: '17', name: 'American IPA', active: true }] })
    if (previous === undefined) delete process.env.INTEGRATION_AUTH_PEPPER
    else process.env.INTEGRATION_AUTH_PEPPER = previous
    expect(response.status).toBe(503)
    expect(response.body.code).toBe('PEPPER_MISSING')
  })
})

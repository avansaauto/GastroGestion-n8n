import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'

describe('GET /api/health', () => {
  it('responde sin requerir conexiones externas', async () => {
    const response = await request(createApp()).get('/api/health')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      status: 'ok',
      service: 'senda-ops-api',
      supabase: 'pending',
    })
  })
})

import express from 'express'
import request from 'supertest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createRequireAuth, type AuthenticatedRequest } from './auth.js'

function appWithAuth(client: SupabaseClient) {
  const app = express()
  app.get(
    '/protected',
    createRequireAuth(() => client),
    (req, res) => res.json({ userId: (req as AuthenticatedRequest).user.id }),
  )
  return app
}

describe('middleware de autenticación', () => {
  it('rechaza solicitudes sin Bearer token', async () => {
    const response = await request(appWithAuth({} as SupabaseClient)).get('/protected')
    expect(response.status).toBe(401)
  })

  it('rechaza tokens inválidos', async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: new Error('invalid token'),
    })
    const client = { auth: { getUser } } as unknown as SupabaseClient

    const response = await request(appWithAuth(client))
      .get('/protected')
      .set('Authorization', 'Bearer token-invalido')

    expect(response.status).toBe(401)
    expect(getUser).toHaveBeenCalledWith('token-invalido')
  })

  it('adjunta el usuario validado a la request', async () => {
    const client = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1' } },
          error: null,
        }),
      },
    } as unknown as SupabaseClient

    const response = await request(appWithAuth(client))
      .get('/protected')
      .set('Authorization', 'Bearer token-valido')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ userId: 'user-1' })
  })
})

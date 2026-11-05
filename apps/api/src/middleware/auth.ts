import type { NextFunction, Request, Response } from 'express'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createSupabaseUserClient } from '../lib/supabase.js'

export type AuthenticatedRequest = Request & {
  user: User
  supabase: SupabaseClient
}

export type UserClientFactory = (accessToken: string) => SupabaseClient

function bearerToken(request: Request): string | null {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

export function createRequireAuth(
  createClient: UserClientFactory = createSupabaseUserClient,
) {
  return async function requireAuth(request: Request, response: Response, next: NextFunction) {
    const token = bearerToken(request)
    if (!token) {
      response.status(401).json({ error: 'No autenticado.' })
      return
    }

    try {
      const supabase = createClient(token)
      const { data, error } = await supabase.auth.getUser(token)

      if (error || !data.user) {
        response.status(401).json({ error: 'Token inválido o vencido.' })
        return
      }

      const authenticated = request as AuthenticatedRequest
      authenticated.user = data.user
      authenticated.supabase = supabase
      next()
    } catch {
      response.status(401).json({ error: 'No se pudo validar la sesión.' })
    }
  }
}

export const requireAuth = createRequireAuth()

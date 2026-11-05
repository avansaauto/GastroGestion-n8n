import { describe, expect, it } from 'vitest'
import {
  LISTEN_HOST,
  PUBLIC_WEB_ORIGIN,
  corsAllowedOrigins,
  listenPort,
  missingProductionEnv,
} from './runtimeConfig.js'

describe('runtime Railway', () => {
  it('escucha en todas las interfaces', () => {
    expect(LISTEN_HOST).toBe('0.0.0.0')
  })

  it('permite gastrogest.app y no agrega localhost en producción', () => {
    expect(corsAllowedOrigins({
      NODE_ENV: 'production',
      FRONT_URL: 'https://gastrogest.app',
    })).toEqual(['https://gastrogest.app'])
    expect(corsAllowedOrigins({ NODE_ENV: 'production' })).toEqual([PUBLIC_WEB_ORIGIN])
    expect(corsAllowedOrigins({ NODE_ENV: 'development' })).toContain('http://localhost:5173')
    expect(corsAllowedOrigins({})).not.toContain('https://api.gastrogest.app')
  })

  it('lista solo los nombres de variables obligatorias que faltan', () => {
    expect(missingProductionEnv({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: '',
      INTEGRATION_AUTH_PEPPER: '  ',
    })).toEqual(['SUPABASE_SERVICE_ROLE_KEY', 'INTEGRATION_AUTH_PEPPER'])
  })

  it('usa PORT de Railway', () => {
    expect(listenPort({ PORT: '8080' })).toBe(8080)
    expect(listenPort({})).toBe(3001)
    expect(() => listenPort({ PORT: 'no' })).toThrow(/PORT/)
  })
})

/** Origen público del frontend. No es la URL de la API. */
export const PUBLIC_WEB_ORIGIN = 'https://gastrogest.app'

const REQUIRED_PRODUCTION_ENV = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'INTEGRATION_AUTH_PEPPER',
] as const

export function corsAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = String(env.FRONT_URL ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const origins = new Set(configured)
  origins.add(PUBLIC_WEB_ORIGIN)
  if (env.NODE_ENV !== 'production') origins.add('http://localhost:5173')
  return [...origins]
}

export function missingProductionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_PRODUCTION_ENV.filter((name) => !String(env[name] ?? '').trim())
}

export function listenPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.PORT ?? '').trim()
  const port = Number(raw || 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT inválido.')
  }
  return port
}

export const LISTEN_HOST = '0.0.0.0'

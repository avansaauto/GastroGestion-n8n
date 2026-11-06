import type { Location, Organization } from '@/lib/api'
import { hasActiveAuthorizedScope } from '@/lib/authorizedScope'

export const LOCATION_GATE_PATH = '/entrar'

export function safeReturnPath(next: string | null | undefined) {
  const raw = (next ?? '').trim()
  if (!raw) return '/'
  let value = raw
  try {
    value = decodeURIComponent(raw)
  } catch {
    return '/'
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) return '/'
  const path = value.split('?')[0] ?? '/'
  if (path === LOCATION_GATE_PATH || path.startsWith(`${LOCATION_GATE_PATH}/`)) return '/'
  return value
}

export function locationGateRedirect(pathname: string, search = '') {
  const current = `${pathname}${search}`
  if (pathname === LOCATION_GATE_PATH) return LOCATION_GATE_PATH
  const next = safeReturnPath(current)
  return `${LOCATION_GATE_PATH}?next=${encodeURIComponent(next)}`
}

export function organizationChangePath(pathname: string, search = '') {
  const next = encodeURIComponent(safeReturnPath(`${pathname}${search}`))
  return `${LOCATION_GATE_PATH}?cambiar=organizacion&next=${next}`
}

export function isOrganizationChangeRequest(search: string | null | undefined) {
  const params = new URLSearchParams((search ?? '').replace(/^\?/, ''))
  return params.get('cambiar') === 'organizacion'
}

export function needsLocationGate(input: {
  previewMode: boolean
  organizations: Organization[]
  locations: Location[]
  organizationId: string
  locationId: string
  loading?: boolean
  error?: string
}) {
  if (input.previewMode) return false
  if (input.loading) return false
  if (input.error) return true
  return !hasActiveAuthorizedScope(input)
}

/** Qué muestra el shell después de autenticar, sin adelantar la puerta de local. */
export function scopeShell(input: {
  previewMode: boolean
  loading: boolean
  error?: string
  organizations: Organization[]
  locations: Location[]
  organizationId: string
  locationId: string
}): 'boot' | 'gate' | 'app' {
  if (input.previewMode) return 'app'
  if (input.loading) return 'boot'
  if (needsLocationGate(input)) return 'gate'
  return 'app'
}

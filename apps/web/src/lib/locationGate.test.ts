import { describe, expect, it } from 'vitest'
import type { Location, Organization } from '@/lib/api'
import { hasActiveAuthorizedScope } from '@/lib/authorizedScope'
import {
  LOCATION_GATE_PATH,
  isOrganizationChangeRequest,
  locationGateRedirect,
  needsLocationGate,
  organizationChangePath,
  safeReturnPath,
} from './locationGate'

const OGHAM: Organization = { id: 'org-ogham', name: 'Ogham' }
const OTHER: Organization = { id: 'org-other', name: 'Otra' }
const CHINO: Location = { id: 'loc-chino', organization_id: 'org-ogham', name: 'Barrio Chino' }
const CASA: Location = { id: 'loc-casa', organization_id: 'org-ogham', name: 'Casa Central' }

const ready = {
  previewMode: false,
  organizations: [OGHAM],
  locations: [CHINO],
  organizationId: 'org-ogham',
  locationId: 'loc-chino',
}

describe('puerta de local', () => {
  it('deja entrar con un único local válido', () => {
    expect(hasActiveAuthorizedScope(ready)).toBe(true)
    expect(needsLocationGate(ready)).toBe(false)
  })

  it('pide selección si hay varios locales y ninguno activo', () => {
    expect(needsLocationGate({
      ...ready,
      locations: [CHINO, CASA],
      locationId: '',
    })).toBe(true)
    expect(hasActiveAuthorizedScope({
      ...ready,
      locations: [CHINO, CASA],
      locationId: '',
    })).toBe(false)
  })

  it('pide organización si hay varias y ninguna activa', () => {
    expect(needsLocationGate({
      previewMode: false,
      organizations: [OGHAM, OTHER],
      locations: [],
      organizationId: '',
      locationId: '',
    })).toBe(true)
  })

  it('restaura una preferencia válida y rechaza una revocada', () => {
    expect(hasActiveAuthorizedScope(ready)).toBe(true)
    expect(hasActiveAuthorizedScope({
      ...ready,
      locations: [CASA],
      locationId: 'loc-chino',
    })).toBe(false)
    expect(needsLocationGate({
      ...ready,
      locations: [CASA, CHINO].slice(0, 1),
      locationId: 'loc-chino',
    })).toBe(true)
  })

  it('exige selección sin organizaciones o sin locales', () => {
    expect(needsLocationGate({
      previewMode: false,
      organizations: [],
      locations: [],
      organizationId: '',
      locationId: '',
    })).toBe(true)
    expect(needsLocationGate({
      ...ready,
      locations: [],
      locationId: '',
    })).toBe(true)
  })

  it('no omite la selección con una navegación directa a una ruta operativa', () => {
    expect(locationGateRedirect('/inventario')).toBe(`${LOCATION_GATE_PATH}?next=${encodeURIComponent('/inventario')}`)
    expect(locationGateRedirect('/facturas/nueva')).toBe(`${LOCATION_GATE_PATH}?next=${encodeURIComponent('/facturas/nueva')}`)
    expect(locationGateRedirect(LOCATION_GATE_PATH, '?next=/inventario')).toBe(LOCATION_GATE_PATH)
  })

  it('conserva el destino original y evita bucles o redirecciones abiertas', () => {
    expect(safeReturnPath('/inventario')).toBe('/inventario')
    expect(safeReturnPath('/facturas/recepciones-pendientes')).toBe('/facturas/recepciones-pendientes')
    expect(safeReturnPath(LOCATION_GATE_PATH)).toBe('/')
    expect(safeReturnPath(`${LOCATION_GATE_PATH}?next=/inventario`)).toBe('/')
    expect(safeReturnPath('https://evil.example')).toBe('/')
    expect(safeReturnPath('//evil.example')).toBe('/')
    expect(safeReturnPath('')).toBe('/')
  })

  it('vuelve a la puerta si el usuario pierde el local o cambia de usuario', () => {
    expect(needsLocationGate({
      ...ready,
      organizations: [],
      locations: [],
      organizationId: '',
      locationId: '',
    })).toBe(true)
    expect(needsLocationGate({
      previewMode: false,
      organizations: [OTHER],
      locations: [],
      organizationId: 'org-ogham',
      locationId: 'loc-chino',
    })).toBe(true)
  })

  it('no bloquea el modo vista previa', () => {
    expect(needsLocationGate({ ...ready, previewMode: true, organizationId: '', locationId: '' })).toBe(false)
  })

  it('reusa /entrar para cambiar de organización', () => {
    expect(organizationChangePath('/inventario')).toBe(
      `${LOCATION_GATE_PATH}?cambiar=organizacion&next=${encodeURIComponent('/inventario')}`,
    )
    expect(isOrganizationChangeRequest('cambiar=organizacion&next=%2Finventario')).toBe(true)
    expect(isOrganizationChangeRequest('next=%2Finventario')).toBe(false)
  })
})

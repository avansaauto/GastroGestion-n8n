import { describe, expect, it, vi } from 'vitest'
import type { Location, Organization } from '@/lib/api'
import {
  AuthorizedScopeSession,
  authorizedScopeEmpty,
  authorizedScopeReducer,
  EMPTY_AUTHORIZED_SCOPE,
  isAuthorizedLocation,
  isAuthorizedOrganization,
  locationsForOrganization,
  memoryScopeStorage,
  readScopePreference,
  resolveAuthorizedId,
  scopePreferenceKey,
  writeScopePreference,
} from './authorizedScope'

const OGHAM: Organization = { id: 'org-ogham', name: 'Ogham' }
const OTHER_ORG: Organization = { id: 'org-other', name: 'Otra' }
const BARRIO_CHINO: Location = { id: 'loc-chino', organization_id: 'org-ogham', name: 'Barrio Chino' }
const CASA_CENTRAL: Location = { id: 'loc-casa', organization_id: 'org-ogham', name: 'Casa Central' }
const OTHER_LOC: Location = { id: 'loc-other', organization_id: 'org-other', name: 'Sucursal Norte' }
const FOREIGN_LOC: Location = { id: 'loc-foreign', organization_id: 'org-other', name: 'Ajeno' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function sessionWith(
  organizations: Organization[] | (() => Promise<Organization[]>),
  locations: Location[] | ((organizationId: string) => Promise<Location[]>),
  storage = memoryScopeStorage(),
) {
  const getOrganizations = typeof organizations === 'function'
    ? organizations
    : vi.fn().mockResolvedValue(organizations)
  const getLocations = typeof locations === 'function'
    ? locations
    : vi.fn().mockImplementation(async (organizationId: string) => (
      locations.filter((location) => location.organization_id === organizationId)
    ))
  const session = new AuthorizedScopeSession({ getOrganizations, getLocations, storage })
  return { session, getOrganizations, getLocations, storage }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('El alcance no terminó de resolverse.')
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('resolución autorizada', () => {
  it('autoelige solo cuando hay un id', () => {
    expect(resolveAuthorizedId(['org-ogham'], undefined, true)).toBe('org-ogham')
    expect(resolveAuthorizedId(['org-ogham', 'org-other'], undefined, true)).toBe('')
    expect(resolveAuthorizedId(['org-ogham', 'org-other'], 'org-other', true)).toBe('org-other')
    expect(resolveAuthorizedId(['org-ogham'], 'inexistente', true)).toBe('org-ogham')
    expect(resolveAuthorizedId([], 'org-ogham', true)).toBe('')
  })

  it('no mezcla locales de otra organización', () => {
    expect(locationsForOrganization([BARRIO_CHINO, FOREIGN_LOC], 'org-ogham')).toEqual([BARRIO_CHINO])
    expect(isAuthorizedOrganization([OGHAM], 'org-other')).toBe(false)
    expect(isAuthorizedLocation([BARRIO_CHINO], 'loc-chino', 'org-ogham')).toBe(true)
    expect(isAuthorizedLocation([BARRIO_CHINO], 'loc-chino', 'org-other')).toBe(false)
  })
})

describe('AuthorizedScopeSession', () => {
  it('selecciona automáticamente una organización y un local', async () => {
    const { session } = sessionWith([OGHAM], [BARRIO_CHINO])
    session.setUser('user-1')
    await waitFor(() => session.state.locationId === 'loc-chino')
    expect(session.state.organizationId).toBe('org-ogham')
    expect(session.state.locationId).toBe('loc-chino')
    expect(authorizedScopeEmpty(session.state)).toBe(null)
  })

  it('no asume el primer local si hay varios', async () => {
    const { session } = sessionWith([OGHAM], [BARRIO_CHINO, CASA_CENTRAL])
    session.setUser('user-1')
    await waitFor(() => session.state.organizationId === 'org-ogham' && !session.state.loading)
    expect(session.state.organizationId).toBe('org-ogham')
    expect(session.state.locationId).toBe('')
    expect(session.state.locations.map((row) => row.id)).toEqual(['loc-chino', 'loc-casa'])
    expect(authorizedScopeEmpty(session.state)).toBe('location_unselected')
  })

  it('no asume la primera organización si hay varias', async () => {
    const { session } = sessionWith([OGHAM, OTHER_ORG], [BARRIO_CHINO, OTHER_LOC])
    session.setUser('user-1')
    await waitFor(() => !session.state.loading)
    expect(session.state.organizationId).toBe('')
    expect(session.state.locationId).toBe('')
    expect(session.state.locations).toEqual([])
    expect(authorizedScopeEmpty(session.state)).toBe('organization_unselected')
  })

  it('expone vacío explícito sin organizaciones', async () => {
    const { session } = sessionWith([], [])
    session.setUser('user-1')
    await waitFor(() => !session.state.loading)
    expect(session.state.organizations).toEqual([])
    expect(authorizedScopeEmpty(session.state)).toBe('no_organizations')
  })

  it('expone vacío explícito si la organización no tiene locales', async () => {
    const { session } = sessionWith([OGHAM], [])
    session.setUser('user-1')
    await waitFor(() => session.state.organizationId === 'org-ogham' && !session.state.loading)
    expect(session.state.organizationId).toBe('org-ogham')
    expect(session.state.locations).toEqual([])
    expect(authorizedScopeEmpty(session.state)).toBe('no_locations')
  })

  it('invalida el local al cambiar de organización', async () => {
    const storage = memoryScopeStorage()
    writeScopePreference('user-1', {
      organizationId: 'org-ogham',
      locationByOrganization: { 'org-ogham': 'loc-chino' },
    }, storage)
    const { session } = sessionWith([OGHAM, OTHER_ORG], [BARRIO_CHINO, OTHER_LOC], storage)
    session.setUser('user-1')
    await settle()
    expect(session.state).toMatchObject({ organizationId: 'org-ogham', locationId: 'loc-chino' })

    expect(session.selectOrganization('org-other')).toBe(true)
    expect(session.state.organizationId).toBe('org-other')
    expect(session.state.locationId).toBe('')
    expect(session.state.locations).toEqual([])
    await settle()
    expect(session.state).toMatchObject({ organizationId: 'org-other', locationId: 'loc-other' })
  })

  it('no elige otro local si el preferido dejó de estar autorizado y hay varios', async () => {
    const storage = memoryScopeStorage()
    writeScopePreference('user-1', {
      organizationId: 'org-ogham',
      locationByOrganization: { 'org-ogham': 'loc-chino' },
    }, storage)
    const { session } = sessionWith(
      [OGHAM],
      [{ id: 'loc-a', organization_id: 'org-ogham', name: 'A' }, { id: 'loc-b', organization_id: 'org-ogham', name: 'B' }],
      storage,
    )
    session.setUser('user-1')
    await waitFor(() => !session.state.loading)
    expect(session.state.locationId).toBe('')
    expect(session.selectLocation('loc-chino')).toBe(false)
  })

  it('descarta un local que dejó de estar autorizado', async () => {
    const storage = memoryScopeStorage()
    writeScopePreference('user-1', {
      organizationId: 'org-ogham',
      locationByOrganization: { 'org-ogham': 'loc-chino' },
    }, storage)
    const { session } = sessionWith([OGHAM], [CASA_CENTRAL], storage)
    session.setUser('user-1')
    await settle()
    expect(session.state.locationId).toBe('loc-casa')
    expect(session.selectLocation('loc-chino')).toBe(false)
    expect(readScopePreference('user-1', storage)?.locationByOrganization['org-ogham']).toBe('loc-casa')
  })

  it('limpia el contexto al cerrar sesión y no mezcla usuarios', async () => {
    const storage = memoryScopeStorage()
    const { session, getOrganizations } = sessionWith([OGHAM], [BARRIO_CHINO], storage)
    const organizations = getOrganizations as ReturnType<typeof vi.fn>
    session.setUser('user-a')
    await settle()
    expect(session.state.organizationId).toBe('org-ogham')
    expect(readScopePreference('user-a', storage)?.organizationId).toBe('org-ogham')

    session.setUser(null)
    expect(session.state).toMatchObject({
      organizations: [],
      locations: [],
      organizationId: '',
      locationId: '',
    })
    expect(readScopePreference('user-a', storage)?.organizationId).toBe('org-ogham')

    organizations.mockResolvedValueOnce([OTHER_ORG])
    session.setUser('user-b')
    await settle()
    expect(session.state.organizationId).toBe('org-other')
    expect(session.state.locationId).toBe('')
    expect(readScopePreference('user-b', storage)?.organizationId).toBe('org-other')
    expect(readScopePreference('user-a', storage)?.organizationId).toBe('org-ogham')
  })

  it('conserva el error y permite reintentar', async () => {
    const getOrganizations = vi.fn()
      .mockRejectedValueOnce(new Error('No se pudieron consultar las organizaciones.'))
      .mockResolvedValueOnce([OGHAM])
    const getLocations = vi.fn().mockResolvedValue([BARRIO_CHINO])
    const session = new AuthorizedScopeSession({
      getOrganizations,
      getLocations,
      storage: memoryScopeStorage(),
    })
    session.setUser('user-1')
    await settle()
    expect(session.state.error).toBe('No se pudieron consultar las organizaciones.')
    expect(session.state.organizationId).toBe('')
    await session.reload()
    expect(session.state.error).toBe('')
    expect(session.state).toMatchObject({ organizationId: 'org-ogham', locationId: 'loc-chino' })
  })

  it('ignora locales de una organización anterior que llegan tarde', async () => {
    const orgs = deferred<Organization[]>()
    const first = deferred<Location[]>()
    const second = deferred<Location[]>()
    let locationCalls = 0
    const session = new AuthorizedScopeSession({
      getOrganizations: () => orgs.promise,
      getLocations: () => {
        locationCalls += 1
        return locationCalls === 1 ? first.promise : second.promise
      },
      storage: memoryScopeStorage(),
    })
    session.setUser('user-1')
    orgs.resolve([OGHAM, OTHER_ORG])
    await settle()
    expect(session.selectOrganization('org-ogham')).toBe(true)
    expect(session.selectOrganization('org-other')).toBe(true)
    expect(session.state.locationId).toBe('')
    expect(session.state.locations).toEqual([])

    first.resolve([BARRIO_CHINO])
    await settle()
    expect(session.state.organizationId).toBe('org-other')
    expect(session.state.locations).toEqual([])
    expect(session.state.locationId).toBe('')

    second.resolve([OTHER_LOC])
    await settle()
    expect(session.state.locations).toEqual([OTHER_LOC])
    expect(session.state.locationId).toBe('loc-other')
  })

  it('ignora organizaciones de una recarga anterior', async () => {
    const first = deferred<Organization[]>()
    const second = deferred<Organization[]>()
    let calls = 0
    const session = new AuthorizedScopeSession({
      getOrganizations: () => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
      },
      getLocations: async () => [BARRIO_CHINO],
      storage: memoryScopeStorage(),
    })
    session.setUser('user-1')
    void session.reload()
    first.resolve([OTHER_ORG])
    await settle()
    expect(session.state.organizations).toEqual([])
    second.resolve([OGHAM])
    await settle()
    expect(session.state.organizations).toEqual([OGHAM])
    expect(session.state.organizationId).toBe('org-ogham')
  })

  it('rechaza IDs arbitrarios y no los persiste', async () => {
    const { session, storage } = sessionWith([OGHAM], [BARRIO_CHINO, CASA_CENTRAL])
    session.setUser('user-1')
    await settle()
    expect(session.selectOrganization('org-inventada')).toBe(false)
    expect(session.selectLocation('loc-inventada')).toBe(false)
    expect(session.state.organizationId).toBe('org-ogham')
    expect(session.selectLocation('loc-casa')).toBe(true)
    const saved = readScopePreference('user-1', storage)
    expect(saved?.organizationId).toBe('org-ogham')
    expect(saved?.locationByOrganization['org-ogham']).toBe('loc-casa')
    expect(JSON.stringify(saved)).not.toMatch(/password|token|secret/i)
    expect(scopePreferenceKey('user-1')).toContain('user-1')
  })

  it('filtra un local ajeno aunque la API lo devuelva', async () => {
    const { session } = sessionWith([OGHAM], async () => [BARRIO_CHINO, FOREIGN_LOC])
    session.setUser('user-1')
    await settle()
    expect(session.state.locations).toEqual([BARRIO_CHINO])
    expect(session.state.locationId).toBe('loc-chino')
  })
})

describe('reducer de alcance', () => {
  it('no aplica locales si la generación o la organización no coinciden', () => {
    const selected = authorizedScopeReducer(
      { ...EMPTY_AUTHORIZED_SCOPE, organizations: [OGHAM, OTHER_ORG], organizationId: 'org-other', locationGeneration: 4 },
      {
        type: 'LOCS_LOADED',
        generation: 3,
        organizationId: 'org-ogham',
        locations: [BARRIO_CHINO],
      },
    )
    expect(selected.locations).toEqual([])
    expect(selected.locationId).toBe('')
    expect(selected.organizationId).toBe('org-other')
  })
})

import type { Location, Organization } from '@/lib/api'

export type AuthorizedScopeEmpty =
  | 'no_organizations'
  | 'no_locations'
  | 'organization_unselected'
  | 'location_unselected'
  | null

export type ScopePreference = {
  organizationId: string
  locationByOrganization: Record<string, string>
}

export type ScopeStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type AuthorizedScopeState = {
  organizations: Organization[]
  locations: Location[]
  organizationId: string
  locationId: string
  loading: boolean
  error: string
  orgGeneration: number
  locationGeneration: number
}

export const EMPTY_AUTHORIZED_SCOPE: AuthorizedScopeState = {
  organizations: [],
  locations: [],
  organizationId: '',
  locationId: '',
  loading: false,
  error: '',
  orgGeneration: 0,
  locationGeneration: 0,
}

export const SCOPE_PREFERENCE_PREFIX = 'senda-ops.scope.v1:'

export type AuthorizedScopeAction =
  | { type: 'RESET'; orgGeneration: number; locationGeneration: number }
  | { type: 'ORGS_LOADING'; generation: number }
  | { type: 'ORGS_LOADED'; generation: number; organizations: Organization[]; preferredOrganizationId?: string }
  | { type: 'ORGS_FAILED'; generation: number; error: string }
  | { type: 'SELECT_ORG'; organizationId: string }
  | { type: 'LOCS_LOADING'; generation: number; organizationId: string }
  | {
      type: 'LOCS_LOADED'
      generation: number
      organizationId: string
      locations: Location[]
      preferredLocationId?: string
    }
  | { type: 'LOCS_FAILED'; generation: number; organizationId: string; error: string }
  | { type: 'SELECT_LOC'; locationId: string }

export function scopePreferenceKey(userId: string) {
  return `${SCOPE_PREFERENCE_PREFIX}${userId}`
}

export function memoryScopeStorage(initial: Record<string, string> = {}): ScopeStorage {
  const data = { ...initial }
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      data[key] = value
    },
    removeItem(key) {
      delete data[key]
    },
  }
}

export function browserScopeStorage(): ScopeStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* private mode */
  }
  return memoryScopeStorage()
}

export function readScopePreference(userId: string, storage: ScopeStorage): ScopePreference | null {
  if (!userId) return null
  const raw = storage.getItem(scopePreferenceKey(userId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ScopePreference>
    const organizationId = typeof parsed.organizationId === 'string' ? parsed.organizationId.trim() : ''
    const locationByOrganization: Record<string, string> = {}
    if (parsed.locationByOrganization && typeof parsed.locationByOrganization === 'object') {
      for (const [organization, locationId] of Object.entries(parsed.locationByOrganization)) {
        if (typeof locationId === 'string' && locationId.trim() && organization.trim()) {
          locationByOrganization[organization] = locationId.trim()
        }
      }
    }
    if (!organizationId && Object.keys(locationByOrganization).length === 0) return null
    return { organizationId, locationByOrganization }
  } catch {
    return null
  }
}

export function writeScopePreference(
  userId: string,
  preference: ScopePreference,
  storage: ScopeStorage,
) {
  if (!userId) return
  storage.setItem(scopePreferenceKey(userId), JSON.stringify(preference))
}

export function authorizedIds(items: Array<{ id?: string | null }>) {
  return items.map((item) => item.id?.trim() || '').filter(Boolean)
}

export function resolveAuthorizedId(
  availableIds: string[],
  preferredId: string | undefined,
  autoIfSingle: boolean,
) {
  const preferred = preferredId?.trim() || ''
  if (preferred && availableIds.includes(preferred)) return preferred
  if (autoIfSingle && availableIds.length === 1) return availableIds[0] ?? ''
  return ''
}

export function locationsForOrganization(locations: Location[], organizationId: string) {
  if (!organizationId) return []
  return locations.filter((location) => {
    const id = location.id?.trim()
    if (!id) return false
    const owner = location.organization_id?.trim()
    return !owner || owner === organizationId
  })
}

export function isAuthorizedOrganization(organizations: Organization[], organizationId: string) {
  const id = organizationId.trim()
  return Boolean(id) && organizations.some((organization) => organization.id === id)
}

export function isAuthorizedLocation(
  locations: Location[],
  locationId: string,
  organizationId: string,
) {
  const id = locationId.trim()
  if (!id || !organizationId) return false
  return locationsForOrganization(locations, organizationId).some((location) => location.id === id)
}

export function hasActiveAuthorizedScope(input: {
  organizationId: string
  locationId: string
  organizations: Organization[]
  locations: Location[]
}) {
  return isAuthorizedOrganization(input.organizations, input.organizationId)
    && isAuthorizedLocation(input.locations, input.locationId, input.organizationId)
}

export function authorizedScopeEmpty(state: AuthorizedScopeState): AuthorizedScopeEmpty {
  if (state.loading) return null
  if (state.organizations.length === 0) return 'no_organizations'
  if (!state.organizationId) return 'organization_unselected'
  if (state.locations.length === 0) return 'no_locations'
  if (!state.locationId) return 'location_unselected'
  return null
}

export function authorizedScopeReducer(
  state: AuthorizedScopeState,
  action: AuthorizedScopeAction,
): AuthorizedScopeState {
  switch (action.type) {
    case 'RESET':
      return {
        ...EMPTY_AUTHORIZED_SCOPE,
        orgGeneration: action.orgGeneration,
        locationGeneration: action.locationGeneration,
      }
    case 'ORGS_LOADING':
      return { ...state, loading: true, error: '', orgGeneration: action.generation }
    case 'ORGS_LOADED': {
      if (action.generation !== state.orgGeneration) return state
      const organizations = action.organizations.filter((organization) => Boolean(organization.id?.trim()))
      const organizationId = resolveAuthorizedId(
        authorizedIds(organizations),
        action.preferredOrganizationId,
        true,
      )
      const orgChanged = organizationId !== state.organizationId
      return {
        ...state,
        organizations,
        organizationId,
        locations: orgChanged ? [] : state.locations,
        locationId: orgChanged ? '' : state.locationId,
        loading: Boolean(organizationId),
        error: '',
        locationGeneration: orgChanged ? state.locationGeneration + 1 : state.locationGeneration,
      }
    }
    case 'ORGS_FAILED':
      if (action.generation !== state.orgGeneration) return state
      return { ...state, loading: false, error: action.error }
    case 'SELECT_ORG': {
      if (!isAuthorizedOrganization(state.organizations, action.organizationId)) return state
      if (action.organizationId === state.organizationId) return state
      return {
        ...state,
        organizationId: action.organizationId,
        locations: [],
        locationId: '',
        error: '',
        loading: true,
        locationGeneration: state.locationGeneration + 1,
      }
    }
    case 'LOCS_LOADING':
      if (action.organizationId !== state.organizationId) return state
      return { ...state, loading: true, error: '', locationGeneration: action.generation }
    case 'LOCS_LOADED': {
      if (action.generation !== state.locationGeneration) return state
      if (action.organizationId !== state.organizationId) return state
      const locations = locationsForOrganization(action.locations, action.organizationId)
      const locationId = resolveAuthorizedId(
        authorizedIds(locations),
        action.preferredLocationId,
        true,
      )
      return {
        ...state,
        locations,
        locationId,
        loading: false,
        error: '',
      }
    }
    case 'LOCS_FAILED':
      if (action.generation !== state.locationGeneration) return state
      if (action.organizationId !== state.organizationId) return state
      return { ...state, loading: false, error: action.error }
    case 'SELECT_LOC': {
      if (!isAuthorizedLocation(state.locations, action.locationId, state.organizationId)) return state
      return { ...state, locationId: action.locationId }
    }
  }
}

function errorMessage(reason: unknown) {
  return reason instanceof Error && reason.message
    ? reason.message
    : 'No se pudieron consultar las organizaciones y locales autorizados.'
}

export type AuthorizedScopeDeps = {
  getOrganizations: () => Promise<Organization[]>
  getLocations: (organizationId: string) => Promise<Location[]>
  storage: ScopeStorage
}

export class AuthorizedScopeSession {
  state: AuthorizedScopeState = EMPTY_AUTHORIZED_SCOPE
  private userId: string | null = null
  private orgGeneration = 0
  private locationGeneration = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: AuthorizedScopeDeps) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.state

  setUser(userId: string | null) {
    const next = userId?.trim() || null
    if (next === this.userId) return
    this.userId = next
    this.reset()
    if (next) void this.reload()
  }

  reset() {
    this.orgGeneration += 1
    this.locationGeneration += 1
    this.apply({
      type: 'RESET',
      orgGeneration: this.orgGeneration,
      locationGeneration: this.locationGeneration,
    })
  }

  selectOrganization(organizationId: string) {
    const current = this.state
    const next = authorizedScopeReducer(current, { type: 'SELECT_ORG', organizationId })
    if (next === current) return false
    this.locationGeneration = next.locationGeneration
    this.applyState(next)
    this.persist()
    void this.loadLocations(next.organizationId)
    return true
  }

  selectLocation(locationId: string) {
    const current = this.state
    const next = authorizedScopeReducer(current, { type: 'SELECT_LOC', locationId })
    if (next === current) return false
    this.applyState(next)
    this.persist()
    return true
  }

  async reload() {
    if (!this.userId) {
      this.reset()
      return
    }
    const generation = ++this.orgGeneration
    this.apply({ type: 'ORGS_LOADING', generation })
    try {
      const organizations = await this.deps.getOrganizations()
      if (generation !== this.orgGeneration) return
      const preferred = readScopePreference(this.userId, this.deps.storage)
      this.apply({
        type: 'ORGS_LOADED',
        generation,
        organizations,
        preferredOrganizationId: preferred?.organizationId,
      })
      if (this.state.organizationId) await this.loadLocations(this.state.organizationId)
      else this.persist()
    } catch (reason) {
      if (generation !== this.orgGeneration) return
      this.apply({ type: 'ORGS_FAILED', generation, error: errorMessage(reason) })
    }
  }

  private async loadLocations(organizationId: string) {
    if (!organizationId) return
    const generation = ++this.locationGeneration
    this.apply({ type: 'LOCS_LOADING', generation, organizationId })
    try {
      const locations = await this.deps.getLocations(organizationId)
      if (generation !== this.locationGeneration) return
      const preferred = this.userId
        ? readScopePreference(this.userId, this.deps.storage)?.locationByOrganization[organizationId]
        : undefined
      this.apply({
        type: 'LOCS_LOADED',
        generation,
        organizationId,
        locations,
        preferredLocationId: preferred,
      })
      this.persist()
    } catch (reason) {
      if (generation !== this.locationGeneration) return
      this.apply({
        type: 'LOCS_FAILED',
        generation,
        organizationId,
        error: errorMessage(reason),
      })
    }
  }

  private persist() {
    if (!this.userId) return
    const previous = readScopePreference(this.userId, this.deps.storage)
    const locationByOrganization = { ...(previous?.locationByOrganization ?? {}) }
    if (this.state.organizationId) {
      if (this.state.locationId) {
        locationByOrganization[this.state.organizationId] = this.state.locationId
      } else if (
        this.state.locationId === ''
        && this.state.locations.length > 0
        && !this.state.loading
      ) {
        delete locationByOrganization[this.state.organizationId]
      }
    }
    writeScopePreference(this.userId, {
      organizationId: this.state.organizationId,
      locationByOrganization,
    }, this.deps.storage)
  }

  private apply(action: AuthorizedScopeAction) {
    this.applyState(authorizedScopeReducer(this.state, action))
  }

  private applyState(next: AuthorizedScopeState) {
    this.state = next
    this.orgGeneration = next.orgGeneration
    this.locationGeneration = next.locationGeneration
    for (const listener of this.listeners) listener()
  }
}

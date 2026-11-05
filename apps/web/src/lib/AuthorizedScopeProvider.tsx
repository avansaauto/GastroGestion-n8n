import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { getLocations, getOrganizations, type Location, type Organization } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  AuthorizedScopeSession,
  authorizedScopeEmpty,
  browserScopeStorage,
  type AuthorizedScopeEmpty,
} from '@/lib/authorizedScope'

export type AuthorizedScopeContextValue = {
  organizations: Organization[]
  organization: Organization | null
  organizationId: string
  locations: Location[]
  location: Location | null
  locationId: string
  loading: boolean
  error: string
  empty: AuthorizedScopeEmpty
  selectOrganization: (organizationId: string) => boolean
  selectLocation: (locationId: string) => boolean
  reload: () => Promise<void>
}

export const AuthorizedScopeContext = createContext<AuthorizedScopeContextValue | null>(null)

export function AuthorizedScopeProvider({ children }: { children: ReactNode }) {
  const { user, previewMode } = useAuth()
  const userId = previewMode ? null : user?.id ?? null
  const sessionRef = useRef<AuthorizedScopeSession>()
  if (!sessionRef.current) {
    sessionRef.current = new AuthorizedScopeSession({
      getOrganizations,
      getLocations,
      storage: browserScopeStorage(),
    })
  }
  const session = sessionRef.current
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)

  useEffect(() => {
    session.setUser(userId)
  }, [session, userId])

  const value = useMemo<AuthorizedScopeContextValue>(() => ({
    organizations: state.organizations,
    organization: state.organizations.find((item) => item.id === state.organizationId) ?? null,
    organizationId: state.organizationId,
    locations: state.locations,
    location: state.locations.find((item) => item.id === state.locationId) ?? null,
    locationId: state.locationId,
    loading: state.loading,
    error: state.error,
    empty: authorizedScopeEmpty(state),
    selectOrganization: (organizationId) => session.selectOrganization(organizationId),
    selectLocation: (locationId) => session.selectLocation(locationId),
    reload: () => session.reload(),
  }), [session, state])

  return <AuthorizedScopeContext.Provider value={value}>{children}</AuthorizedScopeContext.Provider>
}

export function useAuthorizedScopeContext() {
  const context = useContext(AuthorizedScopeContext)
  if (!context) {
    throw new Error('useAuthorizedScopeContext debe usarse dentro de AuthorizedScopeProvider.')
  }
  return context
}

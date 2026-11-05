import { Loader2, LogOut, MapPin } from 'lucide-react'
import { useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { hasActiveAuthorizedScope, type AuthorizedScopeEmpty } from '@/lib/authorizedScope'
import { useAuth } from '@/lib/auth'
import { isOrganizationChangeRequest, LOCATION_GATE_PATH, safeReturnPath } from '@/lib/locationGate'
import { locationName, organizationName } from '@/lib/operations'
import type { Location, Organization } from '@/lib/api'

export function LocationGateView({
  loading,
  error,
  empty,
  organizations,
  organization,
  locations,
  forceOrganizationChoice = false,
  onSelectOrganization,
  onSelectLocation,
  onRetry,
  onSignOut,
}: {
  loading: boolean
  error: string
  empty: AuthorizedScopeEmpty
  organizations: Organization[]
  organization: Organization | null
  locations: Location[]
  forceOrganizationChoice?: boolean
  onSelectOrganization: (organizationId: string) => boolean
  onSelectLocation: (locationId: string) => boolean
  onRetry: () => void
  onSignOut: () => void
}) {
  const [choosingOrganization, setChoosingOrganization] = useState(forceOrganizationChoice || !organization)
  const showOrganizations = organizations.length > 1 && (choosingOrganization || !organization)
  const showLocations = Boolean(organization) && !showOrganizations && !loading

  return (
    <main className="grid min-h-screen place-items-center bg-senda-canvas px-5 py-8">
      <Card className="w-full max-w-lg p-7">
        <div className="mb-7 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img
              alt="GastroGest"
              className="h-11 w-11 rounded-xl object-contain"
              height={44}
              src="/Gastrogest_logo.png"
              width={44}
            />
            <div>
              <p className="m-0 text-lg font-extrabold tracking-tight">GastroGest</p>
              <p className="m-0 text-sm text-senda-muted">Operaciones gastronómicas</p>
            </div>
          </div>
          <Button aria-label="Cerrar sesión" className="px-3" variant="ghost" onClick={onSignOut}>
            <LogOut size={17} />
          </Button>
        </div>

        <h1 className="m-0 text-2xl font-bold">¿Con qué local querés trabajar?</h1>
        <p className="mb-0 mt-2 text-sm text-senda-muted">
          El local activo define facturas, recepciones y existencias. El catálogo de insumos sigue siendo de la organización.
        </p>

        {loading && (
          <div className="mt-8 flex items-center justify-center gap-2 text-sm text-senda-muted">
            <Loader2 className="animate-spin" size={19} /> Cargando locales autorizados…
          </div>
        )}

        {!loading && error && (
          <div className="mt-6 space-y-4">
            <p className="mb-0 text-sm text-red-700" role="alert">{error}</p>
            <Button onClick={onRetry} type="button">Reintentar</Button>
          </div>
        )}

        {!loading && !error && empty === 'no_organizations' && (
          <p className="mb-0 mt-6 text-sm text-senda-muted">
            No hay organizaciones disponibles para este usuario. Pedí acceso a un administrador de SENDA.
          </p>
        )}

        {!loading && !error && empty === 'no_locations' && organization && (
          <p className="mb-0 mt-6 text-sm text-senda-muted">
            {organizationName(organization)} no tiene locales autorizados para tu usuario.
          </p>
        )}

        {!loading && !error && showOrganizations && (
          <div className="mt-6 space-y-3">
            <p className="mb-0 text-xs font-semibold uppercase tracking-wide text-senda-muted">Organización</p>
            <div className="grid gap-2">
              {organizations.map((item) => (
                <button
                  className="rounded-xl border border-senda-border bg-white px-4 py-3 text-left transition hover:bg-senda-subtle focus:outline-none focus:ring-2 focus:ring-senda-navy"
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelectOrganization(item.id)
                    setChoosingOrganization(false)
                  }}
                >
                  <span className="block text-sm font-semibold">{organizationName(item)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!loading && !error && showLocations && organization && (
          <div className="mt-6 space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="mb-0 text-xs font-semibold uppercase tracking-wide text-senda-muted">Organización</p>
                <p className="mb-0 mt-1 text-sm font-semibold">{organizationName(organization)}</p>
              </div>
              {organizations.length > 1 && (
                <Button className="px-3 text-xs" variant="ghost" onClick={() => setChoosingOrganization(true)}>
                  Cambiar organización
                </Button>
              )}
            </div>
            <p className="mb-0 text-xs font-semibold uppercase tracking-wide text-senda-muted">Locales</p>
            <div className="grid gap-2">
              {locations.map((item) => (
                <button
                  className="flex items-center gap-3 rounded-xl border border-senda-border bg-white px-4 py-3 text-left transition hover:bg-senda-subtle focus:outline-none focus:ring-2 focus:ring-senda-navy"
                  key={item.id}
                  type="button"
                  onClick={() => onSelectLocation(item.id)}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-senda-subtle text-senda-navy">
                    <MapPin size={16} />
                  </span>
                  <span className="block text-sm font-semibold">{locationName(item)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>
    </main>
  )
}

export function LocationGatePage() {
  const scope = useAuthorizedScopeContext()
  const { signOut } = useAuth()
  const [params] = useSearchParams()
  const next = safeReturnPath(params.get('next'))
  const [pickingOrganization, setPickingOrganization] = useState(() => isOrganizationChangeRequest(params.toString()))

  if (hasActiveAuthorizedScope(scope) && !pickingOrganization) {
    return <Navigate replace to={next === LOCATION_GATE_PATH ? '/' : next} />
  }

  return (
    <LocationGateView
      empty={scope.empty}
      error={scope.error}
      forceOrganizationChoice={pickingOrganization}
      loading={scope.loading}
      locations={scope.locations}
      organization={scope.organization}
      organizations={scope.organizations}
      onRetry={() => void scope.reload()}
      onSelectLocation={(locationId) => {
        const selected = scope.selectLocation(locationId)
        if (selected) setPickingOrganization(false)
        return selected
      }}
      onSelectOrganization={(organizationId) => {
        const selected = scope.selectOrganization(organizationId)
        setPickingOrganization(false)
        return selected
      }}
      onSignOut={() => void signOut()}
    />
  )
}

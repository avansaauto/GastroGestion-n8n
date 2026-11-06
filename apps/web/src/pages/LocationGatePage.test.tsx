import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { Location, Organization } from '@/lib/api'
import { LocationGateView } from './LocationGatePage'
import { HeaderLocationSwitcher } from '@/components/layout/Header'

const OGHAM: Organization = { id: 'org-ogham', name: 'Ogham' }
const OTHER: Organization = { id: 'org-other', name: 'Otra' }
const CHINO: Location = { id: 'loc-chino', organization_id: 'org-ogham', name: 'Barrio Chino' }
const CASA: Location = { id: 'loc-casa', organization_id: 'org-ogham', name: 'Casa Central' }

function renderGate(overrides: Partial<Parameters<typeof LocationGateView>[0]> = {}) {
  return renderToString(
    <MemoryRouter>
      <LocationGateView
        empty={null}
        error=""
        loading={false}
        locations={[]}
        organization={null}
        organizations={[]}
        onRetry={() => undefined}
        onSelectLocation={() => false}
        onSelectOrganization={() => false}
        onSignOut={() => undefined}
        {...overrides}
      />
    </MemoryRouter>,
  )
}

describe('pantalla de selección de local', () => {
  it('muestra carga mientras resuelve el alcance', () => {
    const html = renderGate({ loading: true })
    expect(html).toContain('Preparando tu local')
    expect(html).not.toContain('¿Con qué local querés trabajar?')
    expect(html).not.toContain('Barrio Chino')
  })

  it('pide elegir entre varios locales y no asume el primero', () => {
    const html = renderGate({
      empty: 'location_unselected',
      organization: OGHAM,
      organizations: [OGHAM],
      locations: [CHINO, CASA],
    })
    expect(html).toContain('¿Con qué local querés trabajar?')
    expect(html).toContain('Ogham')
    expect(html).toContain('Barrio Chino')
    expect(html).toContain('Casa Central')
    expect(html).toContain('type="button"')
    expect(html).not.toContain('org-ogham')
    expect(html.indexOf('Barrio Chino')).toBeLessThan(html.indexOf('Casa Central'))
  })

  it('pide organización cuando hay varias y ninguna está activa', () => {
    const html = renderGate({
      empty: 'organization_unselected',
      organizations: [OGHAM, OTHER],
    })
    expect(html).toContain('Ogham')
    expect(html).toContain('Otra')
    expect(html).not.toContain('Barrio Chino')
  })

  it('muestra vacío sin organizaciones y sin locales', () => {
    expect(renderGate({ empty: 'no_organizations' })).toContain('No hay organizaciones disponibles')
    expect(renderGate({
      empty: 'no_locations',
      organization: OGHAM,
      organizations: [OGHAM],
    })).toContain('no tiene locales autorizados')
  })

  it('muestra error de API y reintento', () => {
    const html = renderGate({ error: 'No se pudieron consultar las organizaciones.' })
    expect(html).toContain('No se pudieron consultar las organizaciones.')
    expect(html).toContain('Reintentar')
    expect(html).toContain('Cerrar sesión')
  })

  it('conserva logout en la puerta', () => {
    expect(renderGate({ empty: 'no_organizations' })).toContain('Cerrar sesión')
  })

  it('vuelve al flujo de /entrar para cambiar de organización', () => {
    const html = renderGate({
      empty: 'organization_unselected',
      forceOrganizationChoice: true,
      organization: OGHAM,
      organizations: [OGHAM, OTHER],
      locations: [CHINO, CASA],
    })
    expect(html).toContain('Ogham')
    expect(html).toContain('Otra')
    expect(html).not.toContain('Barrio Chino')
  })
})

describe('encabezado de sucursal', () => {
  it('muestra un único local sin desplegable', () => {
    const html = renderToString(
      <MemoryRouter>
        <HeaderLocationSwitcher
          location={CHINO}
          locations={[CHINO]}
          organization={OGHAM}
          organizationChangeHref="/entrar?cambiar=organizacion"
          organizations={[OGHAM]}
          onSelectLocation={() => false}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('Barrio Chino')
    expect(html).toContain('Ogham')
    expect(html).not.toContain('listbox')
    expect(html).not.toContain('Cambiar local')
    expect(html).not.toContain('org-ogham')
    expect(html).not.toContain('loc-chino')
  })

  it('lista locales autorizados, marca el actual y permite cambiar de organización', () => {
    const html = renderToString(
      <MemoryRouter>
        <HeaderLocationSwitcher
          location={CHINO}
          locations={[CHINO, CASA]}
          open
          organization={OGHAM}
          organizationChangeHref="/entrar?cambiar=organizacion&next=%2Finventario"
          organizations={[OGHAM, OTHER]}
          onSelectLocation={() => true}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('role="listbox"')
    expect(html).toContain('role="option"')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Barrio Chino')
    expect(html).toContain('Casa Central')
    expect(html).toContain('Actual')
    expect(html).toContain('Cambiar organización')
    expect(html).toContain('/entrar?cambiar=organizacion')
    expect(html).not.toContain('loc-chino')
  })
})

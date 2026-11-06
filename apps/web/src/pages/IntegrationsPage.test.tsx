import { readFileSync } from 'node:fs'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import { AuthProvider } from '@/lib/auth'

const getLocationIntegrations = vi.fn()

vi.mock('@/lib/integrationsApi', () => ({
  getLocationIntegrations: (...args: unknown[]) => getLocationIntegrations(...args),
  connectFudo: vi.fn(),
  updateFudoCredentials: vi.fn(),
  testFudoConnection: vi.fn(),
  disconnectFudo: vi.fn(),
  syncFudoCatalog: vi.fn(),
}))

import { IntegrationsPage } from './IntegrationsPage'

describe('pantalla de integraciones', () => {
  beforeEach(() => {
    getLocationIntegrations.mockReset()
    getLocationIntegrations.mockResolvedValue({
      providers: [
        { id: 'fudo', name: 'Fudo', availability: 'available', summary: 'Catálogo.' },
        { id: 'maxirest', name: 'Maxirest', availability: 'soon', summary: 'Próximamente.' },
        { id: 'bistrosoft', name: 'Bistrosoft', availability: 'soon', summary: 'Próximamente.' },
      ],
      fudo: {
        provider: 'fudo',
        status: 'disconnected',
        organizationId: 'org',
        locationId: 'loc',
        organizationName: 'OGHAM',
        locationName: 'Barrio Chino',
        keyLast4: null,
        lastConnectionOkAt: null,
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        productCount: 179,
        canManage: true,
        jobId: null,
      },
    })
  })

  it('ofrece conectar Fudo y no persiste secretos en el navegador', () => {
    const page = readFileSync(new URL('./IntegrationsPage.tsx', import.meta.url), 'utf8')
    const client = readFileSync(new URL('../lib/integrationsApi.ts', import.meta.url), 'utf8')
    expect(page).not.toContain('localStorage')
    expect(client).not.toContain('localStorage')
    const html = renderToString(
      <MemoryRouter>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <IntegrationsPage />
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('Conectá tu sistema gastronómico')
    expect(html).toContain('Fudo')
    expect(html).toContain('Maxirest')
    expect(html).toContain('Bistrosoft')
    expect(html).toContain('Elegí una organización y un local')
    expect(html).not.toContain('value="')
  })
})

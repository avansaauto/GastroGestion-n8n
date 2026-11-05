import { describe, expect, it, vi } from 'vitest'
import {
  authenticateIntegration,
  FUDO_CATALOG_SYNC_SCOPE,
  hashIntegrationSecret,
  INVOICE_INGEST_SCOPE,
  IntegrationAuthError,
  isHumanPrincipal,
  isIntegrationPrincipal,
  userIdFromActor,
} from './integrationAuth.js'
import type {
  HumanPrincipal,
  IntegrationCredentialRecord,
  IntegrationCredentialRepository,
} from './integrationAuth.js'

const PEPPER = 'test-integration-pepper'
const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const OTHER_SECRET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'
const ID = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const LOCATION = '33333333-3333-4333-8333-333333333333'
const OTHER_ORG = '44444444-4444-4444-8444-444444444444'
const OTHER_LOCATION = '55555555-5555-4555-8555-555555555555'
const NOW = new Date('2026-10-20T12:00:00.000Z')

function record(overrides: Partial<IntegrationCredentialRecord> = {}): IntegrationCredentialRecord {
  return {
    id: ID,
    secretHash: hashIntegrationSecret(SECRET, PEPPER),
    organizationId: ORG,
    locationId: LOCATION,
    scopes: [INVOICE_INGEST_SCOPE],
    status: 'active',
    expiresAt: null,
    ...overrides,
  }
}

function repository(rows: IntegrationCredentialRecord[]): IntegrationCredentialRepository {
  return {
    findById: async (credentialId) => rows.find((row) => row.id === credentialId) ?? null,
  }
}

function authenticate(
  overrides: Partial<Parameters<typeof authenticateIntegration>[0]> = {},
  rows: IntegrationCredentialRecord[] = [record()],
) {
  return authenticateIntegration({
    authorizationHeader: `Bearer snd_${ID}.${SECRET}`,
    body: {},
    pepper: PEPPER,
    repository: repository(rows),
    now: NOW,
    requiredScope: INVOICE_INGEST_SCOPE,
    ...overrides,
  })
}

describe('autenticación de integraciones', () => {
  it('acepta una credencial activa y devuelve el destino guardado', async () => {
    const findById = vi.fn(async (credentialId: string) => {
      expect(credentialId).toBe(ID)
      expect(credentialId).not.toBe(SECRET)
      return record()
    })

    const principal = await authenticate({ repository: { findById } })

    expect(principal).toEqual({
      kind: 'integration',
      integrationId: ID,
      organizationId: ORG,
      locationId: LOCATION,
      scopes: ['invoices.ingest'],
    })
    expect(record().secretHash).not.toBe(SECRET)
    expect(record().secretHash).toHaveLength(64)
    expect(findById).toHaveBeenCalledOnce()
  })

  it('rechaza un encabezado malformado', async () => {
    const headers = [
      undefined,
      '',
      'snd_' + ID + '.' + SECRET,
      'bearer snd_' + ID + '.' + SECRET,
      'Bearer ' + SECRET,
      'Bearer snd_' + ID,
      'Bearer snd_not-a-uuid.' + SECRET,
      'Bearer snd_' + ID + '.short',
      'Bearer snd_' + ID + '.' + SECRET + '.extra',
      'Bearer  snd_' + ID + '.' + SECRET,
    ]

    for (const authorizationHeader of headers) {
      await expect(authenticate({ authorizationHeader })).rejects.toMatchObject({
        name: 'IntegrationAuthError',
        code: 'MALFORMED',
        status: 401,
      })
    }
  })

  it('rechaza un secreto incorrecto', async () => {
    await expect(authenticate({
      authorizationHeader: `Bearer snd_${ID}.${OTHER_SECRET}`,
    })).rejects.toMatchObject({ code: 'SECRET_MISMATCH', status: 401 })

    await expect(authenticate({ pepper: 'otro-pepper' })).rejects.toMatchObject({
      code: 'SECRET_MISMATCH',
      status: 401,
    })
  })

  it('rechaza una credencial inexistente', async () => {
    const missing = '66666666-6666-4666-8666-666666666666'
    await expect(authenticate({
      authorizationHeader: `Bearer snd_${missing}.${SECRET}`,
      repository: repository([]),
    })).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND', status: 401 })
  })

  it('rechaza una credencial revocada', async () => {
    await expect(authenticate({}, [record({ status: 'revoked' })])).rejects.toMatchObject({
      code: 'REVOKED',
      status: 401,
    })
  })

  it('rechaza una credencial vencida', async () => {
    await expect(authenticate({}, [
      record({ expiresAt: '2026-10-20T12:00:00.000Z' }),
    ])).rejects.toMatchObject({ code: 'EXPIRED', status: 401 })

    await expect(authenticate({}, [
      record({ expiresAt: '2026-10-19T00:00:00.000Z' }),
    ])).rejects.toMatchObject({ code: 'EXPIRED', status: 401 })
  })

  it('rechaza un alcance distinto al requerido', async () => {
    await expect(authenticate({}, [record({ scopes: ['invoices.read'] })])).rejects.toMatchObject({
      code: 'SCOPE_DENIED',
      status: 403,
    })
    await expect(authenticate({}, [record({ scopes: [] })])).rejects.toMatchObject({
      code: 'SCOPE_DENIED',
      status: 403,
    })
    await expect(authenticate(
      { requiredScope: FUDO_CATALOG_SYNC_SCOPE },
      [record({ scopes: [INVOICE_INGEST_SCOPE] })],
    )).rejects.toMatchObject({ code: 'SCOPE_DENIED', status: 403 })
  })

  it('acepta fudo.catalog.sync cuando la credencial lo declara', async () => {
    const principal = await authenticate(
      { requiredScope: FUDO_CATALOG_SYNC_SCOPE },
      [record({ scopes: [FUDO_CATALOG_SYNC_SCOPE] })],
    )
    expect(principal.scopes).toEqual([FUDO_CATALOG_SYNC_SCOPE])
    expect(principal.organizationId).toBe(ORG)
    expect(principal.locationId).toBe(LOCATION)
  })

  it('permite varios alcances si incluye el requerido', async () => {
    const principal = await authenticate({}, [
      record({ scopes: [INVOICE_INGEST_SCOPE, FUDO_CATALOG_SYNC_SCOPE] }),
    ])
    expect(principal.scopes).toContain(INVOICE_INGEST_SCOPE)
  })

  it('rechaza una organización enviada por el cliente', async () => {
    const bodies = [
      { organizationId: OTHER_ORG },
      { organization_id: ORG },
      { document: { organizationId: OTHER_ORG } },
    ]
    for (const body of bodies) {
      await expect(authenticate({ body })).rejects.toMatchObject({
        code: 'CLIENT_DESTINATION',
        status: 400,
      })
    }
  })

  it('rechaza una sucursal enviada por el cliente', async () => {
    const bodies = [
      { locationId: OTHER_LOCATION },
      { location_id: LOCATION },
      { lines: [{ locationId: OTHER_LOCATION }] },
    ]
    for (const body of bodies) {
      await expect(authenticate({ body })).rejects.toMatchObject({
        code: 'CLIENT_DESTINATION',
        status: 400,
      })
    }
  })

  it('rechaza actor_user_id y actor_integration_id enviados por el cliente', async () => {
    const bodies = [
      { actor_user_id: '99999999-9999-4999-8999-999999999999' },
      { actorUserId: '99999999-9999-4999-8999-999999999999' },
      { actor_integration_id: ID },
      { actorIntegrationId: ID },
      { userId: 'user-1' },
      { user_id: 'user-1' },
    ]
    for (const body of bodies) {
      await expect(authenticate({ body })).rejects.toMatchObject({
        code: 'CLIENT_DESTINATION',
        status: 400,
      })
    }
  })

  it('no incluye el secreto en el error', async () => {
    const samples = [
      authenticate({ authorizationHeader: `Bearer snd_${ID}.${OTHER_SECRET}` }),
      authenticate({ authorizationHeader: `Bearer snd_not-a-uuid.${SECRET}` }),
      authenticate({ authorizationHeader: `Bearer snd_${ID}.${SECRET}`, body: { organizationId: OTHER_ORG } }),
    ]

    for (const attempt of samples) {
      await expect(attempt).rejects.toBeInstanceOf(IntegrationAuthError)
      try {
        await attempt
      } catch (error) {
        const failure = error as IntegrationAuthError
        const published = JSON.stringify({
          name: failure.name,
          message: failure.message,
          code: failure.code,
          status: failure.status,
        })
        expect(published).not.toContain(SECRET)
        expect(published).not.toContain(OTHER_SECRET)
        expect(published).not.toContain(PEPPER)
        expect(failure.message).not.toContain('snd_')
      }
    }
  })

  it('no trata una integración como usuario', async () => {
    const principal = await authenticate()
    const human: HumanPrincipal = { kind: 'user', userId: 'user-1' }

    expect(isIntegrationPrincipal(principal)).toBe(true)
    expect(isHumanPrincipal(principal)).toBe(false)
    expect(principal).not.toHaveProperty('userId')
    expect(isIntegrationPrincipal(human)).toBe(false)
    expect(userIdFromActor(human)).toBe('user-1')
    expect(() => userIdFromActor(principal)).toThrow(IntegrationAuthError)
    expect(() => userIdFromActor(principal)).toThrow(
      expect.objectContaining({ code: 'NOT_A_USER', status: 403 }),
    )
  })
})

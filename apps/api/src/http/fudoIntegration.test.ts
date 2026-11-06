import { randomBytes } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { FudoClientError, parseFudoProductPage, safeFudoNextUrl } from './fudoClient.js'
import {
  connectFudoIntegration,
  createMemoryFudoStore,
  disconnectFudoIntegration,
  getFudoIntegrationView,
  requestFudoCatalogSync,
  runFudoSyncJob,
  type LocationAccess,
} from './fudoIntegration.js'
import {
  decryptProviderSecret,
  encryptProviderSecret,
  decodeProviderCredentialsKey,
} from './providerSecretCipher.js'
import { FUDO_CATALOG_SYNC_SCOPE, FUDO_SYNC_RUN_SCOPE, type IntegrationPrincipal } from './integrationAuth.js'
import { createFudoIntegrationRouter } from '../routes/fudoIntegration.js'

const KEY = decodeProviderCredentialsKey(randomBytes(32).toString('base64'))
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const API_KEY = 'fudo-api-key-ogham-179'
const API_SECRET = 'fudo-api-secret-not-for-logs'

function access(role: string | null, memberStatus = 'active', locationId = LOCATION): LocationAccess {
  return {
    organizationId: ORG,
    locationId,
    organizationName: 'OGHAM',
    locationName: 'Barrio Chino',
    role,
    memberStatus,
  }
}

function catalogAdmin() {
  const rows = new Map<string, { name: string; active: boolean }>()
  const tables: string[] = []
  const admin = {
    rows,
    tables,
    from(table: string) {
      tables.push(table)
      if (table !== 'fudo_product_catalog') throw new Error(`tabla inesperada ${table}`)
      return {
        upsert(data: Array<Record<string, string | boolean>>) {
          for (const row of data) {
            rows.set(String(row.external_product_id), {
              name: String(row.name),
              active: row.active === true,
            })
          }
          return Promise.resolve({ error: null })
        },
        select() {
          return {
            eq: () => ({
              eq: () => ({
                eq: () => Promise.resolve({
                  data: [...rows.entries()]
                    .filter(([, row]) => row.active)
                    .map(([id]) => ({ external_product_id: id })),
                  error: null,
                }),
              }),
            }),
          }
        },
        update() {
          return {
            eq: () => ({
              eq: () => ({
                in: (_column: string, ids: string[]) => {
                  for (const id of ids) {
                    const row = rows.get(id)
                    if (row) row.active = false
                  }
                  return Promise.resolve({ error: null })
                },
              }),
            }),
          }
        },
      }
    },
  }
  return admin
}

describe('cifrado de credenciales de proveedor', () => {
  it('recupera el secreto y el texto cifrado no lo contiene', () => {
    const encrypted = encryptProviderSecret(API_SECRET, KEY)
    expect(encrypted).not.toContain(API_SECRET)
    expect(decryptProviderSecret(encrypted, KEY)).toBe(API_SECRET)
    expect(() => decryptProviderSecret(encrypted, decodeProviderCredentialsKey(randomBytes(32).toString('base64')))).toThrow(/CIPHER_INVALID/)
  })
})

describe('integración Fudo por local', () => {
  it('un operador no puede conectar y no guarda nada', async () => {
    const store = createMemoryFudoStore({ access: access('operator') })
    await expect(connectFudoIntegration(
      { store, credentialsKey: KEY, testCredentials: async () => undefined },
      USER,
      LOCATION,
      { apiKey: API_KEY, apiSecret: API_SECRET },
    )).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(store.integrations).toHaveLength(0)
  })

  it('un miembro de otra organización no consulta ni modifica', async () => {
    const store = createMemoryFudoStore({ access: access('admin', 'inactive') })
    await expect(getFudoIntegrationView(
      { store, credentialsKey: KEY },
      USER,
      OTHER,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(connectFudoIntegration(
      { store, credentialsKey: KEY, testCredentials: async () => undefined },
      USER,
      OTHER,
      { apiKey: API_KEY, apiSecret: API_SECRET },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(store.integrations).toHaveLength(0)
  })

  it('no guarda credenciales inválidas', async () => {
    const store = createMemoryFudoStore({ access: access('admin') })
    await expect(connectFudoIntegration(
      {
        store,
        credentialsKey: KEY,
        testCredentials: async () => {
          throw new FudoClientError('Fudo rechazó las credenciales.', 'INVALID_CREDENTIALS', 422)
        },
      },
      USER,
      LOCATION,
      { apiKey: API_KEY, apiSecret: API_SECRET },
    )).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 422 })
    expect(store.integrations).toHaveLength(0)
  })

  it('guarda, actualiza y no devuelve secretos', async () => {
    const store = createMemoryFudoStore({ access: access('admin'), catalogCount: 179 })
    const first = await connectFudoIntegration(
      { store, credentialsKey: KEY, testCredentials: async () => undefined },
      USER,
      LOCATION,
      { apiKey: API_KEY, apiSecret: API_SECRET },
    )
    expect(first.status).toBe('connected')
    expect(first.productCount).toBe(179)
    expect(first.keyLast4).toBe('-179')
    expect(JSON.stringify(first)).not.toContain(API_SECRET)
    expect(JSON.stringify(first)).not.toContain(API_KEY)
    const updated = await connectFudoIntegration(
      { store, credentialsKey: KEY, testCredentials: async () => undefined },
      USER,
      LOCATION,
      { apiKey: 'fudo-api-key-replaced', apiSecret: 'fudo-api-secret-replaced' },
    )
    expect(store.integrations).toHaveLength(1)
    expect(updated.keyLast4).toBe('aced')
    expect(store.integrations[0]?.apiSecretCiphertext).not.toContain('fudo-api-secret-replaced')
    expect(decryptProviderSecret(store.integrations[0]?.apiSecretCiphertext ?? '', KEY)).toBe('fudo-api-secret-replaced')
  })

  it('desconectar borra secretos y conserva el catálogo', async () => {
    const store = createMemoryFudoStore({ access: access('admin'), catalogCount: 179 })
    await connectFudoIntegration(
      { store, credentialsKey: KEY, testCredentials: async () => undefined },
      USER,
      LOCATION,
      { apiKey: API_KEY, apiSecret: API_SECRET },
    )
    const view = await disconnectFudoIntegration(
      { store, credentialsKey: KEY },
      USER,
      LOCATION,
    )
    expect(view.status).toBe('disconnected')
    expect(view.productCount).toBe(179)
    expect(store.integrations[0]?.apiKeyCiphertext).toBeNull()
    expect(store.integrations[0]?.apiSecretCiphertext).toBeNull()
    expect(store.catalogDeletes).toBe(0)
  })

  it('sincroniza dos veces sin duplicar y no toca otra tabla', async () => {
    const store = createMemoryFudoStore({ access: access('admin'), catalogCount: 179 })
    await connectFudoIntegration(
      { store, credentialsKey: KEY, testCredentials: async () => undefined },
      USER,
      LOCATION,
      { apiKey: API_KEY, apiSecret: API_SECRET },
    )
    const admin = catalogAdmin()
    const products = [
      { externalProductId: '17', name: 'American IPA', active: true },
      { externalProductId: '60', name: 'fernet', active: true },
    ]
    const deps = {
      store,
      credentialsKey: KEY,
      admin: admin as never,
      pullCatalog: async () => ({ products, complete: true }),
    }
    const first = await requestFudoCatalogSync(deps, USER, LOCATION)
    const second = await requestFudoCatalogSync(deps, USER, LOCATION)
    expect(first.upserted).toBe(2)
    expect(second.upserted).toBe(2)
    expect(admin.rows.size).toBe(2)
    expect(admin.tables.every((table) => table === 'fudo_product_catalog')).toBe(true)
    expect(JSON.stringify(second)).not.toContain(API_SECRET)
  })

  it('no desactiva productos si el catálogo llega incompleto', async () => {
    const store = createMemoryFudoStore({ access: access('admin') })
    await connectFudoIntegration(
      { store, credentialsKey: KEY, testCredentials: async () => undefined },
      USER,
      LOCATION,
      { apiKey: API_KEY, apiSecret: API_SECRET },
    )
    const admin = catalogAdmin()
    admin.rows.set('17', { name: 'American IPA', active: true })
    await expect(requestFudoCatalogSync({
      store,
      credentialsKey: KEY,
      admin: admin as never,
      pullCatalog: async () => ({ products: [], complete: false }),
    }, USER, LOCATION)).rejects.toMatchObject({ code: 'INCOMPLETE_CATALOG' })
    expect(admin.rows.get('17')?.active).toBe(true)
  })

  it('una credencial de otro local no ejecuta el trabajo', async () => {
    const store = createMemoryFudoStore({ access: access('admin'), catalogCount: 179 })
    await connectFudoIntegration(
      { store, credentialsKey: KEY, testCredentials: async () => undefined },
      USER,
      LOCATION,
      { apiKey: API_KEY, apiSecret: API_SECRET },
    )
    const queued = await requestFudoCatalogSync({
      store,
      credentialsKey: KEY,
      webhookUrl: 'https://n8n.example/webhook/fudo',
      notifyWebhook: async (body) => {
        expect(body).not.toHaveProperty('apiKey')
        expect(body).not.toHaveProperty('apiSecret')
        expect(JSON.stringify(body)).not.toContain(API_SECRET)
      },
    }, USER, LOCATION)
    const foreign: IntegrationPrincipal = {
      kind: 'integration',
      integrationId: 'snd-ogham',
      organizationId: ORG,
      locationId: OTHER,
      scopes: [FUDO_CATALOG_SYNC_SCOPE],
    }
    await expect(runFudoSyncJob(
      { store, credentialsKey: KEY, admin: catalogAdmin() as never },
      foreign,
      queued.jobId,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('el alcance fudo.sync.run ejecuta el local del trabajo sin recibir secretos', async () => {
    const store = createMemoryFudoStore({ access: access('admin', 'active', OTHER) })
    await connectFudoIntegration(
      { store, credentialsKey: KEY, testCredentials: async () => undefined },
      USER,
      OTHER,
      { apiKey: API_KEY, apiSecret: API_SECRET },
    )
    const queued = await requestFudoCatalogSync({
      store,
      credentialsKey: KEY,
      notifyWebhook: async () => undefined,
      webhookUrl: 'https://n8n.example/webhook/fudo',
    }, USER, OTHER)
    const admin = catalogAdmin()
    const result = await runFudoSyncJob({
      store,
      credentialsKey: KEY,
      admin: admin as never,
      pullCatalog: async () => ({
        products: [{ externalProductId: '90', name: 'Agua', active: true }],
        complete: true,
      }),
    }, {
      kind: 'integration',
      integrationId: 'platform',
      organizationId: ORG,
      locationId: LOCATION,
      scopes: [FUDO_SYNC_RUN_SCOPE],
    }, queued.jobId)
    expect(result.locationId).toBe(OTHER)
    expect(result.status).toBe('succeeded')
    expect(admin.rows.has('90')).toBe(true)
    expect(JSON.stringify(result)).not.toContain(API_SECRET)
  })
})

describe('parser del catálogo Fudo', () => {
  it('lee JSON:API y rechaza un next fuera de api.fu.do', () => {
    const page = parseFudoProductPage({
      data: [{ id: '17', attributes: { name: 'American IPA', active: true } }],
      links: { next: 'https://evil.example/products' },
    })
    expect(page.products).toEqual([{ externalProductId: '17', name: 'American IPA', active: true }])
    expect(page.nextUrl).toBeNull()
    expect(safeFudoNextUrl('https://api.fu.do/v1alpha1/products?page[number]=2')).toContain('api.fu.do')
  })
})

describe('rutas de integración', () => {
  it('exige sesión y no filtra el secreto en la respuesta', async () => {
    const anonymous = await request(express().use('/api', createFudoIntegrationRouter()))
      .post(`/api/locations/${LOCATION}/integrations/fudo`)
      .send({ apiKey: API_KEY, apiSecret: API_SECRET })
    expect(anonymous.status).toBe(401)
    expect(JSON.stringify(anonymous.body)).not.toContain(API_SECRET)

    const store = createMemoryFudoStore({ access: access('admin'), catalogCount: 179 })
    const app = express()
    app.use(express.json())
    app.use('/api', createFudoIntegrationRouter({
      auth: (req, _res, next) => {
        ;(req as { user?: { id: string } }).user = { id: USER }
        next()
      },
      depsFor: () => ({
        store,
        credentialsKey: KEY,
        testCredentials: async () => undefined,
      }),
    }))
    const response = await request(app)
      .post(`/api/locations/${LOCATION}/integrations/fudo`)
      .send({ apiKey: API_KEY, apiSecret: API_SECRET })
    expect(response.status).toBe(200)
    expect(response.body.data.productCount).toBe(179)
    expect(JSON.stringify(response.body)).not.toContain(API_SECRET)
    expect(JSON.stringify(response.body)).not.toContain(API_KEY)
  })
})

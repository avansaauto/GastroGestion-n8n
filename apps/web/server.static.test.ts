import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, resolveWebPath, WEB_LISTEN_HOST, webListenPort } from './server.mjs'

let server: Server | null = null
let distDir = ''

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve())
    })
    server = null
  }
  if (distDir) await rm(distDir, { recursive: true, force: true })
  distDir = ''
})

function listen(instance: Server) {
  return new Promise<number>((resolve) => {
    instance.listen(0, '127.0.0.1', () => {
      const address = instance.address()
      if (!address || typeof address === 'string') throw new Error('Puerto no disponible.')
      resolve(address.port)
    })
  })
}

function fetchPath(port: number, path: string) {
  return new Promise<{ status: number; body: string; type: string | undefined }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          type: response.headers['content-type'],
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('servidor estático del frontend', () => {
  it('exige PORT y escucha en 0.0.0.0', () => {
    expect(WEB_LISTEN_HOST).toBe('0.0.0.0')
    expect(webListenPort({ PORT: '4173' })).toBe(4173)
    expect(() => webListenPort({ PORT: '' })).toThrow(/PORT inválido/)
  })

  it('sirve el bundle y cae a index.html en rutas de React Router', async () => {
    distDir = await mkdtemp(join(tmpdir(), 'gastrogest-web-'))
    await mkdir(join(distDir, 'assets'))
    await writeFile(join(distDir, 'index.html'), '<div id="root">GastroGest</div>')
    await writeFile(join(distDir, 'assets', 'app.js'), 'console.log("app")')
    server = createWebServer(distDir)
    const port = await listen(server)

    const home = await fetchPath(port, '/')
    const route = await fetchPath(port, '/inventario')
    const asset = await fetchPath(port, '/assets/app.js')
    const missing = await fetchPath(port, '/assets/missing.js')

    expect(home.status).toBe(200)
    expect(home.body).toContain('GastroGest')
    expect(route.status).toBe(200)
    expect(route.body).toContain('GastroGest')
    expect(route.type).toContain('text/html')
    expect(asset.status).toBe(200)
    expect(asset.body).toContain('console.log')
    expect(missing.status).toBe(404)
    expect(resolveWebPath(distDir, '/%2e%2e%2f%2e%2e%2fetc/passwd')?.status).toBe(400)
  })
})

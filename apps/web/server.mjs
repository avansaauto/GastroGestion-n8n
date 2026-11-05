import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export const WEB_LISTEN_HOST = '0.0.0.0'

export function webListenPort(env = process.env) {
  const port = Number(String(env.PORT ?? '').trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT inválido.')
  }
  return port
}

function insideRoot(root, candidate) {
  const prefix = root.endsWith(sep) ? root : root + sep
  return candidate === root || candidate.startsWith(prefix)
}

export function resolveWebPath(rootDir, requestUrl) {
  const root = resolve(rootDir)
  let pathname = '/'
  try {
    pathname = new URL(requestUrl || '/', 'http://127.0.0.1').pathname
  } catch {
    return { status: 400 }
  }
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { status: 400 }
  }
  const absolute = resolve(root, decoded.replace(/^[/\\]+/, ''))
  if (!insideRoot(root, absolute)) return { status: 400 }
  return { absolute, extension: extname(decoded), root }
}

async function existingFile(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? path : null
  } catch {
    return null
  }
}

export function createWebServer(distDir) {
  const root = resolve(distDir)
  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }
    const located = resolveWebPath(root, request.url)
    if (located.status) {
      response.writeHead(located.status)
      response.end()
      return
    }
    let file = await existingFile(located.absolute)
    if (!file) {
      try {
        const info = await stat(located.absolute)
        if (info.isDirectory()) file = await existingFile(join(located.absolute, 'index.html'))
      } catch {
        file = null
      }
    }
    if (!file) {
      if (located.extension && located.extension !== '.html') {
        response.writeHead(404)
        response.end()
        return
      }
      file = await existingFile(join(root, 'index.html'))
    }
    if (!file) {
      response.writeHead(500)
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(file).pipe(response)
  })
}

function apiTargetDescription(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return 'VITE_API_URL vacío: el navegador usa el origen del frontend.'
  try {
    return `VITE_API_URL apunta a ${new URL(raw).host}`
  } catch {
    return 'VITE_API_URL no es una URL absoluta.'
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  let port
  try {
    port = webListenPort()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'PORT inválido.')
    process.exit(1)
  }
  const distDir = fileURLToPath(new URL('./dist', import.meta.url))
  const server = createWebServer(distDir)
  server.listen(port, WEB_LISTEN_HOST, () => {
    console.log(`web listening on ${WEB_LISTEN_HOST}:${port}`)
    console.log(apiTargetDescription(process.env.VITE_API_URL))
  })
}

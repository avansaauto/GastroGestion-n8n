import 'dotenv/config'
import { createApp } from './app.js'
import { LISTEN_HOST, listenPort, missingProductionEnv } from './http/runtimeConfig.js'
import { INVOICE_ANALYZE_HTTP_TIMEOUT_MS } from './routes/invoices.js'

if (process.env.NODE_ENV === 'production') {
  const missing = missingProductionEnv()
  if (missing.length > 0) {
    console.error(`[senda-ops-api] faltan variables: ${missing.join(', ')}`)
    process.exit(1)
  }
}

const port = listenPort()
const httpTimeoutMs = Number(process.env.INVOICE_ANALYZE_HTTP_TIMEOUT_MS)
const timeoutMs =
  Number.isFinite(httpTimeoutMs) && httpTimeoutMs > 0
    ? httpTimeoutMs
    : INVOICE_ANALYZE_HTTP_TIMEOUT_MS

const server = createApp().listen(port, LISTEN_HOST, () => {
  console.log(`[senda-ops-api] listening on ${LISTEN_HOST}:${port}`)
})
server.timeout = timeoutMs
server.headersTimeout = timeoutMs + 5_000
server.requestTimeout = timeoutMs

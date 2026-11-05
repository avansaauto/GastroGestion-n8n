#!/usr/bin/env node
/**
 * Probe de solo lectura: ¿acepta Fudo filter[createdAt] y filter[saleState]?
 *
 * Uso:
 *   FUDO_API_KEY=… FUDO_API_SECRET=… node n8n/probe-fudo-sales-filters.mjs
 *
 * Opcional:
 *   PILOT_START_ISO=2026-11-03T00:00:00Z
 *   PILOT_ALLOWED_SALE_STATES=CLOSED
 *
 * NO escribe en Fudo ni en SENDA. NO imprime apiKey/apiSecret/token.
 */
const AUTH_URL = 'https://auth.fu.do/api'
const SALES_URL = 'https://api.fu.do/v1alpha1/sales'

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Falta ${name}. No se puede probeear sin credenciales.`)
    process.exit(2)
  }
  return v
}

function redact(url) {
  return url
}

async function auth(apiKey, apiSecret) {
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey, apiSecret }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`auth_failed status=${res.status} body=${text.slice(0, 200)}`)
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('auth_invalid_json')
  }
  const token = json.token || json.access_token || json.data?.token
  if (!token) throw new Error('auth_missing_token')
  return token
}

async function getSales(token, params) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue
    qs.set(k, v)
  }
  const url = `${SALES_URL}?${qs.toString()}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  return {
    url: redact(url),
    status: res.status,
    ok: res.ok,
    bodyPreview: text.slice(0, 280),
    count: Array.isArray(json?.data) ? json.data.length : json?.data?.id ? 1 : null,
    sampleStates: summarizeStates(json),
  }
}

function summarizeStates(json) {
  const rows = Array.isArray(json?.data) ? json.data : json?.data?.id ? [json.data] : []
  const states = new Map()
  const fields = new Set()
  for (const row of rows.slice(0, 20)) {
    const a = row.attributes || {}
    for (const k of Object.keys(a)) {
      if (/state|status|cancel|created|closed|paid/i.test(k)) fields.add(k)
    }
    const st = a.saleState ?? a.sale_state ?? '(missing)'
    states.set(String(st), (states.get(String(st)) || 0) + 1)
  }
  return { attributeKeys: [...fields].sort(), saleStateCounts: Object.fromEntries(states) }
}

async function main() {
  const apiKey = requireEnv('FUDO_API_KEY')
  const apiSecret = requireEnv('FUDO_API_SECRET')
  const start = String(process.env.PILOT_START_ISO || '').trim()
  const states = String(process.env.PILOT_ALLOWED_SALE_STATES || 'CLOSED').trim()

  console.log('→ auth…')
  const token = await auth(apiKey, apiSecret)
  console.log('→ auth ok (token no impreso)')

  const baseline = await getSales(token, {
    'page[size]': '5',
    sort: '-createdAt',
  })
  console.log('\n[baseline] GET /sales page[size]=5 sort=-createdAt')
  console.log(JSON.stringify({ status: baseline.status, count: baseline.count, sample: baseline.sampleStates }, null, 2))

  const createdFilter = start ? `gte.${start}` : 'gte.2099-01-01T00:00:00Z'
  const createdProbe = await getSales(token, {
    'page[size]': '5',
    sort: '-createdAt',
    'filter[createdAt]': createdFilter,
  })
  console.log(`\n[createdAt] filter[createdAt]=${createdFilter}`)
  console.log(
    JSON.stringify(
      {
        status: createdProbe.status,
        ok: createdProbe.ok,
        count: createdProbe.count,
        accepted: createdProbe.ok,
        bodyPreview: createdProbe.ok ? undefined : createdProbe.bodyPreview,
      },
      null,
      2,
    ),
  )

  const stateProbe = await getSales(token, {
    'page[size]': '5',
    sort: '-createdAt',
    'filter[saleState]': `in.(${states})`,
  })
  console.log(`\n[saleState] filter[saleState]=in.(${states})`)
  console.log(
    JSON.stringify(
      {
        status: stateProbe.status,
        ok: stateProbe.ok,
        count: stateProbe.count,
        accepted: stateProbe.ok,
        sample: stateProbe.sampleStates,
        bodyPreview: stateProbe.ok ? undefined : stateProbe.bodyPreview,
      },
      null,
      2,
    ),
  )

  console.log('\n=== veredicto ===')
  console.log(
    JSON.stringify(
      {
        createdAt_filter_accepted: createdProbe.ok,
        saleState_filter_accepted: stateProbe.ok,
        enable_in_config: {
          FUDO_API_CREATED_AT_FILTER: createdProbe.ok,
          FUDO_API_SALE_STATE_FILTER: stateProbe.ok,
        },
        note: 'Aunque el API acepte filtros, Separar Ventas sigue filtrando en local (fail-closed).',
      },
      null,
      2,
    ),
  )

  if (!createdProbe.ok || !stateProbe.ok) process.exit(1)
}

main().catch((err) => {
  console.error('probe_failed', err.message || err)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * Parchea / regenera el workflow Fudo → evento de consumo (piloto seguro).
 *
 * Fuente preferida: el JSON sanitizado actual (idempotente).
 * Fallback: ~/Downloads/SENDA - Fudo Inventario copy.json
 *
 * NO activa el workflow. NO habilita el RPC. NO incluye secretos.
 * NO inventa PILOT_START_ISO: queda vacío hasta configuración manual.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, 'SENDA-Fudo-Inventario-sale-event.sanitized.json')
const README = join(__dirname, 'SENDA-Fudo-Inventario-sale-event.README.md')
const SRC_FALLBACK = '/home/senda/Downloads/SENDA - Fudo Inventario copy.json'

/** OGHAM Barrio Chino — única sucursal del piloto. */
export const LOCATION_ID = 'd8d78b7d-eec5-4e90-8f2d-98268a875d00'
export const LOCATION_NAME = 'OGHAM Barrio Chino'
export const OLD_LOCATION_PRUEBAS = '170ee5fa-6f8c-4a0f-830d-8322e76926f6'

const SUPABASE_URL = 'https://yuggbxudurkfjgsnvzkd.supabase.co'

/**
 * Config del piloto (Set node). Valores vacíos a propósito:
 * el operador debe completar PILOT_START_ISO / IDs antes del primer run.
 * FUDO_API_CREATED_AT_FILTER=false hasta que probe-fudo-sales-filters.mjs confirme.
 */
export const PILOT_DEFAULTS = {
  LOCATION_ID,
  LOCATION_NAME,
  PILOT_START_ISO: '',
  PILOT_DATE_FIELD: 'createdAt',
  PILOT_ALLOWED_SALE_STATES: 'CLOSED',
  PILOT_SINGLE_ITEM: true,
  PILOT_EXTERNAL_SALE_ID: '',
  PILOT_EXTERNAL_ITEM_ID: '',
  FUDO_API_CREATED_AT_FILTER: false,
  FUDO_API_SALE_STATE_FILTER: false,
}

const PREPARAR_EVENTO_JS = `
// SENDA — Preparar Evento Consumo (1 ítem Fudo → 1 RPC event)
// source_id = item_id (idempotencia). location = Config Piloto.

const cfg = $('Config Piloto').first().json;
const LOCATION_ID = String(cfg.LOCATION_ID || '').trim();
if (!LOCATION_ID) throw new Error('LOCATION_ID_REQUIRED');

const consumos = $('Calcular Consumo Multi').all().map(i => i.json);
const inventarios = $input.all().map(i => i.json);
const itemActual = String(consumos[0]?.item_id ?? '').trim();
const consumosItem = itemActual
  ? consumos.filter(c => String(c.item_id) === itemActual)
  : consumos;

const inventariosPorProducto = new Map();
for (const inv of inventarios) {
  if (inv.id && inv.inventory_product_id) {
    inventariosPorProducto.set(String(inv.inventory_product_id), inv);
  }
}

const porItem = new Map();

for (const c of consumosItem) {
  const itemId = String(c.item_id ?? '').trim();
  const ventaId = String(c.venta_id ?? '').trim();
  const productoId = String(c.producto_id ?? '').trim();
  const soldQty = Number(c.cantidad_vendida);
  const qty = Number(c.consumo_total);
  const productKey = String(c.inventory_product_id ?? '').trim();

  if (!itemId) throw new Error('MISSING_ITEM_ID');
  if (!ventaId) throw new Error('MISSING_SALE_ID');
  if (!productoId) throw new Error('MISSING_PRODUCT_ID');
  if (!Number.isFinite(soldQty) || soldQty <= 0) throw new Error('INVALID_SOLD_QUANTITY');
  if (!Number.isFinite(qty) || qty >= 0) throw new Error('INVALID_CONSUMPTION_QTY');
  if (!productKey) throw new Error('MISSING_INVENTORY_PRODUCT');

  const inv = inventariosPorProducto.get(productKey);
  if (!inv || !inv.id) throw new Error('INVENTORY_NOT_FOUND:' + productKey);
  if (String(inv.location_id) !== LOCATION_ID) {
    throw new Error('INVENTORY_LOCATION_MISMATCH');
  }

  let acc = porItem.get(itemId);
  if (!acc) {
    acc = {
      venta_id: ventaId,
      item_id: itemId,
      producto_id: productoId,
      producto: c.producto != null ? String(c.producto) : null,
      cantidad_vendida: soldQty,
      recipe_id: c.recipe_id != null ? String(c.recipe_id) : null,
      recipe_name: c.recipe_name != null ? String(c.recipe_name) : null,
      lines: new Map(),
    };
    porItem.set(itemId, acc);
  }

  const prev = acc.lines.get(inv.id) || 0;
  acc.lines.set(inv.id, prev + qty);
}

const eventos = [];
for (const acc of porItem.values()) {
  const lines = [...acc.lines.entries()].map(([location_inventory_id, quantity]) => ({
    location_inventory_id,
    quantity,
  }));
  if (lines.length === 0) throw new Error('EMPTY_LINES');

  eventos.push({
    json: {
      location_id: LOCATION_ID,
      source_type: 'fudo',
      source_id: acc.item_id,
      external_sale_id: acc.venta_id,
      external_item_id: acc.item_id,
      external_product_id: acc.producto_id,
      external_product_name: acc.producto,
      recipe_id: acc.recipe_id,
      recipe_name: acc.recipe_name,
      sold_quantity: acc.cantidad_vendida,
      sold_unit: 'unit',
      lines,
    },
  });
}

return eventos;
`.trim()

const CALCULAR_CONSUMO_JS = `
const venta = $('Cruzar Ventas y Recetas').item.json;
if (!venta?.recipe_id) return [];

const componentes = $input.all().map(item => item.json);
const componentesUnicos = new Map();
for (const componente of componentes) {
  if (componente.id && componente.recipe_id) {
    componentesUnicos.set(componente.id, componente);
  }
}

const resultados = [];
for (const componente of componentesUnicos.values()) {
  if (String(componente.recipe_id) !== String(venta.recipe_id)) continue;
  resultados.push({
    json: {
      venta_id: venta.venta_id,
      item_id: venta.item_id,
      producto_id: venta.producto_id,
      producto: venta.producto,
      cantidad_vendida: Number(venta.cantidad),
      recipe_id: venta.recipe_id,
      recipe_name: venta.recipe_name ?? venta.producto ?? null,
      inventory_product_id: componente.inventory_product_id,
      consumo_total: -Number(componente.quantity) * Number(venta.cantidad),
    },
  });
}
return resultados;
`.trim()

const CRUZAR_JS = `
const venta = $('Preparar Venta').item.json;
const recetas = $input.all().map(item => item.json);
const mapping =
  recetas.find(r =>
    r.recipe_id &&
    String(r.external_product_id) === String(venta.producto_id)
  ) ?? null;
const recipeId = mapping?.recipe_id ?? null;

return [{
  json: {
    ...venta,
    recipe_id: recipeId,
    recipe_name: mapping?.recipe_name ?? venta.producto ?? null,
    tiene_receta: recipeId !== null,
  },
}];
`.trim()

const SEPARAR_VENTAS_JS = `
// Piloto seguro: filtros locales fail-closed.
// Política fecha: PILOT_DATE_FIELD=createdAt → ventas abiertas antes del piloto
// y cerradas después QUEDAN FUERA (no se procesan históricas).
// Cursor incremental / schedule: NO activados.

const cfg = $('Config Piloto').first().json;
const LOCATION_ID = String(cfg.LOCATION_ID || '').trim();
const PILOT_START_ISO = String(cfg.PILOT_START_ISO || '').trim();
const DATE_FIELD = String(cfg.PILOT_DATE_FIELD || 'createdAt').trim() || 'createdAt';
const ALLOWED = String(cfg.PILOT_ALLOWED_SALE_STATES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const single =
  cfg.PILOT_SINGLE_ITEM === true ||
  String(cfg.PILOT_SINGLE_ITEM).toLowerCase() === 'true';
const SALE_ID = String(cfg.PILOT_EXTERNAL_SALE_ID || '').trim();
const ITEM_ID = String(cfg.PILOT_EXTERNAL_ITEM_ID || '').trim();

if (!LOCATION_ID) throw new Error('LOCATION_ID_REQUIRED');
if (single) {
  if (!SALE_ID || !ITEM_ID) throw new Error('PILOT_SINGLE_ITEM_REQUIRES_SALE_AND_ITEM_IDS');
} else if (!PILOT_START_ISO) {
  throw new Error('PILOT_START_ISO_REQUIRED');
}

const root = $input.first().json;
let data = [];
if (Array.isArray(root?.data)) data = root.data;
else if (root?.data?.id) data = [root.data];

const ventas = [];
for (const venta of data) {
  const id = String(venta.id ?? '');
  const attrs = venta.attributes || {};
  const created = attrs.createdAt || attrs.created_at || null;
  const closed = attrs.closedAt || attrs.closed_at || null;
  const saleState = attrs.saleState || attrs.sale_state || null;

  if (single) {
    if (id !== SALE_ID) continue;
  } else {
    const dateVal = DATE_FIELD === 'closedAt' ? closed : created;
    if (!dateVal || String(dateVal) < PILOT_START_ISO) continue;
    if (ALLOWED.length) {
      if (!saleState || !ALLOWED.includes(String(saleState))) continue;
    }
  }

  ventas.push({
    json: {
      venta_id: id,
      items: venta.relationships?.items?.data || [],
      created_at: created,
      closed_at: closed,
      sale_state: saleState,
      location_id: LOCATION_ID,
      pilot_external_item_id: single ? ITEM_ID : null,
    },
  });
}

if (single && ventas.length === 0) {
  throw new Error('PILOT_SALE_NOT_IN_RESPONSE:' + SALE_ID);
}

// Cursor incremental preparado (NO activar):
// const staticData = $getWorkflowStaticData('global');
// if (ventas.length) {
//   const newest = ventas.map(v => v.json.created_at).filter(Boolean).sort().at(-1);
//   if (newest) staticData.last_sale_created_at = newest;
// }

return ventas;
`.trim()

const SEPARAR_ITEMS_JS = `
const cfg = $('Config Piloto').first().json;
const single =
  cfg.PILOT_SINGLE_ITEM === true ||
  String(cfg.PILOT_SINGLE_ITEM).toLowerCase() === 'true';
const onlyItem = String(cfg.PILOT_EXTERNAL_ITEM_ID || '').trim();
const resultado = [];

for (const entrada of $input.all()) {
  const ventaId = entrada.json.venta_id;
  const items = entrada.json.items || [];
  for (const item of items) {
    const itemId = String(item.id ?? '');
    if (single && onlyItem && itemId !== onlyItem) continue;
    resultado.push({
      json: {
        venta_id: ventaId,
        item_id: itemId,
        location_id: entrada.json.location_id || cfg.LOCATION_ID,
        sale_state: entrada.json.sale_state ?? null,
        created_at: entrada.json.created_at ?? null,
        closed_at: entrada.json.closed_at ?? null,
      },
    });
  }
}

if (single && resultado.length === 0) {
  throw new Error('PILOT_ITEM_NOT_IN_SALE:' + onlyItem);
}

return resultado;
`.trim()

function nodeByName(wf, name) {
  const n = wf.nodes.find((x) => x.name === name)
  if (!n) throw new Error('Missing node: ' + name)
  return n
}

function ensureNode(wf, name, factory) {
  let n = wf.nodes.find((x) => x.name === name)
  if (!n) {
    n = factory()
    wf.nodes.push(n)
  }
  return n
}

function stripSecrets(value) {
  if (typeof value === 'string') {
    return value
      .replace(/sb_secret_[A-Za-z0-9_-]+/g, '{{$credentials.supabaseApi.serviceRoleKey}}')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '{{REDACTED_JWT}}')
  }
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = stripSecrets(v)
    return out
  }
  return value
}

function assignment(name, value, type) {
  return { id: randomUUID(), name, value, type }
}

function main() {
  const src = existsSync(OUT) ? OUT : SRC_FALLBACK
  if (!existsSync(src)) throw new Error('No workflow source at ' + src)
  const wf = JSON.parse(readFileSync(src, 'utf8'))

  wf.name = 'SENDA - Fudo Inventario (sale-event piloto)'
  wf.active = false
  if (!wf.id) wf.id = randomUUID()
  wf.versionId = randomUUID()
  wf.pinData = {}
  wf.meta = { ...(wf.meta || {}), templateCredsSetupCompleted: false, sanitized: true, pilotSafe: true }

  // --- Config Piloto (única fuente de LOCATION_ID / flags) ---
  const config = ensureNode(wf, 'Config Piloto', () => ({
    parameters: { assignments: { assignments: [] }, options: {} },
    id: randomUUID(),
    name: 'Config Piloto',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.5,
    position: [-520, 144],
  }))
  config.parameters.assignments = {
    assignments: [
      assignment('LOCATION_ID', PILOT_DEFAULTS.LOCATION_ID, 'string'),
      assignment('LOCATION_NAME', PILOT_DEFAULTS.LOCATION_NAME, 'string'),
      assignment('PILOT_START_ISO', PILOT_DEFAULTS.PILOT_START_ISO, 'string'),
      assignment('PILOT_DATE_FIELD', PILOT_DEFAULTS.PILOT_DATE_FIELD, 'string'),
      assignment('PILOT_ALLOWED_SALE_STATES', PILOT_DEFAULTS.PILOT_ALLOWED_SALE_STATES, 'string'),
      assignment('PILOT_SINGLE_ITEM', PILOT_DEFAULTS.PILOT_SINGLE_ITEM, 'boolean'),
      assignment('PILOT_EXTERNAL_SALE_ID', PILOT_DEFAULTS.PILOT_EXTERNAL_SALE_ID, 'string'),
      assignment('PILOT_EXTERNAL_ITEM_ID', PILOT_DEFAULTS.PILOT_EXTERNAL_ITEM_ID, 'string'),
      assignment('FUDO_API_CREATED_AT_FILTER', PILOT_DEFAULTS.FUDO_API_CREATED_AT_FILTER, 'boolean'),
      assignment('FUDO_API_SALE_STATE_FILTER', PILOT_DEFAULTS.FUDO_API_SALE_STATE_FILTER, 'boolean'),
    ],
  }
  config.notes =
    'Parámetros del piloto. Completar PILOT_START_ISO y, en modo single, sale/item ids. No inventar fechas. Filtros API off hasta probe.'
  config.notesInFlow = true

  // canceled: no usar Boolean(string) — Boolean("false") === true en JS
  const CANCELED_FROM_ATTR =
    "={{ (() => { const v = $json.data.attributes.canceled; if (typeof v === 'boolean') return v; const s = String(v ?? '').trim().toLowerCase(); return s === 'true' || s === '1'; })() }}"
  const CANCELED_FROM_ITEM =
    "={{ (() => { const v = $('Preparar Item').item.json.canceled; if (typeof v === 'boolean') return v; const s = String(v ?? '').trim().toLowerCase(); return s === 'true' || s === '1'; })() }}"

  // --- Preparar Item: canceled boolean ---
  const prepararItem = nodeByName(wf, 'Preparar Item')
  for (const a of prepararItem.parameters.assignments.assignments) {
    if (a.name === 'canceled') {
      a.type = 'boolean'
      a.value = CANCELED_FROM_ATTR
    }
  }

  // --- Preparar Venta: producto + canceled boolean ---
  const prepararVenta = nodeByName(wf, 'Preparar Venta')
  for (const a of prepararVenta.parameters.assignments.assignments) {
    if (a.name === '=producto') a.name = 'producto'
    if (a.name === 'canceled') {
      a.type = 'boolean'
      a.value = CANCELED_FROM_ITEM
    }
  }

  // --- ¿Item cancelado?: boolean equals true ---
  const cancelado = nodeByName(wf, '¿Item cancelado?')
  cancelado.parameters.conditions = {
    options: {
      caseSensitive: true,
      leftValue: '',
      typeValidation: 'loose',
      version: 2,
    },
    conditions: [
      {
        id: randomUUID(),
        leftValue: '={{ $json.canceled }}',
        rightValue: true,
        operator: { type: 'boolean', operation: 'equals' },
      },
    ],
    combinator: 'and',
  }

  // --- Deprecar Coca gate si existe ---
  const coca = wf.nodes.find((n) => /Coca Cola/i.test(n.name))
  if (coca && !coca.name.startsWith('DEPRECADO')) {
    coca.name = 'DEPRECADO - ¿Es Coca Cola Zero?'
    coca.notes = 'Fuera del flujo.'
    coca.notesInFlow = true
  }

  // --- Buscar Receta / Inventario: LOCATION_ID central ---
  const buscarReceta = nodeByName(wf, 'Buscar Receta SENDA')
  buscarReceta.parameters.tableId = 'sales_product_mappings'
  buscarReceta.parameters.matchType = 'allFilters'
  buscarReceta.parameters.filters = {
    conditions: [
      { keyName: 'external_product_id', condition: 'eq', keyValue: '={{ $json.producto_id }}' },
      { keyName: 'source', condition: 'eq', keyValue: 'fudo' },
      { keyName: 'location_id', condition: 'eq', keyValue: `={{ $('Config Piloto').first().json.LOCATION_ID }}` },
      { keyName: 'active', condition: 'eq', keyValue: 'true' },
    ],
  }
  buscarReceta.notes =
    'Fuente = sales_product_mappings. location_id desde Config Piloto (Barrio Chino).'
  buscarReceta.notesInFlow = true

  const buscarInv = nodeByName(wf, 'Buscar Inventario Local')
  for (const c of buscarInv.parameters.filters.conditions) {
    if (c.keyName === 'location_id') {
      c.keyValue = `={{ $('Config Piloto').first().json.LOCATION_ID }}`
    }
  }

  // --- Code nodes ---
  nodeByName(wf, 'Cruzar Ventas y Recetas').parameters.jsCode = CRUZAR_JS
  nodeByName(wf, 'Calcular Consumo Multi').parameters.jsCode = CALCULAR_CONSUMO_JS

  const prepEvento =
    wf.nodes.find((n) => n.name === 'Preparar Evento Consumo') ||
    nodeByName(wf, 'Preparar Movimientos Multi')
  prepEvento.name = 'Preparar Evento Consumo'
  prepEvento.parameters.jsCode = PREPARAR_EVENTO_JS

  nodeByName(wf, 'Separar Ventas').parameters.jsCode = SEPARAR_VENTAS_JS
  nodeByName(wf, 'Separar Ventas').notes =
    'Filtro local fail-closed (fecha + saleState + single item). Cursor incremental comentado.'
  nodeByName(wf, 'Separar Ventas').notesInFlow = true

  nodeByName(wf, 'Separar Items').parameters.jsCode = SEPARAR_ITEMS_JS
  nodeByName(wf, 'Separar Items').notes =
    'Con PILOT_SINGLE_ITEM emite solo PILOT_EXTERNAL_ITEM_ID (no basta page[size]=1).'
  nodeByName(wf, 'Separar Items').notesInFlow = true

  // --- Fudo Obtener Ventas: URL dinámica single vs list; filtros API opt-in ---
  const obtenerVentas = nodeByName(wf, 'Fudo - Obtener Ventas')
  obtenerVentas.parameters.url =
    "={{ (() => { const c = $('Config Piloto').first().json; const single = c.PILOT_SINGLE_ITEM === true || String(c.PILOT_SINGLE_ITEM).toLowerCase() === 'true'; const id = String(c.PILOT_EXTERNAL_SALE_ID || '').trim(); return single && id ? `https://api.fu.do/v1alpha1/sales/${id}` : 'https://api.fu.do/v1alpha1/sales'; })() }}"
  obtenerVentas.parameters.sendQuery = true
  obtenerVentas.parameters.queryParameters = {
    parameters: [
      {
        name: 'page[size]',
        value:
          "={{ (() => { const c = $('Config Piloto').first().json; const single = c.PILOT_SINGLE_ITEM === true || String(c.PILOT_SINGLE_ITEM).toLowerCase() === 'true'; return single ? '1' : '20'; })() }}",
      },
      { name: 'sort', value: '-createdAt' },
      {
        name: 'filter[createdAt]',
        value:
          "={{ (() => { const c = $('Config Piloto').first().json; const on = c.FUDO_API_CREATED_AT_FILTER === true || String(c.FUDO_API_CREATED_AT_FILTER).toLowerCase() === 'true'; const start = String(c.PILOT_START_ISO || '').trim(); const single = c.PILOT_SINGLE_ITEM === true || String(c.PILOT_SINGLE_ITEM).toLowerCase() === 'true'; return on && start && !single ? `gte.${start}` : undefined; })() }}",
      },
      {
        name: 'filter[saleState]',
        value:
          "={{ (() => { const c = $('Config Piloto').first().json; const on = c.FUDO_API_SALE_STATE_FILTER === true || String(c.FUDO_API_SALE_STATE_FILTER).toLowerCase() === 'true'; const states = String(c.PILOT_ALLOWED_SALE_STATES || '').trim(); const single = c.PILOT_SINGLE_ITEM === true || String(c.PILOT_SINGLE_ITEM).toLowerCase() === 'true'; return on && states && !single ? `in.(${states})` : undefined; })() }}",
      },
    ],
  }
  obtenerVentas.notes =
    'Listado o GET /sales/{id} en single-item. Filtros API solo si FUDO_API_*_FILTER=true tras probe. El corte real está en Separar Ventas (local).'
  obtenerVentas.notesInFlow = true

  // --- Token ---
  const token = nodeByName(wf, 'Fudo - Token')
  token.parameters.jsonBody =
    '={{({ apiKey: $credentials.fudoApi.apiKey, apiSecret: $credentials.fudoApi.apiSecret })}}'
  token.parameters.specifyBody = 'json'
  token.notes = 'Credencial Fudo en n8n. Sin secretos en el JSON.'
  token.notesInFlow = true

  // --- RPC (DESHABILITADO) ---
  const registrar =
    wf.nodes.find((n) => n.name === 'Registrar Evento Consumo SENDA - RPC') ||
    nodeByName(wf, 'Registrar Consumo SENDA - RPC')
  registrar.name = 'Registrar Evento Consumo SENDA - RPC'
  registrar.parameters.url = `${SUPABASE_URL}/rest/v1/rpc/senda_register_sale_consumption_event`
  registrar.parameters.jsonBody = `={{({ p: $json })}}`
  registrar.parameters.authentication = 'genericCredentialType'
  registrar.parameters.genericAuthType = 'httpCustomAuth'
  registrar.disabled = true
  registrar.notes =
    'DESHABILITADO. Reconectar Dry-run → este nodo → Loop al autorizar escrituras. body { p: $json }. source_id=item_id.'
  registrar.notesInFlow = true

  const dryRun = ensureNode(wf, 'Dry-run Evento Consumo', () => ({
    parameters: {},
    id: randomUUID(),
    name: 'Dry-run Evento Consumo',
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position: [1200, 368],
  }))
  dryRun.notes =
    'Sustituto temporal del RPC. Inspeccionar payload aquí antes de habilitar escrituras.'
  dryRun.notesInFlow = true

  // --- Pendientes: misma LOCATION; DESHABILITADOS (no escribir prod) ---
  const guardarPend = nodeByName(wf, 'Guardar Productos Pendientes - Upsert')
  guardarPend.parameters.url = `${SUPABASE_URL}/rest/v1/pending_product_mappings?on_conflict=location_id,source,external_product_id`
  guardarPend.parameters.authentication = 'genericCredentialType'
  guardarPend.parameters.genericAuthType = 'httpCustomAuth'
  guardarPend.parameters.headerParameters = {
    parameters: [
      { name: 'Content-Type', value: 'application/json' },
      {
        name: 'Prefer',
        value: 'resolution=merge-duplicates,missing=default,return=representation',
      },
    ],
  }
  guardarPend.parameters.jsonBody = `=
{
  "location_id": "{{ $('Config Piloto').first().json.LOCATION_ID }}",
  "source": "fudo",
  "external_product_id": "{{ $json.producto_id }}",
  "external_product_name": "{{ $json.producto }}",
  "last_seen_at": "{{ $now.toISO() }}"
}
`
  guardarPend.disabled = true
  guardarPend.notes = 'DESHABILITADO en piloto de lectura. location_id desde Config Piloto.'
  guardarPend.notesInFlow = true

  const resolverPend = nodeByName(wf, 'Resolver Productos Pendientes - RPC')
  resolverPend.parameters.url = `${SUPABASE_URL}/rest/v1/rpc/resolve_pending_product_mappings`
  resolverPend.parameters.authentication = 'genericCredentialType'
  resolverPend.parameters.genericAuthType = 'httpCustomAuth'
  resolverPend.disabled = true
  resolverPend.notes = 'DESHABILITADO en piloto de lectura.'
  resolverPend.notesInFlow = true

  // Skip/omitido node
  ensureNode(wf, 'Ítem omitido (cancelado)', () => ({
    parameters: {},
    id: randomUUID(),
    name: 'Ítem omitido (cancelado)',
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position: [420, 560],
  }))

  ensureNode(wf, 'Fin del lote (done)', () => ({
    parameters: {},
    id: randomUUID(),
    name: 'Fin del lote (done)',
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position: [420, 40],
  }))

  // Sticky notes
  const stickySync = ensureNode(wf, 'NOTA — Sync incremental', () => ({
    parameters: { content: '', height: 240, width: 360 },
    id: randomUUID(),
    name: 'NOTA — Sync incremental',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [-200, -120],
  }))
  stickySync.parameters.content =
    '## Sync incremental (NO activar)\n1. Schedule en lugar de Manual.\n2. Paginar `page[number]`.\n3. Activar cursor `last_sale_created_at` tras run OK con RPC.\n4. Política piloto: corte por **createdAt** (no closedAt) → no reprocesa tickets abiertos antes del piloto.'

  const stickyPilot = ensureNode(wf, 'NOTA — Piloto seguro', () => ({
    parameters: { content: '', height: 280, width: 380 },
    id: randomUUID(),
    name: 'NOTA — Piloto seguro',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [-720, -40],
  }))
  stickyPilot.parameters.content = `## Piloto Barrio Chino\n- LOCATION_ID = ${LOCATION_ID}\n- PILOT_SINGLE_ITEM=true + sale/item ids\n- PILOT_START_ISO obligatorio si single=false\n- RPC / pendientes DESHABILITADOS\n- Filtros API off hasta \`probe-fudo-sales-filters.mjs\`\n- Idempotencia: source_id = item_id`

  // Connections
  const C = {}
  C['When clicking ‘Execute workflow’'] = {
    main: [[{ node: 'Config Piloto', type: 'main', index: 0 }]],
  }
  C['Config Piloto'] = {
    main: [[{ node: 'Fudo - Token', type: 'main', index: 0 }]],
  }
  C['Fudo - Token'] = {
    main: [[{ node: 'Fudo - Obtener Ventas', type: 'main', index: 0 }]],
  }
  C['Fudo - Obtener Ventas'] = {
    main: [[{ node: 'Separar Ventas', type: 'main', index: 0 }]],
  }
  C['Separar Ventas'] = {
    main: [[{ node: 'Separar Items', type: 'main', index: 0 }]],
  }
  C['Separar Items'] = {
    main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]],
  }
  C['Loop Over Items'] = {
    main: [
      [{ node: 'Fin del lote (done)', type: 'main', index: 0 }],
      [{ node: 'Fudo - Obtener Item', type: 'main', index: 0 }],
    ],
  }
  C['Fudo - Obtener Item'] = {
    main: [[{ node: 'Preparar Item', type: 'main', index: 0 }]],
  }
  C['Preparar Item'] = {
    main: [[{ node: 'Fudo - Obtener Producto', type: 'main', index: 0 }]],
  }
  C['Fudo - Obtener Producto'] = {
    main: [[{ node: 'Preparar Venta', type: 'main', index: 0 }]],
  }
  C['Preparar Venta'] = {
    main: [[{ node: '¿Item cancelado?', type: 'main', index: 0 }]],
  }
  C['¿Item cancelado?'] = {
    main: [
      [{ node: 'Ítem omitido (cancelado)', type: 'main', index: 0 }],
      [{ node: 'Buscar Receta SENDA', type: 'main', index: 0 }],
    ],
  }
  C['Ítem omitido (cancelado)'] = {
    main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]],
  }
  C['Buscar Receta SENDA'] = {
    main: [[{ node: 'Cruzar Ventas y Recetas', type: 'main', index: 0 }]],
  }
  C['Cruzar Ventas y Recetas'] = {
    main: [[{ node: '¿Tiene receta?', type: 'main', index: 0 }]],
  }
  C['¿Tiene receta?'] = {
    main: [
      [{ node: 'Obtener Componentes Receta', type: 'main', index: 0 }],
      [{ node: 'Identificar Sin Receta', type: 'main', index: 0 }],
    ],
  }
  C['Obtener Componentes Receta'] = {
    main: [[{ node: 'Calcular Consumo Multi', type: 'main', index: 0 }]],
  }
  C['Calcular Consumo Multi'] = {
    main: [[{ node: 'Buscar Inventario Local', type: 'main', index: 0 }]],
  }
  C['Buscar Inventario Local'] = {
    main: [[{ node: 'Preparar Evento Consumo', type: 'main', index: 0 }]],
  }
  C['Preparar Evento Consumo'] = {
    main: [[{ node: 'Dry-run Evento Consumo', type: 'main', index: 0 }]],
  }
  C['Dry-run Evento Consumo'] = {
    main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]],
  }
  // RPC queda en el grafo deshabilitado; al habilitar: Dry-run → RPC → Loop
  C['Registrar Evento Consumo SENDA - RPC'] = {
    main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]],
  }
  C['Identificar Sin Receta'] = {
    main: [[{ node: 'Agrupar Productos Sin Receta', type: 'main', index: 0 }]],
  }
  C['Agrupar Productos Sin Receta'] = {
    main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]],
  }
  // Guardar/Resolver deshabilitados y fuera del camino activo

  wf.connections = C

  const sanitized = stripSecrets(wf)
  const text = JSON.stringify(sanitized)
  if (/sb_secret_/.test(text)) throw new Error('Sanitization failed: sb_secret still present')
  if (text.includes(OLD_LOCATION_PRUEBAS)) {
    throw new Error('SENDA - Pruebas location still present')
  }
  if ((text.match(new RegExp(LOCATION_ID, 'g')) || []).length < 1) {
    throw new Error('LOCATION_ID missing from export')
  }

  writeFileSync(OUT, JSON.stringify(sanitized, null, 2))
  writeFileSync(README, buildReadme())
  console.log('Wrote', OUT)
  console.log('Wrote', README)
}

function buildReadme() {
  return `# SENDA — Fudo Inventario (sale-event piloto)

Importable en n8n. **active=false**. Sin secretos. RPC y pendientes **deshabilitados**.

Sucursal piloto: **${LOCATION_NAME}** (\`${LOCATION_ID}\`).

## Parámetros (nodo Config Piloto)

| Clave | Default | Notas |
|---|---|---|
| \`LOCATION_ID\` | \`${LOCATION_ID}\` | Única sucursal del flujo |
| \`LOCATION_NAME\` | ${LOCATION_NAME} | Solo documentación |
| \`PILOT_START_ISO\` | _(vacío)_ | **Obligatorio** si \`PILOT_SINGLE_ITEM=false\`. No inventar. ISO-8601 UTC |
| \`PILOT_DATE_FIELD\` | \`createdAt\` | Política piloto: corte por creación, no por cierre |
| \`PILOT_ALLOWED_SALE_STATES\` | \`CLOSED\` | Lista CSV; filtro **local**. Confirmar valores reales con probe |
| \`PILOT_SINGLE_ITEM\` | \`true\` | GET \`/sales/{id}\` + un solo \`item_id\` |
| \`PILOT_EXTERNAL_SALE_ID\` | _(vacío)_ | Requerido en single |
| \`PILOT_EXTERNAL_ITEM_ID\` | _(vacío)_ | Requerido en single (\`source_id\`) |
| \`FUDO_API_CREATED_AT_FILTER\` | \`false\` | Activar solo tras \`probe-fudo-sales-filters.mjs\` OK |
| \`FUDO_API_SALE_STATE_FILTER\` | \`false\` | Idem |

## Política de fecha (importante)

El piloto corta por **\`createdAt >= PILOT_START_ISO\`**.

Una venta **creada antes** del piloto y **cerrada después** **no** se procesa. Es deliberado: evita históricas. Si más adelante se elige \`closedAt\`, documentar el riesgo de tickets abiertos pre-piloto.

Filtro API \`filter[createdAt]=gte…\` / \`filter[saleState]=in.(…)\`: opt-in. El corte efectivo siempre está en **Separar Ventas** (local, fail-closed).

## Qué cambió (seguridad)

| Pieza | Cambio |
|---|---|
| Config Piloto | Una sola fuente de \`LOCATION_ID\` / flags |
| Eliminado | Hardcodes de SENDA - Pruebas (reemplazados por Config Piloto) |
| Separar Ventas / Items | Fecha + estado + single-item |
| canceled | Boolean en Preparar Item / Preparar Venta / IF |
| RPC | Deshabilitado; camino activo → Dry-run → Loop |
| Pendientes upsert/resolve | Deshabilitados |
| Idempotencia | \`source_id = item_id\` intacta |
| Cursor / Schedule | No activados |

## Probe de filtros Fudo (solo lectura)

\`\`\`bash
cd apps/api
FUDO_API_KEY=… FUDO_API_SECRET=… node n8n/probe-fudo-sales-filters.mjs
\`\`\`

No escribe en SENDA ni en Fudo. Si el probe confirma sintaxis, setear \`FUDO_API_*_FILTER=true\` en Config.

## Verificación previa a habilitar escrituras

1. Importar JSON (workflow nuevo, inactive).
2. Credenciales n8n: Fudo + Supabase Custom Auth (service_role). Sin pegar secretos en nodos.
3. Completar Config: \`PILOT_EXTERNAL_SALE_ID\` / \`PILOT_EXTERNAL_ITEM_ID\` (venta **nueva** post-piloto, nunca histórica).
4. Mapping activo en Barrio Chino para el producto del ítem; stock suficiente.
5. Ejecutar Manual Trigger con RPC **sigue disabled**.
6. Inspeccionar payload en **Dry-run Evento Consumo** (\`location_id\`, \`source_id\`, \`lines\`).
7. Confirmar que no hubo writes (stock / \`sale_consumption_events\` / pendientes).
8. Solo entonces: habilitar RPC, cablear Dry-run → RPC → Loop, un ítem, verificar \`complete\` / \`duplicate\`.

## Mapa Fudo → RPC

| Campo | RPC |
|---|---|
| \`item_id\` | \`source_id\` + \`external_item_id\` |
| \`venta_id\` | \`external_sale_id\` |
| \`producto_id\` | \`external_product_id\` |
| \`cantidad\` | \`sold_quantity\` |
| LI + qty negativa | \`lines[]\` |
| Config | \`location_id\`, \`source_type=fudo\` |

## Rebuild

\`\`\`bash
node apps/api/n8n/build-fudo-sale-event-workflow.mjs
\`\`\`
`
}

main()

import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WF_PATH = new URL('../../n8n/SENDA-Fudo-Inventario-sale-event.sanitized.json', import.meta.url)
const BUILD_PATH = new URL('../../n8n/build-fudo-sale-event-workflow.mjs', import.meta.url)
const README_PATH = new URL('../../n8n/SENDA-Fudo-Inventario-sale-event.README.md', import.meta.url)
const PROBE_PATH = new URL('../../n8n/probe-fudo-sales-filters.mjs', import.meta.url)

const LOCATION_BARRIO = 'd8d78b7d-eec5-4e90-8f2d-98268a875d00'
const LOCATION_PRUEBAS = '170ee5fa-6f8c-4a0f-830d-8322e76926f6'

describe('workflow sanitizado Fudo → sale-event (piloto seguro)', () => {
  it('existe, inactive, sin secretos ni Pruebas', () => {
    expect(existsSync(WF_PATH)).toBe(true)
    expect(existsSync(PROBE_PATH)).toBe(true)
    const raw = readFileSync(WF_PATH, 'utf8')
    expect(raw).not.toMatch(/sb_secret_/)
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./)
    expect(raw).not.toContain(LOCATION_PRUEBAS)
    expect(raw).toContain(LOCATION_BARRIO)
    const wf = JSON.parse(raw)
    expect(wf.active).toBe(false)
    expect(wf.name).toMatch(/sale-event/i)
  })

  it('centraliza Config Piloto y elimina hardcodes de sucursal en nodos de datos', () => {
    const wf = JSON.parse(readFileSync(WF_PATH, 'utf8'))
    const byName = Object.fromEntries(wf.nodes.map((n: { name: string }) => [n.name, n]))

    expect(byName['Config Piloto']).toBeTruthy()
    const cfgNames = byName['Config Piloto'].parameters.assignments.assignments.map(
      (a: { name: string }) => a.name,
    )
    for (const key of [
      'LOCATION_ID',
      'PILOT_START_ISO',
      'PILOT_DATE_FIELD',
      'PILOT_ALLOWED_SALE_STATES',
      'PILOT_SINGLE_ITEM',
      'PILOT_EXTERNAL_SALE_ID',
      'PILOT_EXTERNAL_ITEM_ID',
      'FUDO_API_CREATED_AT_FILTER',
      'FUDO_API_SALE_STATE_FILTER',
    ]) {
      expect(cfgNames).toContain(key)
    }

    const loc = byName['Config Piloto'].parameters.assignments.assignments.find(
      (a: { name: string }) => a.name === 'LOCATION_ID',
    )
    expect(loc.value).toBe(LOCATION_BARRIO)

    const start = byName['Config Piloto'].parameters.assignments.assignments.find(
      (a: { name: string }) => a.name === 'PILOT_START_ISO',
    )
    expect(start.value).toBe('')

    const single = byName['Config Piloto'].parameters.assignments.assignments.find(
      (a: { name: string }) => a.name === 'PILOT_SINGLE_ITEM',
    )
    expect(single.value).toBe(true)

    const receta = byName['Buscar Receta SENDA']
    const locFilter = receta.parameters.filters.conditions.find(
      (c: { keyName: string }) => c.keyName === 'location_id',
    )
    expect(locFilter.keyValue).toMatch(/Config Piloto/)
    expect(locFilter.keyValue).not.toContain(LOCATION_PRUEBAS)

    const inv = byName['Buscar Inventario Local']
    const invLoc = inv.parameters.filters.conditions.find(
      (c: { keyName: string }) => c.keyName === 'location_id',
    )
    expect(invLoc.keyValue).toMatch(/Config Piloto/)

    expect(byName['Guardar Productos Pendientes - Upsert'].parameters.jsonBody).toMatch(
      /Config Piloto/,
    )
    expect(byName['Preparar Evento Consumo'].parameters.jsCode).toMatch(/Config Piloto/)
    expect(byName['Preparar Evento Consumo'].parameters.jsCode).toMatch(/INVENTORY_LOCATION_MISMATCH/)
    expect(byName['Preparar Evento Consumo'].parameters.jsCode).toMatch(/source_id:\s*acc\.item_id/)
  })

  it('filtra ventas/ítems en código y soporta single-item por id', () => {
    const wf = JSON.parse(readFileSync(WF_PATH, 'utf8'))
    const byName = Object.fromEntries(wf.nodes.map((n: { name: string }) => [n.name, n]))

    const sep = byName['Separar Ventas'].parameters.jsCode
    expect(sep).toMatch(/PILOT_START_ISO_REQUIRED/)
    expect(sep).toMatch(/PILOT_SINGLE_ITEM_REQUIRES_SALE_AND_ITEM_IDS/)
    expect(sep).toMatch(/saleState|sale_state/)
    expect(sep).toMatch(/createdAt/)
    expect(sep).toMatch(/last_sale_created_at/)

    const items = byName['Separar Items'].parameters.jsCode
    expect(items).toMatch(/PILOT_EXTERNAL_ITEM_ID/)
    expect(items).toMatch(/PILOT_ITEM_NOT_IN_SALE/)

    const url = byName['Fudo - Obtener Ventas'].parameters.url
    expect(url).toMatch(/PILOT_SINGLE_ITEM/)
    expect(url).toMatch(/\/sales\/\$\{/)

    const q = byName['Fudo - Obtener Ventas'].parameters.queryParameters.parameters
    const names = q.map((p: { name: string }) => p.name)
    expect(names).toContain('filter[createdAt]')
    expect(names).toContain('filter[saleState]')
    const created = q.find((p: { name: string }) => p.name === 'filter[createdAt]')
    expect(created.value).toMatch(/FUDO_API_CREATED_AT_FILTER/)
  })

  it('normaliza canceled como boolean y mantiene IF boolean', () => {
    const wf = JSON.parse(readFileSync(WF_PATH, 'utf8'))
    const byName = Object.fromEntries(wf.nodes.map((n: { name: string }) => [n.name, n]))

    const prepItem = byName['Preparar Item'].parameters.assignments.assignments.find(
      (a: { name: string }) => a.name === 'canceled',
    )
    expect(prepItem.type).toBe('boolean')
    expect(prepItem.value).toMatch(/typeof v === 'boolean'/)
    expect(prepItem.value).toMatch(/s === 'true'/)
    expect(prepItem.value).not.toMatch(/Boolean\(\$json/)

    const prepVenta = byName['Preparar Venta'].parameters.assignments.assignments.find(
      (a: { name: string }) => a.name === 'canceled',
    )
    expect(prepVenta.type).toBe('boolean')

    const cancel = byName['¿Item cancelado?']
    const cond = cancel.parameters.conditions.conditions[0]
    expect(cond.operator.type).toBe('boolean')
    expect(cond.operator.operation).toBe('equals')
    expect(cond.rightValue).toBe(true)
  })

  it('mantiene RPC cableable pero deshabilitado; dry-run en el camino activo', () => {
    const wf = JSON.parse(readFileSync(WF_PATH, 'utf8'))
    const byName = Object.fromEntries(wf.nodes.map((n: { name: string }) => [n.name, n]))

    const rpc = byName['Registrar Evento Consumo SENDA - RPC']
    expect(rpc.disabled).toBe(true)
    expect(rpc.parameters.url).toMatch(/senda_register_sale_consumption_event/)
    expect(rpc.parameters.jsonBody).toMatch(/\{\s*p:\s*\$json\s*\}/)

    expect(byName['Guardar Productos Pendientes - Upsert'].disabled).toBe(true)
    expect(byName['Resolver Productos Pendientes - RPC'].disabled).toBe(true)

    expect(wf.connections['Preparar Evento Consumo'].main[0][0].node).toBe(
      'Dry-run Evento Consumo',
    )
    expect(wf.connections['Dry-run Evento Consumo'].main[0][0].node).toBe('Loop Over Items')
    expect(wf.connections['When clicking ‘Execute workflow’'].main[0][0].node).toBe(
      'Config Piloto',
    )

    const loop = wf.connections['Loop Over Items'].main
    expect(loop[1].some((c: { node: string }) => c.node === 'Fudo - Obtener Item')).toBe(true)
    expect(loop[0].some((c: { node: string }) => c.node === 'Fin del lote (done)')).toBe(true)
  })

  it('no deja Coca Cola Zero en el flujo activo', () => {
    const wf = JSON.parse(readFileSync(WF_PATH, 'utf8'))
    const connected = new Set<string>()
    for (const outs of Object.values(wf.connections) as Array<{ main: Array<Array<{ node: string }>> }>) {
      for (const branch of outs.main || []) {
        for (const c of branch || []) connected.add(c.node)
      }
    }
    expect([...connected].some((n) => /Coca Cola/i.test(n))).toBe(false)
  })

  it('README documenta política createdAt y procedimiento pre-escritura', () => {
    const readme = readFileSync(README_PATH, 'utf8')
    expect(readme).toMatch(/PILOT_START_ISO/)
    expect(readme).toMatch(/createdAt/)
    expect(readme).toMatch(/probe-fudo-sales-filters/)
    expect(readme).toMatch(/Dry-run Evento Consumo/)
    expect(readme).toMatch(/Barrio Chino/)
    expect(readme).not.toContain(LOCATION_PRUEBAS)

    const build = readFileSync(BUILD_PATH, 'utf8')
    expect(build).toContain(LOCATION_BARRIO)
    expect(build).toMatch(/FUDO_API_CREATED_AT_FILTER:\s*false/)
  })
})

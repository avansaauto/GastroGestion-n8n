import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-register-sale-consumption-stock.sql', import.meta.url),
  'utf8',
)
const INSPECT = readFileSync(
  new URL('../../sql/inspect-register-sale-consumption.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-register-sale-consumption-stock.sql', import.meta.url),
  'utf8',
)
const executable = SQL
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  return source.slice(from, to)
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function decodeProconfigItem(item: string) {
  const eq = item.indexOf('=')
  if (eq < 1) throw new Error('proconfig inválido')
  const gucName = item.slice(0, eq).trim().toLowerCase()
  const raw = item.slice(eq + 1)
  let quoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
  const inner = quoted ? raw.slice(1, -1) : ''
  if (quoted) {
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] !== '"') continue
      if (inner[i + 1] !== '"') {
        quoted = false
        break
      }
      i += 1
    }
  }
  return {
    gucName,
    gucValue: quoted ? inner.replaceAll('""', '"') : raw,
  }
}

function proconfigSetSql(item: string) {
  const decoded = decodeProconfigItem(item)
  return `alter function public.register_sale_consumption(uuid, numeric, text, text) set ${decoded.gucName} = ${quoteLiteral(decoded.gucValue)}`
}

describe('descuento de stock en register_sale_consumption', () => {
  it('conserva la firma y el resultado que ya llama n8n', () => {
    expect(SQL).toMatch(/NO EJECUTAR/)
    expect(executable).toMatch(/begin;/)
    expect(executable).toMatch(/commit;/)
    expect(executable).toMatch(
      /create or replace function public\.register_sale_consumption\(\s*p_location_inventory_id uuid,\s*p_quantity numeric,\s*p_source_type text,\s*p_source_id text\s*\)/,
    )
    expect(executable).toMatch(/returns table \(\s*inserted boolean,\s*movement_id uuid\s*\)/)
    expect(executable).not.toMatch(/\bgrant\b/i)
    expect(executable).not.toMatch(/\brevoke\b/i)
    expect(executable).toMatch(/SALE_CONSUMPTION_ABORT: los permisos de ejecución cambiaron/)
    expect(executable).toMatch(/security definer/)
    expect(executable).toMatch(/security invoker/)
    expect(executable).not.toMatch(/senda_adjust_inventory_quantity/)
    expect(executable).not.toMatch(/senda_receive_purchase_document_line/)
  })

  it('descuenta una vez, rechaza el conflicto y no toca el costo', () => {
    const fn = between(executable, 'as $func$', '$func$')
    expect(fn).toMatch(/INVALID_QUANTITY/)
    expect(fn).toMatch(/INVALID_SOURCE/)
    expect(fn).toMatch(/LOCATION_INVENTORY_MISSING/)
    expect(fn).toMatch(/movement_type = 'sale'/)
    expect(fn).toMatch(/p_source_type/)
    expect(fn).toMatch(/p_source_id/)
    expect(fn).toMatch(/SALE_IDEMPOTENCY_CONFLICT/)
    expect(fn).toMatch(/SALE_EXCEEDS_ON_HAND/)
    expect(fn).toMatch(/inserted := false/)
    expect(fn).toMatch(/inserted := true/)
    expect(fn).toMatch(/insert into public\.inventory_movements/)
    expect(fn).toMatch(/set quantity_on_hand = v_next/)
    expect(fn).toMatch(/where location_inventory_id = v_li/)
    expect(fn).toMatch(/v_next := v_on_hand \+ p_quantity/)
    expect(fn).not.toMatch(/average_unit_cost/)
    expect(fn).not.toMatch(/last_purchase_unit_cost/)
    expect(fn).not.toMatch(/insert into public\.inventory_valuations/)
    expect(fn.match(/set quantity_on_hand/g)).toHaveLength(1)
    expect(fn).not.toMatch(/abs\(/)

    const locationAt = fn.indexOf('from public.location_inventory')
    const valuationAt = fn.indexOf('from public.inventory_valuations')
    const movementAt = fn.indexOf('from public.inventory_movements')
    const replayAt = fn.indexOf('inserted := false')
    const exceedsAt = fn.indexOf('SALE_EXCEEDS_ON_HAND')
    const insertAt = fn.indexOf('insert into public.inventory_movements')
    const updateAt = fn.indexOf('set quantity_on_hand')
    const successAt = fn.indexOf('inserted := true')
    expect(locationAt).toBeGreaterThan(-1)
    expect(valuationAt).toBeGreaterThan(locationAt)
    expect(movementAt).toBeGreaterThan(valuationAt)
    expect(replayAt).toBeGreaterThan(movementAt)
    expect(replayAt).toBeLessThan(updateAt)
    expect(exceedsAt).toBeGreaterThan(replayAt)
    expect(exceedsAt).toBeLessThan(insertAt)
    expect(insertAt).toBeLessThan(updateAt)
    expect(successAt).toBeGreaterThan(updateAt)
  })

  it('no agrega el descuento si un trigger ya aplica el saldo', () => {
    expect(executable).toMatch(/pg_trigger/)
    expect(executable).toMatch(/not t\.tgisinternal/)
    expect(executable).toMatch(/el trigger % ya puede aplicar el saldo/)
    expect(executable).toMatch(/el cuerpo instalado ya escribe quantity_on_hand/)
    expect(executable).toMatch(/sale_rpc_attr_before/)
    expect(executable).toMatch(/sale_rpc_priv_before/)
  })

  it('restaura search_path vacío con SQL válido', () => {
    const broken =
      'alter function public.register_sale_consumption(uuid, numeric, text, text) set search_path=""'
    expect(broken).toContain('search_path=""')
    expect(proconfigSetSql('search_path=""')).toBe(
      "alter function public.register_sale_consumption(uuid, numeric, text, text) set search_path = ''",
    )
    expect(proconfigSetSql('search_path=""')).not.toContain('""')
    expect(proconfigSetSql('search_path=pg_catalog, public')).toBe(
      "alter function public.register_sale_consumption(uuid, numeric, text, text) set search_path = 'pg_catalog, public'",
    )
    expect(proconfigSetSql('search_path="pg_catalog, public"')).toBe(
      proconfigSetSql('search_path=pg_catalog, public'),
    )
    expect(proconfigSetSql('statement_timeout=0')).toBe(
      "alter function public.register_sale_consumption(uuid, numeric, text, text) set statement_timeout = '0'",
    )
    expect(proconfigSetSql('work_mem=4MB')).toBe(
      "alter function public.register_sale_consumption(uuid, numeric, text, text) set work_mem = '4MB'",
    )
    expect(proconfigSetSql('search_path="a""b"')).toBe(
      `alter function public.register_sale_consumption(uuid, numeric, text, text) set search_path = 'a"b'`,
    )
    expect(decodeProconfigItem('search_path=""').gucValue).toBe('')
    expect(decodeProconfigItem('search_path="pg_catalog, public"').gucValue).toBe(
      decodeProconfigItem('search_path=pg_catalog, public').gucValue,
    )

    expect(executable).not.toMatch(/set %s/)
    expect(executable).toMatch(/set %I = %L/)
    expect(executable).toMatch(/replace\(v_inner, '""', '"'\)/)
    expect(executable).toMatch(/SALE_CONSUMPTION_ABORT: proconfig quedó distinto/)
    expect(executable).toMatch(/begin;/)
    expect(executable).toMatch(/commit;/)
    const dropAt = executable.indexOf('drop function pg_temp.sale_decode_proconfig')
    const commitAt = executable.lastIndexOf('commit;')
    expect(dropAt).toBeGreaterThan(-1)
    expect(commitAt).toBeGreaterThan(dropAt)
  })

  it('la inspección y la verificación son de lectura', () => {
    expect(INSPECT).toMatch(/SOLO LECTURA/)
    expect(INSPECT).toMatch(/stock_trigger/)
    expect(INSPECT).toMatch(/routine_privileges/)
    expect(INSPECT).toMatch(/pg_get_function_result/)
    expect(INSPECT).not.toMatch(/^\s*(insert|update|delete|drop|alter|create|grant|revoke)\b/im)
    expect(INSPECT).not.toMatch(/\b(select|perform)\s+public\.register_sale_consumption\s*\(/i)

    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/locks_location_then_valuation/)
    expect(VERIFY).toMatch(/replay_before_discount/)
    expect(VERIFY).toMatch(/keeps_costs/)
    expect(VERIFY).toMatch(/single_balance_write/)
    expect(VERIFY).toMatch(/no_stock_trigger/)
    expect(VERIFY).toMatch(/SALE_CONSUMPTION_VERIFY_FAILED/)
    expect(VERIFY).not.toMatch(/^\s*(insert|update|delete|drop|alter|create|grant|revoke)\b/im)
    expect(VERIFY).not.toMatch(/\b(select|perform)\s+public\.register_sale_consumption\s*\(/i)
  })
})

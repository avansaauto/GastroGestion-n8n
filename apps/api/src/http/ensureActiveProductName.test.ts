import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/proposed-senda-ensure-active-product-name.sql', import.meta.url),
  'utf8',
)
const INSPECT = readFileSync(
  new URL('../../sql/inspect-inventory-products-org-name-unique.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-senda-active-product-name.sql', import.meta.url),
  'utf8',
)
const executable = SQL
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

describe('unicidad de insumo activo', () => {
  it('reemplaza el índice total por uno parcial y no reescribe el histórico', () => {
    expect(SQL).toMatch(/NO EJECUTAR/)
    expect(executable).toMatch(/begin;/)
    expect(executable).toMatch(/commit;/)
    expect(executable).toMatch(/create or replace function public\.senda_inventory_name_key\(p_name text\)/)
    expect(executable).toMatch(/immutable/)
    expect(executable).toMatch(/inventory_products_org_name_unique/)
    expect(executable).toMatch(/drop constraint %I/)
    expect(executable).toMatch(/drop index public\.inventory_products_org_name_unique/)
    expect(executable).toMatch(
      /create unique index inventory_products_org_active_name_key[\s\S]*where active is true/,
    )
    expect(executable).toMatch(/create or replace function public\.senda_ensure_inventory_product_for_intake/)
    expect(executable).toMatch(/public\.senda_inventory_name_key\(v_name\)/)
    expect(executable).toMatch(/public\.senda_inventory_name_key\(ip\.name\)/)
    expect(executable).toMatch(/ip\.active is true/)
    expect(executable).toMatch(/pg_advisory_xact_lock/)
    expect(executable).toMatch(/raise exception 'DUPLICATE_PRODUCT'/)
    expect(executable).toMatch(/insert into public\.inventory_products/)
    expect(executable).not.toMatch(/INACTIVE_PRODUCT_EXISTS/)
    expect(executable).not.toMatch(/update public\.inventory_products/)
    expect(executable).not.toMatch(/delete from public\.inventory_products/)
    expect(executable).not.toMatch(/delete from public\.inventory_movements/)
    expect(executable).not.toMatch(/delete from public\.inventory_cost_history/)
    expect(executable).toMatch(/having count\(\*\) > 1/)
    const lockAt = executable.search(/pg_advisory_xact_lock/)
    const duplicateAt = executable.search(/DUPLICATE_PRODUCT/)
    expect(lockAt).toBeGreaterThan(-1)
    expect(duplicateAt).toBeGreaterThan(lockAt)
  })

  it('la inspección es de lectura y la verificación exige el índice parcial', () => {
    expect(INSPECT).toMatch(/SOLO LECTURA/)
    expect(INSPECT).toMatch(/pg_get_indexdef/)
    expect(INSPECT).toMatch(/constraint_unique/)
    expect(INSPECT).toMatch(/indice_independiente/)
    expect(INSPECT).not.toMatch(/^\s*(insert|update|delete|drop|alter|create)\b/im)
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).toMatch(/inventory_products_org_active_name_key/)
    expect(VERIFY).toMatch(/old_name_unique_gone/)
    expect(VERIFY).toMatch(/ACTIVE_NAME_VERIFY_FAILED/)
    expect(VERIFY).not.toMatch(/^\s*(insert|update|delete|drop|alter|create)\b/im)
  })
})

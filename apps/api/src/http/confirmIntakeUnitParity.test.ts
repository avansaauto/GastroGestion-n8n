import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveConversionFactor } from './invoiceUnits.js'

const unitsSource = readFileSync(new URL('./invoiceUnits.ts', import.meta.url), 'utf8')
const proposed = readFileSync(
  new URL('../../sql/proposed-senda-confirm-purchase-invoice-intake.sql', import.meta.url),
  'utf8',
)
const migration = readFileSync(
  new URL('../../sql/proposed-senda-confirm-intake-unit-parity.sql', import.meta.url),
  'utf8',
)
const functional = readFileSync(
  new URL('../../sql/test-senda-confirm-purchase-invoice-intake.sql', import.meta.url),
  'utf8',
)

function quoted(block: string) {
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

function packagingSet(source: string) {
  const start = source.indexOf('const PACKAGING_UNITS')
  const end = source.indexOf('])', start)
  return quoted(source.slice(start, end)).sort()
}

function sqlPackagingLists(sql: string) {
  return [...sql.matchAll(/in \(\s*((?:'[^']+',?\s*)+)\)/g)]
    .map((match) => quoted(match[1]).sort())
    .filter((list) => list.includes('barra') && list.includes('caja'))
}

function functionBody(sql: string, name: string) {
  const marker = `function public.${name}`
  const start = sql.indexOf(marker)
  const end = sql.indexOf('$$;', start)
  return sql.slice(start, end).replace(/create or replace /g, 'create ')
}

describe('paridad SQL de unidades de confirmación', () => {
  const apiPackaging = packagingSet(unitsSource)

  it('no altera tablas ni los RPC de guardado, confirmación o stock', () => {
    const executable = migration.replace(/--[^\n]*/g, '')
    expect(migration).toMatch(/NO EJECUTAR/)
    expect(executable).toMatch(/begin;/)
    expect(executable).toMatch(/commit;/)
    expect(executable).toMatch(/CONFIRM_INTAKE_UNIT_PARITY_ABORT/)
    expect(executable).not.toMatch(/alter table/i)
    expect(executable).not.toMatch(/create table/i)
    expect(executable).not.toMatch(/senda_confirm_purchase_invoice_intake/)
    expect(executable).not.toMatch(/senda_save_purchase_invoice/)
    expect(executable).not.toMatch(/senda_receive_purchase_document_line/)
    expect(executable).not.toMatch(/senda_map_purchase_document_line/)
    expect(migration).toMatch(/create or replace function public\.senda_confirm_intake_canonical_unit/)
    expect(migration).toMatch(/create or replace function public\.senda_confirm_intake_assert_physical/)
    expect(migration).toMatch(/revoke all on function public\.senda_confirm_intake_assert_physical/)
  })

  it('el espejo SQL usa el mismo vocabulario que invoiceUnits.ts', () => {
    for (const sql of [proposed, migration]) {
      const lists = sqlPackagingLists(sql)
      expect(lists.length).toBeGreaterThanOrEqual(3)
      for (const list of lists) {
        expect(list).toEqual(apiPackaging)
      }
    }
    expect(apiPackaging).toEqual([
      'barra', 'barras', 'barril', 'barriles', 'bidon', 'bidones', 'bloque', 'bloques',
      'bolsa', 'bolsas', 'botella', 'botellas', 'bulto', 'bultos', 'caja', 'cajas',
      'cajon', 'cajones', 'horma', 'hormas', 'lata', 'latas', 'maple', 'pack', 'packs',
      'palet', 'pallet', 'pieza', 'piezas', 'plancha', 'planchas',
    ])
    expect(migration).toMatch(/'uni'/)
    expect(migration).toMatch(/'und'/)
    expect(migration).toMatch(/when 'cl' then 10/)
    expect(migration).toMatch(/when 'mg' then 0\.001/)
    expect(migration).toMatch(/when 'docena' then 12/)
    expect(functionBody(migration, 'senda_confirm_intake_canonical_unit')).toBe(
      functionBody(proposed, 'senda_confirm_intake_canonical_unit'),
    )
    expect(functionBody(migration, 'senda_confirm_intake_assert_physical')).toBe(
      functionBody(proposed, 'senda_confirm_intake_assert_physical'),
    )
  })

  it('cubre La Paulina, Doña Aurora, los otros cuatro, kg, desconocida y empaque sin factor', () => {
    const cases = [
      ['barra', 'g', 3500, 2, 7000],
      ['plancha', 'g', 8880, 1, 8880],
      ['pack', 'g', 10000, 1, 10000],
      ['pack', 'ml', 12000, 1, 12000],
      ['bolsa', 'g', 5000, 2, 10000],
      ['bolsa', 'g', 1000, 1, 1000],
    ] as const
    for (const [unit, base, factor, quantity, physical] of cases) {
      expect(resolveConversionFactor({
        invoiceUnit: unit,
        inventoryUnit: base,
        conversionFactor: factor,
      })).toBe(factor)
      expect(quantity * factor).toBe(physical)
    }
    expect(resolveConversionFactor({
      invoiceUnit: 'kg',
      inventoryUnit: 'g',
      conversionFactor: 1000,
    })).toBe(1000)
    expect(() => resolveConversionFactor({
      invoiceUnit: 'kg',
      inventoryUnit: 'g',
      conversionFactor: 3500,
    })).toThrow(/no coincide/)
    expect(() => resolveConversionFactor({
      invoiceUnit: 'xyz',
      inventoryUnit: 'g',
      conversionFactor: 1,
    })).toThrow(/No se puede convertir/)
    expect(() => resolveConversionFactor({
      invoiceUnit: 'barra',
      inventoryUnit: 'g',
      conversionFactor: null,
    })).toThrow(/equivalen/)
    expect(functional).toMatch(/assert_physical\('barra', 'g', 2, 3500, 7000\)/)
    expect(functional).toMatch(/assert_physical\('plancha', 'g', 1, 8880, 8880\)/)
    expect(functional).toMatch(/assert_physical\('pack', 'ml', 1, 12000, 12000\)/)
    expect(functional).toMatch(/assert_physical\('bolsa', 'g', 2, 5000, 10000\)/)
    expect(functional).toMatch(/assert_physical\('xyz', 'g', 1, 1, 1\)/)
    expect(functional).toMatch(/assert_physical\('kg', 'g', 2, 3500, 7000\)/)
    expect(functional).toMatch(/assert_physical\('barra', 'g', 2, null, 7000\)/)
  })
})

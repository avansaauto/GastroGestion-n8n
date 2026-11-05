import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  new URL('../../sql/inspect-recipes-schema.sql', import.meta.url),
  'utf8',
)

function withoutComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '')
}

describe('inspect-recipes-schema.sql', () => {
  it('es inspección de solo lectura y no se ejecuta sola', () => {
    expect(SQL).toMatch(/Paso 401/)
    expect(SQL).toMatch(/SOLO LECTURA/)
    expect(SQL).toMatch(/NO EJECUTAR/)
    const body = withoutComments(SQL)
    expect(body).not.toMatch(/^\s*(insert|update|delete|grant|revoke|alter|create|drop|truncate|call)\b/im)
    expect(body).not.toMatch(/\b(insert into|update\s+\w+\s+set|delete from|truncate table)\b/i)
  })

  it('no lee filas de negocio ni llama RPC de recetas o ventas', () => {
    const body = withoutComments(SQL)
    expect(body).not.toMatch(
      /\bfrom\s+(only\s+)?(public\.)?(recipes|recipe_components|pending_product_mappings|sales_product_mappings)\b/i,
    )
    expect(body).not.toMatch(/\bresolve_pending_product_mappings\s*\(/)
    expect(body).not.toMatch(/\bregister_sale_consumption\s*\(/)
  })

  it('cubre tablas, constraints, políticas, triggers y las dos funciones', () => {
    expect(SQL).toMatch(/information_schema\.columns/)
    expect(SQL).toMatch(/pg_constraint/)
    expect(SQL).toMatch(/pg_indexes/)
    expect(SQL).toMatch(/pg_policies/)
    expect(SQL).toMatch(/pg_trigger/)
    expect(SQL).toMatch(/pg_proc/)
    expect(SQL).toMatch(/pg_get_functiondef/)
    expect(SQL).toMatch(/resolve_pending_product_mappings/)
    expect(SQL).toMatch(/register_sale_consumption/)
    for (const table of [
      'recipes',
      'recipe_components',
      'pending_product_mappings',
      'sales_product_mappings',
    ]) {
      expect(SQL).toContain(`'${table}'`)
    }
  })
})

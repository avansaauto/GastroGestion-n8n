import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  RECIPE_STATUS_RPC_ENABLED,
  isSetRecipeActiveRpcMissing,
  setOrganizationRecipeActive,
} from './recipeStatus.js'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const OTHER_ORGANIZATION = '22222222-2222-4222-8222-222222222222'
const RECIPE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PARENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MAPPING = '12121212-1212-4121-8121-121212121212'

function filterable(rows: Record<string, unknown>[], error: { message?: string } | null = null) {
  let filtered = [...rows]
  const builder: Record<string, unknown> = {}
  const self = () => builder
  builder.select = self
  builder.eq = (column: string, value: string) => {
    filtered = filtered.filter((row) => String(row[column] ?? '') === value)
    return builder
  }
  builder.in = (column: string, values: string[]) => {
    const allowed = new Set(values)
    filtered = filtered.filter((row) => allowed.has(String(row[column] ?? '')))
    return builder
  }
  builder.maybeSingle = async () => ({
    data: error ? null : filtered[0] ?? null,
    error,
  })
  builder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => {
    resolve({ data: error ? null : filtered, error })
  }
  return builder
}

function clients(options: {
  organization?: Record<string, unknown> | null
  organizationError?: { message: string } | null
  recipes?: Record<string, unknown>[]
  recipeError?: { message: string } | null
  components?: Record<string, unknown>[]
  mappings?: Record<string, unknown>[]
  rpcData?: Record<string, unknown> | null
  rpcError?: { code?: string; message?: string; details?: string } | null
} = {}) {
  const tables: string[] = []
  const from = vi.fn((table: string) => {
    tables.push(table)
    if (table === 'inventory_movements' || table === 'pending_product_mappings') {
      throw new Error(`${table} no debe consultarse`)
    }
    if (table === 'organizations') {
      return filterable(
        options.organization === undefined
          ? [{ id: ORGANIZATION }]
          : options.organization
            ? [options.organization]
            : [],
        options.organizationError ?? null,
      )
    }
    if (table === 'recipes') {
      return filterable(
        options.recipes ?? [{
          id: RECIPE,
          organization_id: ORGANIZATION,
          name: 'Salsa de la casa',
          active: true,
        }],
        options.recipeError ?? null,
      )
    }
    if (table === 'recipe_components') {
      return filterable(options.components ?? [])
    }
    if (table === 'sales_product_mappings') {
      return filterable(options.mappings ?? [])
    }
    throw new Error(`tabla inesperada: ${table}`)
  })
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: options.rpcError ? null : (options.rpcData ?? {
      recipe_id: RECIPE,
      active: false,
      replay: false,
      used_by: [],
      active_mapping_count: 0,
    }),
    error: options.rpcError ?? null,
  }))
  return {
    from,
    rpc,
    tables,
    user: { from } as unknown as SupabaseClient,
    admin: { rpc } as unknown as SupabaseClient,
  }
}

const DEACTIVATE = { active: false, expectedActive: true }
const REACTIVATE = { active: true, expectedActive: false }

async function setStatus(
  db: ReturnType<typeof clients>,
  overrides: Partial<{
    userId: string
    organizationId: string
    recipeId: string
    body: unknown
    rpcEnabled: boolean
  }> = {},
) {
  return setOrganizationRecipeActive({
    userClient: db.user,
    adminClient: db.admin,
    userId: 'userId' in overrides ? overrides.userId ?? '' : USER,
    organizationId: overrides.organizationId ?? ORGANIZATION,
    recipeId: overrides.recipeId ?? RECIPE,
    body: 'body' in overrides ? overrides.body : DEACTIVATE,
    rpcEnabled: overrides.rpcEnabled,
  })
}

describe('setOrganizationRecipeActive', () => {
  it('llama senda_set_recipe_active por defecto y no escribe stock ni mappings', async () => {
    expect(RECIPE_STATUS_RPC_ENABLED).toBe(true)
    const db = clients({
      rpcData: {
        recipe_id: RECIPE,
        active: false,
        replay: false,
        used_by: [],
        active_mapping_count: 0,
      },
    })
    const result = await setStatus(db)
    expect(result).toEqual({
      recipeId: RECIPE,
      active: false,
      replay: false,
      usedBy: [],
      activeMappingCount: 0,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_set_recipe_active', {
      p: {
        actor_user_id: USER,
        organization_id: ORGANIZATION,
        recipe_id: RECIPE,
        active: false,
        expected_active: true,
      },
    })
    expect(db.rpc.mock.calls[0][0]).not.toBe('senda_create_recipe')
    expect(db.rpc.mock.calls[0][0]).not.toBe('senda_update_recipe')
    expect(db.rpc.mock.calls[0][0]).not.toBe('senda_save_fudo_recipe')
    expect(db.tables).not.toContain('inventory_movements')
    expect(db.tables).not.toContain('pending_product_mappings')
  })

  it('si se desactiva el flag no llama el RPC', async () => {
    const db = clients({})
    await expect(setStatus(db, { rpcEnabled: false })).rejects.toMatchObject({
      code: 'RECIPE_STATUS_RPC_PENDING',
      status: 503,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('desactiva sin dependencias cuando el RPC está habilitado', async () => {
    const db = clients({
      mappings: [{
        id: MAPPING,
        recipe_id: RECIPE,
        active: true,
      }],
      rpcData: {
        recipe_id: RECIPE,
        active: false,
        replay: false,
        used_by: [],
        active_mapping_count: 1,
      },
    })
    const result = await setStatus(db, { rpcEnabled: true })
    expect(result).toEqual({
      recipeId: RECIPE,
      active: false,
      replay: false,
      usedBy: [],
      activeMappingCount: 1,
    })
    expect(db.rpc).toHaveBeenCalledWith('senda_set_recipe_active', {
      p: {
        actor_user_id: USER,
        organization_id: ORGANIZATION,
        recipe_id: RECIPE,
        active: false,
        expected_active: true,
      },
    })
    expect(db.rpc.mock.calls[0][0]).not.toBe('senda_create_recipe')
    expect(db.rpc.mock.calls[0][0]).not.toBe('senda_update_recipe')
    expect(db.rpc.mock.calls[0][0]).not.toBe('senda_save_fudo_recipe')
  })

  it('reactiva una receta inactiva', async () => {
    const db = clients({
      recipes: [{
        id: RECIPE,
        organization_id: ORGANIZATION,
        name: 'Salsa de la casa',
        active: false,
      }],
      rpcData: {
        recipe_id: RECIPE,
        active: true,
        replay: false,
        used_by: [],
        active_mapping_count: 0,
      },
    })
    const result = await setStatus(db, { rpcEnabled: true, body: REACTIVATE })
    expect(result.active).toBe(true)
    expect(db.rpc.mock.calls[0][1]).toMatchObject({
      p: { active: true, expected_active: false },
    })
  })

  it('bloquea desactivar si una receta activa la usa como subreceta', async () => {
    const db = clients({
      components: [{
        recipe_id: PARENT_ID,
        component_recipe_id: RECIPE,
      }],
      recipes: [
        {
          id: RECIPE,
          organization_id: ORGANIZATION,
          name: 'Salsa de la casa',
          active: true,
        },
        {
          id: PARENT_ID,
          organization_id: ORGANIZATION,
          name: 'Milanesa napolitana',
          active: true,
        },
      ],
    })
    await expect(setStatus(db, { rpcEnabled: true })).rejects.toMatchObject({
      code: 'RECIPE_IN_USE',
      status: 409,
      usedBy: [{ recipeId: PARENT_ID, name: 'Milanesa napolitana' }],
      message: expect.stringContaining('Milanesa napolitana'),
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('permite desactivar si el padre está inactivo', async () => {
    const db = clients({
      components: [{
        recipe_id: PARENT_ID,
        component_recipe_id: RECIPE,
      }],
      recipes: [
        {
          id: RECIPE,
          organization_id: ORGANIZATION,
          name: 'Salsa de la casa',
          active: true,
        },
        {
          id: PARENT_ID,
          organization_id: ORGANIZATION,
          name: 'Milanesa archivada',
          active: false,
        },
      ],
      rpcData: {
        recipe_id: RECIPE,
        active: false,
        replay: false,
        used_by: [],
        active_mapping_count: 0,
      },
    })
    await expect(setStatus(db, { rpcEnabled: true })).resolves.toMatchObject({ active: false, replay: false })
    expect(db.rpc).toHaveBeenCalled()
  })

  it('no bloquea por mappings Fudo activos y no los escribe', async () => {
    const db = clients({
      mappings: [{
        id: MAPPING,
        recipe_id: RECIPE,
        active: true,
      }],
      rpcData: {
        recipe_id: RECIPE,
        active: false,
        replay: false,
        used_by: [],
        active_mapping_count: 1,
      },
    })
    const result = await setStatus(db, { rpcEnabled: true })
    expect(result.activeMappingCount).toBe(1)
    expect(db.rpc).toHaveBeenCalledWith('senda_set_recipe_active', expect.anything())
    expect(db.tables).not.toContain('inventory_movements')
    expect(db.tables).not.toContain('pending_product_mappings')
  })

  it('no expone recetas de otra organización', async () => {
    const db = clients({
      recipes: [{
        id: RECIPE,
        organization_id: OTHER_ORGANIZATION,
        name: 'Ajena',
        active: true,
      }],
    })
    await expect(setStatus(db)).rejects.toMatchObject({
      code: 'RECIPE_NOT_IN_ORG',
      status: 404,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('reintenta sin escribir si ya está en el estado pedido', async () => {
    const db = clients({
      recipes: [{
        id: RECIPE,
        organization_id: ORGANIZATION,
        name: 'Salsa de la casa',
        active: false,
      }],
      mappings: [{ id: MAPPING, recipe_id: RECIPE, active: true }],
    })
    const result = await setStatus(db, {
      body: { active: false, expectedActive: true },
    })
    expect(result).toEqual({
      recipeId: RECIPE,
      active: false,
      replay: true,
      usedBy: [],
      activeMappingCount: 1,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('detecta un cambio concurrente cuando el estado no coincide', async () => {
    const db = clients({
      recipes: [{
        id: RECIPE,
        organization_id: ORGANIZATION,
        name: 'Salsa de la casa',
        active: false,
      }],
    })
    await expect(setStatus(db, { body: { active: true, expectedActive: true } })).rejects.toMatchObject({
      code: 'CONCURRENT_UPDATE',
      status: 409,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('ignora actor y ids forjados en el body', async () => {
    const db = clients({
      rpcData: {
        recipe_id: RECIPE,
        active: false,
        replay: false,
        used_by: [],
        active_mapping_count: 0,
      },
    })
    await setStatus(db, {
      rpcEnabled: true,
      body: {
        ...DEACTIVATE,
        actor_user_id: '99999999-9999-4999-8999-999999999999',
        organization_id: OTHER_ORGANIZATION,
        recipe_id: PARENT_ID,
      },
    })
    expect(db.rpc.mock.calls[0][1].p).toEqual({
      actor_user_id: USER,
      organization_id: ORGANIZATION,
      recipe_id: RECIPE,
      active: false,
      expected_active: true,
    })
  })

  it('exige expectedActive y un pedido válido', async () => {
    const db = clients({})
    await expect(setStatus(db, { body: { active: false } })).rejects.toMatchObject({
      code: 'EXPECTED_REQUIRED',
      status: 400,
    })
    await expect(setStatus(db, { body: { expectedActive: true } })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
      status: 400,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('si el RPC no existe responde 503', async () => {
    const db = clients({
      rpcError: {
        code: 'PGRST202',
        message: 'Could not find the function public.senda_set_recipe_active(p) in the schema cache',
      },
    })
    await expect(setStatus(db, { rpcEnabled: true })).rejects.toMatchObject({
      code: 'RECIPE_STATUS_RPC_MISSING',
      status: 503,
    })
  })
})

describe('isSetRecipeActiveRpcMissing', () => {
  it('detecta ausencia del RPC en el schema cache', () => {
    expect(isSetRecipeActiveRpcMissing({
      code: 'PGRST202',
      message: 'Could not find the function public.senda_set_recipe_active(p) in the schema cache',
    })).toBe(true)
    expect(isSetRecipeActiveRpcMissing({ code: 'P0001', message: 'CONCURRENT_UPDATE' })).toBe(false)
  })
})

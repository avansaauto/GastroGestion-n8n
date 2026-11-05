import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isInventoryInsertDenied } from './inventoryError.js'

const SQL = readFileSync(
  new URL('../../sql/proposed-inventory-products-insert-policy.sql', import.meta.url),
  'utf8',
)
const ANON = readFileSync(
  new URL('../../sql/proposed-inventory-products-anon-revoke.sql', import.meta.url),
  'utf8',
)
const SELECT_SQL = readFileSync(
  new URL('../../sql/proposed-inventory-products-select-policy.sql', import.meta.url),
  'utf8',
)
const RLS = readFileSync(
  new URL('../../sql/proposed-inventory-products-rls.sql', import.meta.url),
  'utf8',
)
const VERIFY = readFileSync(
  new URL('../../sql/verify-inventory-products-insert-policy.sql', import.meta.url),
  'utf8',
)

describe('política INSERT de inventory_products', () => {
  it('crea INSERT autenticado con WITH CHECK y sin GRANT extra', () => {
    expect(SQL).toMatch(/NO EJECUTAR|NO APLICAR/)
    expect(SQL).toMatch(/create policy inventory_products_member_insert/)
    expect(SQL).toMatch(/for insert/)
    expect(SQL).toMatch(/to authenticated/)
    expect(SQL).toMatch(/with check \(/)
    expect(SQL).toMatch(/senda_is_org_inventory_manager\(organization_id\)/)
    expect(SQL).toMatch(/set search_path = pg_catalog/)
    expect(SQL).toMatch(/from public\.organization_members as m/)
    expect(SQL).toMatch(/m\.role in \('admin', 'operator'\)/)
    expect(SQL).toMatch(/m\.status = 'active'/)
    expect(SQL).toMatch(/m\.user_id = p_user_id/)
    expect(SQL).toMatch(/auth\.uid\(\)/)
    expect(SQL).not.toMatch(/grant insert on table public\.inventory_products/i)
    expect(SQL).not.toMatch(/grant select on table public\.inventory_products/i)
    expect(SQL).not.toMatch(/grant update on table public\.inventory_products/i)
    expect(SQL).not.toMatch(/grant delete on table public\.inventory_products/i)
    expect(SQL).not.toMatch(/for select/i)
    expect(SQL).not.toMatch(/for update/i)
    expect(SQL).not.toMatch(/for delete/i)
    expect(SQL).not.toMatch(/disable row level security/i)
    expect(SQL).not.toMatch(/create or replace function public\.senda_is_purchase_member/)
    expect(SQL).not.toMatch(/insert into public\.inventory_movements/i)
    expect(SQL).not.toMatch(/insert into public\.location_inventory/i)
    expect(SQL).not.toMatch(/revoke insert on table public\.inventory_products from anon/)
  })

  it('restringe EXECUTE y no deja suplantar el actor desde authenticated', () => {
    expect(SQL).toMatch(/security definer/)
    expect(SQL).toMatch(/revoke all on function public\.senda_actor_is_org_inventory_manager\(uuid, uuid\)/)
    expect(SQL).toMatch(/from public, anon, authenticated, service_role/)
    expect(SQL).toMatch(/grant execute on function public\.senda_is_org_inventory_manager\(uuid\) to authenticated/)
    expect(SQL).not.toMatch(/grant execute on function public\.senda_actor_is_org_inventory_manager/)
    expect(SQL).not.toMatch(/m\.user_id = current_user/)
    expect(SQL).not.toMatch(/p_user_id :=/)
  })

  it('separa el revoco de anon y no lo aplica con el INSERT', () => {
    expect(ANON).toMatch(/NO EJECUTAR/)
    expect(ANON).toMatch(/NO APLICAR automáticamente/)
    expect(ANON).toMatch(/revoke insert on table public\.inventory_products from anon, public/)
    expect(ANON).not.toMatch(/revoke insert on table public\.inventory_products from authenticated/)
  })

  it('SELECT queda acotado a membresía activa, sin rol de alta ni UPDATE/DELETE', () => {
    expect(SELECT_SQL).toMatch(/NO EJECUTAR/)
    expect(SELECT_SQL).toMatch(/create policy inventory_products_member_select/)
    expect(SELECT_SQL).toMatch(/for select/)
    expect(SELECT_SQL).toMatch(/to authenticated/)
    expect(SELECT_SQL).toMatch(/using \(/)
    expect(SELECT_SQL).toMatch(/senda_is_org_active_member\(organization_id\)/)
    expect(SELECT_SQL).toMatch(/m\.status = 'active'/)
    expect(SELECT_SQL).toMatch(/m\.user_id = p_user_id/)
    expect(SELECT_SQL).not.toMatch(/m\.role in \('admin', 'operator'\)/)
    expect(SELECT_SQL).not.toMatch(/for insert/i)
    expect(SELECT_SQL).not.toMatch(/for update/i)
    expect(SELECT_SQL).not.toMatch(/for delete/i)
    expect(SELECT_SQL).not.toMatch(/grant select on table public\.inventory_products/i)
    expect(SELECT_SQL).not.toMatch(/grant execute on function public\.senda_actor_is_org_active_member/)
  })

  it('aplica SELECT e INSERT juntos, con dueño clonado y sin DML', () => {
    expect(RLS).toMatch(/^\s*begin;/m)
    expect(RLS).toMatch(/^\s*commit;/m)
    expect(RLS).toMatch(/inventory_products_member_insert/)
    expect(RLS).toMatch(/inventory_products_member_select/)
    expect(RLS).toMatch(/senda_is_org_inventory_manager\(organization_id\)/)
    expect(RLS).toMatch(/senda_is_org_active_member\(organization_id\)/)
    expect(RLS).toMatch(/alter function public\.senda_is_org_inventory_manager\(uuid\) owner to/)
    expect(RLS).toMatch(/alter function public\.senda_is_org_active_member\(uuid\) owner to/)
    expect(RLS).toMatch(/proname = 'senda_is_purchase_member'/)
    expect(RLS).not.toMatch(/create policy inventory_products_\w+ on public\.inventory_products\s+for update/i)
    expect(RLS).not.toMatch(/create policy inventory_products_\w+ on public\.inventory_products\s+for delete/i)
    expect(RLS).not.toMatch(/insert into public\.inventory_products/i)
    expect(RLS).not.toMatch(/insert into public\.inventory_movements/i)
    expect(RLS).not.toMatch(/grant insert on table public\.inventory_products/i)
    expect(RLS).not.toMatch(/grant select on table public\.inventory_products/i)
    expect(RLS).not.toMatch(/create or replace function public\.senda_is_purchase_member/)
  })

  it('la verificación posterior es de solo lectura', () => {
    expect(VERIFY).toMatch(/SOLO LECTURA/)
    expect(VERIFY).not.toMatch(/^\s*(create|alter|drop|grant|revoke|insert|update|delete)\b/im)
  })
})

describe('clasificación del rechazo de INSERT', () => {
  it('trata GRANT faltante y RLS como CREATE_NOT_ALLOWED', () => {
    expect(isInventoryInsertDenied({
      code: '42501',
      message: 'permission denied for table inventory_products',
    })).toBe(true)
    expect(isInventoryInsertDenied({
      code: '42501',
      message: 'new row violates row-level security policy for table "inventory_products"',
    })).toBe(true)
    expect(isInventoryInsertDenied({
      code: '23514',
      message: 'new row for relation "inventory_products" violates check constraint',
    })).toBe(false)
  })
})

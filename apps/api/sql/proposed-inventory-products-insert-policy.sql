-- SENDA OPS — Paso 318
-- SQL DEFINITIVO DE POLÍTICA INSERT. NO EJECUTAR. NO APLICAR sin autorización.
--
-- Confirmado en inspección real:
--   inventory_products: RLS on, 0 políticas.
--   authenticated ya tiene GRANT INSERT.
--   anon también tiene GRANT INSERT (endurecimiento aparte; no va en este script).
--   organization_members tiene RLS + política SELECT: por eso la membresía
--   se resuelve en SECURITY DEFINER, no con un EXISTS INVOKER.
--
-- Este script:
--   - no concede GRANT INSERT
--   - no toca UPDATE/DELETE/SELECT
--   - no modifica senda_* de compras
--   - no escribe location_inventory ni inventory_movements

-- 0. Guardia: no apilar otra política INSERT.
do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_products'
      and cmd = 'INSERT'
  ) then
    raise exception 'INVENTORY_PRODUCTS_INSERT_POLICY_EXISTS';
  end if;
end $$;

-- 1. Membresía DEFINER a nivel organización.
--    authenticated no puede pasar un user_id arbitrario: no tiene EXECUTE
--    de la función actor. El wrapper fija p_user_id = auth.uid().
create or replace function public.senda_actor_is_org_inventory_manager(
  p_organization_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.organization_members as m
    where m.organization_id = p_organization_id
      and p_user_id is not null
      and m.user_id = p_user_id
      and m.status = 'active'
      and m.role in ('admin', 'operator')
  );
$$;

create or replace function public.senda_is_org_inventory_manager(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select public.senda_actor_is_org_inventory_manager(p_organization_id, auth.uid());
$$;

revoke all on function public.senda_actor_is_org_inventory_manager(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.senda_is_org_inventory_manager(uuid)
  from public, anon, service_role;
grant execute on function public.senda_is_org_inventory_manager(uuid) to authenticated;

-- 2. Política INSERT. WITH CHECK sobre la org de la fila, no del cliente HTTP.
create policy inventory_products_member_insert
on public.inventory_products
for insert
to authenticated
with check (
  public.senda_is_org_inventory_manager(organization_id)
);

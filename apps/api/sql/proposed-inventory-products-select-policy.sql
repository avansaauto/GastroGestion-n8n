-- SENDA OPS — Paso 319
-- SQL COMPLETO DE POLÍTICA SELECT. NO EJECUTAR. NO APLICAR sin autorización.
--
-- Listado actual: RLS on + 0 políticas ⇒ SELECT autenticado devuelve 0 filas
-- (el catálogo vacío no es falta de GRANT SELECT: authenticated ya lo tiene).
--
-- Alcance: solo filas cuyo organization_id tenga membresía activa de auth.uid().
-- No filtra por admin/operator: leer catálogo ≠ crear insumos.
-- INSERT sigue exigiendo admin/operator vía senda_is_org_inventory_manager.
-- Un admin/operator activo satisface ambas ⇒ .insert().select() ve la fila.
--
-- DEFINER: organization_members solo deja ver la fila del propio usuario;
-- la función lee membresía como dueño para no depender de esa política
-- ni recursionar sobre inventory_products.
--
-- No GRANT SELECT (ya existe). No UPDATE. No DELETE. No toca compras.

-- 0. Guardia: no apilar otra política SELECT.
do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_products'
      and cmd = 'SELECT'
  ) then
    raise exception 'INVENTORY_PRODUCTS_SELECT_POLICY_EXISTS';
  end if;
end $$;

-- 1. Membresía activa DEFINER (sin rol). authenticated no EXECUTE del actor.
create or replace function public.senda_actor_is_org_active_member(
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
  );
$$;

create or replace function public.senda_is_org_active_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select public.senda_actor_is_org_active_member(p_organization_id, auth.uid());
$$;

revoke all on function public.senda_actor_is_org_active_member(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.senda_is_org_active_member(uuid)
  from public, anon, service_role;
grant execute on function public.senda_is_org_active_member(uuid) to authenticated;

-- 2. Política SELECT. USING sobre la org de la fila.
create policy inventory_products_member_select
on public.inventory_products
for select
to authenticated
using (
  public.senda_is_org_active_member(organization_id)
);

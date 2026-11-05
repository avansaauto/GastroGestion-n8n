-- SENDA OPS — Paso 319
-- APLICACIÓN CONJUNTA INSERT + SELECT. NO EJECUTAR. NO APLICAR sin autorización.
-- Una sola transacción. Sin DML. Sin GRANT extra. Sin UPDATE/DELETE.
-- Sin revoco de anon (archivo aparte). Sin modificar senda_* de compras.
--
-- Pegar el bloque entero en el SQL Editor de SENDA (no GastroGest).

begin;

-- Guardias: no apilar políticas.
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'inventory_products' and cmd = 'INSERT'
  ) then
    raise exception 'INVENTORY_PRODUCTS_INSERT_POLICY_EXISTS';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'inventory_products' and cmd = 'SELECT'
  ) then
    raise exception 'INVENTORY_PRODUCTS_SELECT_POLICY_EXISTS';
  end if;
end $$;

-- INSERT: admin/operator activo de la org de la fila.
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

-- SELECT: cualquier membresía activa de esa org (incluye admin/operator).
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

-- Propietario = el de senda_is_purchase_member (DEFINER que ya funciona).
do $$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'senda_is_purchase_member'
  order by p.oid
  limit 1;

  if v_owner is null then
    raise exception 'PURCHASE_MEMBER_FN_MISSING';
  end if;

  execute format(
    'alter function public.senda_actor_is_org_inventory_manager(uuid, uuid) owner to %I',
    v_owner
  );
  execute format(
    'alter function public.senda_is_org_inventory_manager(uuid) owner to %I',
    v_owner
  );
  execute format(
    'alter function public.senda_actor_is_org_active_member(uuid, uuid) owner to %I',
    v_owner
  );
  execute format(
    'alter function public.senda_is_org_active_member(uuid) owner to %I',
    v_owner
  );
end $$;

revoke all on function public.senda_actor_is_org_inventory_manager(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.senda_actor_is_org_active_member(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.senda_is_org_inventory_manager(uuid)
  from public, anon, service_role;
revoke all on function public.senda_is_org_active_member(uuid)
  from public, anon, service_role;
grant execute on function public.senda_is_org_inventory_manager(uuid) to authenticated;
grant execute on function public.senda_is_org_active_member(uuid) to authenticated;

create policy inventory_products_member_insert
on public.inventory_products
for insert
to authenticated
with check (
  public.senda_is_org_inventory_manager(organization_id)
);

create policy inventory_products_member_select
on public.inventory_products
for select
to authenticated
using (
  public.senda_is_org_active_member(organization_id)
);

-- Verificación en la misma transacción. Si falla, ROLLBACK. Sin DML.
do $$
declare
  v_insert int;
  v_select int;
  v_write int;
begin
  select count(*) into v_insert
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'inventory_products'
    and cmd = 'INSERT'
    and policyname = 'inventory_products_member_insert';

  select count(*) into v_select
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'inventory_products'
    and cmd = 'SELECT'
    and policyname = 'inventory_products_member_select';

  select count(*) into v_write
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'inventory_products'
    and cmd in ('UPDATE', 'DELETE', 'ALL');

  if v_insert <> 1 or v_select <> 1 then
    raise exception 'INVENTORY_PRODUCTS_POLICY_VERIFY_FAILED';
  end if;
  if v_write <> 0 then
    raise exception 'INVENTORY_PRODUCTS_WRITE_POLICY_NOT_ALLOWED';
  end if;
end $$;

commit;

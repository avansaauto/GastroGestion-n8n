-- SENDA OPS — Paso 406
-- POLÍTICAS SELECT DE RECETAS. NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA → SQL Editor.
-- Pegar el archivo entero. Una transacción. Si un guardia falla, ROLLBACK.
--
-- Objetivo: JWT + RLS lee recipes, recipe_components y sales_product_mappings.
-- authenticated: únicamente SELECT. anon: nada. service_role: no se toca.
--
-- Reutiliza senda_is_org_active_member (ya existe, DEFINER, EXECUTE de
-- authenticated). No la recrea. No otorga EXECUTE. No usa
-- senda_is_purchase_member ni senda_is_org_inventory_manager.
--
-- Confirmado en Supabase: service_role tiene SELECT/INSERT/UPDATE/DELETE
-- directos. No hay GRANT a PUBLIC. Este script no nombra service_role en
-- GRANT ni REVOKE.
--
-- Reaplicación: si ya hay políticas en esas tablas, aborta
-- (RECIPES_SELECT_POLICY_EXISTS). No apila. No hace DROP silencioso.

begin;

-- =============================================================================
-- 0. Guardias
-- =============================================================================
do $guard$
declare
  missing text;
  existing_policies int;
  service_ok boolean;
begin
  if to_regprocedure('public.senda_is_org_active_member(uuid)') is null then
    raise exception 'RECIPES_SELECT_ABORT: falta senda_is_org_active_member(uuid).';
  end if;

  select string_agg(t.table_name, ', ' order by 1)
    into missing
  from (
    values
      ('recipes'),
      ('recipe_components'),
      ('sales_product_mappings')
  ) as t(table_name)
  where to_regclass(format('public.%I', t.table_name)) is null;
  if missing is not null then
    raise exception 'RECIPES_SELECT_ABORT: faltan tablas: %', missing;
  end if;

  select
    has_table_privilege('service_role', 'public.recipes', 'SELECT')
    and has_table_privilege('service_role', 'public.recipes', 'INSERT')
    and has_table_privilege('service_role', 'public.recipes', 'UPDATE')
    and has_table_privilege('service_role', 'public.recipes', 'DELETE')
    and has_table_privilege('service_role', 'public.recipe_components', 'SELECT')
    and has_table_privilege('service_role', 'public.recipe_components', 'INSERT')
    and has_table_privilege('service_role', 'public.recipe_components', 'UPDATE')
    and has_table_privilege('service_role', 'public.recipe_components', 'DELETE')
    and has_table_privilege('service_role', 'public.sales_product_mappings', 'SELECT')
    and has_table_privilege('service_role', 'public.sales_product_mappings', 'INSERT')
    and has_table_privilege('service_role', 'public.sales_product_mappings', 'UPDATE')
    and has_table_privilege('service_role', 'public.sales_product_mappings', 'DELETE')
  into service_ok;
  if not coalesce(service_ok, false) then
    raise exception 'RECIPES_SELECT_ABORT: service_role no tiene SELECT/INSERT/UPDATE/DELETE directos. No aplicar.';
  end if;

  select count(*)
    into existing_policies
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename in (
      'recipes',
      'recipe_components',
      'sales_product_mappings'
    );
  if existing_policies > 0 then
    raise exception 'RECIPES_SELECT_POLICY_EXISTS';
  end if;
end
$guard$;

-- RLS ya está activo. enable es idempotente; no lo desactiva.
alter table public.recipes enable row level security;
alter table public.recipe_components enable row level security;
alter table public.sales_product_mappings enable row level security;

-- public/anon: defensa. No hay GRANT a PUBLIC confirmado; no nombra service_role.
revoke all on table public.recipes from public, anon;
revoke all on table public.recipe_components from public, anon;
revoke all on table public.sales_product_mappings from public, anon;

-- authenticated: quitar INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN
-- y cualquier otro privilegio de tabla; dejar solo SELECT.
revoke all on table public.recipes from authenticated;
revoke all on table public.recipe_components from authenticated;
revoke all on table public.sales_product_mappings from authenticated;

grant select on table public.recipes to authenticated;
grant select on table public.recipe_components to authenticated;
grant select on table public.sales_product_mappings to authenticated;

-- =============================================================================
-- 1. recipes: miembro activo de organization_id
-- =============================================================================
create policy recipes_member_select
on public.recipes
for select
to authenticated
using (
  public.senda_is_org_active_member(organization_id)
);

-- =============================================================================
-- 2. recipe_components: la receta padre es de una org visible
-- =============================================================================
create policy recipe_components_member_select
on public.recipe_components
for select
to authenticated
using (
  exists (
    select 1
    from public.recipes as r
    where r.id = recipe_id
      and public.senda_is_org_active_member(r.organization_id)
  )
);

-- =============================================================================
-- 3. sales_product_mappings: el local es de una org con membresía activa
-- =============================================================================
create policy sales_product_mappings_member_select
on public.sales_product_mappings
for select
to authenticated
using (
  exists (
    select 1
    from public.locations as l
    where l.id = location_id
      and public.senda_is_org_active_member(l.organization_id)
  )
);

-- =============================================================================
-- 4. Verificación en la misma transacción. Si falla, ROLLBACK.
-- =============================================================================
do $verify$
declare
  v_select int;
  v_write int;
  v_rls int;
  v_auth_extra int;
  v_auth_select int;
  v_service_ok boolean;
begin
  select count(*) into v_select
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename in (
      'recipes',
      'recipe_components',
      'sales_product_mappings'
    )
    and cmd = 'SELECT'
    and policyname in (
      'recipes_member_select',
      'recipe_components_member_select',
      'sales_product_mappings_member_select'
    );

  select count(*) into v_write
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename in (
      'recipes',
      'recipe_components',
      'sales_product_mappings'
    )
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');

  select count(*) into v_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity
    and c.relname in (
      'recipes',
      'recipe_components',
      'sales_product_mappings'
    );

  select count(*) into v_auth_select
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname in (
      'recipes',
      'recipe_components',
      'sales_product_mappings'
    )
    and r.rolname = 'authenticated'
    and a.privilege_type = 'SELECT';

  select count(*) into v_auth_extra
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname in (
      'recipes',
      'recipe_components',
      'sales_product_mappings'
    )
    and r.rolname = 'authenticated'
    and a.privilege_type <> 'SELECT';

  select
    has_table_privilege('service_role', 'public.recipes', 'SELECT')
    and has_table_privilege('service_role', 'public.recipes', 'INSERT')
    and has_table_privilege('service_role', 'public.recipes', 'UPDATE')
    and has_table_privilege('service_role', 'public.recipes', 'DELETE')
    and has_table_privilege('service_role', 'public.recipe_components', 'SELECT')
    and has_table_privilege('service_role', 'public.recipe_components', 'INSERT')
    and has_table_privilege('service_role', 'public.recipe_components', 'UPDATE')
    and has_table_privilege('service_role', 'public.recipe_components', 'DELETE')
    and has_table_privilege('service_role', 'public.sales_product_mappings', 'SELECT')
    and has_table_privilege('service_role', 'public.sales_product_mappings', 'INSERT')
    and has_table_privilege('service_role', 'public.sales_product_mappings', 'UPDATE')
    and has_table_privilege('service_role', 'public.sales_product_mappings', 'DELETE')
  into v_service_ok;

  if v_select <> 3 then
    raise exception 'RECIPES_SELECT_POLICY_VERIFY_FAILED';
  end if;
  if v_write <> 0 then
    raise exception 'RECIPES_WRITE_POLICY_NOT_ALLOWED';
  end if;
  if v_rls <> 3 then
    raise exception 'RECIPES_RLS_REQUIRED';
  end if;
  if v_auth_select <> 3 then
    raise exception 'RECIPES_AUTH_SELECT_REQUIRED';
  end if;
  if v_auth_extra <> 0 then
    raise exception 'RECIPES_AUTH_EXTRA_PRIVILEGE';
  end if;
  if not coalesce(v_service_ok, false) then
    raise exception 'RECIPES_SERVICE_ROLE_GRANTS_CHANGED';
  end if;
end
$verify$;

commit;

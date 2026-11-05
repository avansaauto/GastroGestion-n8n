-- SENDA OPS — Pasos 428 y 429
-- Verificación de SOLO LECTURA tras aplicar proposed-senda-create-recipe.sql.
-- No modifica tablas, políticas, grants ni datos. No llama el RPC.
-- Si un chequeo falla, el bloque final aborta.

select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.proconfig as search_path_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'senda_create_recipe'
order by arguments;

select
  r.rolname as grantee,
  has_function_privilege(
    r.oid,
    'public.senda_create_recipe(jsonb)',
    'EXECUTE'
  ) as has_execute
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  r.rolname as grantee,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') as has_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public'
  and p.proname in (
    'senda_require_backend_actor'
  )
  and r.rolname in ('anon', 'authenticated', 'service_role')
order by p.proname, arguments, r.rolname;

select
  'definer' as check_id,
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure('public.senda_create_recipe(jsonb)')
      and p.prosecdef
  ) as ok
union all
select
  'execute_service_only',
  to_regprocedure('public.senda_create_recipe(jsonb)') is not null
    and has_function_privilege('service_role', 'public.senda_create_recipe(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.senda_create_recipe(jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.senda_create_recipe(jsonb)', 'EXECUTE')
union all
select
  'actor_still_closed',
  not has_function_privilege(
    'service_role',
    'public.senda_require_backend_actor(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.senda_require_backend_actor(uuid)',
    'EXECUTE'
  )
union all
select
  'no_fudo_or_stock_in_body',
  pg_get_functiondef('public.senda_create_recipe(jsonb)'::regprocedure)
    not ilike '%register_sale_consumption%'
  and pg_get_functiondef('public.senda_create_recipe(jsonb)'::regprocedure)
    not ilike '%resolve_pending_product_mappings%'
  and pg_get_functiondef('public.senda_create_recipe(jsonb)'::regprocedure)
    not ilike '%pending_product_mappings%'
  and pg_get_functiondef('public.senda_create_recipe(jsonb)'::regprocedure)
    not ilike '%sales_product_mappings%'
  and pg_get_functiondef('public.senda_create_recipe(jsonb)'::regprocedure)
    not ilike '%inventory_movements%'
  and pg_get_functiondef('public.senda_create_recipe(jsonb)'::regprocedure)
    not ilike '%location_inventory%'
union all
select
  'categories_table',
  to_regclass('public.recipe_categories') is not null
union all
select
  'recipes_category_id',
  exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'recipes'
      and c.column_name = 'category_id'
  )
union all
select
  'categories_rls',
  exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'recipe_categories'
      and c.relrowsecurity
  )
union all
select
  'categories_select_only',
  exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_categories'
      and cmd = 'SELECT'
      and policyname = 'recipe_categories_member_select'
  )
  and not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_categories'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
union all
select
  'categories_grants',
  has_table_privilege('authenticated', 'public.recipe_categories', 'SELECT')
    and not has_table_privilege('authenticated', 'public.recipe_categories', 'INSERT')
    and not has_table_privilege('authenticated', 'public.recipe_categories', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.recipe_categories', 'DELETE')
    and not has_table_privilege('anon', 'public.recipe_categories', 'SELECT')
    and not has_table_privilege('anon', 'public.recipe_categories', 'INSERT')
union all
select
  'categories_unique_ci',
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'recipe_categories'
      and indexdef ilike '%unique%'
      and indexdef ilike '%lower(btrim(name))%'
  )
union all
select
  'recipes_category_org_fk',
  exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public'
      and rel.relname = 'recipes'
      and con.conname = 'recipes_category_organization_fk'
      and con.contype = 'f'
  )
union all
select
  'creates_category_in_rpc',
  pg_get_functiondef('public.senda_create_recipe(jsonb)'::regprocedure)
    ilike '%insert into public.recipe_categories%';

do $assert$
declare
  failed text;
begin
  select string_agg(check_id, ', ' order by 1)
    into failed
  from (
    select 'definer' as check_id
    where not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.oid = to_regprocedure('public.senda_create_recipe(jsonb)')
        and p.prosecdef
    )
    union all
    select 'execute_service_only'
    where not (
      to_regprocedure('public.senda_create_recipe(jsonb)') is not null
      and has_function_privilege('service_role', 'public.senda_create_recipe(jsonb)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.senda_create_recipe(jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.senda_create_recipe(jsonb)', 'EXECUTE')
    )
    union all
    select 'actor_still_closed'
    where has_function_privilege('service_role', 'public.senda_require_backend_actor(uuid)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.senda_require_backend_actor(uuid)', 'EXECUTE')
    union all
    select 'categories_table'
    where to_regclass('public.recipe_categories') is null
    union all
    select 'recipes_category_id'
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'recipes'
        and c.column_name = 'category_id'
    )
    union all
    select 'categories_unique_ci'
    where not exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'recipe_categories'
        and indexdef ilike '%unique%'
        and indexdef ilike '%lower(btrim(name))%'
    )
    union all
    select 'recipes_category_org_fk'
    where not exists (
      select 1
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = 'public'
        and rel.relname = 'recipes'
        and con.conname = 'recipes_category_organization_fk'
        and con.contype = 'f'
    )
    union all
    select 'categories_grants'
    where not (
      has_table_privilege('authenticated', 'public.recipe_categories', 'SELECT')
      and not has_table_privilege('authenticated', 'public.recipe_categories', 'INSERT')
      and not has_table_privilege('authenticated', 'public.recipe_categories', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.recipe_categories', 'DELETE')
      and not has_table_privilege('anon', 'public.recipe_categories', 'SELECT')
      and not has_table_privilege('anon', 'public.recipe_categories', 'INSERT')
    )
  ) s;
  if failed is not null then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: %', failed;
  end if;
end
$assert$;

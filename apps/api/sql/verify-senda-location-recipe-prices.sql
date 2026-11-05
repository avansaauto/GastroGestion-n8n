-- SENDA OPS — Paso 442
-- Verificación de SOLO LECTURA tras aplicar proposed-senda-location-recipe-prices.sql.
-- No modifica tablas, políticas, grants ni datos. No llama el RPC.
-- Si un chequeo falla, el bloque final aborta.

select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname = 'location_recipe_prices';

select
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.numeric_precision,
  c.numeric_scale
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name = 'location_recipe_prices'
order by c.ordinal_position;

select
  con.conname,
  con.contype,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'public'
  and rel.relname = 'location_recipe_prices'
order by con.contype, con.conname;

select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.proconfig as search_path_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'senda_set_location_recipe_price'
order by arguments;

select
  r.rolname as grantee,
  has_function_privilege(
    r.oid,
    'public.senda_set_location_recipe_price(jsonb)',
    'EXECUTE'
  ) as has_execute
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

select
  'table_exists' as check_id,
  to_regclass('public.location_recipe_prices') is not null as ok
union all
select
  'rls_enabled',
  exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'location_recipe_prices'
      and c.relrowsecurity
  )
union all
select
  'select_policy_only',
  exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'location_recipe_prices'
      and cmd = 'SELECT'
      and policyname = 'location_recipe_prices_member_select'
  )
  and not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'location_recipe_prices'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
union all
select
  'table_grants',
  has_table_privilege('authenticated', 'public.location_recipe_prices', 'SELECT')
    and not has_table_privilege('authenticated', 'public.location_recipe_prices', 'INSERT')
    and not has_table_privilege('authenticated', 'public.location_recipe_prices', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.location_recipe_prices', 'DELETE')
    and not has_table_privilege('anon', 'public.location_recipe_prices', 'SELECT')
    and has_table_privilege('service_role', 'public.location_recipe_prices', 'SELECT')
    and has_table_privilege('service_role', 'public.location_recipe_prices', 'INSERT')
    and has_table_privilege('service_role', 'public.location_recipe_prices', 'UPDATE')
    and not has_table_privilege('service_role', 'public.location_recipe_prices', 'DELETE')
union all
select
  'unique_location_recipe',
  exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public'
      and rel.relname = 'location_recipe_prices'
      and con.contype = 'u'
      and pg_get_constraintdef(con.oid) ilike '%location_id%'
      and pg_get_constraintdef(con.oid) ilike '%recipe_id%'
  )
union all
select
  'sale_price_positive',
  exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public'
      and rel.relname = 'location_recipe_prices'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%sale_price > 0%'
  )
union all
select
  'composite_fks',
  exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public'
      and rel.relname = 'location_recipe_prices'
      and con.conname = 'location_recipe_prices_location_org_fk'
  )
  and exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public'
      and rel.relname = 'location_recipe_prices'
      and con.conname = 'location_recipe_prices_recipe_org_fk'
  )
union all
select
  'no_price_on_recipes',
  not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'recipes'
      and c.column_name in ('sale_price', 'precio_venta', 'precio', 'price')
  )
union all
select
  'definer',
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure('public.senda_set_location_recipe_price(jsonb)')
      and p.prosecdef
  )
union all
select
  'execute_service_only',
  to_regprocedure('public.senda_set_location_recipe_price(jsonb)') is not null
    and has_function_privilege('service_role', 'public.senda_set_location_recipe_price(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.senda_set_location_recipe_price(jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.senda_set_location_recipe_price(jsonb)', 'EXECUTE')
union all
select
  'writes_only_price_table',
  pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    ilike '%insert into public.location_recipe_prices%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    ilike '%update public.location_recipe_prices%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    not ilike '%update public.recipes%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    not ilike '%delete from public.location_recipe_prices%'
union all
select
  'concurrency',
  pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    ilike '%EXPECTED_REQUIRED%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    ilike '%CONCURRENT_UPDATE%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    ilike '%expected_version%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    ilike '%if not found%'
union all
select
  'sale_price_bounds',
  pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    ilike '%9999999999.99%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    ilike '%round(%'
union all
select
  'keeps_inactive_price',
  pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    ilike '%RECIPE_INACTIVE%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    not ilike '%delete from public.location_recipe_prices%'
union all
select
  'no_fudo_or_stock',
  pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    not ilike '%pending_product_mappings%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    not ilike '%register_sale_consumption%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    not ilike '%inventory_movements%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    not ilike '%insert into public.sales_product_mappings%'
  and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
    not ilike '%update public.sales_product_mappings%'
union all
select
  'does_not_replace_recipe_rpcs',
  to_regprocedure('public.senda_create_recipe(jsonb)') is not null
  and to_regprocedure('public.senda_update_recipe(jsonb)') is not null
  and to_regprocedure('public.senda_set_recipe_active(jsonb)') is not null
  and to_regprocedure('public.senda_save_fudo_recipe(jsonb)') is not null;

do $assert$
declare
  failed text;
begin
  select string_agg(check_id, ', ' order by 1)
    into failed
  from (
    select
      'table_exists' as check_id,
      to_regclass('public.location_recipe_prices') is not null as ok
    union all
    select
      'rls_enabled',
      exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'location_recipe_prices'
          and c.relrowsecurity
      )
    union all
    select
      'select_policy_only',
      exists (
        select 1 from pg_catalog.pg_policies
        where schemaname = 'public'
          and tablename = 'location_recipe_prices'
          and cmd = 'SELECT'
          and policyname = 'location_recipe_prices_member_select'
      )
      and not exists (
        select 1 from pg_catalog.pg_policies
        where schemaname = 'public'
          and tablename = 'location_recipe_prices'
          and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      )
    union all
    select
      'table_grants',
      has_table_privilege('authenticated', 'public.location_recipe_prices', 'SELECT')
        and not has_table_privilege('authenticated', 'public.location_recipe_prices', 'INSERT')
        and not has_table_privilege('authenticated', 'public.location_recipe_prices', 'DELETE')
        and not has_table_privilege('anon', 'public.location_recipe_prices', 'SELECT')
    union all
    select
      'unique_location_recipe',
      exists (
        select 1 from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace n on n.oid = rel.relnamespace
        where n.nspname = 'public'
          and rel.relname = 'location_recipe_prices'
          and con.contype = 'u'
          and pg_get_constraintdef(con.oid) ilike '%(location_id, recipe_id)%'
      )
    union all
    select
      'sale_price_positive',
      exists (
        select 1 from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace n on n.oid = rel.relnamespace
        where n.nspname = 'public'
          and rel.relname = 'location_recipe_prices'
          and con.contype = 'c'
          and pg_get_constraintdef(con.oid) ilike '%sale_price > 0%'
      )
    union all
    select
      'no_price_on_recipes',
      not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name = 'recipes'
          and c.column_name in ('sale_price', 'precio_venta', 'precio', 'price')
      )
    union all
    select
      'execute_service_only',
      to_regprocedure('public.senda_set_location_recipe_price(jsonb)') is not null
        and has_function_privilege('service_role', 'public.senda_set_location_recipe_price(jsonb)', 'EXECUTE')
        and not has_function_privilege('authenticated', 'public.senda_set_location_recipe_price(jsonb)', 'EXECUTE')
        and not has_function_privilege('anon', 'public.senda_set_location_recipe_price(jsonb)', 'EXECUTE')
    union all
    select
      'keeps_inactive_price',
      pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
        ilike '%RECIPE_INACTIVE%'
      and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
        not ilike '%delete from public.location_recipe_prices%'
    union all
    select
      'no_fudo_or_stock',
      pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
        not ilike '%pending_product_mappings%'
      and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
        not ilike '%register_sale_consumption%'
      and pg_get_functiondef('public.senda_set_location_recipe_price(jsonb)'::regprocedure)
        not ilike '%update public.sales_product_mappings%'
  ) checks
  where ok is not true;
  if failed is not null then
    raise exception 'RECIPE_PRICE_VERIFY_FAILED: %', failed;
  end if;
end
$assert$;

-- SENDA OPS — Paso 437
-- Verificación de SOLO LECTURA tras aplicar proposed-senda-set-recipe-active.sql.
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
  and p.proname = 'senda_set_recipe_active'
order by arguments;

select
  r.rolname as grantee,
  has_function_privilege(
    r.oid,
    'public.senda_set_recipe_active(jsonb)',
    'EXECUTE'
  ) as has_execute
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

select
  'definer' as check_id,
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure('public.senda_set_recipe_active(jsonb)')
      and p.prosecdef
  ) as ok
union all
select
  'execute_service_only',
  to_regprocedure('public.senda_set_recipe_active(jsonb)') is not null
    and has_function_privilege('service_role', 'public.senda_set_recipe_active(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.senda_set_recipe_active(jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.senda_set_recipe_active(jsonb)', 'EXECUTE')
union all
select
  'sets_active_only',
  pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    ilike '%update public.recipes%'
  and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    ilike '%set active = v_desired%'
union all
select
  'blocks_active_parents',
  pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    ilike '%RECIPE_IN_USE%'
  and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    ilike '%component_recipe_id%'
union all
select
  'concurrency',
  pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    ilike '%EXPECTED_REQUIRED%'
  and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    ilike '%CONCURRENT_UPDATE%'
union all
select
  'keeps_bom_and_fudo',
  pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    not ilike '%delete from public.recipes%'
  and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    not ilike '%delete from public.recipe_components%'
  and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    not ilike '%insert into public.sales_product_mappings%'
  and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    not ilike '%update public.sales_product_mappings%'
  and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    not ilike '%delete from public.sales_product_mappings%'
union all
select
  'no_stock_or_pending_writes',
  pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    not ilike '%pending_product_mappings%'
  and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    not ilike '%register_sale_consumption%'
  and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
    not ilike '%inventory_movements%'
union all
select
  'does_not_replace_create_update_or_fudo',
  to_regprocedure('public.senda_create_recipe(jsonb)') is not null
  and to_regprocedure('public.senda_update_recipe(jsonb)') is not null
  and to_regprocedure('public.senda_save_fudo_recipe(jsonb)') is not null;

do $assert$
declare
  failed text;
begin
  select string_agg(check_id, ', ' order by 1)
    into failed
  from (
    select
      'definer' as check_id,
      exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.oid = to_regprocedure('public.senda_set_recipe_active(jsonb)')
          and p.prosecdef
      ) as ok
    union all
    select
      'execute_service_only',
      to_regprocedure('public.senda_set_recipe_active(jsonb)') is not null
        and has_function_privilege('service_role', 'public.senda_set_recipe_active(jsonb)', 'EXECUTE')
        and not has_function_privilege('authenticated', 'public.senda_set_recipe_active(jsonb)', 'EXECUTE')
        and not has_function_privilege('anon', 'public.senda_set_recipe_active(jsonb)', 'EXECUTE')
    union all
    select
      'keeps_bom_and_fudo',
      pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
        not ilike '%delete from public.recipe_components%'
      and pg_get_functiondef('public.senda_set_recipe_active(jsonb)'::regprocedure)
        not ilike '%update public.sales_product_mappings%'
  ) checks
  where ok is not true;
  if failed is not null then
    raise exception 'RECIPE_STATUS_VERIFY_FAILED: %', failed;
  end if;
end
$assert$;

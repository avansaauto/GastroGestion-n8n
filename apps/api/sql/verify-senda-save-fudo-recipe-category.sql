-- SENDA OPS — Paso 432
-- Verificación de SOLO LECTURA tras aplicar
-- proposed-senda-save-fudo-recipe-category.sql.
-- No modifica tablas, políticas, grants ni datos. No llama el RPC.

select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.proconfig as search_path_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'senda_save_fudo_recipe'
order by arguments;

select
  r.rolname as grantee,
  has_function_privilege(
    r.oid,
    'public.senda_save_fudo_recipe(jsonb)',
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
      and p.oid = to_regprocedure('public.senda_save_fudo_recipe(jsonb)')
      and p.prosecdef
  ) as ok
union all
select
  'execute_service_only',
  to_regprocedure('public.senda_save_fudo_recipe(jsonb)') is not null
    and has_function_privilege('service_role', 'public.senda_save_fudo_recipe(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.senda_save_fudo_recipe(jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.senda_save_fudo_recipe(jsonb)', 'EXECUTE')
union all
select
  'actor_still_closed',
  not has_function_privilege(
    'service_role',
    'public.senda_actor_is_purchase_member(uuid, uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.senda_actor_is_purchase_member(uuid, uuid)',
    'EXECUTE'
  )
union all
select
  'create_resolves_category',
  pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%CATEGORY_NOT_IN_ORG%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%CATEGORY_CONFLICT%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%insert into public.recipe_categories%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%insert into public.recipes%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%category_id%'
union all
select
  'link_does_not_update_recipe',
  pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    not ilike '%update public.recipes%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%LINK_DOES_NOT_EDIT_BOM%'
union all
select
  'replay_includes_category',
  pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%v_recipe.category_id is not distinct from v_category_id%'
union all
select
  'keeps_fudo_identity_and_pending',
  pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%PENDING_NOT_FOUND%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%MAPPING_INACTIVE%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%ALREADY_LINKED%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%external_product_id%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%status = ''resolved''%'
union all
select
  'no_stock_or_sales_writes',
  pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    not ilike '%register_sale_consumption%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    not ilike '%resolve_pending_product_mappings%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    not ilike '%insert into public.inventory_movements%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    not ilike '%insert into public.location_inventory%'
union all
select
  'locks_pending',
  pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%for update%';

do $assert$
declare
  failed text;
  body text;
begin
  body := pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure);

  select string_agg(check_id, ', ' order by 1)
    into failed
  from (
    select 'definer' as check_id
    where not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.oid = to_regprocedure('public.senda_save_fudo_recipe(jsonb)')
        and p.prosecdef
    )
    union all
    select 'execute_service_only'
    where not (
      has_function_privilege('service_role', 'public.senda_save_fudo_recipe(jsonb)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.senda_save_fudo_recipe(jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.senda_save_fudo_recipe(jsonb)', 'EXECUTE')
    )
    union all
    select 'create_resolves_category'
    where body not ilike '%CATEGORY_NOT_IN_ORG%'
       or body not ilike '%insert into public.recipe_categories%'
    union all
    select 'link_does_not_update_recipe'
    where body ilike '%update public.recipes%'
       or body not ilike '%LINK_DOES_NOT_EDIT_BOM%'
    union all
    select 'no_stock_or_sales_writes'
    where body ilike '%register_sale_consumption%'
       or body ilike '%insert into public.inventory_movements%'
  ) t;

  if failed is not null then
    raise exception 'RECIPE_SAVE_CATEGORY_VERIFY_FAILED: %', failed;
  end if;
end
$assert$;

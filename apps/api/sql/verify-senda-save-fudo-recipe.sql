-- SENDA OPS — Paso 418
-- Verificación de SOLO LECTURA tras aplicar proposed-senda-save-fudo-recipe.sql.
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
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  r.rolname as grantee,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') as has_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public'
  and p.proname in (
    'senda_actor_is_purchase_member',
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
  'no_sale_rpc_in_body',
  pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    not ilike '%register_sale_consumption%'
  and pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    not ilike '%resolve_pending_product_mappings%'
union all
select
  'locks_pending',
  pg_get_functiondef('public.senda_save_fudo_recipe(jsonb)'::regprocedure)
    ilike '%for update%';

-- SENDA OPS — Verificación de SOLO LECTURA tras aplicar
-- proposed-senda-ensure-active-product-name.sql.
-- No modifica tablas, índices, funciones ni filas. No llama el RPC.

select
  'name_key_immutable' as check_id,
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure('public.senda_inventory_name_key(text)')
      and p.provolatile = 'i'
  ) as ok
union all
select
  'old_name_unique_gone',
  to_regclass('public.inventory_products_org_name_unique') is null
union all
select
  'active_name_index',
  exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'inventory_products'
      and c.relname = 'inventory_products_org_active_name_key'
      and i.indisunique
      and pg_get_expr(i.indpred, i.indrelid) ~* 'active[[:space:]]+is[[:space:]]+true'
      and pg_get_indexdef(i.indexrelid) ilike '%senda_inventory_name_key%'
      and pg_get_indexdef(i.indexrelid) ilike '%organization_id%'
  )
union all
select
  'no_active_normalized_duplicates',
  not exists (
    select 1
    from public.inventory_products ip
    where ip.active is true
    group by ip.organization_id, public.senda_inventory_name_key(ip.name)
    having count(*) > 1
  )
union all
select
  'ensure_uses_active_key',
  pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%senda_inventory_name_key%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%ip.active is true%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%DUPLICATE_PRODUCT%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%pg_advisory_xact_lock%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    not ilike '%INACTIVE_PRODUCT_EXISTS%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    not ilike '%update public.inventory_products%'
union all
select
  'ensure_not_executable_externally',
  to_regprocedure('public.senda_ensure_inventory_product_for_intake(jsonb)') is not null
  and not has_function_privilege(
    'service_role',
    'public.senda_ensure_inventory_product_for_intake(jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.senda_ensure_inventory_product_for_intake(jsonb)',
    'EXECUTE'
  );

do $fail$
begin
  if exists (
    select 1
    from (
      select
        'active_name_index' as check_id,
        exists (
          select 1
          from pg_index i
          join pg_class c on c.oid = i.indexrelid
          where c.relname = 'inventory_products_org_active_name_key'
            and i.indisunique
            and pg_get_expr(i.indpred, i.indrelid) ~* 'active[[:space:]]+is[[:space:]]+true'
        ) as ok
      union all
      select
        'old_name_unique_gone',
        to_regclass('public.inventory_products_org_name_unique') is null
      union all
      select
        'ensure_uses_active_key',
        pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
          ilike '%senda_inventory_name_key%'
        and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
          not ilike '%INACTIVE_PRODUCT_EXISTS%'
        and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
          not ilike '%update public.inventory_products%'
    ) checks
    where not ok
  ) then
    raise exception 'ACTIVE_NAME_VERIFY_FAILED';
  end if;
end
$fail$;

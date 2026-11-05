-- SENDA OPS — Paso 447
-- Verificación de SOLO LECTURA tras aplicar proposed-senda-set-inventory-purchase-cost.sql.
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
  and c.relname = 'inventory_cost_history';

select
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name = 'inventory_cost_history'
order by c.ordinal_position;

select
  con.conname,
  con.contype,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'public'
  and rel.relname = 'inventory_cost_history'
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
  and p.proname = 'senda_set_inventory_purchase_cost'
order by arguments;

select
  r.rolname as grantee,
  has_function_privilege(
    r.oid,
    'public.senda_set_inventory_purchase_cost(jsonb)',
    'EXECUTE'
  ) as has_execute
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

select
  'history_exists' as check_id,
  to_regclass('public.inventory_cost_history') is not null as ok
union all
select
  'history_rls',
  exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'inventory_cost_history'
      and c.relrowsecurity
  )
union all
select
  'history_select_policy_only',
  exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_cost_history'
      and policyname = 'inventory_cost_history_member_select'
      and cmd = 'SELECT'
  )
  and not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_cost_history'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
union all
select
  'definer',
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure('public.senda_set_inventory_purchase_cost(jsonb)')
      and p.prosecdef
  )
union all
select
  'execute_service_only',
  has_function_privilege('service_role', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
union all
select
  'no_stock_movement',
  pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure)
    not ilike '%insert into public.inventory_movements%'
union all
select
  'keeps_quantity_on_hand',
  pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure)
    not ilike '%set quantity_on_hand%'
  and pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure)
    not ilike '%quantity_on_hand = public.inventory_valuations.quantity_on_hand +%'
union all
select
  'writes_last_cost_on_both_columns',
  pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure)
    ilike '%set average_unit_cost = excluded.average_unit_cost%'
  and pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure)
    ilike '%last_purchase_unit_cost = excluded.last_purchase_unit_cost%'
union all
select
  'writes_history',
  pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure)
    ilike '%insert into public.inventory_cost_history%'
union all
select
  'no_invoices_or_sales',
  pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure)
    not ilike '%purchase_documents%'
  and pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure)
    not ilike '%register_sale_consumption%'
  and pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure)
    not ilike '%senda_receive_purchase_document_line%';

do $assert$
begin
  if exists (
    select 1
    from (
      select
        has_function_privilege('service_role', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
        and not has_function_privilege('authenticated', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
        and to_regclass('public.inventory_cost_history') is not null
        as ok
    ) t
    where not t.ok
  ) then
    raise exception 'INVENTORY_COST_VERIFY_FAILED';
  end if;
end
$assert$;

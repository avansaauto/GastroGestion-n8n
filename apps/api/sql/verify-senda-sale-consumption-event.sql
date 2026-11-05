-- SENDA OPS — Verificación de solo lectura del evento de consumo.
-- No modifica datos. Ejecutar después de aplicar
-- proposed-senda-sale-consumption-event.sql.

select
  'table_events' as check_name,
  to_regclass('public.sale_consumption_events') is not null as ok;

select
  'table_lines' as check_name,
  to_regclass('public.sale_consumption_event_lines') is not null as ok;

select
  'rpc_exists' as check_name,
  to_regprocedure('public.senda_register_sale_consumption_event(jsonb)') is not null as ok;

select
  'rpc_sale_untouched' as check_name,
  pg_get_function_identity_arguments(
    'public.register_sale_consumption(uuid, numeric, text, text)'::regprocedure
  ) = 'p_location_inventory_id uuid, p_quantity numeric, p_source_type text, p_source_id text' as ok;

select
  'rpc_calls_sale' as check_name,
  position(
    'register_sale_consumption' in
    lower(pg_get_functiondef('public.senda_register_sale_consumption_event(jsonb)'::regprocedure))
  ) > 0 as ok;

select
  'rpc_keeps_exceeds' as check_name,
  position(
    'exception' in
    lower(pg_get_functiondef('public.senda_register_sale_consumption_event(jsonb)'::regprocedure))
  ) > 0 as ok;

select
  'rpc_retries_failed_only' as check_name,
  position(
    'failed' in
    lower(pg_get_functiondef('public.senda_register_sale_consumption_event(jsonb)'::regprocedure))
  ) > 0
  and position(
    'sale_reversal' in
    lower(pg_get_functiondef('public.senda_register_sale_consumption_event(jsonb)'::regprocedure))
  ) = 0 as ok;

select
  'rpc_search_path_safe' as check_name,
  position(
    'pg_catalog, public' in
    pg_get_functiondef('public.senda_register_sale_consumption_event(jsonb)'::regprocedure)
  ) > 0 as ok;

select
  grantee,
  privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'senda_register_sale_consumption_event'
order by grantee, privilege_type;

select
  tablename,
  policyname,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('sale_consumption_events', 'sale_consumption_event_lines')
order by tablename, policyname;

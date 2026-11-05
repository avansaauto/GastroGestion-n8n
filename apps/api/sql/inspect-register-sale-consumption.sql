-- SENDA OPS — Inspección de SOLO LECTURA antes de aplicar
-- proposed-register-sale-consumption-stock.sql.
-- No modifica funciones, permisos, triggers ni datos. No llama el RPC.
--
-- Dónde: Supabase Dashboard → proyecto SENDA (no GastroGest) → SQL Editor.
-- Si stock_trigger es true, no aplicar la migración: ese trigger ya mueve el saldo.

-- 1. Firma, resultado, seguridad y si el cuerpo ya escribe stock.
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as args,
  pg_get_function_result(p.oid) as result_type,
  p.prosecdef as security_definer,
  p.provolatile as volatility,
  l.lanname as language,
  pg_get_userbyid(p.proowner) as owner,
  p.proconfig as config,
  pg_get_functiondef(p.oid) ~* 'quantity_on_hand\s*=|set\s+quantity_on_hand' as writes_quantity,
  pg_get_functiondef(p.oid) ~* 'average_unit_cost|last_purchase_unit_cost' as mentions_cost,
  pg_get_functiondef(p.oid) ~* 'perform\s+public\.\w+\s*\(|select\s+public\.\w+\s*\(' as calls_function,
  pg_get_functiondef(p.oid) ~* 'auth\.uid|senda_require_backend_actor|senda_actor_is_purchase_member|organization_members|request\.jwt' as has_actor_check
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
where n.nspname = 'public'
  and p.proname = 'register_sale_consumption';

-- 2. EXECUTE actual. La migración no debe ampliar esta lista.
select
  routine_name,
  grantee,
  privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'register_sale_consumption'
order by grantee, privilege_type;

-- 3. Triggers de usuario sobre el libro de movimientos.
select
  c.relname as tabla,
  t.tgname as trigger_name,
  p.proname as funcion,
  pg_get_triggerdef(t.oid) as definicion,
  pg_get_functiondef(p.oid) ~* 'quantity_on_hand|inventory_valuations' as stock_trigger
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'public'
  and c.relname in ('inventory_movements', 'inventory_valuations')
  and not t.tgisinternal
order by c.relname, t.tgname;

-- 4. Índices únicos que definen la identidad del origen.
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'inventory_movements'
  and indexdef ilike '%unique%';

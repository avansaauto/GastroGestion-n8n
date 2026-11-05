-- GastroGest / SENDA — verificación SOLO LECTURA de políticas SELECT de movimientos
-- Ejecutar después de aplicar proposed-inventory-movements-select-policy.sql

select
  has_table_privilege('authenticated', 'public.inventory_movements', 'SELECT') as mov_select_ok,
  has_table_privilege('authenticated', 'public.inventory_adjustments', 'SELECT') as adj_select_ok;

select
  tablename,
  policyname,
  cmd,
  roles
from pg_catalog.pg_policies
where schemaname = 'public'
  and tablename in ('inventory_movements', 'inventory_adjustments')
order by tablename, policyname;

select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('inventory_movements', 'inventory_adjustments')
order by 1;

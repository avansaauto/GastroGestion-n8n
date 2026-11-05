-- SENDA OPS — Paso 319
-- Verificación de SOLO LECTURA posterior a aplicar INSERT+SELECT.
-- No modifica tablas, políticas, grants ni datos.

-- 1. Políticas: solo member_select (SELECT) y member_insert (INSERT)
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'inventory_products'
order by cmd, policyname;

-- 2. EXECUTE y dueño (wrappers: authenticated; actores: nadie de la app)
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.proconfig as search_path_settings,
  r.rolname as grantee,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') as has_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public'
  and p.proname in (
    'senda_actor_is_org_inventory_manager',
    'senda_is_org_inventory_manager',
    'senda_actor_is_org_active_member',
    'senda_is_org_active_member',
    'senda_actor_is_purchase_member',
    'senda_is_purchase_member'
  )
  and r.rolname in ('anon', 'authenticated', 'service_role')
order by p.proname, arguments, r.rolname;

-- 3. Privilegio de tabla (no debe aparecer UPDATE/DELETE para authenticated)
select
  r.rolname as grantee,
  has_table_privilege(r.oid, 'public.inventory_products'::regclass, 'SELECT') as has_select,
  has_table_privilege(r.oid, 'public.inventory_products'::regclass, 'INSERT') as has_insert,
  has_table_privilege(r.oid, 'public.inventory_products'::regclass, 'UPDATE') as has_update,
  has_table_privilege(r.oid, 'public.inventory_products'::regclass, 'DELETE') as has_delete
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

-- 4. RLS sigue habilitado
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'inventory_products';

-- 5. Compras intactas
select p.proname, pg_get_function_identity_arguments(p.oid) as arguments, p.prosecdef
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('senda_is_purchase_member', 'senda_actor_is_purchase_member')
order by p.proname;

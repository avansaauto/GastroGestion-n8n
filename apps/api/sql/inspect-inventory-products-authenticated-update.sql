-- SENDA OPS — Diagnóstico SOLO LECTURA
-- Por qué falla verify no_authenticated_update_grant tras
-- proposed-senda-set-inventory-product-active.sql.
--
-- NO EJECUTAR DML/DDL. No modifica nada.
-- Pegar en SQL Editor de SENDA (lectura).

-- =============================================================================
-- A. Resumen (mismo criterio que el verificador)
-- =============================================================================
select
  'verifier_predicate' as section,
  has_table_privilege('authenticated', 'public.inventory_products', 'UPDATE') as authenticated_has_update,
  has_table_privilege('authenticated', 'public.inventory_products', 'DELETE') as authenticated_has_delete,
  (
    not has_table_privilege('authenticated', 'public.inventory_products', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.inventory_products', 'DELETE')
  ) as no_authenticated_update_grant_ok;

-- =============================================================================
-- B. Privilegios efectivos por rol (tabla)
-- =============================================================================
select
  'effective_table_privs' as section,
  r.rolname as grantee,
  has_table_privilege(r.oid, 'public.inventory_products'::regclass, 'SELECT') as has_select,
  has_table_privilege(r.oid, 'public.inventory_products'::regclass, 'INSERT') as has_insert,
  has_table_privilege(r.oid, 'public.inventory_products'::regclass, 'UPDATE') as has_update,
  has_table_privilege(r.oid, 'public.inventory_products'::regclass, 'DELETE') as has_delete,
  has_table_privilege(r.oid, 'public.inventory_products'::regclass, 'TRUNCATE') as has_truncate
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role', 'postgres', 'public')
order by r.rolname;

-- =============================================================================
-- C. ACL directa sobre la tabla (quién recibió el GRANT)
--    grantor / grantee / privilegio / grantable
-- =============================================================================
select
  'table_acl_entries' as section,
  c.relname as table_name,
  coalesce(grantee.rolname, 'PUBLIC') as grantee,
  grantor.rolname as grantor,
  a.privilege_type,
  a.is_grantable
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as a
left join pg_roles grantee on grantee.oid = a.grantee
join pg_roles grantor on grantor.oid = a.grantor
where n.nspname = 'public'
  and c.relname = 'inventory_products'
  and a.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
order by coalesce(grantee.rolname, 'PUBLIC'), a.privilege_type;

-- =============================================================================
-- D. ¿UPDATE por columna? (privilegios de columna distintos de la tabla)
-- =============================================================================
select
  'column_acl_entries' as section,
  c.relname as table_name,
  att.attname as column_name,
  coalesce(grantee.rolname, 'PUBLIC') as grantee,
  grantor.rolname as grantor,
  a.privilege_type,
  a.is_grantable
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute att
  on att.attrelid = c.oid
 and att.attnum > 0
 and not att.attisdropped
cross join lateral aclexplode(coalesce(att.attacl, acldefault('c', c.relowner))) as a
left join pg_roles grantee on grantee.oid = a.grantee
join pg_roles grantor on grantor.oid = a.grantor
where n.nspname = 'public'
  and c.relname = 'inventory_products'
  and att.attacl is not null
  and a.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
order by att.attname, coalesce(grantee.rolname, 'PUBLIC'), a.privilege_type;

-- Sin ACL de columna explícita: vacío = no hay grants por columna.
select
  'column_acl_present' as section,
  exists (
    select 1
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'inventory_products'
      and att.attnum > 0
      and not att.attisdropped
      and att.attacl is not null
  ) as has_any_column_acl;

-- =============================================================================
-- E. Herencia de roles: ¿authenticated hereda UPDATE de otro rol?
-- =============================================================================
select
  'role_membership' as section,
  r.rolname as member,
  g.rolname as inherits_from
from pg_auth_members m
join pg_roles r on r.oid = m.member
join pg_roles g on g.oid = m.roleid
where r.rolname = 'authenticated'
   or g.rolname = 'authenticated'
order by 1, 2;

-- =============================================================================
-- F. Políticas RLS (¿hay política UPDATE que use el GRANT?)
-- =============================================================================
select
  'rls_policies' as section,
  policyname,
  roles,
  cmd,
  permissive,
  qual is not null as has_using,
  with_check is not null as has_with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'inventory_products'
order by cmd, policyname;

select
  'rls_flags' as section,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'inventory_products';

-- =============================================================================
-- G. Esta migración no concede UPDATE (cuerpo del RPC instalado)
-- =============================================================================
select
  'migration_rpc_grants' as section,
  has_function_privilege(
    'authenticated',
    'public.senda_set_inventory_product_active(jsonb)',
    'EXECUTE'
  ) as authenticated_can_execute_rpc,
  has_function_privilege(
    'service_role',
    'public.senda_set_inventory_product_active(jsonb)',
    'EXECUTE'
  ) as service_role_can_execute_rpc,
  pg_get_functiondef(
    'public.senda_set_inventory_product_active(jsonb)'::regprocedure
  ) not ilike '%grant%update%inventory_products%' as rpc_body_has_no_grant_update;

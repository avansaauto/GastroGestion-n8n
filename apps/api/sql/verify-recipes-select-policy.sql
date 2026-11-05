-- SENDA OPS — Paso 406
-- VERIFICACIÓN POST-POLÍTICAS SELECT DE RECETAS. SOLO LECTURA.
-- No modifica tablas, políticas, grants ni datos.
-- No llama RPC de negocio. No lee filas de recetas ni mappings.
--
-- Cuándo: después de aplicar proposed-recipes-select-policy.sql
-- Dónde: Supabase Dashboard → proyecto SENDA → SQL Editor.
-- Cómo: pegar el archivo entero y Run. En el bloque 1, ok debe ser true.
-- Rol: postgres del dashboard.

-- =============================================================================
-- 1. Contrato: un renglón por chequeo (ok debe ser true)
-- =============================================================================
select check_id, check_name, expected, actual, ok
from (
  select
    'recipes_select' as check_id,
    'SELECT recipes_member_select' as check_name,
    '1' as expected,
    (
      select count(*)::text
      from pg_policies
      where schemaname = 'public'
        and tablename = 'recipes'
        and cmd = 'SELECT'
        and policyname = 'recipes_member_select'
    ) as actual,
    exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'recipes'
        and cmd = 'SELECT'
        and policyname = 'recipes_member_select'
        and qual ilike '%senda_is_org_active_member%organization_id%'
    ) as ok
  union all
  select
    'components_select',
    'SELECT recipe_components_member_select',
    '1',
    (
      select count(*)::text
      from pg_policies
      where schemaname = 'public'
        and tablename = 'recipe_components'
        and cmd = 'SELECT'
        and policyname = 'recipe_components_member_select'
    ),
    exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'recipe_components'
        and cmd = 'SELECT'
        and policyname = 'recipe_components_member_select'
        and qual ilike '%recipes%'
        and qual ilike '%senda_is_org_active_member%'
    )
  union all
  select
    'mappings_select',
    'SELECT sales_product_mappings_member_select',
    '1',
    (
      select count(*)::text
      from pg_policies
      where schemaname = 'public'
        and tablename = 'sales_product_mappings'
        and cmd = 'SELECT'
        and policyname = 'sales_product_mappings_member_select'
    ),
    exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'sales_product_mappings'
        and cmd = 'SELECT'
        and policyname = 'sales_product_mappings_member_select'
        and qual ilike '%locations%'
        and qual ilike '%senda_is_org_active_member%'
    )
  union all
  select
    'no_write_policies',
    'Sin políticas INSERT/UPDATE/DELETE/ALL en recetas',
    '0',
    (
      select count(*)::text
      from pg_policies
      where schemaname = 'public'
        and tablename in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
        and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
        and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    )
  union all
  select
    'select_count',
    'Exactamente una política SELECT por tabla',
    '1,1,1',
    (
      select string_agg(n::text, ',' order by t)
      from (
        select tablename as t, count(*) as n
        from pg_policies
        where schemaname = 'public'
          and tablename in (
            'recipes',
            'recipe_components',
            'sales_product_mappings'
          )
          and cmd = 'SELECT'
        group by tablename
      ) s
    ),
    (
      select count(*) = 3
      from pg_policies
      where schemaname = 'public'
        and tablename in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
        and cmd = 'SELECT'
    )
    and not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
        and cmd = 'SELECT'
      group by tablename
      having count(*) <> 1
    )
  union all
  select
    'rls_on',
    'RLS habilitado en las tres tablas',
    'true,true,true',
    (
      select string_agg(c.relrowsecurity::text, ',' order by c.relname)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
    ),
    (
      select count(*) = 3
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relrowsecurity
        and c.relname in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
    )
  union all
  select
    'auth_select',
    'authenticated tiene SELECT en las tres tablas',
    'true,true,true',
    concat_ws(',',
      has_table_privilege('authenticated', 'public.recipes', 'SELECT')::text,
      has_table_privilege('authenticated', 'public.recipe_components', 'SELECT')::text,
      has_table_privilege('authenticated', 'public.sales_product_mappings', 'SELECT')::text
    ),
    has_table_privilege('authenticated', 'public.recipes', 'SELECT')
      and has_table_privilege('authenticated', 'public.recipe_components', 'SELECT')
      and has_table_privilege('authenticated', 'public.sales_product_mappings', 'SELECT')
  union all
  select
    'auth_only_select',
    'authenticated: ACL de tabla únicamente SELECT',
    'SELECT',
    coalesce((
      select string_agg(distinct a.privilege_type, ',' order by a.privilege_type)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
        and r.rolname = 'authenticated'
    ), 'none'),
    not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
        and r.rolname = 'authenticated'
        and a.privilege_type <> 'SELECT'
    )
    and (
      select count(distinct c.relname)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
        and r.rolname = 'authenticated'
        and a.privilege_type = 'SELECT'
    ) = 3
  union all
  select
    'auth_no_dml',
    'authenticated sin INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER',
    'false',
    concat_ws(',',
      has_table_privilege('authenticated', 'public.recipes', 'INSERT')::text,
      has_table_privilege('authenticated', 'public.recipes', 'UPDATE')::text,
      has_table_privilege('authenticated', 'public.recipes', 'DELETE')::text,
      has_table_privilege('authenticated', 'public.recipes', 'TRUNCATE')::text,
      has_table_privilege('authenticated', 'public.recipes', 'REFERENCES')::text,
      has_table_privilege('authenticated', 'public.recipes', 'TRIGGER')::text
    ),
    not has_table_privilege('authenticated', 'public.recipes', 'INSERT')
      and not has_table_privilege('authenticated', 'public.recipes', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.recipes', 'DELETE')
      and not has_table_privilege('authenticated', 'public.recipes', 'TRUNCATE')
      and not has_table_privilege('authenticated', 'public.recipes', 'REFERENCES')
      and not has_table_privilege('authenticated', 'public.recipes', 'TRIGGER')
      and not has_table_privilege('authenticated', 'public.recipe_components', 'INSERT')
      and not has_table_privilege('authenticated', 'public.recipe_components', 'TRUNCATE')
      and not has_table_privilege('authenticated', 'public.sales_product_mappings', 'INSERT')
      and not has_table_privilege('authenticated', 'public.sales_product_mappings', 'TRUNCATE')
  union all
  select
    'service_role_kept',
    'service_role conserva SELECT/INSERT/UPDATE/DELETE',
    'true',
    concat_ws(',',
      has_table_privilege('service_role', 'public.recipes', 'SELECT')::text,
      has_table_privilege('service_role', 'public.recipes', 'INSERT')::text,
      has_table_privilege('service_role', 'public.recipes', 'UPDATE')::text,
      has_table_privilege('service_role', 'public.recipes', 'DELETE')::text
    ),
    has_table_privilege('service_role', 'public.recipes', 'SELECT')
      and has_table_privilege('service_role', 'public.recipes', 'INSERT')
      and has_table_privilege('service_role', 'public.recipes', 'UPDATE')
      and has_table_privilege('service_role', 'public.recipes', 'DELETE')
      and has_table_privilege('service_role', 'public.recipe_components', 'SELECT')
      and has_table_privilege('service_role', 'public.recipe_components', 'INSERT')
      and has_table_privilege('service_role', 'public.recipe_components', 'UPDATE')
      and has_table_privilege('service_role', 'public.recipe_components', 'DELETE')
      and has_table_privilege('service_role', 'public.sales_product_mappings', 'SELECT')
      and has_table_privilege('service_role', 'public.sales_product_mappings', 'INSERT')
      and has_table_privilege('service_role', 'public.sales_product_mappings', 'UPDATE')
      and has_table_privilege('service_role', 'public.sales_product_mappings', 'DELETE')
  union all
  select
    'anon_no_select',
    'anon sin SELECT',
    'false,false,false',
    concat_ws(',',
      has_table_privilege('anon', 'public.recipes', 'SELECT')::text,
      has_table_privilege('anon', 'public.recipe_components', 'SELECT')::text,
      has_table_privilege('anon', 'public.sales_product_mappings', 'SELECT')::text
    ),
    not has_table_privilege('anon', 'public.recipes', 'SELECT')
      and not has_table_privilege('anon', 'public.recipe_components', 'SELECT')
      and not has_table_privilege('anon', 'public.sales_product_mappings', 'SELECT')
  union all
  select
    'member_fn',
    'senda_is_org_active_member existe; authenticated EXECUTE',
    'true',
    case
      when to_regprocedure('public.senda_is_org_active_member(uuid)') is null then 'missing'
      else has_function_privilege(
        'authenticated',
        'public.senda_is_org_active_member(uuid)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_is_org_active_member(uuid)') is not null
      and has_function_privilege(
        'authenticated',
        'public.senda_is_org_active_member(uuid)',
        'EXECUTE'
      )
  union all
  select
    'actor_no_exec',
    'authenticated sin EXECUTE del actor',
    'false',
    case
      when to_regprocedure('public.senda_actor_is_org_active_member(uuid, uuid)') is null then 'missing'
      else has_function_privilege(
        'authenticated',
        'public.senda_actor_is_org_active_member(uuid, uuid)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_actor_is_org_active_member(uuid, uuid)') is not null
      and not has_function_privilege(
        'authenticated',
        'public.senda_actor_is_org_active_member(uuid, uuid)',
        'EXECUTE'
      )
  union all
  select
    'purchase_untouched',
    'senda_is_purchase_member sigue existiendo',
    'present',
    case
      when to_regprocedure('public.senda_is_purchase_member(uuid)') is null then 'missing'
      else 'present'
    end,
    to_regprocedure('public.senda_is_purchase_member(uuid)') is not null
  union all
  select
    'no_purchase_in_recipes_policy',
    'Políticas de recetas no usan senda_is_purchase_member',
    '0',
    (
      select count(*)::text
      from pg_policies
      where schemaname = 'public'
        and tablename in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
        and (
          coalesce(qual, '') ilike '%senda_is_purchase_member%'
          or coalesce(with_check, '') ilike '%senda_is_purchase_member%'
        )
    ),
    not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename in (
          'recipes',
          'recipe_components',
          'sales_product_mappings'
        )
        and (
          coalesce(qual, '') ilike '%senda_is_purchase_member%'
          or coalesce(with_check, '') ilike '%senda_is_purchase_member%'
        )
    )
) checks
order by check_id;

-- =============================================================================
-- 2. Políticas crudas
-- =============================================================================
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'recipes',
    'recipe_components',
    'sales_product_mappings'
  )
order by tablename, cmd, policyname;

-- =============================================================================
-- 3. Grants de tabla
-- =============================================================================
select table_name, grantee, privilege_type, is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'recipes',
    'recipe_components',
    'sales_product_mappings'
  )
  and grantee in ('anon', 'authenticated', 'service_role', 'postgres', 'public')
order by table_name, grantee, privilege_type;

-- =============================================================================
-- 4. RLS
-- =============================================================================
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'recipes',
    'recipe_components',
    'sales_product_mappings'
  )
order by c.relname;

-- =============================================================================
-- 5. EXECUTE de funciones de membresía
-- =============================================================================
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  r.rolname as grantee,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') as has_execute,
  p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public'
  and p.proname in (
    'senda_is_org_active_member',
    'senda_actor_is_org_active_member',
    'senda_is_org_inventory_manager',
    'senda_is_purchase_member'
  )
  and r.rolname in ('anon', 'authenticated', 'service_role')
order by p.proname, arguments, r.rolname;

-- =============================================================================
-- 6. Plan de aislamiento entre organizaciones (manual; no se ejecuta acá)
-- =============================================================================
-- El SQL Editor del dashboard corre como postgres y bypasea RLS. No sirve
-- para probar aislamiento. Tampoco usar service_role (bypassrls).
--
-- A. Dos usuarios reales, dos organizaciones (o una membresía inactive).
-- B. Usuario de org A, cliente anon+JWT (como la API SENDA):
--      select id, organization_id, name from recipes;
--    Debe devolver solo filas de A.
-- C. El mismo usuario:
--      select rc.id from recipe_components rc;
--    Solo componentes cuyo recipe_id sea receta de A.
-- D. Mappings:
--      select id, location_id from sales_product_mappings;
--    Solo locales cuyo locations.organization_id sea A.
-- E. Usuario de org B (o sin membresía activa en A): 0 filas de A en las tres.
-- F. anon sin JWT: sin SELECT (42501) o 0 filas; nunca las de A.
-- G. INSERT/UPDATE/DELETE autenticado sobre recipes debe fallar (42501 / RLS).
-- H. No llamar register_sale_consumption ni resolve_pending_product_mappings.

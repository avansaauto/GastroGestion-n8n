-- SENDA OPS — Paso 401
-- INSPECCIÓN DE ESQUEMA DE RECETAS. SOLO LECTURA.
-- NO EJECUTAR desde la aplicación. NO APLICAR cambios.
--
-- Cuándo: revisión humana, antes de implementar el editor de recetas.
-- Dónde: Supabase Dashboard → proyecto SENDA (no GastroGest) → SQL Editor.
-- Cómo: pegar el archivo entero y Run. Revisar cada bloque.
-- Rol: postgres del dashboard (information_schema / pg_catalog).
--
-- Este archivo:
--   - solo SELECT sobre catálogo
--   - no llama resolve_pending_product_mappings ni register_sale_consumption
--   - no lee filas de negocio (recipes, mappings, inventario)
--   - no incluye credenciales
--   - no autoriza migraciones ni el editor

-- Tablas bajo inspección:
--   recipes
--   recipe_components
--   pending_product_mappings
--   sales_product_mappings
-- Funciones bajo inspección (definición, no ejecución):
--   resolve_pending_product_mappings
--   register_sale_consumption

-- =============================================================================
-- 0. Existencia de tablas y RLS
-- =============================================================================
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
order by c.relname;

-- =============================================================================
-- 1. Columnas y tipos
-- =============================================================================
select
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
order by c.table_name, c.ordinal_position;

-- =============================================================================
-- 2. Claves primarias, foráneas, UNIQUE y CHECK
-- =============================================================================
select
  n.nspname as schema_name,
  rel.relname as table_name,
  con.conname as constraint_name,
  con.contype as constraint_type,
  pg_get_constraintdef(con.oid) as definition,
  fk.relname as referenced_table
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace n on n.oid = rel.relnamespace
left join pg_class fk on fk.oid = con.confrelid
where n.nspname = 'public'
  and rel.relname in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
order by rel.relname, con.contype, con.conname;

-- =============================================================================
-- 3. Índices (incluye UNIQUE que no sea constraint)
-- =============================================================================
select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
order by tablename, indexname;

-- =============================================================================
-- 4. Políticas RLS
-- =============================================================================
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
order by tablename, policyname;

-- =============================================================================
-- 5. Triggers y definición
-- =============================================================================
select
  n.nspname as schema_name,
  rel.relname as table_name,
  t.tgname as trigger_name,
  t.tgenabled as enabled,
  pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class rel on rel.oid = t.tgrelid
join pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'public'
  and not t.tgisinternal
  and rel.relname in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
order by rel.relname, t.tgname;

select
  event_object_table,
  trigger_name,
  action_timing,
  event_manipulation,
  action_orientation,
  action_statement
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
order by event_object_table, trigger_name, event_manipulation;

-- =============================================================================
-- 6. Privilegios de tabla (quién puede escribir sin RPC)
-- =============================================================================
select
  table_name,
  grantee,
  privilege_type,
  is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
  and grantee in ('anon', 'authenticated', 'service_role', 'postgres')
order by table_name, grantee, privilege_type;

-- =============================================================================
-- 7. Firmas de funciones (todas las sobrecargas)
-- =============================================================================
select
  n.nspname as schema_name,
  p.proname as function_name,
  p.oid::regprocedure as identity,
  pg_get_function_identity_arguments(p.oid) as args,
  pg_get_function_result(p.oid) as result_type,
  p.prosecdef as security_definer,
  p.provolatile as volatility,
  p.prorettype as return_type_oid,
  pg_get_userbyid(p.proowner) as owner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'resolve_pending_product_mappings',
    'register_sale_consumption'
  )
order by p.proname, args;

-- =============================================================================
-- 8. EXECUTE sobre esas funciones
-- =============================================================================
select
  routine_schema,
  routine_name,
  grantee,
  privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'resolve_pending_product_mappings',
    'register_sale_consumption'
  )
  and grantee in ('anon', 'authenticated', 'service_role', 'postgres')
order by routine_name, grantee;

-- =============================================================================
-- 9. Definición completa (código fuente; no se ejecuta)
-- =============================================================================
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as args,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'resolve_pending_product_mappings',
    'register_sale_consumption'
  )
order by p.proname, args;

-- =============================================================================
-- 10. Lectura del cuerpo: tablas, org/local, idempotencia, inventario
--     (banderas sobre el texto; no ejecuta la función)
-- =============================================================================
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as args,
  pg_get_functiondef(p.oid) ilike '%recipes%' as mentions_recipes,
  pg_get_functiondef(p.oid) ilike '%recipe_components%' as mentions_recipe_components,
  pg_get_functiondef(p.oid) ilike '%pending_product_mappings%' as mentions_pending_product_mappings,
  pg_get_functiondef(p.oid) ilike '%sales_product_mappings%' as mentions_sales_product_mappings,
  pg_get_functiondef(p.oid) ilike '%inventory_products%' as mentions_inventory_products,
  pg_get_functiondef(p.oid) ilike '%location_inventory%' as mentions_location_inventory,
  pg_get_functiondef(p.oid) ilike '%inventory_valuations%' as mentions_inventory_valuations,
  pg_get_functiondef(p.oid) ilike '%inventory_movements%' as mentions_inventory_movements,
  pg_get_functiondef(p.oid) ilike '%organization_id%' as mentions_organization_id,
  pg_get_functiondef(p.oid) ilike '%location_id%' as mentions_location_id,
  pg_get_functiondef(p.oid) ilike '%organization_members%' as mentions_organization_members,
  pg_get_functiondef(p.oid) ilike '%auth.uid%' as mentions_auth_uid,
  pg_get_functiondef(p.oid) ~* 'idempoten' as mentions_idempotency,
  pg_get_functiondef(p.oid) ~* 'on conflict' as mentions_on_conflict,
  pg_get_functiondef(p.oid) ~* '\yinsert\y' as mentions_insert,
  pg_get_functiondef(p.oid) ~* '\yupdate\y' as mentions_update,
  pg_get_functiondef(p.oid) ~* '\ydelete\y' as mentions_delete
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'resolve_pending_product_mappings',
    'register_sale_consumption'
  )
order by p.proname, args;

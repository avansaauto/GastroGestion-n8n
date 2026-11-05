-- SENDA OPS — Paso 415
-- INSPECCIÓN DE GUARDIAS PARA EL GUARDADO DE RECETAS. SOLO LECTURA.
-- NO EJECUTAR desde la aplicación. NO APLICAR cambios.
--
-- Cuándo: revisión humana, antes de proponer senda_save_fudo_recipe.
-- Dónde: Supabase Dashboard → proyecto SENDA (no GastroGest) → SQL Editor.
-- Cómo: pegar el archivo entero y Run. Revisar cada bloque.
-- Rol: postgres del dashboard (information_schema / pg_catalog).
--
-- Complementa inspect-recipes-schema.sql (Paso 401, dump amplio).
-- Este archivo interpreta guardias concretas: UNIQUE, CHECK, FK ON DELETE,
-- funciones de membresía y privilegios.
--
-- Este archivo:
--   - solo SELECT sobre catálogo
--   - no llama resolve_pending_product_mappings ni register_sale_consumption
--   - no lee filas de negocio (recipes, mappings, inventario)
--   - no incluye credenciales
--   - no autoriza migraciones ni el RPC
--   - no crea senda_save_fudo_recipe

-- =============================================================================
-- 0. UNIQUE e índices únicos (constraint o índice; incluye parciales)
-- =============================================================================
with idx as (
  select
    t.relname as table_name,
    i.relname as index_name,
    ix.indisunique as is_unique,
    ix.indisprimary as is_primary,
    ix.indpred is not null as is_partial,
    pg_get_expr(ix.indpred, ix.indrelid) as predicate,
    (
      select array_agg(a.attname order by a.attname)
      from unnest(ix.indkey) with ordinality as k(attnum, ord)
      join pg_attribute a
        on a.attrelid = t.oid
       and a.attnum = k.attnum
    ) as columns_sorted,
    pg_get_indexdef(ix.indexrelid) as indexdef
  from pg_index ix
  join pg_class t on t.oid = ix.indrelid
  join pg_class i on i.oid = ix.indexrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relkind = 'r'
    and t.relname in (
      'recipes',
      'recipe_components',
      'pending_product_mappings',
      'sales_product_mappings'
    )
)
select
  table_name,
  index_name,
  is_unique,
  is_primary,
  is_partial,
  predicate,
  columns_sorted,
  indexdef
from idx
where is_unique
order by table_name, index_name;

-- =============================================================================
-- 1. CHECK (texto completo; buscar quantity, yield, XOR, recipe_type, status)
-- =============================================================================
select
  rel.relname as table_name,
  con.conname as constraint_name,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'public'
  and con.contype = 'c'
  and rel.relname in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
order by rel.relname, con.conname;

-- =============================================================================
-- 2. Foreign keys y ON DELETE
-- =============================================================================
select
  rel.relname as table_name,
  con.conname as constraint_name,
  pg_get_constraintdef(con.oid) as definition,
  fk.relname as referenced_table,
  case con.confdeltype
    when 'a' then 'NO ACTION'
    when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT'
    else con.confdeltype::text
  end as on_delete,
  case con.confupdtype
    when 'a' then 'NO ACTION'
    when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT'
    else con.confupdtype::text
  end as on_update
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace n on n.oid = rel.relnamespace
join pg_class fk on fk.oid = con.confrelid
where n.nspname = 'public'
  and con.contype = 'f'
  and rel.relname in (
    'recipes',
    'recipe_components',
    'pending_product_mappings',
    'sales_product_mappings'
  )
order by rel.relname, con.conname;

-- =============================================================================
-- 3. Checklist: encontrado / ausente (no aborta; no RAISE)
-- =============================================================================
with idx as (
  select
    t.relname as table_name,
    i.relname as index_name,
    ix.indisunique as is_unique,
    ix.indpred is not null as is_partial,
    pg_get_expr(ix.indpred, ix.indrelid) as predicate,
    (
      select array_agg(a.attname order by a.attname)
      from unnest(ix.indkey) with ordinality as k(attnum, ord)
      join pg_attribute a
        on a.attrelid = t.oid
       and a.attnum = k.attnum
    ) as columns_sorted,
    pg_get_indexdef(ix.indexrelid) as indexdef
  from pg_index ix
  join pg_class t on t.oid = ix.indrelid
  join pg_class i on i.oid = ix.indexrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relkind = 'r'
    and t.relname in (
      'recipes',
      'recipe_components',
      'pending_product_mappings',
      'sales_product_mappings'
    )
),
checks as (
  select
    rel.relname as table_name,
    con.conname as constraint_name,
    pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  where n.nspname = 'public'
    and con.contype = 'c'
    and rel.relname in (
      'recipes',
      'recipe_components',
      'pending_product_mappings',
      'sales_product_mappings'
    )
)
select
  check_id,
  expected,
  found,
  evidence
from (
  select
    'recipes_unique_org_name' as check_id,
    'UNIQUE (organization_id, name) en recipes' as expected,
    exists (
      select 1 from idx
      where table_name = 'recipes'
        and is_unique
        and columns_sorted = array['name', 'organization_id']::name[]
    ) as found,
    coalesce(
      (
        select string_agg(index_name || case when is_partial then ' PARTIAL' else '' end, ', ' order by 1)
        from idx
        where table_name = 'recipes'
          and is_unique
          and columns_sorted = array['name', 'organization_id']::name[]
      ),
      'missing'
    ) as evidence
  union all
  select
    'sales_unique_fudo_terna',
    'UNIQUE (location_id, source, external_product_id) en sales_product_mappings',
    exists (
      select 1 from idx
      where table_name = 'sales_product_mappings'
        and is_unique
        and columns_sorted = array['external_product_id', 'location_id', 'source']::name[]
    ),
    coalesce(
      (
        select string_agg(
          index_name || case when is_partial then ' PARTIAL ' || coalesce(predicate, '') else '' end,
          ', ' order by 1
        )
        from idx
        where table_name = 'sales_product_mappings'
          and is_unique
          and columns_sorted = array['external_product_id', 'location_id', 'source']::name[]
      ),
      'missing'
    )
  union all
  select
    'pending_unique_fudo_terna',
    'UNIQUE (location_id, source, external_product_id) en pending_product_mappings',
    exists (
      select 1 from idx
      where table_name = 'pending_product_mappings'
        and is_unique
        and columns_sorted = array['external_product_id', 'location_id', 'source']::name[]
    ),
    coalesce(
      (
        select string_agg(
          index_name || case when is_partial then ' PARTIAL ' || coalesce(predicate, '') else '' end,
          ', ' order by 1
        )
        from idx
        where table_name = 'pending_product_mappings'
          and is_unique
          and columns_sorted = array['external_product_id', 'location_id', 'source']::name[]
      ),
      'missing'
    )
  union all
  select
    'components_check_quantity_positive',
    'CHECK quantity > 0 en recipe_components',
    exists (
      select 1 from checks
      where table_name = 'recipe_components'
        and definition ~* 'quantity\s*>\s*0'
    ),
    coalesce(
      (
        select string_agg(constraint_name || ': ' || definition, ' | ' order by 1)
        from checks
        where table_name = 'recipe_components'
          and definition ~* 'quantity'
      ),
      'missing'
    )
  union all
  select
    'recipes_check_yield_quantity',
    'CHECK yield_quantity > 0 en recipes',
    exists (
      select 1 from checks
      where table_name = 'recipes'
        and definition ~* 'yield_quantity\s*>\s*0'
    ),
    coalesce(
      (
        select string_agg(constraint_name || ': ' || definition, ' | ' order by 1)
        from checks
        where table_name = 'recipes'
          and definition ~* 'yield_quantity'
      ),
      'missing'
    )
  union all
  select
    'recipes_check_yield_unit',
    'CHECK yield_unit en recipes (unit|g|ml u otro)',
    exists (
      select 1 from checks
      where table_name = 'recipes'
        and definition ~* 'yield_unit'
    ),
    coalesce(
      (
        select string_agg(constraint_name || ': ' || definition, ' | ' order by 1)
        from checks
        where table_name = 'recipes'
          and definition ~* 'yield_unit'
      ),
      'missing'
    )
  union all
  select
    'recipes_check_recipe_type',
    'CHECK recipe_type en recipes (sale_product|preparation)',
    exists (
      select 1 from checks
      where table_name = 'recipes'
        and definition ~* 'recipe_type'
    ),
    coalesce(
      (
        select string_agg(constraint_name || ': ' || definition, ' | ' order by 1)
        from checks
        where table_name = 'recipes'
          and definition ~* 'recipe_type'
      ),
      'missing'
    )
  union all
  select
    'components_check_xor',
    'CHECK XOR inventory_product_id / component_recipe_id',
    exists (
      select 1 from checks
      where table_name = 'recipe_components'
        and definition ~* 'inventory_product_id'
        and definition ~* 'component_recipe_id'
    ),
    coalesce(
      (
        select string_agg(constraint_name || ': ' || definition, ' | ' order by 1)
        from checks
        where table_name = 'recipe_components'
          and definition ~* 'inventory_product_id'
          and definition ~* 'component_recipe_id'
      ),
      'missing'
    )
  union all
  select
    'pending_check_status',
    'CHECK status en pending_product_mappings',
    exists (
      select 1 from checks
      where table_name = 'pending_product_mappings'
        and definition ~* 'status'
    ),
    coalesce(
      (
        select string_agg(constraint_name || ': ' || definition, ' | ' order by 1)
        from checks
        where table_name = 'pending_product_mappings'
          and definition ~* 'status'
      ),
      'missing'
    )
  union all
  select
    'fn_actor_purchase_member',
    'senda_actor_is_purchase_member(uuid, uuid) existe',
    to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is not null,
    case
      when to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null
        then 'missing'
      else 'present'
    end
  union all
  select
    'fn_require_backend_actor',
    'senda_require_backend_actor(uuid) existe',
    to_regprocedure('public.senda_require_backend_actor(uuid)') is not null,
    case
      when to_regprocedure('public.senda_require_backend_actor(uuid)') is null
        then 'missing'
      else 'present'
    end
  union all
  select
    'fn_actor_inventory_manager',
    'senda_actor_is_org_inventory_manager(uuid, uuid) existe',
    to_regprocedure('public.senda_actor_is_org_inventory_manager(uuid, uuid)') is not null,
    case
      when to_regprocedure('public.senda_actor_is_org_inventory_manager(uuid, uuid)') is null
        then 'missing'
      else 'present'
    end
  union all
  select
    'fn_inventory_manager_wrapper',
    'senda_is_org_inventory_manager(uuid) existe',
    to_regprocedure('public.senda_is_org_inventory_manager(uuid)') is not null,
    case
      when to_regprocedure('public.senda_is_org_inventory_manager(uuid)') is null
        then 'missing'
      else 'present'
    end
  union all
  select
    'fn_active_member',
    'senda_is_org_active_member(uuid) existe',
    to_regprocedure('public.senda_is_org_active_member(uuid)') is not null,
    case
      when to_regprocedure('public.senda_is_org_active_member(uuid)') is null
        then 'missing'
      else 'present'
    end
  union all
  select
    'fn_actor_active_member',
    'senda_actor_is_org_active_member(uuid, uuid) existe',
    to_regprocedure('public.senda_actor_is_org_active_member(uuid, uuid)') is not null,
    case
      when to_regprocedure('public.senda_actor_is_org_active_member(uuid, uuid)') is null
        then 'missing'
      else 'present'
    end
  union all
  select
    'fn_save_fudo_recipe_absent',
    'senda_save_fudo_recipe todavía no existe (esperado)',
    not exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'senda_save_fudo_recipe'
    ),
    case
      when exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'senda_save_fudo_recipe'
      ) then 'present — no crear otra sobrecarga'
      else 'absent'
    end
) checklist
order by check_id;

-- =============================================================================
-- 4. Funciones de membresía: dueño, DEFINER, EXECUTE
-- =============================================================================
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
    'senda_is_purchase_member',
    'senda_require_backend_actor',
    'senda_save_fudo_recipe',
    'resolve_pending_product_mappings',
    'register_sale_consumption'
  )
  and r.rolname in ('anon', 'authenticated', 'service_role')
order by p.proname, arguments, r.rolname;

-- =============================================================================
-- 5. Privilegios de tabla (quién podría escribir sin RPC)
-- =============================================================================
select
  t.table_name,
  r.rolname as grantee,
  has_table_privilege(r.oid, format('public.%I', t.table_name)::regclass, 'SELECT') as has_select,
  has_table_privilege(r.oid, format('public.%I', t.table_name)::regclass, 'INSERT') as has_insert,
  has_table_privilege(r.oid, format('public.%I', t.table_name)::regclass, 'UPDATE') as has_update,
  has_table_privilege(r.oid, format('public.%I', t.table_name)::regclass, 'DELETE') as has_delete
from (
  values
    ('recipes'),
    ('recipe_components'),
    ('pending_product_mappings'),
    ('sales_product_mappings')
) as t(table_name)
cross join pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
  and to_regclass(format('public.%I', t.table_name)) is not null
order by t.table_name, r.rolname;

-- =============================================================================
-- 6. Políticas RLS (cmd) — confirmar que no hay INSERT/UPDATE autenticado
-- =============================================================================
select
  tablename,
  policyname,
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
order by tablename, cmd, policyname;

-- =============================================================================
-- 7. Triggers (pending resolved→pending, etc.)
-- =============================================================================
select
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

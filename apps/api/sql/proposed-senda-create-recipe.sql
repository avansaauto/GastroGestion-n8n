-- SENDA OPS — Pasos 428 y 429
-- RPC TRANSACCIONAL senda_create_recipe + recipe_categories.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Después: apps/api/sql/verify-senda-create-recipe.sql (solo lectura).
--
-- Contrato: apps/api/sql/proposed-senda-create-recipe.md
--
-- El Paso 428 todavía NO está aplicado. Este archivo lo incluye y lo extiende
-- con categorías. No hay REPLACE. Si senda_create_recipe o recipe_categories
-- ya existen, aborta.
--
-- Reutiliza senda_require_backend_actor y senda_is_org_active_member.
-- No las recrea. No GRANT/REVOKE sobre ellas.
-- EXECUTE anidado como postgres (Paso 417). authenticated no EXECUTE de este RPC.
--
-- Membresía de escritura: misma regla que senda_actor_is_purchase_member
-- (admin/operator activo) filtrada por organization_id. No exige local.
-- Lectura de categorías: miembro activo, SELECT JWT+RLS.
--
-- No llama resolve_pending_product_mappings ni register_sale_consumption.
-- No escribe pending_product_mappings, sales_product_mappings,
-- inventory_movements ni location_inventory.
-- No GRANT INSERT autenticado sobre recipes / recipe_components / recipe_categories.
-- No inserta categorías predefinidas.
--
-- Alta sale_product de organización, con o sin BOM, con o sin categoría. Sin Fudo.
-- Nombre duplicado → DUPLICATE_RECIPE_NAME. Sin replay.
-- Categoría nueva y receta en la misma transacción: si el alta de receta falla,
-- no queda categoría huérfana.

begin;

-- =============================================================================
-- 0. Guardias
-- =============================================================================
do $guard$
declare
  missing text;
  unique_ok boolean;
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'senda_create_recipe'
  ) then
    raise exception 'RECIPE_CREATE_RPC_EXISTS';
  end if;

  if to_regclass('public.recipe_categories') is not null then
    raise exception 'RECIPE_CREATE_ABORT: recipe_categories ya existe.';
  end if;

  if exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'recipes'
      and c.column_name = 'category_id'
  ) then
    raise exception 'RECIPE_CREATE_ABORT: recipes.category_id ya existe.';
  end if;

  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'RECIPE_CREATE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_is_org_active_member(uuid)') is null then
    raise exception 'RECIPE_CREATE_ABORT: falta senda_is_org_active_member(uuid).';
  end if;

  select string_agg(format('%s.%s', t.table_name, t.column_name), ', ' order by 1)
    into missing
  from (
    values
      ('organizations', 'id'),
      ('organization_members', 'organization_id'),
      ('organization_members', 'user_id'),
      ('organization_members', 'status'),
      ('organization_members', 'role'),
      ('recipes', 'id'),
      ('recipes', 'organization_id'),
      ('recipes', 'name'),
      ('recipes', 'recipe_type'),
      ('recipes', 'active'),
      ('recipes', 'yield_quantity'),
      ('recipes', 'yield_unit'),
      ('recipe_components', 'recipe_id'),
      ('recipe_components', 'inventory_product_id'),
      ('recipe_components', 'component_recipe_id'),
      ('recipe_components', 'quantity'),
      ('inventory_products', 'id'),
      ('inventory_products', 'organization_id'),
      ('inventory_products', 'active')
  ) as t(table_name, column_name)
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = t.table_name
      and c.column_name = t.column_name
  );
  if missing is not null then
    raise exception 'RECIPE_CREATE_ABORT: columnas ausentes: %', missing;
  end if;

  select exists (
    select 1
    from pg_index ix
    join pg_class t on t.oid = ix.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'recipes'
      and ix.indisunique
      and (
        select array_agg(a.attname order by a.attname)
        from unnest(ix.indkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
      ) = array['name', 'organization_id']::name[]
  ) into unique_ok;
  if not coalesce(unique_ok, false) then
    raise exception 'RECIPE_CREATE_ABORT: falta UNIQUE (organization_id, name) en recipes.';
  end if;
end
$guard$;

-- =============================================================================
-- 1. Tabla recipe_categories y recipes.category_id
-- =============================================================================
create table public.recipe_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name text not null,
  created_at timestamptz not null default now(),
  constraint recipe_categories_name_not_blank check (length(btrim(name)) > 0)
);

create unique index recipe_categories_organization_name_ci
  on public.recipe_categories (organization_id, (lower(btrim(name))));

create unique index recipe_categories_id_organization
  on public.recipe_categories (id, organization_id);

comment on table public.recipe_categories is
  'Categorías de recetas por organización. Unicidad case-insensitive. Escritura solo RPC.';

alter table public.recipes
  add column category_id uuid;

alter table public.recipes
  add constraint recipes_category_organization_fk
  foreign key (category_id, organization_id)
  references public.recipe_categories (id, organization_id);

alter table public.recipe_categories enable row level security;

revoke all on table public.recipe_categories from public, anon;
revoke all on table public.recipe_categories from authenticated;
grant select on table public.recipe_categories to authenticated;

create policy recipe_categories_member_select
on public.recipe_categories
for select
to authenticated
using (
  public.senda_is_org_active_member(organization_id)
);

-- =============================================================================
-- 2. RPC
-- =============================================================================
create function public.senda_create_recipe(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_name text;
  v_yield numeric;
  v_unit text;
  v_components jsonb;
  v_recipe_id uuid;
  v_existing uuid;
  v_count integer;
  v_ok integer;
  v_given_category uuid;
  v_given_category_name text;
  v_category_id uuid;
  v_category_name text;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  if v_org is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;

  if not exists (select 1 from public.organizations o where o.id = v_org) then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;

  if not exists (
    select 1
    from public.organization_members m
    where m.organization_id = v_org
      and v_actor is not null
      and m.user_id = v_actor
      and m.status = 'active'
      and m.role in ('admin', 'operator')
  ) then
    raise exception 'NOT_A_MEMBER';
  end if;

  v_name := btrim(coalesce(p->>'name', ''));
  if v_name = '' then
    raise exception 'NAME_REQUIRED';
  end if;

  begin
    v_yield := (p->>'yield_quantity')::numeric;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_YIELD';
  end;
  if v_yield is null or v_yield <= 0 then
    raise exception 'INVALID_YIELD';
  end if;

  v_unit := lower(btrim(coalesce(p->>'yield_unit', '')));
  if v_unit not in ('unit', 'g', 'ml') then
    raise exception 'INVALID_YIELD_UNIT';
  end if;

  if jsonb_typeof(coalesce(p->'components', '[]'::jsonb)) is distinct from 'array' then
    raise exception 'INVALID_BOM';
  end if;
  v_components := coalesce(p->'components', '[]'::jsonb);

  select count(*) into v_count
  from jsonb_array_elements(v_components) e;

  if exists (
    select 1
    from jsonb_array_elements(v_components) e
    where coalesce(btrim(e->>'component_recipe_id'), '') <> ''
  ) then
    raise exception 'INVALID_BOM';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_components) e
    group by e->>'inventory_product_id'
    having count(*) > 1
  ) then
    raise exception 'DUPLICATE_INGREDIENT';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_components) e
    where coalesce(btrim(e->>'inventory_product_id'), '') = ''
  ) then
    raise exception 'INVALID_BOM';
  end if;
  begin
    if exists (
      select 1
      from jsonb_array_elements(v_components) e
      where (e->>'quantity') is null
         or (e->>'quantity')::numeric is null
         or (e->>'quantity')::numeric <= 0
    ) then
      raise exception 'INVALID_QUANTITY';
    end if;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_QUANTITY';
  end;

  if coalesce(v_count, 0) > 0 then
    select count(*)
      into v_ok
    from public.inventory_products ip
    join jsonb_array_elements(v_components) e
      on ip.id = (e->>'inventory_product_id')::uuid
    where ip.organization_id = v_org
      and ip.active is not false;
    if coalesce(v_ok, 0) is distinct from coalesce(v_count, 0) then
      raise exception 'INGREDIENT_NOT_IN_ORG';
    end if;
    -- Indivisibles: cantidad base múltiplo de conversion_factor (si el helper existe).
    if to_regprocedure('public.senda_assert_recipe_component_quantities(uuid, jsonb)') is not null then
      perform public.senda_assert_recipe_component_quantities(v_org, v_components);
    end if;
  end if;

  begin
    v_given_category := nullif(btrim(coalesce(p->>'category_id', '')), '')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  v_given_category_name := nullif(btrim(coalesce(p->>'category_name', '')), '');

  if v_given_category is not null then
    select c.id, c.name
      into v_category_id, v_category_name
    from public.recipe_categories c
    where c.id = v_given_category
      and c.organization_id = v_org
    for update;
    if v_category_id is null then
      raise exception 'CATEGORY_NOT_IN_ORG';
    end if;
    if v_given_category_name is not null
       and lower(v_given_category_name) is distinct from lower(btrim(v_category_name)) then
      raise exception 'CATEGORY_CONFLICT';
    end if;
  elsif v_given_category_name is not null then
    select c.id, c.name
      into v_category_id, v_category_name
    from public.recipe_categories c
    where c.organization_id = v_org
      and lower(btrim(c.name)) = lower(v_given_category_name)
    for update;
    if v_category_id is null then
      begin
        insert into public.recipe_categories (organization_id, name)
        values (v_org, v_given_category_name)
        returning id, name into v_category_id, v_category_name;
      exception
        when unique_violation then
          select c.id, c.name
            into v_category_id, v_category_name
          from public.recipe_categories c
          where c.organization_id = v_org
            and lower(btrim(c.name)) = lower(v_given_category_name)
          for update;
          if v_category_id is null then
            raise exception 'CONCURRENT_UPDATE';
          end if;
      end;
    end if;
  end if;

  select r.id
    into v_existing
  from public.recipes r
  where r.organization_id = v_org
    and r.name = v_name
  for update;
  if v_existing is not null then
    raise exception 'DUPLICATE_RECIPE_NAME';
  end if;

  begin
    insert into public.recipes (
      organization_id,
      name,
      recipe_type,
      active,
      yield_quantity,
      yield_unit,
      category_id
    ) values (
      v_org,
      v_name,
      'sale_product',
      true,
      v_yield,
      v_unit,
      v_category_id
    )
    returning id into v_recipe_id;
  exception
    when unique_violation then
      raise exception 'DUPLICATE_RECIPE_NAME';
  end;

  begin
    insert into public.recipe_components (
      recipe_id,
      inventory_product_id,
      component_recipe_id,
      quantity
    )
    select
      v_recipe_id,
      (e->>'inventory_product_id')::uuid,
      null,
      (e->>'quantity')::numeric
    from jsonb_array_elements(v_components) e;
  exception
    when foreign_key_violation then
      raise exception 'INGREDIENT_NOT_IN_ORG';
  end;

  return jsonb_build_object(
    'recipe_id', v_recipe_id,
    'name', v_name,
    'yield_quantity', v_yield,
    'yield_unit', v_unit,
    'component_count', coalesce(v_count, 0),
    'category_id', v_category_id,
    'category_name', v_category_name
  );
exception
  when invalid_text_representation then
    raise exception 'INVALID_PAYLOAD';
  when serialization_failure or deadlock_detected then
    raise exception 'CONCURRENT_UPDATE';
end;
$$;

comment on function public.senda_create_recipe(jsonb) is
  'Alta sale_product de organización, con categoría opcional atómica. service_role + actor getUser. Sin Fudo. No descuenta stock.';

revoke all on function public.senda_create_recipe(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_create_recipe(jsonb)
  to service_role;

-- =============================================================================
-- 3. Verificación en la misma transacción
-- =============================================================================
do $verify$
declare
  v_definer boolean;
  v_search text;
  v_auth_exec boolean;
  v_anon_exec boolean;
  v_service_exec boolean;
  v_body text;
  v_write int;
  v_rls boolean;
  v_fk boolean;
  v_unique boolean;
  v_auth_select boolean;
  v_auth_write boolean;
  v_anon_table boolean;
begin
  if to_regclass('public.recipe_categories') is null then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: falta recipe_categories';
  end if;
  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'recipes'
      and c.column_name = 'category_id'
  ) then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: falta recipes.category_id';
  end if;

  select p.prosecdef, array_to_string(p.proconfig, ','), pg_get_functiondef(p.oid)
    into v_definer, v_search, v_body
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = to_regprocedure('public.senda_create_recipe(jsonb)');

  if not coalesce(v_definer, false) then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: no es SECURITY DEFINER';
  end if;
  if coalesce(v_search, '') not ilike '%search_path=pg_catalog, public%'
     and coalesce(v_search, '') not ilike '%search_path=pg_catalog,public%' then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: search_path esperado pg_catalog, public';
  end if;

  v_auth_exec := has_function_privilege(
    'authenticated',
    'public.senda_create_recipe(jsonb)',
    'EXECUTE'
  );
  v_anon_exec := has_function_privilege(
    'anon',
    'public.senda_create_recipe(jsonb)',
    'EXECUTE'
  );
  v_service_exec := has_function_privilege(
    'service_role',
    'public.senda_create_recipe(jsonb)',
    'EXECUTE'
  );
  if coalesce(v_auth_exec, true)
     or coalesce(v_anon_exec, true)
     or not coalesce(v_service_exec, false) then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: EXECUTE debe ser solo service_role';
  end if;

  if v_body is null
     or v_body not ilike '%senda_require_backend_actor%'
     or v_body not ilike '%organization_members%'
     or v_body not ilike '%insert into public.recipes%'
     or v_body not ilike '%insert into public.recipe_categories%'
     or v_body ilike '%register_sale_consumption%'
     or v_body ilike '%resolve_pending_product_mappings%'
     or v_body ilike '%pending_product_mappings%'
     or v_body ilike '%sales_product_mappings%'
     or v_body ilike '%inventory_movements%'
     or v_body ilike '%location_inventory%' then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: cuerpo RPC inesperado';
  end if;

  select count(*) into v_write
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'recipe_categories'
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if coalesce(v_write, 0) <> 0 then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: recipe_categories no debe tener políticas de escritura';
  end if;

  select c.relrowsecurity into v_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'recipe_categories';
  if not coalesce(v_rls, false) then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: RLS requerido en recipe_categories';
  end if;

  select exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public'
      and rel.relname = 'recipes'
      and con.conname = 'recipes_category_organization_fk'
      and con.contype = 'f'
  ) into v_fk;
  if not coalesce(v_fk, false) then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: falta FK (category_id, organization_id)';
  end if;

  select exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'recipe_categories'
      and indexdef ilike '%unique%'
      and indexdef ilike '%lower(btrim(name))%'
  ) into v_unique;
  if not coalesce(v_unique, false) then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: falta UNIQUE case-insensitive de categorías';
  end if;

  v_auth_select := has_table_privilege('authenticated', 'public.recipe_categories', 'SELECT');
  v_auth_write := has_table_privilege('authenticated', 'public.recipe_categories', 'INSERT')
    or has_table_privilege('authenticated', 'public.recipe_categories', 'UPDATE')
    or has_table_privilege('authenticated', 'public.recipe_categories', 'DELETE');
  v_anon_table := has_table_privilege('anon', 'public.recipe_categories', 'SELECT')
    or has_table_privilege('anon', 'public.recipe_categories', 'INSERT')
    or has_table_privilege('anon', 'public.recipe_categories', 'UPDATE')
    or has_table_privilege('anon', 'public.recipe_categories', 'DELETE');
  if not coalesce(v_auth_select, false) or coalesce(v_auth_write, true) or coalesce(v_anon_table, true) then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: grants de recipe_categories inesperados';
  end if;

  if has_function_privilege(
       'service_role',
       'public.senda_require_backend_actor(uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.senda_require_backend_actor(uuid)',
       'EXECUTE'
     )
  then
    raise exception 'RECIPE_CREATE_VERIFY_FAILED: se alteró EXECUTE del actor';
  end if;
end
$verify$;

commit;

-- SENDA OPS — Paso 435
-- RPC TRANSACCIONAL senda_update_recipe.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Después: apps/api/sql/verify-senda-update-recipe.sql (solo lectura).
--
-- Contrato: apps/api/sql/proposed-senda-update-recipe.md
--
-- No hay REPLACE de senda_create_recipe ni senda_save_fudo_recipe.
-- Si senda_update_recipe ya existe, aborta (RECIPE_UPDATE_RPC_EXISTS).
-- Exige senda_create_recipe, recipe_categories y recipes.category_id.
--
-- Reutiliza senda_require_backend_actor. No la recrea. No GRANT/REVOKE sobre ella.
-- EXECUTE solo service_role.
--
-- Membresía: admin/operator activo de la organización. No exige local.
-- No llama resolve_pending_product_mappings ni register_sale_consumption.
-- No escribe pending_product_mappings, sales_product_mappings,
-- inventory_movements ni location_inventory.
-- No GRANT autenticado de UPDATE/INSERT/DELETE sobre recipes.
--
-- Actualiza name, yield, categoría y BOM en una transacción.
-- Conserva mappings Fudo. Rechaza receta inactiva. Concurrencia por huella expected.
-- El esquema actual no tiene recipes.updated_at ni version; no se agrega columna.

begin;

do $guard$
declare
  missing text;
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'senda_update_recipe'
      and pg_get_function_identity_arguments(p.oid) = 'p jsonb'
  ) then
    raise exception 'RECIPE_UPDATE_RPC_EXISTS';
  end if;

  if to_regprocedure('public.senda_create_recipe(jsonb)') is null then
    raise exception 'RECIPE_UPDATE_ABORT: falta senda_create_recipe(jsonb).';
  end if;

  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'RECIPE_UPDATE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;

  if to_regclass('public.recipe_categories') is null then
    raise exception 'RECIPE_UPDATE_ABORT: falta recipe_categories.';
  end if;

  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'recipes'
      and c.column_name = 'category_id'
  ) then
    raise exception 'RECIPE_UPDATE_ABORT: falta recipes.category_id.';
  end if;

  select string_agg(t.table_name, ', ' order by 1)
    into missing
  from (
    values
      ('recipes'),
      ('recipe_components'),
      ('inventory_products')
  ) as t(table_name)
  where to_regclass(format('public.%I', t.table_name)) is null;
  if missing is not null then
    raise exception 'RECIPE_UPDATE_ABORT: faltan tablas: %', missing;
  end if;
end
$guard$;

create function public.senda_update_recipe(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_recipe_id uuid;
  v_name text;
  v_yield numeric;
  v_unit text;
  v_components jsonb;
  v_expected jsonb;
  v_expected_name text;
  v_expected_yield numeric;
  v_expected_unit text;
  v_expected_category uuid;
  v_expected_components jsonb;
  v_expected_count integer;
  v_recipe public.recipes%rowtype;
  v_count integer;
  v_ok integer;
  v_given_category uuid;
  v_given_category_name text;
  v_category_id uuid;
  v_category_name text;
  v_shared integer;
  v_same boolean;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
    v_recipe_id := (p->>'recipe_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  if v_org is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;
  if v_recipe_id is null then
    raise exception 'RECIPE_REQUIRED';
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

  select *
    into v_recipe
  from public.recipes r
  where r.id = v_recipe_id
    and r.organization_id = v_org
  for update;
  if v_recipe.id is null then
    raise exception 'RECIPE_NOT_IN_ORG';
  end if;
  if v_recipe.active is distinct from true then
    raise exception 'RECIPE_INACTIVE';
  end if;

  if exists (
    select 1
    from public.recipe_components c
    where c.recipe_id = v_recipe.id
      and c.component_recipe_id is not null
  ) then
    raise exception 'INVALID_BOM';
  end if;

  if jsonb_typeof(p->'expected') is distinct from 'object' then
    raise exception 'EXPECTED_REQUIRED';
  end if;
  v_expected := p->'expected';
  v_expected_name := btrim(coalesce(v_expected->>'name', ''));
  begin
    v_expected_yield := (v_expected->>'yield_quantity')::numeric;
    v_expected_category := nullif(btrim(coalesce(v_expected->>'category_id', '')), '')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  v_expected_unit := lower(btrim(coalesce(v_expected->>'yield_unit', '')));
  if jsonb_typeof(coalesce(v_expected->'components', '[]'::jsonb)) is distinct from 'array' then
    raise exception 'INVALID_PAYLOAD';
  end if;
  v_expected_components := coalesce(v_expected->'components', '[]'::jsonb);
  select count(*) into v_expected_count
  from jsonb_array_elements(v_expected_components) e;

  v_same := v_recipe.name = v_expected_name
    and v_recipe.yield_quantity is not distinct from v_expected_yield
    and lower(v_recipe.yield_unit) = v_expected_unit
    and v_recipe.category_id is not distinct from v_expected_category
    and (
      select count(*)
      from public.recipe_components c
      where c.recipe_id = v_recipe.id
    ) = v_expected_count
    and not exists (
      select 1
      from jsonb_array_elements(v_expected_components) e
      left join public.recipe_components c
        on c.recipe_id = v_recipe.id
       and c.inventory_product_id = (e->>'inventory_product_id')::uuid
      where c.id is null
         or c.quantity is distinct from (e->>'quantity')::numeric
    );
  if not v_same then
    raise exception 'CONCURRENT_UPDATE';
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

  if exists (
    select 1
    from public.recipes r
    where r.organization_id = v_org
      and r.name = v_name
      and r.id is distinct from v_recipe_id
  ) then
    raise exception 'DUPLICATE_RECIPE_NAME';
  end if;

  begin
    update public.recipes
       set name = v_name,
           yield_quantity = v_yield,
           yield_unit = v_unit,
           category_id = v_category_id
     where id = v_recipe_id
       and organization_id = v_org;
  exception
    when unique_violation then
      raise exception 'DUPLICATE_RECIPE_NAME';
  end;

  delete from public.recipe_components
   where recipe_id = v_recipe_id;

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

  select count(distinct location_id)
    into v_shared
  from public.sales_product_mappings
  where recipe_id = v_recipe_id
    and active is not false;

  return jsonb_build_object(
    'recipe_id', v_recipe_id,
    'name', v_name,
    'yield_quantity', v_yield,
    'yield_unit', v_unit,
    'component_count', coalesce(v_count, 0),
    'category_id', v_category_id,
    'category_name', v_category_name,
    'shared_location_count', coalesce(v_shared, 0)
  );
exception
  when invalid_text_representation then
    raise exception 'INVALID_PAYLOAD';
  when serialization_failure or deadlock_detected then
    raise exception 'CONCURRENT_UPDATE';
end;
$$;

comment on function public.senda_update_recipe(jsonb) is
  'Edición sale_product de organización, con categoría y BOM atómicos. Conserva mappings Fudo. service_role + actor getUser. Sin stock.';

revoke all on function public.senda_update_recipe(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_update_recipe(jsonb)
  to service_role;

do $verify$
declare
  v_definer boolean;
  v_body text;
  v_service boolean;
  v_auth boolean;
  v_anon boolean;
begin
  select p.prosecdef, pg_get_functiondef(p.oid)
    into v_definer, v_body
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = to_regprocedure('public.senda_update_recipe(jsonb)');
  if not coalesce(v_definer, false) then
    raise exception 'RECIPE_UPDATE_VERIFY_FAILED: no es SECURITY DEFINER';
  end if;
  if not has_function_privilege('service_role', 'public.senda_update_recipe(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.senda_update_recipe(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.senda_update_recipe(jsonb)', 'EXECUTE') then
    raise exception 'RECIPE_UPDATE_VERIFY_FAILED: EXECUTE no es solo service_role';
  end if;
  v_body := coalesce(v_body, '');
  if v_body not ilike '%RECIPE_INACTIVE%'
     or v_body not ilike '%EXPECTED_REQUIRED%'
     or v_body not ilike '%CONCURRENT_UPDATE%'
     or v_body not ilike '%update public.recipes%'
     or v_body not ilike '%delete from public.recipe_components%'
     or v_body not ilike '%insert into public.recipe_components%'
     or v_body not ilike '%insert into public.recipe_categories%'
     or v_body ilike '%insert into public.sales_product_mappings%'
     or v_body ilike '%update public.sales_product_mappings%'
     or v_body ilike '%delete from public.sales_product_mappings%'
     or v_body ilike '%register_sale_consumption%'
     or v_body ilike '%inventory_movements%' then
    raise exception 'RECIPE_UPDATE_VERIFY_FAILED: cuerpo inesperado';
  end if;
end
$verify$;

commit;

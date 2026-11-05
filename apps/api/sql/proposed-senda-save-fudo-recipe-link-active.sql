-- SENDA OPS — Paso 438
-- LINK Fudo rechaza recetas inactivas en el RPC YA INSTALADO senda_save_fudo_recipe.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Después: apps/api/sql/verify-senda-save-fudo-recipe-link-active.sql (solo lectura).
--
-- Contrato: apps/api/sql/proposed-senda-save-fudo-recipe-link-active.md
--
-- Este archivo REPLACE el cuerpo del RPC instalado (Paso 433, con categoría).
-- El cambio es mínimo: LINK nuevo exige recipes.active. Un replay del mismo
-- mapping sigue OK aunque la receta se haya desactivado después.
-- No recrea senda_require_backend_actor ni senda_actor_is_purchase_member.
-- No GRANT/REVOKE sobre ellas. No REPLACE senda_create_recipe,
-- senda_update_recipe ni senda_set_recipe_active.
--
-- Conserva CREATE/LINK, identidad Fudo, categorías en CREATE, pendientes,
-- replay, MAPPING_INACTIVE, ALREADY_LINKED, LINK_DOES_NOT_EDIT_BOM y
-- EXECUTE solo service_role. Intent link no lee ni escribe categoría ni BOM.
--
-- Orden de locks (no cambiar): pending FOR UPDATE, mapping FOR UPDATE,
-- recipe FOR UPDATE. Compatible con senda_set_recipe_active, que solo
-- bloquea recipes. No bloquear mappings en el RPC de estado.
--
-- No llama resolve_pending_product_mappings ni register_sale_consumption.
-- No escribe inventory_movements ni location_inventory.
-- No desactiva mappings. No hace UPDATE de recipes.

begin;

-- =============================================================================
-- 0. Guardias
-- =============================================================================
do $guard$
declare
  missing text;
  unique_ok boolean;
begin
  if to_regprocedure('public.senda_save_fudo_recipe(jsonb)') is null then
    raise exception 'RECIPE_SAVE_LINK_ACTIVE_ABORT: falta senda_save_fudo_recipe(jsonb). Aplicar primero el RPC con categoría.';
  end if;
  if to_regclass('public.recipe_categories') is null then
    raise exception 'RECIPE_SAVE_LINK_ACTIVE_ABORT: falta recipe_categories.';
  end if;
  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'recipes'
      and c.column_name = 'category_id'
  ) then
    raise exception 'RECIPE_SAVE_LINK_ACTIVE_ABORT: falta recipes.category_id.';
  end if;
  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'recipes'
      and c.column_name = 'active'
  ) then
    raise exception 'RECIPE_SAVE_LINK_ACTIVE_ABORT: falta recipes.active.';
  end if;

  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'RECIPE_SAVE_LINK_ACTIVE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'RECIPE_SAVE_LINK_ACTIVE_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;

  select string_agg(format('%s.%s', t.table_name, t.column_name), ', ' order by 1)
    into missing
  from (
    values
      ('locations', 'id'),
      ('locations', 'organization_id'),
      ('recipes', 'id'),
      ('recipes', 'organization_id'),
      ('recipes', 'name'),
      ('recipes', 'recipe_type'),
      ('recipes', 'active'),
      ('recipes', 'yield_quantity'),
      ('recipes', 'yield_unit'),
      ('recipes', 'category_id'),
      ('recipe_categories', 'id'),
      ('recipe_categories', 'organization_id'),
      ('recipe_categories', 'name'),
      ('recipe_components', 'recipe_id'),
      ('recipe_components', 'inventory_product_id'),
      ('recipe_components', 'component_recipe_id'),
      ('recipe_components', 'quantity'),
      ('pending_product_mappings', 'id'),
      ('pending_product_mappings', 'location_id'),
      ('pending_product_mappings', 'source'),
      ('pending_product_mappings', 'external_product_id'),
      ('pending_product_mappings', 'external_product_name'),
      ('pending_product_mappings', 'status'),
      ('sales_product_mappings', 'id'),
      ('sales_product_mappings', 'location_id'),
      ('sales_product_mappings', 'source'),
      ('sales_product_mappings', 'external_product_id'),
      ('sales_product_mappings', 'external_product_name'),
      ('sales_product_mappings', 'recipe_id'),
      ('sales_product_mappings', 'active'),
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
    raise exception 'RECIPE_SAVE_ABORT: columnas ausentes: %', missing;
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
    raise exception 'RECIPE_SAVE_ABORT: falta UNIQUE (organization_id, name) en recipes.';
  end if;

  select exists (
    select 1
    from pg_index ix
    join pg_class t on t.oid = ix.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'sales_product_mappings'
      and ix.indisunique
      and (
        select array_agg(a.attname order by a.attname)
        from unnest(ix.indkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
      ) = array['external_product_id', 'location_id', 'source']::name[]
  ) into unique_ok;
  if not coalesce(unique_ok, false) then
    raise exception 'RECIPE_SAVE_ABORT: falta UNIQUE (location_id, source, external_product_id) en sales_product_mappings.';
  end if;

  select exists (
    select 1
    from pg_index ix
    join pg_class t on t.oid = ix.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'pending_product_mappings'
      and ix.indisunique
      and (
        select array_agg(a.attname order by a.attname)
        from unnest(ix.indkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
      ) = array['external_product_id', 'location_id', 'source']::name[]
  ) into unique_ok;
  if not coalesce(unique_ok, false) then
    raise exception 'RECIPE_SAVE_ABORT: falta UNIQUE (location_id, source, external_product_id) en pending_product_mappings.';
  end if;
end
$guard$;

-- =============================================================================
-- 1. RPC
-- =============================================================================
create or replace function public.senda_save_fudo_recipe(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_location uuid;
  v_org uuid;
  v_intent text;
  v_source text;
  v_external text;
  v_name text;
  v_yield numeric;
  v_unit text;
  v_components jsonb;
  v_existing uuid;
  v_given_category uuid;
  v_given_category_name text;
  v_category_id uuid;
  v_category_name text;
  v_pending public.pending_product_mappings%rowtype;
  v_mapping public.sales_product_mappings%rowtype;
  v_recipe public.recipes%rowtype;
  v_recipe_id uuid;
  v_mapping_id uuid;
  v_replay boolean := false;
  v_count integer;
  v_ok integer;
  v_same boolean;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  v_location := (p->>'location_id')::uuid;
  if v_location is null then
    raise exception 'LOCATION_REQUIRED';
  end if;

  select l.organization_id
    into v_org
  from public.locations l
  where l.id = v_location;
  if v_org is null then
    raise exception 'LOCATION_NOT_FOUND';
  end if;

  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;

  v_intent := lower(btrim(coalesce(p->>'intent', '')));
  if v_intent is distinct from 'create' and v_intent is distinct from 'link' then
    raise exception 'INVALID_INTENT';
  end if;

  v_source := btrim(coalesce(p->>'source', ''));
  v_external := btrim(coalesce(p->>'external_product_id', ''));
  if v_source = '' then
    raise exception 'SOURCE_REQUIRED';
  end if;
  if v_external = '' then
    raise exception 'EXTERNAL_PRODUCT_ID_REQUIRED';
  end if;

  if jsonb_typeof(coalesce(p->'components', '[]'::jsonb)) is distinct from 'array' then
    raise exception 'INVALID_BOM';
  end if;
  v_components := coalesce(p->'components', '[]'::jsonb);

  if v_intent = 'link' then
    if jsonb_array_length(v_components) > 0 then
      raise exception 'LINK_DOES_NOT_EDIT_BOM';
    end if;
    v_existing := (p->>'existing_recipe_id')::uuid;
    if v_existing is null then
      raise exception 'EXISTING_RECIPE_REQUIRED';
    end if;
  else
    if p->>'existing_recipe_id' is not null and btrim(p->>'existing_recipe_id') <> '' then
      raise exception 'INVALID_INTENT';
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
    if v_yield is null then
      v_yield := 1;
    end if;
    if v_yield <= 0 then
      raise exception 'INVALID_YIELD';
    end if;
    v_unit := lower(btrim(coalesce(p->>'yield_unit', 'unit')));
    if v_unit not in ('unit', 'g', 'ml') then
      raise exception 'INVALID_YIELD_UNIT';
    end if;
  end if;

  select *
    into v_pending
  from public.pending_product_mappings
  where location_id = v_location
    and source = v_source
    and external_product_id = v_external
  for update;

  if v_pending.id is null then
    raise exception 'PENDING_NOT_FOUND';
  end if;

  select *
    into v_mapping
  from public.sales_product_mappings
  where location_id = v_location
    and source = v_source
    and external_product_id = v_external
  for update;

  if v_mapping.id is not null and v_mapping.active is distinct from true then
    raise exception 'MAPPING_INACTIVE';
  end if;

  if v_intent = 'link' then
    select *
      into v_recipe
    from public.recipes r
    where r.id = v_existing
      and r.organization_id = v_org
    for update;
    if v_recipe.id is null then
      raise exception 'RECIPE_NOT_IN_ORG';
    end if;

    if v_mapping.id is not null then
      if v_mapping.recipe_id is distinct from v_existing then
        raise exception 'ALREADY_LINKED';
      end if;
      v_recipe_id := v_mapping.recipe_id;
      v_mapping_id := v_mapping.id;
      v_replay := true;
    else
      if v_recipe.active is not true then
        raise exception 'RECIPE_INACTIVE';
      end if;
      begin
        insert into public.sales_product_mappings (
          location_id,
          source,
          external_product_id,
          external_product_name,
          recipe_id,
          active
        ) values (
          v_location,
          v_pending.source,
          v_pending.external_product_id,
          v_pending.external_product_name,
          v_existing,
          true
        )
        returning id into v_mapping_id;
      exception
        when unique_violation then
          raise exception 'ALREADY_LINKED';
      end;
      v_recipe_id := v_existing;
    end if;
  else
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

    if v_mapping.id is not null then
      select *
        into v_recipe
      from public.recipes r
      where r.id = v_mapping.recipe_id
        and r.organization_id = v_org;

      v_same := v_recipe.id is not null
        and v_recipe.recipe_type = 'sale_product'
        and v_recipe.name = v_name
        and v_recipe.yield_quantity is not distinct from v_yield
        and lower(v_recipe.yield_unit) = v_unit
        and v_recipe.category_id is not distinct from v_category_id
        and not exists (
          select 1
          from public.recipe_components c
          where c.recipe_id = v_recipe.id
            and c.component_recipe_id is not null
        )
        and (
          select count(*)
          from public.recipe_components c
          where c.recipe_id = v_recipe.id
        ) = v_count
        and not exists (
          select 1
          from jsonb_array_elements(v_components) e
          left join public.recipe_components c
            on c.recipe_id = v_recipe.id
           and c.inventory_product_id = (e->>'inventory_product_id')::uuid
          where c.id is null
             or c.quantity is distinct from (e->>'quantity')::numeric
        );

      if not v_same then
        raise exception 'ALREADY_LINKED';
      end if;

      v_recipe_id := v_recipe.id;
      v_mapping_id := v_mapping.id;
      v_replay := true;
    else
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

      begin
        insert into public.sales_product_mappings (
          location_id,
          source,
          external_product_id,
          external_product_name,
          recipe_id,
          active
        ) values (
          v_location,
          v_pending.source,
          v_pending.external_product_id,
          v_pending.external_product_name,
          v_recipe_id,
          true
        )
        returning id into v_mapping_id;
      exception
        when unique_violation then
          raise exception 'ALREADY_LINKED';
      end;
    end if;
  end if;

  if v_pending.status is distinct from 'resolved' then
    update public.pending_product_mappings
       set status = 'resolved'
     where id = v_pending.id;
  end if;

  return jsonb_build_object(
    'recipe_id', v_recipe_id,
    'mapping_id', v_mapping_id,
    'pending_id', v_pending.id,
    'replay', v_replay
  );
exception
  when invalid_text_representation then
    raise exception 'INVALID_PAYLOAD';
  when serialization_failure or deadlock_detected then
    raise exception 'CONCURRENT_UPDATE';
end;
$$;

comment on function public.senda_save_fudo_recipe(jsonb) is
  'Alta o vínculo Fudo atómico, con categoría opcional en CREATE. LINK nuevo exige receta activa. Replay conserva mappings históricos. service_role + actor getUser. No descuenta stock.';

revoke all on function public.senda_save_fudo_recipe(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_save_fudo_recipe(jsonb)
  to service_role;

-- =============================================================================
-- 2. Verificación en la misma transacción
-- =============================================================================
do $verify$
declare
  v_definer boolean;
  v_search text;
  v_auth_exec boolean;
  v_service_exec boolean;
  v_body text;
begin
  select p.prosecdef, array_to_string(p.proconfig, ','), pg_get_functiondef(p.oid)
    into v_definer, v_search, v_body
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = to_regprocedure('public.senda_save_fudo_recipe(jsonb)');

  if not coalesce(v_definer, false) then
    raise exception 'RECIPE_SAVE_VERIFY_FAILED: no es SECURITY DEFINER';
  end if;
  if coalesce(v_search, '') not ilike '%search_path=pg_catalog, public%'
     and coalesce(v_search, '') not ilike '%search_path=pg_catalog,public%' then
    raise exception 'RECIPE_SAVE_VERIFY_FAILED: search_path esperado pg_catalog, public';
  end if;

  v_auth_exec := has_function_privilege(
    'authenticated',
    'public.senda_save_fudo_recipe(jsonb)',
    'EXECUTE'
  );
  v_service_exec := has_function_privilege(
    'service_role',
    'public.senda_save_fudo_recipe(jsonb)',
    'EXECUTE'
  );
  if coalesce(v_auth_exec, true) or not coalesce(v_service_exec, false) then
    raise exception 'RECIPE_SAVE_VERIFY_FAILED: EXECUTE debe ser solo service_role';
  end if;

  if v_body is null
     or v_body not ilike '%senda_require_backend_actor%'
     or v_body not ilike '%senda_actor_is_purchase_member%'
     or v_body not ilike '%for update%'
     or v_body not ilike '%CATEGORY_NOT_IN_ORG%'
     or v_body not ilike '%insert into public.recipe_categories%'
     or v_body not ilike '%v_recipe.category_id is not distinct from v_category_id%'
     or v_body not ilike '%RECIPE_INACTIVE%'
     or v_body not ilike '%v_recipe.active is not true%'
     or v_body ilike '%update public.recipes%'
     or v_body ilike '%update public.sales_product_mappings%'
     or v_body ilike '%register_sale_consumption%'
     or v_body ilike '%resolve_pending_product_mappings%' then
    raise exception 'RECIPE_SAVE_VERIFY_FAILED: cuerpo RPC inesperado';
  end if;

  if has_function_privilege(
       'service_role',
       'public.senda_actor_is_purchase_member(uuid, uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.senda_actor_is_purchase_member(uuid, uuid)',
       'EXECUTE'
     )
  then
    raise exception 'RECIPE_SAVE_VERIFY_FAILED: se alteró EXECUTE del actor';
  end if;
end
$verify$;

commit;

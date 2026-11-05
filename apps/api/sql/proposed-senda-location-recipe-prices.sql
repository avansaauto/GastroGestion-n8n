-- SENDA OPS — Paso 442
-- TABLA location_recipe_prices + RPC senda_set_location_recipe_price.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Después: apps/api/sql/verify-senda-location-recipe-prices.sql (solo lectura).
--
-- Contrato: apps/api/sql/proposed-senda-location-recipe-prices.md
--
-- No hay REPLACE de senda_create_recipe, senda_update_recipe,
-- senda_set_recipe_active ni senda_save_fudo_recipe.
-- Si la tabla o el RPC ya existen, aborta.
--
-- Reutiliza senda_require_backend_actor y senda_is_org_active_member.
-- No las recrea. No GRANT/REVOKE sobre ellas.
-- EXECUTE del RPC solo service_role. authenticated no EXECUTE.
--
-- Membresía de escritura: admin/operator activo de la organización
-- (igual que create/update/status de recetas). El local debe ser de esa org.
-- Lectura JWT+RLS: miembro activo, SELECT.
--
-- Precio de lista por local × receta. Manual. Sin fila = sin precio (null).
-- No usa 0 como pendiente. No escribe recipes.sale_price (no existe).
-- No escribe precios observados de Fudo. LINK/CREATE Fudo no se tocan.
-- Receta inactiva conserva el precio histórico; este RPC no lo cambia.
--
-- Concurrencia: version + expected_version + FOR UPDATE.
-- Orden de bloqueo: location SHARE → recipe UPDATE → price UPDATE.
-- Compatible con senda_set_recipe_active (solo recipe) y LINK
-- (pending → mapping → recipe). Este RPC no bloquea mappings.

begin;

-- =============================================================================
-- 0. Guardias
-- =============================================================================
do $guard$
declare
  missing text;
begin
  if to_regclass('public.location_recipe_prices') is not null then
    raise exception 'RECIPE_PRICE_TABLE_EXISTS';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'senda_set_location_recipe_price'
      and pg_get_function_identity_arguments(p.oid) = 'p jsonb'
  ) then
    raise exception 'RECIPE_PRICE_RPC_EXISTS';
  end if;

  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'RECIPE_PRICE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_is_org_active_member(uuid)') is null then
    raise exception 'RECIPE_PRICE_ABORT: falta senda_is_org_active_member(uuid).';
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
      ('locations', 'id'),
      ('locations', 'organization_id'),
      ('recipes', 'id'),
      ('recipes', 'organization_id'),
      ('recipes', 'active'),
      ('recipes', 'recipe_type')
  ) as t(table_name, column_name)
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = t.table_name
      and c.column_name = t.column_name
  );
  if missing is not null then
    raise exception 'RECIPE_PRICE_ABORT: columnas ausentes: %', missing;
  end if;

  if exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'recipes'
      and c.column_name in ('sale_price', 'precio_venta', 'precio', 'price')
  ) then
    raise exception 'RECIPE_PRICE_ABORT: recipes no debe tener columna de precio.';
  end if;
end
$guard$;

-- =============================================================================
-- 1. Índices UNIQUE (id, organization_id) para FK compuesta
--     PK(id) ya es único; este índice solo sirve de destino de FK.
-- =============================================================================
create unique index if not exists locations_id_organization_uniq
  on public.locations (id, organization_id);

create unique index if not exists recipes_id_organization_uniq
  on public.recipes (id, organization_id);

-- =============================================================================
-- 2. Tabla
-- =============================================================================
create table public.location_recipe_prices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null,
  recipe_id uuid not null,
  sale_price numeric(12, 2) not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint location_recipe_prices_location_org_fk
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id),
  constraint location_recipe_prices_recipe_org_fk
    foreign key (recipe_id, organization_id)
    references public.recipes (id, organization_id),
  constraint location_recipe_prices_location_recipe_uniq
    unique (location_id, recipe_id),
  constraint location_recipe_prices_sale_price_positive
    check (sale_price > 0),
  constraint location_recipe_prices_version_positive
    check (version > 0)
);

comment on table public.location_recipe_prices is
  'Precio de venta manual por local × receta. Sin fila = sin precio. Escritura solo RPC.';
comment on column public.location_recipe_prices.sale_price is
  'Precio de lista por unidad vendible (yield de la receta) en este local. Siempre > 0.';
comment on column public.location_recipe_prices.version is
  'Concurrencia optimista. 1 al insertar; se incrementa en cada UPDATE de precio.';
comment on column public.location_recipe_prices.organization_id is
  'Desnormalizado para FK compuesta y RLS. Debe coincidir con local y receta.';

create index location_recipe_prices_recipe_idx
  on public.location_recipe_prices (recipe_id);

alter table public.location_recipe_prices enable row level security;

revoke all on table public.location_recipe_prices from public, anon;
revoke all on table public.location_recipe_prices from authenticated;
grant select on table public.location_recipe_prices to authenticated;
grant select, insert, update on table public.location_recipe_prices to service_role;
revoke delete, truncate on table public.location_recipe_prices from service_role;

create policy location_recipe_prices_member_select
on public.location_recipe_prices
for select
to authenticated
using (
  public.senda_is_org_active_member(organization_id)
);

-- =============================================================================
-- 3. RPC
-- =============================================================================
create function public.senda_set_location_recipe_price(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_location_id uuid;
  v_recipe_id uuid;
  v_desired numeric(12, 2);
  v_raw numeric;
  v_expected integer;
  v_expected_raw numeric;
  v_loc_org uuid;
  v_recipe public.recipes%rowtype;
  v_row public.location_recipe_prices%rowtype;
  v_replay boolean := false;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
    v_location_id := (p->>'location_id')::uuid;
    v_recipe_id := (p->>'recipe_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  if v_org is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;
  if v_location_id is null then
    raise exception 'LOCATION_REQUIRED';
  end if;
  if v_recipe_id is null then
    raise exception 'RECIPE_REQUIRED';
  end if;

  if not (p ? 'expected_version') then
    raise exception 'EXPECTED_REQUIRED';
  end if;
  if jsonb_typeof(p->'expected_version') = 'null' then
    v_expected := null;
  elsif jsonb_typeof(p->'expected_version') = 'number' then
    begin
      v_expected_raw := (p->>'expected_version')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'INVALID_PAYLOAD';
    end;
    if v_expected_raw is null
       or v_expected_raw <= 0
       or v_expected_raw <> trunc(v_expected_raw) then
      raise exception 'INVALID_PAYLOAD';
    end if;
    begin
      v_expected := v_expected_raw::integer;
    exception
      when numeric_value_out_of_range then
        raise exception 'INVALID_PAYLOAD';
    end;
  else
    raise exception 'EXPECTED_REQUIRED';
  end if;

  if jsonb_typeof(p->'sale_price') is distinct from 'number' then
    raise exception 'INVALID_SALE_PRICE';
  end if;
  begin
    v_raw := round((p->>'sale_price')::numeric, 2);
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'INVALID_SALE_PRICE';
  end;
  -- 0.004 → 0.00: no insertar cero. numeric(12,2) máximo 9999999999.99.
  if v_raw is null or v_raw <= 0 or v_raw > 9999999999.99 then
    raise exception 'INVALID_SALE_PRICE';
  end if;
  v_desired := v_raw;

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

  select l.organization_id
    into v_loc_org
  from public.locations l
  where l.id = v_location_id
  for share;
  if v_loc_org is null or v_loc_org is distinct from v_org then
    raise exception 'LOCATION_NOT_IN_ORG';
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
  if v_recipe.recipe_type is distinct from 'sale_product' then
    raise exception 'RECIPE_NOT_SALE_PRODUCT';
  end if;

  select *
    into v_row
  from public.location_recipe_prices
  where location_id = v_location_id
    and recipe_id = v_recipe_id
  for update;

  if v_row.id is null then
    if v_expected is not null then
      raise exception 'CONCURRENT_UPDATE';
    end if;
    -- SELECT FOR UPDATE sobre cero filas no cierra el hueco UNIQUE:
    -- el segundo INSERT cae acá. Mismo precio = replay; si no, conflicto.
    begin
      insert into public.location_recipe_prices (
        organization_id,
        location_id,
        recipe_id,
        sale_price,
        version
      ) values (
        v_org,
        v_location_id,
        v_recipe_id,
        v_desired,
        1
      )
      returning * into v_row;
    exception
      when unique_violation then
        select *
          into v_row
        from public.location_recipe_prices
        where location_id = v_location_id
          and recipe_id = v_recipe_id
        for update;
        if v_row.id is null or v_row.organization_id is distinct from v_org then
          raise exception 'CONCURRENT_UPDATE';
        end if;
        if v_row.sale_price is not distinct from v_desired then
          v_replay := true;
        else
          raise exception 'CONCURRENT_UPDATE';
        end if;
    end;
  else
    if v_row.sale_price is not distinct from v_desired then
      v_replay := true;
    else
      if v_expected is null or v_expected is distinct from v_row.version then
        raise exception 'CONCURRENT_UPDATE';
      end if;
      update public.location_recipe_prices
         set sale_price = v_desired,
             version = version + 1,
             updated_at = now()
       where id = v_row.id
         and location_id = v_location_id
         and recipe_id = v_recipe_id
         and organization_id = v_org
         and version = v_expected
      returning * into v_row;
      if not found then
        raise exception 'CONCURRENT_UPDATE';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'location_id', v_location_id,
    'recipe_id', v_recipe_id,
    'sale_price', v_row.sale_price,
    'version', v_row.version,
    'updated_at', v_row.updated_at,
    'replay', v_replay
  );
exception
  when invalid_text_representation then
    raise exception 'INVALID_PAYLOAD';
  when serialization_failure or deadlock_detected then
    raise exception 'CONCURRENT_UPDATE';
end;
$$;

comment on function public.senda_set_location_recipe_price(jsonb) is
  'Precio de venta manual de una receta en un local. service_role + actor getUser. Sin Fudo ni stock.';

revoke all on function public.senda_set_location_recipe_price(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_set_location_recipe_price(jsonb)
  to service_role;

-- =============================================================================
-- 4. Verificación en la misma transacción. Si falla, ROLLBACK.
-- =============================================================================
do $verify$
declare
  v_definer boolean;
  v_body text;
  v_write_policies int;
begin
  if to_regclass('public.location_recipe_prices') is null then
    raise exception 'RECIPE_PRICE_VERIFY_FAILED: falta la tabla';
  end if;

  select p.prosecdef, pg_get_functiondef(p.oid)
    into v_definer, v_body
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = to_regprocedure('public.senda_set_location_recipe_price(jsonb)');
  if not coalesce(v_definer, false) then
    raise exception 'RECIPE_PRICE_VERIFY_FAILED: no es SECURITY DEFINER';
  end if;
  if not has_function_privilege('service_role', 'public.senda_set_location_recipe_price(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.senda_set_location_recipe_price(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.senda_set_location_recipe_price(jsonb)', 'EXECUTE') then
    raise exception 'RECIPE_PRICE_VERIFY_FAILED: EXECUTE no es solo service_role';
  end if;

  if not has_table_privilege('authenticated', 'public.location_recipe_prices', 'SELECT')
     or has_table_privilege('authenticated', 'public.location_recipe_prices', 'INSERT')
     or has_table_privilege('authenticated', 'public.location_recipe_prices', 'UPDATE')
     or has_table_privilege('authenticated', 'public.location_recipe_prices', 'DELETE')
     or has_table_privilege('anon', 'public.location_recipe_prices', 'SELECT')
     or not has_table_privilege('service_role', 'public.location_recipe_prices', 'INSERT')
     or has_table_privilege('service_role', 'public.location_recipe_prices', 'DELETE') then
    raise exception 'RECIPE_PRICE_VERIFY_FAILED: grants de tabla';
  end if;

  select count(*) into v_write_policies
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'location_recipe_prices'
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if v_write_policies > 0 then
    raise exception 'RECIPE_PRICE_VERIFY_FAILED: hay política de escritura';
  end if;

  v_body := coalesce(v_body, '');
  if v_body not ilike '%EXPECTED_REQUIRED%'
     or v_body not ilike '%CONCURRENT_UPDATE%'
     or v_body not ilike '%INVALID_SALE_PRICE%'
     or v_body not ilike '%RECIPE_INACTIVE%'
     or v_body not ilike '%9999999999.99%'
     or v_body not ilike '%round(%sale_price%2)%'
     or v_body not ilike '%if not found%'
     or v_body not ilike '%insert into public.location_recipe_prices%'
     or v_body not ilike '%update public.location_recipe_prices%'
     or v_body ilike '%update public.recipes%'
     or v_body ilike '%insert into public.recipes%'
     or v_body ilike '%delete from public.location_recipe_prices%'
     or v_body ilike '%insert into public.sales_product_mappings%'
     or v_body ilike '%update public.sales_product_mappings%'
     or v_body ilike '%delete from public.sales_product_mappings%'
     or v_body ilike '%pending_product_mappings%'
     or v_body ilike '%register_sale_consumption%'
     or v_body ilike '%inventory_movements%'
     or v_body ilike '%inventory_valuations%' then
    raise exception 'RECIPE_PRICE_VERIFY_FAILED: cuerpo inesperado';
  end if;
end
$verify$;

commit;

-- SENDA OPS — Unicidad de insumo solo entre activos.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Sustituye inventory_products_org_name_unique por un índice único parcial
-- sobre el nombre normalizado, limitado a active is true.
-- Reemplaza senda_ensure_inventory_product_for_intake para usar esa misma clave.
--
-- No borra ni actualiza inventory_products.
-- No toca movimientos, costos, vínculos, auditorías ni el id histórico.
-- No reactiva un insumo inactivo.
-- Un duplicado activo sigue prohibido, también con otra mayúscula, tilde o espacio.
--
-- Antes, en solo lectura: inspect-inventory-products-org-name-unique.sql
-- Después, en solo lectura: verify-senda-active-product-name.sql
--
-- La transacción aborta, y no deja el índice viejo a medias, si:
--   la unicidad activa ya fue aplicada;
--   el índice no es UNIQUE (organization_id, name), con o sin lower/btrim;
--   está atado a una constraint que no es UNIQUE;
--   ya hay dos activos con la misma clave.

begin;

create or replace function public.senda_inventory_name_key(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select btrim(
    regexp_replace(
      lower(
        translate(
          coalesce(p_name, ''),
          'ÁÀÄÂáàäâÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔóòöôÚÙÜÛúùüûÑñÇç',
          'AAAAAAAAEEEEEEEIIIIIIIIOOOOOOOOUUUUUUUUnnCc'
        )
      ),
      '[^a-z0-9]+',
      ' ',
      'g'
    )
  );
$$;

comment on function public.senda_inventory_name_key(text) is
  'Clave de nombre de insumo: minúsculas, sin tildes y con espacios colapsados. No lee ni escribe tablas.';

revoke all on function public.senda_inventory_name_key(text) from public, anon;
grant execute on function public.senda_inventory_name_key(text) to authenticated, service_role;

do $migrate$
declare
  v_index oid;
  v_unique boolean;
  v_def text;
  v_pred text;
  v_conname text;
  v_contype "char";
  v_condef text;
  v_bad_column text;
begin
  if to_regclass('public.inventory_products_org_active_name_key') is not null
     and to_regclass('public.inventory_products_org_name_unique') is null then
    raise exception 'ACTIVE_NAME_UNIQUE_ABORT: la unicidad activa ya está aplicada. No se modificó nada.';
  end if;

  if exists (
    select 1
    from public.inventory_products ip
    where ip.active is true
    group by ip.organization_id, public.senda_inventory_name_key(ip.name)
    having count(*) > 1
  ) then
    raise exception 'ACTIVE_NAME_UNIQUE_ABORT: hay insumos activos con el mismo nombre normalizado. No se cambió la unicidad.';
  end if;

  select c.oid, i.indisunique, pg_get_indexdef(i.indexrelid), pg_get_expr(i.indpred, i.indrelid)
    into v_index, v_unique, v_def, v_pred
  from pg_class c
  join pg_index i on i.indexrelid = c.oid
  join pg_class t on t.oid = i.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'inventory_products'
    and c.relname = 'inventory_products_org_name_unique';

  if v_index is null then
    raise exception 'ACTIVE_NAME_UNIQUE_ABORT: no existe inventory_products_org_name_unique.';
  end if;
  if v_unique is not true then
    raise exception 'ACTIVE_NAME_UNIQUE_ABORT: % no es único. def=%', 'inventory_products_org_name_unique', v_def;
  end if;
  if v_pred is not null then
    raise exception 'ACTIVE_NAME_UNIQUE_ABORT: el índice ya es parcial (%). def=%', v_pred, v_def;
  end if;
  if v_def not ilike '%organization_id%' or v_def not ilike '%name%' then
    raise exception 'ACTIVE_NAME_UNIQUE_ABORT: se esperaba organization_id y name. def=%', v_def;
  end if;
  if v_def ilike '%base_unit%'
     or v_def ilike '%category%'
     or v_def ilike '%created_at%'
     or v_def ilike '%active%' then
    raise exception 'ACTIVE_NAME_UNIQUE_ABORT: la clave incluye otra columna. def=%', v_def;
  end if;

  select a.attname
    into v_bad_column
  from pg_index i
  join lateral unnest(i.indkey) as k(attnum) on true
  join pg_attribute a
    on a.attrelid = i.indrelid
   and a.attnum = k.attnum
  where i.indexrelid = v_index
    and k.attnum > 0
    and a.attname not in ('organization_id', 'name')
  limit 1;
  if v_bad_column is not null then
    raise exception 'ACTIVE_NAME_UNIQUE_ABORT: columna inesperada %. def=%', v_bad_column, v_def;
  end if;

  select con.conname, con.contype, pg_get_constraintdef(con.oid)
    into v_conname, v_contype, v_condef
  from pg_constraint con
  where con.conindid = v_index;

  if v_conname is not null and v_contype is distinct from 'u' then
    raise exception 'ACTIVE_NAME_UNIQUE_ABORT: % respalda la constraint % tipo %. def=% constraintdef=%',
      'inventory_products_org_name_unique', v_conname, v_contype, v_def, v_condef;
  end if;

  raise notice 'ACTIVE_NAME_UNIQUE: se reemplaza indexdef=% association=% constraintdef=%',
    v_def,
    case when v_conname is null then 'indice_independiente' else 'constraint_unique ' || v_conname end,
    v_condef;

  if v_conname is not null then
    execute format('alter table public.inventory_products drop constraint %I', v_conname);
  else
    execute 'drop index public.inventory_products_org_name_unique';
  end if;
end
$migrate$;

create unique index inventory_products_org_active_name_key
  on public.inventory_products (organization_id, public.senda_inventory_name_key(name))
  where active is true;

create or replace function public.senda_ensure_inventory_product_for_intake(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_name text;
  v_base text;
  v_category text;
  v_id uuid;
  v_norm text;
  v_existing public.inventory_products%rowtype;
  v_minimum numeric;
  v_location uuid;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
    v_location := nullif(p->>'location_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  if v_org is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;
  if v_location is null then
    raise exception 'LOCATION_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id = v_location
      and l.organization_id = v_org
  ) then
    raise exception 'LOCATION_ORG_MISMATCH';
  end if;

  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;

  v_name := nullif(btrim(coalesce(p->>'name', '')), '');
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'INVALID_NAME';
  end if;

  v_base := lower(btrim(coalesce(p->>'base_unit', '')));
  if v_base in ('gr', 'gramo', 'gramos') then v_base := 'g'; end if;
  if v_base in ('mililitro', 'mililitros') then v_base := 'ml'; end if;
  if v_base in ('u', 'un', 'unidad', 'unidades') then v_base := 'unit'; end if;
  if v_base not in ('g', 'ml', 'unit') then
    raise exception 'INVALID_BASE_UNIT';
  end if;

  v_category := nullif(btrim(coalesce(p->>'category', '')), '');

  if p ? 'minimum_stock' and nullif(p->>'minimum_stock', '') is not null then
    begin
      v_minimum := (p->>'minimum_stock')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'INVALID_MINIMUM_STOCK';
    end;
    if v_minimum is null or v_minimum < 0 then
      raise exception 'INVALID_MINIMUM_STOCK';
    end if;
  else
    v_minimum := 0;
  end if;

  v_norm := public.senda_inventory_name_key(v_name);

  -- Serializa altas concurrentes de la misma clave en la org.
  -- El índice único parcial es el cierre si dos transacciones pasan el SELECT.
  perform pg_advisory_xact_lock(
    hashtext('senda_ensure_inv:' || v_org::text),
    hashtext(v_norm)
  );

  -- Solo un insumo activo ocupa la clave. El inactivo no se lee para reutilizarlo.
  select *
    into v_existing
  from public.inventory_products ip
  where ip.organization_id = v_org
    and ip.active is true
    and public.senda_inventory_name_key(ip.name) = v_norm
  order by ip.id
  limit 1
  for update;

  if v_existing.id is not null then
    raise exception 'DUPLICATE_PRODUCT';
  end if;

  insert into public.inventory_products (
    organization_id, name, base_unit, active, category
  ) values (
    v_org, v_name, v_base, true, v_category
  )
  returning id into v_id;

  insert into public.location_inventory (
    location_id, inventory_product_id, minimum_stock, active
  ) values (
    v_location, v_id, v_minimum, true
  )
  on conflict (location_id, inventory_product_id) do update
    set minimum_stock = excluded.minimum_stock,
        active = true;

  return v_id;
end;
$$;

comment on function public.senda_ensure_inventory_product_for_intake(jsonb) is
  'Alta de insumo para confirmación atómica. Duplicado solo contra activos con la misma clave. Un inactivo no se reactiva ni se modifica.';

revoke all on function public.senda_ensure_inventory_product_for_intake(jsonb)
  from public, anon, authenticated, service_role;

commit;

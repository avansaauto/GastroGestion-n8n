-- SENDA OPS — Edición de insumo (nombre, categoría, stock mínimo)
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- REPLACE/CREATE senda_update_inventory_product(jsonb).
-- No toca quantity_on_hand ni costos.
-- Actualizar minimum_stock no reactiva producto ni location_inventory.
-- Después: verify-senda-update-inventory-product.sql (solo lectura).

begin;

do $guard$
begin
  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'INVENTORY_UPDATE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'INVENTORY_UPDATE_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;
  if to_regclass('public.inventory_products') is null then
    raise exception 'INVENTORY_UPDATE_ABORT: falta inventory_products.';
  end if;
end
$guard$;

alter table public.inventory_products
  add column if not exists category text;

create or replace function public.senda_update_inventory_product(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_location uuid;
  v_product uuid;
  v_name text;
  v_category text;
  v_minimum numeric;
  v_row public.inventory_products%rowtype;
  v_li uuid;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);
  v_org := (p->>'organization_id')::uuid;
  v_location := (p->>'location_id')::uuid;
  v_product := (p->>'inventory_product_id')::uuid;
  v_name := nullif(btrim(coalesce(p->>'name', '')), '');
  v_category := nullif(btrim(coalesce(p->>'category', '')), '');
  if p ? 'minimum_stock' then
    v_minimum := nullif(p->>'minimum_stock', '')::numeric;
  end if;

  if v_org is null or v_location is null or v_product is null then
    raise exception 'INVALID_PAYLOAD';
  end if;
  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;

  select * into v_row
  from public.inventory_products ip
  where ip.id = v_product
  for update;
  if v_row.id is null or v_row.organization_id is distinct from v_org then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  if v_name is not null then
    if char_length(v_name) < 2 then
      raise exception 'INVALID_NAME';
    end if;
    if exists (
      select 1
      from public.inventory_products other
      where other.organization_id = v_org
        and other.id is distinct from v_product
        and lower(btrim(other.name)) = lower(v_name)
    ) then
      raise exception 'DUPLICATE_PRODUCT';
    end if;
    update public.inventory_products
       set name = v_name,
           category = case when p ? 'category' then v_category else category end
     where id = v_product;
  elsif p ? 'category' then
    update public.inventory_products
       set category = v_category
     where id = v_product;
  end if;

  if p ? 'minimum_stock' then
    if v_minimum is not null and v_minimum < 0 then
      raise exception 'INVALID_MINIMUM_STOCK';
    end if;
    -- No reactivar: el INSERT hereda inventory_products.active;
    -- el CONFLICT solo toca minimum_stock (nunca active).
    insert into public.location_inventory (
      location_id, inventory_product_id, minimum_stock, active
    ) values (
      v_location,
      v_product,
      coalesce(v_minimum, 0),
      coalesce(v_row.active, false)
    )
    on conflict (location_id, inventory_product_id) do update
      set minimum_stock = coalesce(v_minimum, 0);

    select li.id into v_li
    from public.location_inventory li
    where li.location_id = v_location
      and li.inventory_product_id = v_product;
  end if;

  select * into v_row from public.inventory_products where id = v_product;

  return jsonb_build_object(
    'inventory_product_id', v_product,
    'name', v_row.name,
    'category', v_row.category,
    'minimum_stock', v_minimum,
    'location_inventory_id', v_li
  );
end;
$$;

revoke all on function public.senda_update_inventory_product(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_update_inventory_product(jsonb)
  to service_role;

commit;

-- SENDA OPS — Persistencia presentación comercial + proveedor habitual
-- NO EJECUTAR. NO APLICAR sin autorización expresa.
--
-- Reutiliza conversion_factor (mapping memory) y public.suppliers.
-- No reinterpreta movimientos ni costos históricos.
-- Extiende senda_update_inventory_product preservando validaciones actuales
--   (nombre, categoría, mínimo, membresía, no fuerza active).
-- Después (solo lectura): verify-inventory-product-presentation-supplier.sql

begin;

do $guard$
begin
  if to_regclass('public.inventory_products') is null then
    raise exception 'INVENTORY_PRESENTATION_ABORT: falta inventory_products.';
  end if;
  if to_regclass('public.suppliers') is null then
    raise exception 'INVENTORY_PRESENTATION_ABORT: falta suppliers.';
  end if;
  if to_regclass('public.locations') is null then
    raise exception 'INVENTORY_PRESENTATION_ABORT: falta locations.';
  end if;
  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'INVENTORY_PRESENTATION_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'INVENTORY_PRESENTATION_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;
end
$guard$;

alter table public.inventory_products
  add column if not exists category text,
  add column if not exists presentation_unit text,
  add column if not exists conversion_factor numeric,
  add column if not exists preferred_supplier_id uuid,
  -- null/true: recetas admiten g/ml parciales; false: solo múltiplos de conversión (u enteras).
  add column if not exists divisible boolean;

do $fk$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_products_preferred_supplier_id_fkey'
  ) then
    alter table public.inventory_products
      add constraint inventory_products_preferred_supplier_id_fkey
      foreign key (preferred_supplier_id)
      references public.suppliers (id)
      on delete set null;
  end if;
end
$fk$;

do $chk$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_products_conversion_factor_positive'
  ) then
    alter table public.inventory_products
      add constraint inventory_products_conversion_factor_positive
      check (conversion_factor is null or conversion_factor > 0);
  end if;
end
$chk$;

create index if not exists inventory_products_preferred_supplier_id_idx
  on public.inventory_products (preferred_supplier_id)
  where preferred_supplier_id is not null;

-- Evita duplicados concurrentes de proveedores.
create unique index if not exists suppliers_org_tax_uidx
  on public.suppliers (organization_id, tax_id)
  where tax_id is not null and btrim(tax_id) <> '';

create unique index if not exists suppliers_org_name_norm_uidx
  on public.suppliers (organization_id, (lower(btrim(name))));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.senda_normalize_presentation_unit(p_unit text)
returns text
language sql
immutable
as $$
  select case
    when nullif(lower(btrim(coalesce(p_unit, ''))), '') is null then null
    when lower(btrim(p_unit)) in ('u', 'unit', 'unidad', 'unidades', 'un', 'unid') then 'u'
    else lower(btrim(p_unit))
  end;
$$;

create or replace function public.senda_assert_presentation_coherence(
  p_base_unit text,
  p_presentation_unit text,
  p_conversion_factor numeric,
  p_divisible boolean
)
returns void
language plpgsql
immutable
as $$
declare
  v_base text := lower(btrim(coalesce(p_base_unit, '')));
  v_pres text := public.senda_normalize_presentation_unit(p_presentation_unit);
begin
  -- Ambos null → sin presentación.
  if v_pres is null and p_conversion_factor is null then
    if p_divisible is not null then
      raise exception 'INVALID_PRESENTATION';
    end if;
    return;
  end if;

  -- Incompleto: uno sin el otro.
  if v_pres is null or p_conversion_factor is null then
    raise exception 'INVALID_PRESENTATION';
  end if;
  if p_conversion_factor <= 0 then
    raise exception 'INVALID_CONVERSION_FACTOR';
  end if;
  if v_pres is distinct from 'u' then
    raise exception 'INVALID_PRESENTATION';
  end if;
  -- Contenido medible solo sobre base física g/ml.
  if v_base not in ('g', 'ml') then
    raise exception 'INVALID_PRESENTATION';
  end if;
end;
$$;

create or replace function public.senda_inventory_product_has_history(p_product_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_has boolean := false;
begin
  if exists (
    select 1
    from public.location_inventory li
    join public.inventory_valuations iv on iv.location_inventory_id = li.id
    where li.inventory_product_id = p_product_id
      and coalesce(iv.quantity_on_hand, 0) <> 0
  ) then
    return true;
  end if;

  if to_regclass('public.inventory_movements') is not null then
    select exists (
      select 1
      from public.inventory_movements m
      join public.location_inventory li on li.id = m.location_inventory_id
      where li.inventory_product_id = p_product_id
    ) into v_has;
    if v_has then return true; end if;
  end if;

  if to_regclass('public.purchase_document_receipts') is not null then
    select exists (
      select 1
      from public.purchase_document_receipts r
      where r.inventory_product_id = p_product_id
    ) into v_has;
    if v_has then return true; end if;
  end if;

  if to_regclass('public.recipe_components') is not null then
    select exists (
      select 1
      from public.recipe_components c
      where c.inventory_product_id = p_product_id
    ) into v_has;
    if v_has then return true; end if;
  end if;

  return false;
end;
$$;

-- Cantidades de BOM están en unidad base. Indivisible ⇒ múltiplo del factor.
create or replace function public.senda_assert_recipe_component_quantities(
  p_organization_id uuid,
  p_components jsonb
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
  v_product_id uuid;
  v_qty numeric;
  v_base text;
  v_factor numeric;
  v_divisible boolean;
  v_presentation text;
begin
  if p_components is null or jsonb_typeof(p_components) is distinct from 'array' then
    raise exception 'INVALID_BOM';
  end if;

  for v_item in select value from jsonb_array_elements(p_components)
  loop
    begin
      v_product_id := (v_item->>'inventory_product_id')::uuid;
      v_qty := (v_item->>'quantity')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'INVALID_QUANTITY';
    end;
    if v_product_id is null or v_qty is null or v_qty <= 0 then
      raise exception 'INVALID_QUANTITY';
    end if;

    select
      lower(btrim(ip.base_unit)),
      ip.conversion_factor,
      ip.divisible,
      public.senda_normalize_presentation_unit(ip.presentation_unit)
    into v_base, v_factor, v_divisible, v_presentation
    from public.inventory_products ip
    where ip.id = v_product_id
      and ip.organization_id = p_organization_id
      and ip.active is not false;

    if v_base is null then
      raise exception 'INGREDIENT_NOT_IN_ORG';
    end if;

    -- Indivisible con presentación: la cantidad base debe ser múltiplo del factor.
    if v_divisible is false
       and v_presentation = 'u'
       and v_factor is not null
       and v_factor > 0
       and v_base in ('g', 'ml')
    then
      if round(v_qty / v_factor, 6) is distinct from round(trunc(v_qty / v_factor), 6) then
        raise exception 'INDIVISIBLE_QUANTITY';
      end if;
      if round(v_qty / v_factor, 6) < 1 then
        raise exception 'INDIVISIBLE_QUANTITY';
      end if;
    end if;
  end loop;
end;
$$;

revoke all on function public.senda_normalize_presentation_unit(text) from public, anon, authenticated;
revoke all on function public.senda_assert_presentation_coherence(text, text, numeric, boolean) from public, anon, authenticated;
revoke all on function public.senda_inventory_product_has_history(uuid) from public, anon, authenticated;
revoke all on function public.senda_assert_recipe_component_quantities(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.senda_normalize_presentation_unit(text) to service_role;
grant execute on function public.senda_assert_presentation_coherence(text, text, numeric, boolean) to service_role;
grant execute on function public.senda_inventory_product_has_history(uuid) to service_role;
grant execute on function public.senda_assert_recipe_component_quantities(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- senda_update_inventory_product — preserva contrato original + presentación
-- ---------------------------------------------------------------------------

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
  v_presentation_unit text;
  v_conversion_factor numeric;
  v_divisible boolean;
  v_preferred_supplier uuid;
  v_row public.inventory_products%rowtype;
  v_li uuid;
  v_supplier_org uuid;
  v_loc_org uuid;
  v_next_presentation text;
  v_next_factor numeric;
  v_next_divisible boolean;
  v_presentation_touched boolean := false;
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

  if p ? 'presentation_unit' then
    v_presentation_touched := true;
    v_presentation_unit := public.senda_normalize_presentation_unit(p->>'presentation_unit');
  end if;
  if p ? 'conversion_factor' then
    v_presentation_touched := true;
    begin
      v_conversion_factor := nullif(p->>'conversion_factor', '')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'INVALID_CONVERSION_FACTOR';
    end;
  end if;
  if p ? 'divisible' then
    v_presentation_touched := true;
    if jsonb_typeof(p->'divisible') = 'null' or nullif(p->>'divisible', '') is null then
      v_divisible := null;
    elsif jsonb_typeof(p->'divisible') = 'boolean' then
      v_divisible := (p->>'divisible')::boolean;
    else
      raise exception 'INVALID_PRESENTATION';
    end if;
  end if;
  if p ? 'preferred_supplier_id' then
    v_preferred_supplier := nullif(p->>'preferred_supplier_id', '')::uuid;
  end if;

  if v_org is null or v_location is null or v_product is null then
    raise exception 'INVALID_PAYLOAD';
  end if;

  select l.organization_id into v_loc_org
  from public.locations l
  where l.id = v_location;
  if v_loc_org is null then
    raise exception 'LOCATION_NOT_FOUND';
  end if;
  if v_loc_org is distinct from v_org then
    raise exception 'ORG_LOCATION_MISMATCH';
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

  if v_preferred_supplier is not null then
    select s.organization_id into v_supplier_org
    from public.suppliers s
    where s.id = v_preferred_supplier
      and coalesce(s.active, true);
    if v_supplier_org is null then
      raise exception 'SUPPLIER_NOT_FOUND';
    end if;
    if v_supplier_org is distinct from v_org then
      raise exception 'SUPPLIER_ORG_MISMATCH';
    end if;
  end if;

  -- Estado efectivo de presentación tras el patch.
  v_next_presentation := case
    when p ? 'presentation_unit' then v_presentation_unit
    else public.senda_normalize_presentation_unit(v_row.presentation_unit)
  end;
  v_next_factor := case
    when p ? 'conversion_factor' then v_conversion_factor
    else v_row.conversion_factor
  end;
  v_next_divisible := case
    when p ? 'divisible' then v_divisible
    else v_row.divisible
  end;

  if v_presentation_touched then
    perform public.senda_assert_presentation_coherence(
      v_row.base_unit,
      v_next_presentation,
      v_next_factor,
      v_next_divisible
    );

    -- Cambios de factor/unidad con historial: solo vía operación controlada.
    if (
         v_next_presentation is distinct from public.senda_normalize_presentation_unit(v_row.presentation_unit)
      or v_next_factor is distinct from v_row.conversion_factor
    ) and public.senda_inventory_product_has_history(v_product) then
      raise exception 'PRESENTATION_LOCKED';
    end if;
  end if;

  -- Preserva el patrón original: name (+category opcional) / solo category.
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
           category = case when p ? 'category' then v_category else category end,
           presentation_unit = case when p ? 'presentation_unit' then v_presentation_unit else presentation_unit end,
           conversion_factor = case when p ? 'conversion_factor' then v_conversion_factor else conversion_factor end,
           divisible = case when p ? 'divisible' then v_divisible else divisible end,
           preferred_supplier_id = case when p ? 'preferred_supplier_id' then v_preferred_supplier else preferred_supplier_id end
     where id = v_product;
  elsif p ? 'category'
     or p ? 'presentation_unit'
     or p ? 'conversion_factor'
     or p ? 'divisible'
     or p ? 'preferred_supplier_id'
  then
    update public.inventory_products
       set category = case when p ? 'category' then v_category else category end,
           presentation_unit = case when p ? 'presentation_unit' then v_presentation_unit else presentation_unit end,
           conversion_factor = case when p ? 'conversion_factor' then v_conversion_factor else conversion_factor end,
           divisible = case when p ? 'divisible' then v_divisible else divisible end,
           preferred_supplier_id = case when p ? 'preferred_supplier_id' then v_preferred_supplier else preferred_supplier_id end
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
    'location_inventory_id', v_li,
    'presentation_unit', v_row.presentation_unit,
    'conversion_factor', v_row.conversion_factor,
    'divisible', v_row.divisible,
    'preferred_supplier_id', v_row.preferred_supplier_id
  );
end;
$$;

revoke all on function public.senda_update_inventory_product(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_update_inventory_product(jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Operación controlada de presentación (no reinterpreta existencias)
-- ---------------------------------------------------------------------------

create or replace function public.senda_set_inventory_product_presentation(p jsonb)
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
  v_presentation_unit text;
  v_conversion_factor numeric;
  v_divisible boolean;
  v_reason text;
  v_confirm boolean;
  v_row public.inventory_products%rowtype;
  v_loc_org uuid;
  v_had_history boolean;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);
  v_org := (p->>'organization_id')::uuid;
  v_location := (p->>'location_id')::uuid;
  v_product := (p->>'inventory_product_id')::uuid;
  v_reason := nullif(btrim(coalesce(p->>'reason', '')), '');
  v_confirm := coalesce((p->>'confirm_change')::boolean, false);

  v_presentation_unit := public.senda_normalize_presentation_unit(p->>'presentation_unit');
  begin
    v_conversion_factor := nullif(p->>'conversion_factor', '')::numeric;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_CONVERSION_FACTOR';
  end;
  if jsonb_typeof(p->'divisible') = 'boolean' then
    v_divisible := (p->>'divisible')::boolean;
  else
    v_divisible := null;
  end if;

  if v_org is null or v_location is null or v_product is null then
    raise exception 'INVALID_PAYLOAD';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED';
  end if;
  if not v_confirm then
    raise exception 'CONFIRM_REQUIRED';
  end if;

  select l.organization_id into v_loc_org
  from public.locations l
  where l.id = v_location;
  if v_loc_org is null then
    raise exception 'LOCATION_NOT_FOUND';
  end if;
  if v_loc_org is distinct from v_org then
    raise exception 'ORG_LOCATION_MISMATCH';
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

  perform public.senda_assert_presentation_coherence(
    v_row.base_unit,
    v_presentation_unit,
    v_conversion_factor,
    v_divisible
  );

  v_had_history := public.senda_inventory_product_has_history(v_product);

  -- Solo metadatos. No toca valuations, movimientos ni costos.
  update public.inventory_products
     set presentation_unit = v_presentation_unit,
         conversion_factor = v_conversion_factor,
         divisible = v_divisible
   where id = v_product;

  select * into v_row from public.inventory_products where id = v_product;

  return jsonb_build_object(
    'inventory_product_id', v_product,
    'presentation_unit', v_row.presentation_unit,
    'conversion_factor', v_row.conversion_factor,
    'divisible', v_row.divisible,
    'had_history', v_had_history,
    'stock_reinterpreted', false,
    'reason', v_reason
  );
end;
$$;

revoke all on function public.senda_set_inventory_product_presentation(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_set_inventory_product_presentation(jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Alta de proveedor sin duplicados concurrentes
-- ---------------------------------------------------------------------------

create or replace function public.senda_ensure_supplier_from_issuer(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_name text;
  v_tax text;
  v_id uuid;
  v_norm text;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;
  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);
  v_org := (p->>'organization_id')::uuid;
  v_name := nullif(btrim(coalesce(p->>'name', '')), '');
  v_tax := nullif(btrim(coalesce(p->>'tax_id', '')), '');
  if v_org is null or v_name is null or char_length(v_name) < 2 then
    raise exception 'INVALID_PAYLOAD';
  end if;
  if not exists (
    select 1
    from public.organization_members m
    where m.organization_id = v_org
      and m.user_id = v_actor
      and m.status = 'active'
  ) then
    raise exception 'NOT_A_MEMBER';
  end if;

  v_norm := lower(btrim(v_name));

  if v_tax is not null then
    select s.id into v_id
    from public.suppliers s
    where s.organization_id = v_org
      and s.tax_id is not distinct from v_tax
    limit 1
    for update;
  end if;

  if v_id is null then
    select s.id into v_id
    from public.suppliers s
    where s.organization_id = v_org
      and lower(btrim(s.name)) = v_norm
    limit 1
    for update;
  end if;

  if v_id is null then
    begin
      insert into public.suppliers (organization_id, name, tax_id, active)
      values (v_org, v_name, v_tax, true)
      returning id into v_id;
    exception
      when unique_violation then
        if v_tax is not null then
          select s.id into v_id
          from public.suppliers s
          where s.organization_id = v_org
            and s.tax_id is not distinct from v_tax
          limit 1;
        end if;
        if v_id is null then
          select s.id into v_id
          from public.suppliers s
          where s.organization_id = v_org
            and lower(btrim(s.name)) = v_norm
          limit 1;
        end if;
        if v_id is null then
          raise;
        end if;
    end;
  else
    update public.suppliers
       set active = true,
           name = case when btrim(name) = '' then v_name else name end,
           tax_id = coalesce(tax_id, v_tax)
     where id = v_id;
  end if;

  return jsonb_build_object(
    'supplier_id', v_id,
    'organization_id', v_org,
    'name', v_name,
    'tax_id', v_tax
  );
end;
$$;

revoke all on function public.senda_ensure_supplier_from_issuer(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_ensure_supplier_from_issuer(jsonb)
  to service_role;

commit;

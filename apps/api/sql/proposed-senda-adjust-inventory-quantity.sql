-- SENDA OPS — Ajuste trazable de existencias
-- RPC TRANSACCIONAL senda_adjust_inventory_quantity.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Después: apps/api/sql/verify-senda-adjust-inventory-quantity.sql (solo lectura).
--
-- Contrato: apps/api/sql/proposed-senda-adjust-inventory-quantity.md
--
-- Vaciar existencias = ajuste con cantidad = -quantity_on_hand y motivo.
-- Nunca SET quantity_on_hand sin insertar inventory_movements.
-- No desactiva el insumo. No toca costos ni facturas.
--
-- Idempotencia: unique (location_id, idempotency_key); mismo qty → replay;
-- qty distinta → IDEMPOTENCY_CONFLICT.
-- Saldo: next = on_hand + qty; si next < 0 → ADJUSTMENT_EXCEEDS_ON_HAND.
-- Permisos: DEFINER + EXECUTE solo service_role + purchase member.
-- Trazabilidad: inventory_movements (adjustment, cantidad firmada) +
-- inventory_adjustments. Descuento = quantity negativa (salida).
-- movement_type: solo amplía el CHECK existente para incluir 'adjustment';
-- no reemplaza la lista por (purchase, adjustment).

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
      and p.proname = 'senda_adjust_inventory_quantity'
      and pg_get_function_identity_arguments(p.oid) = 'p jsonb'
  ) then
    raise exception 'INVENTORY_ADJUST_RPC_EXISTS';
  end if;

  if to_regclass('public.inventory_adjustments') is not null then
    raise exception 'INVENTORY_ADJUSTMENTS_EXISTS';
  end if;

  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'INVENTORY_ADJUST_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'INVENTORY_ADJUST_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;

  select string_agg(t.table_name, ', ' order by 1)
    into missing
    from (
      values
        ('inventory_products'),
        ('location_inventory'),
        ('inventory_movements'),
        ('inventory_valuations'),
        ('locations'),
        ('organizations')
    ) as t(table_name)
  where to_regclass(format('public.%I', t.table_name)) is null;
  if missing is not null then
    raise exception 'INVENTORY_ADJUST_ABORT: faltan tablas: %', missing;
  end if;
end
$guard$;

-- movement_type: conservar tipos ya admitidos; solo agregar 'adjustment' si falta.
do $chk_movement_type$
declare
  r record;
  v_def text;
  v_token text;
  v_from_check text[] := array[]::text[];
  v_from_data text[] := array[]::text[];
  v_merged text[] := array[]::text[];
  v_has_adjustment boolean := false;
  v_check_count int := 0;
  v_list text;
begin
  for r in
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'inventory_movements'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'movement_type'
  loop
    v_check_count := v_check_count + 1;
    v_def := r.def;
    if v_def ~* '''adjustment''' then
      v_has_adjustment := true;
    end if;
    for v_token in
      select distinct m[1]
      from regexp_matches(v_def, '''([^'']+)''', 'g') as m
    loop
      if v_token is not null and not (v_token = any (v_from_check)) then
        v_from_check := array_append(v_from_check, v_token);
      end if;
    end loop;
  end loop;

  if v_has_adjustment then
    -- Ya admite adjustment: no tocar restricciones existentes.
    null;
  elsif v_check_count = 0 then
    -- Sin CHECK de movement_type: no inventar una lista restrictiva.
    null;
  else
    select coalesce(array_agg(distinct m.movement_type order by 1), array[]::text[])
      into v_from_data
    from public.inventory_movements m
    where m.movement_type is not null;

    v_merged := v_from_check;
    foreach v_token in array v_from_data loop
      if v_token is not null and not (v_token = any (v_merged)) then
        v_merged := array_append(v_merged, v_token);
      end if;
    end loop;
    foreach v_token in array array['purchase', 'adjustment'] loop
      if not (v_token = any (v_merged)) then
        v_merged := array_append(v_merged, v_token);
      end if;
    end loop;

    select array_agg(x order by x) into v_merged from unnest(v_merged) as x;

    for r in
      select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname = 'inventory_movements'
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) ~* 'movement_type'
    loop
      execute format('alter table public.inventory_movements drop constraint %I', r.conname);
    end loop;

    v_list := (
      select string_agg(quote_literal(x), ', ' order by x)
      from unnest(v_merged) as x
    );
    execute format(
      'alter table public.inventory_movements
         add constraint inventory_movements_movement_type_chk
         check (movement_type in (%s))',
      v_list
    );
  end if;
end
$chk_movement_type$;

-- quantity firmada (salida negativa): solo relajar quantity > 0 / >= 0 → <> 0.
do $chk_quantity$
declare
  r record;
  v_def text;
  v_positive_only boolean := false;
begin
  for r in
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'inventory_movements'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'quantity'
      and pg_get_constraintdef(c.oid) !~* 'movement_type'
  loop
    v_def := r.def;
    if v_def ~* 'quantity\s*>\s*0'
       or v_def ~* 'quantity\s*>=\s*0' then
      v_positive_only := true;
      execute format('alter table public.inventory_movements drop constraint %I', r.conname);
    elsif v_def ~* 'quantity\s*<>\s*0'
       or v_def ~* 'quantity\s*!=\s*0' then
      null;
    elsif v_def ~* 'quantity\s*<\s*0' then
      raise exception
        'INVENTORY_ADJUST_ABORT: CHECK de quantity incompatible con ajustes firmados: %',
        v_def;
    end if;
  end loop;

  if v_positive_only
     and not exists (
       select 1
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'public'
         and t.relname = 'inventory_movements'
         and c.contype = 'c'
         and pg_get_constraintdef(c.oid) ~* 'quantity\s*<>\s*0'
     ) then
    alter table public.inventory_movements
      add constraint inventory_movements_quantity_nonzero_chk
      check (quantity <> 0);
  end if;
end
$chk_quantity$;

create table public.inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null,
  inventory_product_id uuid not null,
  location_inventory_id uuid not null,
  quantity numeric not null,
  previous_quantity_on_hand numeric not null,
  next_quantity_on_hand numeric not null,
  reason text not null,
  idempotency_key uuid not null,
  actor_user_id uuid not null,
  inventory_movement_id uuid,
  created_at timestamptz not null default now(),
  constraint inventory_adjustments_qty_chk check (quantity <> 0),
  constraint inventory_adjustments_reason_chk check (char_length(btrim(reason)) >= 3),
  constraint inventory_adjustments_idempotency_key unique (location_id, idempotency_key)
);

alter table public.inventory_adjustments enable row level security;

create policy inventory_adjustments_member_select
  on public.inventory_adjustments
  for select
  to authenticated
  using (public.senda_is_org_active_member(organization_id));

revoke all on table public.inventory_adjustments from public, anon, authenticated;
grant select on table public.inventory_adjustments to authenticated;
grant insert on table public.inventory_adjustments to service_role;

create function public.senda_adjust_inventory_quantity(p jsonb)
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
  v_qty numeric;
  v_reason text;
  v_key uuid;
  v_li uuid;
  v_on_hand numeric;
  v_next numeric;
  v_movement uuid;
  v_adjustment uuid;
  v_existing public.inventory_adjustments%rowtype;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
    v_location := (p->>'location_id')::uuid;
    v_product := (p->>'inventory_product_id')::uuid;
    v_key := (p->>'idempotency_key')::uuid;
    v_qty := (p->>'quantity')::numeric;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  if v_org is null or v_location is null or v_product is null or v_key is null then
    raise exception 'INVALID_PAYLOAD';
  end if;
  if v_qty is null or v_qty = 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  v_reason := btrim(coalesce(p->>'reason', ''));
  if char_length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED';
  end if;

  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id = v_location
      and l.organization_id = v_org
  ) then
    raise exception 'LOCATION_ORG_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.inventory_products ip
    where ip.id = v_product
      and ip.organization_id = v_org
  ) then
    raise exception 'PRODUCT_NOT_IN_ORG';
  end if;

  select *
    into v_existing
  from public.inventory_adjustments a
  where a.location_id = v_location
    and a.idempotency_key = v_key
  for update;
  if v_existing.id is not null then
    if v_existing.quantity is distinct from v_qty
       or v_existing.inventory_product_id is distinct from v_product then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'inventory_product_id', v_existing.inventory_product_id,
      'quantity', v_existing.quantity,
      'previous_quantity_on_hand', v_existing.previous_quantity_on_hand,
      'next_quantity_on_hand', v_existing.next_quantity_on_hand,
      'inventory_movement_id', v_existing.inventory_movement_id,
      'replay', true
    );
  end if;

  -- No forzar active=true: hereda el flag del producto (no reactivar).
  insert into public.location_inventory (
    location_id, inventory_product_id, minimum_stock, active
  )
  select
    v_location,
    v_product,
    0,
    coalesce(ip.active, false)
  from public.inventory_products ip
  where ip.id = v_product
  on conflict (location_id, inventory_product_id) do nothing;

  select li.id
    into v_li
  from public.location_inventory li
  where li.location_id = v_location
    and li.inventory_product_id = v_product
  for update;
  if v_li is null then
    raise exception 'LOCATION_INVENTORY_MISSING';
  end if;

  insert into public.inventory_valuations (
    location_inventory_id,
    quantity_on_hand,
    average_unit_cost,
    last_purchase_unit_cost,
    currency,
    last_purchase_at,
    updated_at
  ) values (
    v_li, 0, null, null, 'ARS', null, now()
  )
  on conflict (location_inventory_id) do nothing;

  select v.quantity_on_hand
    into v_on_hand
  from public.inventory_valuations v
  where v.location_inventory_id = v_li
  for update;
  v_on_hand := coalesce(v_on_hand, 0);
  v_next := v_on_hand + v_qty;
  if v_next < 0 then
    raise exception 'ADJUSTMENT_EXCEEDS_ON_HAND';
  end if;

  -- Cantidad firmada: positiva = entrada, negativa = salida. No usar abs().
  insert into public.inventory_movements (
    location_inventory_id,
    movement_type,
    quantity,
    source_type,
    source_id,
    occurred_at,
    created_at
  ) values (
    v_li,
    'adjustment',
    v_qty,
    'adjustment',
    v_key,
    now(),
    now()
  )
  returning id into v_movement;

  update public.inventory_valuations
     set quantity_on_hand = v_next,
         updated_at = now()
   where location_inventory_id = v_li;

  insert into public.inventory_adjustments (
    organization_id,
    location_id,
    inventory_product_id,
    location_inventory_id,
    quantity,
    previous_quantity_on_hand,
    next_quantity_on_hand,
    reason,
    idempotency_key,
    actor_user_id,
    inventory_movement_id
  ) values (
    v_org,
    v_location,
    v_product,
    v_li,
    v_qty,
    v_on_hand,
    v_next,
    v_reason,
    v_key,
    v_actor,
    v_movement
  )
  returning id into v_adjustment;

  return jsonb_build_object(
    'id', v_adjustment,
    'inventory_product_id', v_product,
    'quantity', v_qty,
    'previous_quantity_on_hand', v_on_hand,
    'next_quantity_on_hand', v_next,
    'inventory_movement_id', v_movement,
    'replay', false
  );
end;
$$;

comment on function public.senda_adjust_inventory_quantity(jsonb) is
  'Ajuste trazable de existencias. No desactiva el insumo. No toca costos. Solo service_role.';

revoke all on function public.senda_adjust_inventory_quantity(jsonb) from public, anon, authenticated;
grant execute on function public.senda_adjust_inventory_quantity(jsonb) to service_role;

do $verify$
declare
  v_body text;
begin
  v_body := pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure);
  if v_body not ilike '%insert into public.inventory_movements%'
     or v_body not ilike '%REASON_REQUIRED%'
     or v_body ilike '%delete from public.inventory_products%'
     or v_body ilike '%purchase_documents%' then
    raise exception 'INVENTORY_ADJUST_ABORT: el RPC debe ajustar con movimiento y motivo.';
  end if;
end
$verify$;

commit;

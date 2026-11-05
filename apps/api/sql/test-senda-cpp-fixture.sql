-- Fixture DESCARTABLE para test-senda-cpp.sql.
-- NO EJECUTAR en SENDA. La base tiene que llamarse senda_cpp_test.
-- Crea el esquema mínimo y los RPC que la migración de CPP reemplaza o inspecciona.
-- No inserta insumos.

do $guard$
begin
  if current_database() is distinct from 'senda_cpp_test'
     and coalesce(current_setting('senda.cpp_test', true), '') is distinct from 'on' then
    raise exception 'TEST_ABORT: solo corre en la base descartable senda_cpp_test.';
  end if;
end
$guard$;

do $extensions$
begin
  create extension if not exists pgcrypto;
exception
  when others then
    create sequence if not exists public.cpp_test_uuid_seq;
    create or replace function public.gen_random_uuid()
    returns uuid
    language sql
    volatile
    as $uuid$
      select (
        substr(md5(nextval('public.cpp_test_uuid_seq')::text || clock_timestamp()::text), 1, 8) || '-' ||
        substr(md5(nextval('public.cpp_test_uuid_seq')::text), 1, 4) || '-4' ||
        substr(md5(clock_timestamp()::text), 1, 3) || '-8' ||
        substr(md5(random()::text), 1, 3) || '-' ||
        substr(md5(nextval('public.cpp_test_uuid_seq')::text || random()::text), 1, 12)
      )::uuid;
    $uuid$;
end
$extensions$;

do $dblink$
begin
  create extension if not exists dblink;
exception
  when others then
    raise notice 'dblink no está en este motor. Las pruebas concurrentes no corren acá.';
end
$dblink$;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end
$roles$;

create table public.organizations (
  id uuid primary key
);

create table public.locations (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id),
  unique (id, organization_id)
);

create table public.inventory_products (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id),
  name text not null,
  active boolean not null default true,
  unique (id, organization_id)
);

create table public.location_inventory (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  inventory_product_id uuid not null,
  minimum_stock numeric not null default 0,
  active boolean not null default true,
  unique (location_id, inventory_product_id)
);

create table public.inventory_valuations (
  location_inventory_id uuid primary key references public.location_inventory (id),
  quantity_on_hand numeric not null default 0,
  average_unit_cost numeric,
  last_purchase_unit_cost numeric,
  currency text,
  last_purchase_at timestamptz,
  updated_at timestamptz
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  location_inventory_id uuid not null references public.location_inventory (id),
  movement_type text not null,
  quantity numeric not null,
  source_type text,
  source_id text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.inventory_cost_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null,
  inventory_product_id uuid not null,
  location_inventory_id uuid not null references public.location_inventory (id),
  previous_unit_cost numeric,
  new_unit_cost numeric not null,
  source text not null,
  source_ref uuid,
  effective_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  actor_user_id uuid,
  purchase_quantity numeric not null,
  purchase_cost numeric(12, 2) not null,
  constraint inventory_cost_history_location_org_fk
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id),
  constraint inventory_cost_history_product_org_fk
    foreign key (inventory_product_id, organization_id)
    references public.inventory_products (id, organization_id),
  constraint inventory_cost_history_source_check
    check (source in ('manual', 'invoice')),
  constraint inventory_cost_history_quantity_positive
    check (purchase_quantity > 0),
  constraint inventory_cost_history_cost_range
    check (purchase_cost >= 0 and purchase_cost <= 9999999999.99)
);

create table public.inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null,
  inventory_product_id uuid not null,
  location_inventory_id uuid not null,
  quantity numeric not null,
  previous_quantity_on_hand numeric not null,
  next_quantity_on_hand numeric not null,
  reason text not null,
  idempotency_key uuid not null,
  actor_user_id uuid,
  inventory_movement_id uuid,
  unique (location_id, idempotency_key)
);

create table public.purchase_documents (
  id uuid primary key,
  location_id uuid not null,
  organization_id uuid not null,
  status text not null,
  currency text,
  document_date date,
  deleted_at timestamptz,
  deleted_by uuid,
  storage_bucket text,
  storage_object_path text,
  issuer_name text,
  document_number text
);

create table public.purchase_document_lines (
  id uuid primary key,
  purchase_document_id uuid not null references public.purchase_documents (id),
  inventory_eligibility text,
  mapping_status text,
  classification text,
  quantity_kind text,
  reviewed_amount numeric,
  original_amount numeric,
  inventory_product_id uuid,
  inventory_physical_quantity numeric
);

create table public.purchase_document_receipts (
  id uuid primary key default gen_random_uuid(),
  purchase_document_id uuid not null,
  purchase_document_line_id uuid not null,
  organization_id uuid not null,
  location_id uuid not null,
  inventory_product_id uuid,
  location_inventory_id uuid,
  quantity numeric not null,
  idempotency_key uuid not null,
  actor_user_id uuid,
  created_at timestamptz not null default now(),
  inventory_movement_id uuid,
  unique (purchase_document_id, idempotency_key)
);

create table public.purchase_document_audit (
  id uuid primary key default gen_random_uuid(),
  purchase_document_id uuid not null,
  action text not null,
  actor_user_id uuid,
  payload jsonb
);

create table public.purchase_invoice_deletion_log (
  purchase_document_id uuid primary key,
  organization_id uuid,
  location_id uuid,
  actor_user_id uuid,
  previous_status text,
  issuer_name text,
  document_number text,
  document_date date,
  reversed_receipts jsonb,
  reversed_movements jsonb,
  cost_rollbacks jsonb,
  storage_bucket text,
  storage_object_path text,
  deleted_at timestamptz
);

create or replace function public.senda_require_backend_actor(p_user_id uuid)
returns uuid
language plpgsql
stable
as $$
begin
  if p_user_id is null then
    raise exception 'ACTOR_REQUIRED';
  end if;
  return p_user_id;
end;
$$;

create or replace function public.senda_actor_is_purchase_member(p_location_id uuid, p_user_id uuid)
returns boolean
language sql
stable
as $$
  select true;
$$;

create or replace function public.senda_purchase_line_is_inventoriable(
  p_eligibility text,
  p_mapping_status text,
  p_classification text,
  p_quantity_kind text,
  p_reviewed_amount numeric,
  p_original_amount numeric
) returns boolean
language sql
immutable
as $$
  select p_eligibility is not distinct from 'eligible'
    and p_mapping_status is distinct from 'not_applicable'
    and coalesce(p_classification, '') not in ('fiscal', 'service', 'ignored', 'expense', 'logistics')
    and coalesce(p_quantity_kind, '') not in ('service_consumption', 'charge', 'none')
    and coalesce(p_reviewed_amount, p_original_amount, 0) >= 0;
$$;

create or replace function public.senda_purchase_document_is_fully_received(p_document_id uuid)
returns boolean
language sql
stable
as $$
  select false;
$$;

create or replace function public.senda_set_inventory_purchase_cost(p jsonb)
returns jsonb
language plpgsql
as $$
begin
  return '{}'::jsonb;
end;
$$;

create or replace function public.senda_receive_purchase_document_line(
  p_document_id uuid,
  p_line_id uuid,
  p_quantity numeric,
  p_idempotency_key uuid,
  p_actor_user_id uuid
) returns jsonb
language plpgsql
as $$
begin
  return '{}'::jsonb;
end;
$$;

create or replace function public.senda_delete_purchase_invoice(p jsonb)
returns jsonb
language plpgsql
as $$
begin
  return '{}'::jsonb;
end;
$$;

create or replace function public.senda_adjust_inventory_quantity(p jsonb)
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
  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);
  v_org := (p->>'organization_id')::uuid;
  v_location := (p->>'location_id')::uuid;
  v_product := (p->>'inventory_product_id')::uuid;
  v_key := (p->>'idempotency_key')::uuid;
  v_qty := (p->>'quantity')::numeric;
  v_reason := btrim(coalesce(p->>'reason', ''));
  if v_qty is null or v_qty = 0 then
    raise exception 'INVALID_QUANTITY';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED';
  end if;

  select *
    into v_existing
  from public.inventory_adjustments a
  where a.location_id = v_location
    and a.idempotency_key = v_key
  for update;
  if v_existing.id is not null then
    return jsonb_build_object(
      'id', v_existing.id,
      'inventory_movement_id', v_existing.inventory_movement_id,
      'previous_quantity_on_hand', v_existing.previous_quantity_on_hand,
      'next_quantity_on_hand', v_existing.next_quantity_on_hand,
      'replay', true
    );
  end if;

  select li.id
    into v_li
  from public.location_inventory li
  where li.location_id = v_location
    and li.inventory_product_id = v_product
  for update;

  select iv.quantity_on_hand
    into v_on_hand
  from public.inventory_valuations iv
  where iv.location_inventory_id = v_li
  for update;
  v_on_hand := coalesce(v_on_hand, 0);
  v_next := v_on_hand + v_qty;
  if v_next < 0 then
    raise exception 'ADJUSTMENT_EXCEEDS_ON_HAND';
  end if;

  insert into public.inventory_movements (
    location_inventory_id, movement_type, quantity, source_type, source_id,
    occurred_at, created_at
  ) values (
    v_li, 'adjustment', v_qty, 'adjustment', v_key::text,
    clock_timestamp(), clock_timestamp()
  )
  returning id into v_movement;

  update public.inventory_valuations
     set quantity_on_hand = v_next,
         updated_at = clock_timestamp()
   where location_inventory_id = v_li;

  insert into public.inventory_adjustments (
    organization_id, location_id, inventory_product_id, location_inventory_id,
    quantity, previous_quantity_on_hand, next_quantity_on_hand, reason,
    idempotency_key, actor_user_id, inventory_movement_id
  ) values (
    v_org, v_location, v_product, v_li,
    v_qty, v_on_hand, v_next, v_reason,
    v_key, v_actor, v_movement
  )
  returning id into v_adjustment;

  return jsonb_build_object(
    'id', v_adjustment,
    'inventory_movement_id', v_movement,
    'previous_quantity_on_hand', v_on_hand,
    'next_quantity_on_hand', v_next,
    'replay', false
  );
end;
$$;

create or replace function public.register_sale_consumption(
  p_location_inventory_id uuid,
  p_quantity numeric,
  p_source_type text,
  p_source_id text
) returns table (inserted boolean, movement_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_li uuid;
  v_on_hand numeric;
  v_next numeric;
  v_existing uuid;
  v_existing_qty numeric;
begin
  if p_quantity is null or p_quantity >= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;
  if p_source_type is null or btrim(p_source_type) = ''
     or p_source_id is null or btrim(p_source_id) = '' then
    raise exception 'INVALID_SOURCE';
  end if;

  select li.id
    into v_li
  from public.location_inventory li
  where li.id = p_location_inventory_id
  for update;
  if v_li is null then
    raise exception 'LOCATION_INVENTORY_MISSING';
  end if;

  select iv.quantity_on_hand
    into v_on_hand
  from public.inventory_valuations iv
  where iv.location_inventory_id = v_li
  for update;

  select m.id, m.quantity
    into v_existing, v_existing_qty
  from public.inventory_movements m
  where m.location_inventory_id = v_li
    and m.movement_type = 'sale'
    and m.source_type = p_source_type
    and m.source_id = p_source_id
  for update;
  if v_existing is not null then
    if v_existing_qty is distinct from p_quantity then
      raise exception 'SALE_IDEMPOTENCY_CONFLICT';
    end if;
    inserted := false;
    movement_id := v_existing;
    return next;
    return;
  end if;

  v_next := coalesce(v_on_hand, 0) + p_quantity;
  if v_next < 0 then
    raise exception 'SALE_EXCEEDS_ON_HAND';
  end if;

  insert into public.inventory_movements (
    location_inventory_id, movement_type, quantity, source_type, source_id,
    occurred_at, created_at
  ) values (
    v_li, 'sale', p_quantity, p_source_type, p_source_id,
    clock_timestamp(), clock_timestamp()
  )
  returning id into movement_id;

  update public.inventory_valuations
     set quantity_on_hand = v_next,
         updated_at = clock_timestamp()
   where location_inventory_id = v_li;
  if not found then
    raise exception 'SALE_EXCEEDS_ON_HAND';
  end if;

  inserted := true;
  return next;
  return;
end;
$$;

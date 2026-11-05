-- SENDA OPS — Paso 447 (adapta el SQL 446)
-- RPC TRANSACCIONAL senda_set_inventory_purchase_cost
-- + tabla inventory_cost_history.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Después: apps/api/sql/verify-senda-set-inventory-purchase-cost.sql (solo lectura).
--
-- Contrato: apps/api/sql/proposed-senda-set-inventory-purchase-cost.md
--
-- Criterio: último costo de compra. No hay promedio ponderado.
-- last_purchase_unit_cost = costo unitario vigente.
-- average_unit_cost = la misma cifra (compatibilidad de recetas). No renombra columnas.
--
-- No hay REPLACE de recetas, precios, Fudo ni recepción de facturas.
-- Si el RPC o la tabla de historial ya existen, aborta.
--
-- Reutiliza senda_require_backend_actor, senda_actor_is_purchase_member
-- y senda_is_org_active_member. No las recrea. No GRANT/REVOKE sobre ellas.
-- EXECUTE del RPC solo service_role.
--
-- Persiste unitario = purchase_cost / purchase_quantity.
-- No cambia quantity_on_hand. No inserta inventory_movements.
-- No toca facturas ni ventas. Etapa B (recepción) no se implementa aquí.

begin;

-- =============================================================================
-- 0. Guardias
-- =============================================================================
do $guard$
declare
  missing text;
begin
  if to_regclass('public.inventory_cost_history') is not null then
    raise exception 'INVENTORY_COST_HISTORY_EXISTS';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'senda_set_inventory_purchase_cost'
      and pg_get_function_identity_arguments(p.oid) = 'p jsonb'
  ) then
    raise exception 'INVENTORY_COST_RPC_EXISTS';
  end if;

  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'INVENTORY_COST_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'INVENTORY_COST_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;
  if to_regprocedure('public.senda_is_org_active_member(uuid)') is null then
    raise exception 'INVENTORY_COST_ABORT: falta senda_is_org_active_member(uuid).';
  end if;

  select string_agg(format('%s.%s', t.table_name, t.column_name), ', ' order by 1)
    into missing
  from (
    values
      ('organizations', 'id'),
      ('locations', 'id'),
      ('locations', 'organization_id'),
      ('inventory_products', 'id'),
      ('inventory_products', 'organization_id'),
      ('location_inventory', 'id'),
      ('location_inventory', 'location_id'),
      ('location_inventory', 'inventory_product_id'),
      ('location_inventory', 'minimum_stock'),
      ('location_inventory', 'active'),
      ('inventory_valuations', 'location_inventory_id'),
      ('inventory_valuations', 'quantity_on_hand'),
      ('inventory_valuations', 'average_unit_cost'),
      ('inventory_valuations', 'last_purchase_unit_cost'),
      ('inventory_valuations', 'currency'),
      ('inventory_valuations', 'last_purchase_at'),
      ('inventory_valuations', 'updated_at')
  ) as t(table_name, column_name)
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = t.table_name
      and c.column_name = t.column_name
  );
  if missing is not null then
    raise exception 'INVENTORY_COST_ABORT: columnas ausentes: %', missing;
  end if;
end
$guard$;

-- =============================================================================
-- 1. Índices UNIQUE (id, organization_id) para FK compuesta
-- =============================================================================
create unique index if not exists locations_id_organization_uniq
  on public.locations (id, organization_id);

create unique index if not exists inventory_products_id_organization_uniq
  on public.inventory_products (id, organization_id);

-- Semántica de las columnas de valuación (no las renombra).
comment on column public.inventory_valuations.last_purchase_unit_cost is
  'Último costo unitario conocido en la unidad base del insumo. Criterio vigente.';
comment on column public.inventory_valuations.average_unit_cost is
  'Compatibilidad para recetas. En esta etapa equivale al último costo de compra, no a un promedio ponderado.';

-- =============================================================================
-- 2. Historial de cambios de costo
-- =============================================================================
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

comment on table public.inventory_cost_history is
  'Append-only. Cada cambio del último costo de compra por local × insumo. Escritura solo RPC.';
comment on column public.inventory_cost_history.previous_unit_cost is
  'Costo unitario vigente antes de este cambio. Null si no había valuación.';
comment on column public.inventory_cost_history.new_unit_cost is
  'Último costo unitario después del cambio. 0 es un costo conocido.';
comment on column public.inventory_cost_history.source is
  'manual = carga desde Inventario. invoice = reserva para Etapa B (recepción).';
comment on column public.inventory_cost_history.source_ref is
  'Referencia de la operación (p. ej. recibo de factura). Null en carga manual.';
comment on column public.inventory_cost_history.effective_at is
  'Fecha efectiva de la compra. En Etapa A es now().';
comment on column public.inventory_cost_history.recorded_at is
  'Fecha de registro en SENDA.';

create index inventory_cost_history_scope_idx
  on public.inventory_cost_history (
    organization_id, location_id, inventory_product_id, recorded_at desc
  );

alter table public.inventory_cost_history enable row level security;

revoke all on table public.inventory_cost_history from public, anon;
revoke all on table public.inventory_cost_history from authenticated;
grant select on table public.inventory_cost_history to authenticated;
grant select, insert on table public.inventory_cost_history to service_role;
revoke update, delete, truncate on table public.inventory_cost_history from service_role;

create policy inventory_cost_history_member_select
on public.inventory_cost_history
for select
to authenticated
using (
  public.senda_is_org_active_member(organization_id)
);

-- =============================================================================
-- 3. RPC — único escritor de último costo
-- =============================================================================
create function public.senda_set_inventory_purchase_cost(p jsonb)
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
  v_cost numeric;
  v_unit_cost numeric;
  v_source text;
  v_source_ref uuid;
  v_effective timestamptz;
  v_location_inventory_id uuid;
  v_on_hand numeric;
  v_currency text;
  v_existing_avg numeric;
  v_existing_last numeric;
  v_existing_last_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_replay boolean := false;
  v_skipped_stale boolean := false;
  v_history_id uuid;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
    v_location := (p->>'location_id')::uuid;
    v_product := (p->>'inventory_product_id')::uuid;
    v_qty := (p->>'purchase_quantity')::numeric;
    v_cost := (p->>'purchase_cost')::numeric;
    v_source_ref := nullif(p->>'source_ref', '')::uuid;
    v_effective := coalesce(nullif(p->>'effective_at', '')::timestamptz, v_now);
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;

  v_source := lower(coalesce(nullif(btrim(p->>'source'), ''), 'manual'));
  if v_source not in ('manual', 'invoice') then
    raise exception 'INVALID_PAYLOAD';
  end if;

  if v_org is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;
  if v_location is null then
    raise exception 'LOCATION_REQUIRED';
  end if;
  if v_product is null then
    raise exception 'PRODUCT_REQUIRED';
  end if;
  if v_qty is null or v_qty <= 0 then
    raise exception 'INVALID_PURCHASE_QUANTITY';
  end if;
  if v_cost is null or v_cost < 0 or v_cost > 9999999999.99 then
    raise exception 'INVALID_PURCHASE_COST';
  end if;

  v_cost := round(v_cost, 2);
  v_unit_cost := round(v_cost / v_qty, 8);

  if not exists (select 1 from public.organizations o where o.id = v_org) then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id = v_location
      and l.organization_id = v_org
  ) then
    raise exception 'LOCATION_NOT_IN_ORG';
  end if;

  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;

  if not exists (
    select 1
    from public.inventory_products ip
    where ip.id = v_product
      and ip.organization_id = v_org
  ) then
    raise exception 'PRODUCT_NOT_IN_ORG';
  end if;

  insert into public.location_inventory (
    location_id, inventory_product_id, minimum_stock, active
  ) values (
    v_location, v_product, 0, true
  )
  on conflict (location_id, inventory_product_id) do nothing;

  select li.id
    into v_location_inventory_id
  from public.location_inventory li
  where li.location_id = v_location
    and li.inventory_product_id = v_product
  for update;
  if v_location_inventory_id is null then
    raise exception 'LOCATION_INVENTORY_MISSING';
  end if;

  select iv.quantity_on_hand, iv.currency, iv.average_unit_cost,
         iv.last_purchase_unit_cost, iv.last_purchase_at
    into v_on_hand, v_currency, v_existing_avg, v_existing_last, v_existing_last_at
  from public.inventory_valuations iv
  where iv.location_inventory_id = v_location_inventory_id
  for update;

  -- Etapa B: una factura más vieja no pisa un último costo más nuevo.
  -- Etapa A (source=manual) siempre reemplaza: last-write-wins bajo FOR UPDATE.
  if found
     and v_source = 'invoice'
     and v_existing_last_at is not null
     and v_effective < v_existing_last_at then
    v_skipped_stale := true;
    return jsonb_build_object(
      'inventory_product_id', v_product,
      'location_id', v_location,
      'purchase_quantity', v_qty,
      'purchase_cost', v_cost,
      'average_unit_cost', v_existing_avg,
      'last_purchase_unit_cost', v_existing_last,
      'quantity_on_hand', v_on_hand,
      'source', v_source,
      'replay', false,
      'skipped_stale', true
    );
  end if;

  if found
     and v_existing_avg is not distinct from v_unit_cost
     and v_existing_last is not distinct from v_unit_cost then
    v_replay := true;
    return jsonb_build_object(
      'inventory_product_id', v_product,
      'location_id', v_location,
      'purchase_quantity', v_qty,
      'purchase_cost', v_cost,
      'average_unit_cost', v_unit_cost,
      'last_purchase_unit_cost', v_unit_cost,
      'quantity_on_hand', v_on_hand,
      'source', v_source,
      'replay', true,
      'skipped_stale', false
    );
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
    v_location_inventory_id,
    coalesce(v_on_hand, 0),
    v_unit_cost,
    v_unit_cost,
    coalesce(nullif(v_currency, ''), 'ARS'),
    v_effective,
    v_now
  )
  on conflict (location_inventory_id) do update
    set average_unit_cost = excluded.average_unit_cost,
        last_purchase_unit_cost = excluded.last_purchase_unit_cost,
        last_purchase_at = excluded.last_purchase_at,
        updated_at = excluded.updated_at;

  insert into public.inventory_cost_history (
    organization_id,
    location_id,
    inventory_product_id,
    location_inventory_id,
    previous_unit_cost,
    new_unit_cost,
    source,
    source_ref,
    effective_at,
    recorded_at,
    actor_user_id,
    purchase_quantity,
    purchase_cost
  ) values (
    v_org,
    v_location,
    v_product,
    v_location_inventory_id,
    coalesce(v_existing_last, v_existing_avg),
    v_unit_cost,
    v_source,
    v_source_ref,
    v_effective,
    v_now,
    v_actor,
    v_qty,
    v_cost
  )
  returning id into v_history_id;

  select iv.quantity_on_hand
    into v_on_hand
  from public.inventory_valuations iv
  where iv.location_inventory_id = v_location_inventory_id;

  return jsonb_build_object(
    'inventory_product_id', v_product,
    'location_id', v_location,
    'purchase_quantity', v_qty,
    'purchase_cost', v_cost,
    'average_unit_cost', v_unit_cost,
    'last_purchase_unit_cost', v_unit_cost,
    'quantity_on_hand', coalesce(v_on_hand, 0),
    'source', v_source,
    'history_id', v_history_id,
    'replay', v_replay,
    'skipped_stale', v_skipped_stale
  );
end;
$$;

comment on function public.senda_set_inventory_purchase_cost(jsonb) is
  'Único escritor del último costo de compra por local × insumo. Sincroniza last_purchase_unit_cost y average_unit_cost. No cambia stock. service_role + actor getUser. Etapa A: source=manual.';

revoke all on function public.senda_set_inventory_purchase_cost(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_set_inventory_purchase_cost(jsonb)
  to service_role;

do $$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'senda_receive_purchase_document_line'
  order by p.oid
  limit 1;
  if v_owner is null then
    select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'senda_map_purchase_document_line'
    order by p.oid
    limit 1;
  end if;
  if v_owner is null then
    raise exception 'INVENTORY_COST_ABORT: no se pudo clonar el owner de recepción o mapeo.';
  end if;
  execute format(
    'alter function public.senda_set_inventory_purchase_cost(jsonb) owner to %I',
    v_owner
  );
  execute format(
    'alter table public.inventory_cost_history owner to %I',
    v_owner
  );
end $$;

do $verify$
declare
  v_definer boolean;
  v_body text;
  v_write_policies integer;
begin
  if to_regclass('public.inventory_cost_history') is null then
    raise exception 'INVENTORY_COST_VERIFY_FAILED: falta inventory_cost_history';
  end if;

  select p.prosecdef, pg_get_functiondef(p.oid)
    into v_definer, v_body
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = to_regprocedure('public.senda_set_inventory_purchase_cost(jsonb)');
  if not coalesce(v_definer, false) then
    raise exception 'INVENTORY_COST_VERIFY_FAILED: no es SECURITY DEFINER';
  end if;
  if not has_function_privilege('service_role', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE') then
    raise exception 'INVENTORY_COST_VERIFY_FAILED: EXECUTE no es solo service_role';
  end if;

  if not has_table_privilege('authenticated', 'public.inventory_cost_history', 'SELECT')
     or has_table_privilege('authenticated', 'public.inventory_cost_history', 'INSERT')
     or has_table_privilege('authenticated', 'public.inventory_cost_history', 'UPDATE')
     or has_table_privilege('authenticated', 'public.inventory_cost_history', 'DELETE')
     or has_table_privilege('anon', 'public.inventory_cost_history', 'SELECT')
     or not has_table_privilege('service_role', 'public.inventory_cost_history', 'INSERT')
     or has_table_privilege('service_role', 'public.inventory_cost_history', 'DELETE') then
    raise exception 'INVENTORY_COST_VERIFY_FAILED: grants de historial';
  end if;

  select count(*) into v_write_policies
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'inventory_cost_history'
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if v_write_policies > 0 then
    raise exception 'INVENTORY_COST_VERIFY_FAILED: hay política de escritura en historial';
  end if;

  v_body := coalesce(v_body, '');
  if v_body not ilike '%round(v_cost / v_qty, 8)%'
     or v_body not ilike '%set average_unit_cost = excluded.average_unit_cost%'
     or v_body not ilike '%last_purchase_unit_cost = excluded.last_purchase_unit_cost%'
     or v_body not ilike '%insert into public.inventory_cost_history%'
     or v_body not ilike '%v_source = ''invoice''%'
     or v_body not ilike '%skipped_stale%'
     or v_body not ilike '%insert into public.location_inventory%'
     or v_body not ilike '%on conflict (location_id, inventory_product_id) do nothing%'
     or v_body not ilike '%for update%'
     or v_body ilike '%insert into public.inventory_movements%'
     or v_body ilike '%quantity_on_hand = public.inventory_valuations.quantity_on_hand +%'
     or v_body ilike '%set quantity_on_hand%'
     or v_body ilike '%purchase_documents%'
     or v_body ilike '%register_sale_consumption%'
     or v_body ilike '%senda_receive_purchase_document_line%'
     or v_body ilike '%update public.recipes%'
     or v_body ilike '%ponderado%' then
    raise exception 'INVENTORY_COST_VERIFY_FAILED: cuerpo inesperado';
  end if;
end
$verify$;

commit;

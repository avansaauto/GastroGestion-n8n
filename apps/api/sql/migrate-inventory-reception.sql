-- SENDA OPS — Paso 335
-- MIGRACIÓN DEFINITIVA de recepción de mercadería.
-- NO EJECUTAR. NO APLICAR sin autorización explícita.
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA → SQL Editor → Run.
-- Después: apps/api/sql/verify-inventory-reception.sql (solo lectura).
--
-- Inspect confirmó:
--   location_inventory (id, location_id, inventory_product_id, minimum_stock, active)
--     UNIQUE (location_id, inventory_product_id). Sin columna de cantidad.
--   inventory_movements (id, location_inventory_id, movement_type, quantity,
--     source_type, source_id, occurred_at, created_at). movement_type admite 'purchase'.
--   inventory_valuations (id, location_inventory_id, quantity_on_hand,
--     average_unit_cost, last_purchase_unit_cost, currency, last_purchase_at, updated_at)
--     UNIQUE (location_inventory_id). El saldo físico vive acá.
--   purchase_receipts UNIQUE (purchase_document_id) → no sirve para parciales.
--   Sin triggers propios en las tablas de inventario inspeccionadas.
--
-- Este script:
--   - crea purchase_document_receipts (eventos parciales por línea)
--   - crea senda_receive_purchase_document_line (RPC atómica, service_role)
--   - inserta inventory_movements.movement_type = 'purchase'
--   - suma quantity_on_hand; NO toca average_unit_cost
--   - no usa purchase_receipts ni purchase_items
--   - no reescribe senda_save / senda_map / senda_cancel
--   - received solo en transición real reviewed→received, service_role y factura completa
--   - received→received no revalida la reserva; transiciones no autorizadas siguen prohibidas
--   - factura completa: cada línea inventariable mapped + producto + qty física > 0 + recibida = facturada
--   - costos nuevos en NULL; no pisa average_unit_cost existente
--   - no escribe Fudo, pending_product_mappings ni datos de prueba
--   - no concede GRANT INSERT/UPDATE a authenticated sobre inventario

begin;

-- =============================================================================
-- 0. Guardias de esquema
-- =============================================================================
do $guard$
declare
  missing text;
  unexpected text;
begin
  if to_regclass('public.purchase_document_receipts') is not null then
    raise exception 'RECEIVE_ABORT: purchase_document_receipts ya existe.';
  end if;
  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'RECEIVE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'RECEIVE_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;
  if to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is null then
    raise exception 'RECEIVE_ABORT: falta senda_map_purchase_document_line. Aplicar persistencia de facturas primero.';
  end if;

  select string_agg(format('%s.%s', t.table_name, t.column_name), ', ' order by 1)
    into missing
  from (
    values
      ('location_inventory', 'id'),
      ('location_inventory', 'location_id'),
      ('location_inventory', 'inventory_product_id'),
      ('location_inventory', 'minimum_stock'),
      ('location_inventory', 'active'),
      ('inventory_movements', 'id'),
      ('inventory_movements', 'location_inventory_id'),
      ('inventory_movements', 'movement_type'),
      ('inventory_movements', 'quantity'),
      ('inventory_movements', 'source_type'),
      ('inventory_movements', 'source_id'),
      ('inventory_movements', 'occurred_at'),
      ('inventory_movements', 'created_at'),
      ('inventory_valuations', 'id'),
      ('inventory_valuations', 'location_inventory_id'),
      ('inventory_valuations', 'quantity_on_hand'),
      ('inventory_valuations', 'average_unit_cost'),
      ('inventory_valuations', 'last_purchase_unit_cost'),
      ('inventory_valuations', 'currency'),
      ('inventory_valuations', 'last_purchase_at'),
      ('inventory_valuations', 'updated_at'),
      ('purchase_documents', 'id'),
      ('purchase_documents', 'status'),
      ('purchase_documents', 'location_id'),
      ('purchase_documents', 'organization_id'),
      ('purchase_documents', 'currency'),
      ('purchase_document_lines', 'id'),
      ('purchase_document_lines', 'purchase_document_id'),
      ('purchase_document_lines', 'inventory_product_id'),
      ('purchase_document_lines', 'inventory_physical_quantity'),
      ('purchase_document_lines', 'mapping_status'),
      ('purchase_document_lines', 'inventory_eligibility')
  ) as t(table_name, column_name)
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = t.table_name
      and c.column_name = t.column_name
  );
  if missing is not null then
    raise exception 'RECEIVE_ABORT: columnas ausentes: %', missing;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'location_inventory' and column_name = 'quantity'
  ) then
    raise exception 'RECEIVE_ABORT: location_inventory.quantity existe; el inspect decía que el saldo no vive ahí.';
  end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'location_inventory'
      and con.contype in ('u', 'p')
      and pg_get_constraintdef(con.oid) ilike '%location_id%'
      and pg_get_constraintdef(con.oid) ilike '%inventory_product_id%'
  ) and not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'location_inventory'
      and indexdef ilike '%unique%'
      and indexdef ilike '%location_id%'
      and indexdef ilike '%inventory_product_id%'
  ) then
    raise exception 'RECEIVE_ABORT: falta UNIQUE (location_id, inventory_product_id) en location_inventory.';
  end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'inventory_valuations'
      and con.contype in ('u', 'p')
      and pg_get_constraintdef(con.oid) ilike '%location_inventory_id%'
  ) and not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'inventory_valuations'
      and indexdef ilike '%unique%'
      and indexdef ilike '%location_inventory_id%'
  ) then
    raise exception 'RECEIVE_ABORT: falta UNIQUE (location_inventory_id) en inventory_valuations.';
  end if;

  select string_agg(format('%s.%s', c.table_name, c.column_name), ', ' order by 1)
    into unexpected
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.is_nullable = 'NO'
    and c.column_default is null
    and c.column_name <> 'id'
    and (
      (c.table_name = 'location_inventory'
        and c.column_name not in ('location_id', 'inventory_product_id', 'minimum_stock', 'active'))
      or (c.table_name = 'inventory_movements'
        and c.column_name not in (
          'location_inventory_id', 'movement_type', 'quantity',
          'source_type', 'source_id', 'occurred_at', 'created_at'
        ))
      or (c.table_name = 'inventory_valuations'
        and c.column_name not in (
          'location_inventory_id', 'quantity_on_hand', 'average_unit_cost',
          'last_purchase_unit_cost', 'currency', 'last_purchase_at', 'updated_at'
        ))
    );
  if unexpected is not null then
    raise exception 'RECEIVE_ABORT: columnas NOT NULL no contempladas: %', unexpected;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_movements'
      and column_name = 'source_id'
      and udt_name not in ('uuid', 'text', 'varchar', 'bpchar')
  ) then
    raise exception 'RECEIVE_ABORT: inventory_movements.source_id no es uuid ni texto.';
  end if;

  if exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'inventory_movements'
      and con.contype = 'f'
      and pg_get_constraintdef(con.oid) ilike '%source_id%'
  ) then
    raise exception 'RECEIVE_ABORT: inventory_movements.source_id tiene FK; no se puede apuntar al recibo.';
  end if;
end
$guard$;

alter table public.inventory_valuations
  alter column average_unit_cost drop not null,
  alter column last_purchase_unit_cost drop not null,
  alter column last_purchase_at drop not null;

-- =============================================================================
-- 1. Eventos de recepción (antes de las funciones que los consultan)
-- =============================================================================
create table public.purchase_document_receipts (
  id uuid primary key default gen_random_uuid(),
  purchase_document_id uuid not null references public.purchase_documents(id),
  purchase_document_line_id uuid not null references public.purchase_document_lines(id),
  organization_id uuid not null references public.organizations(id),
  location_id uuid not null references public.locations(id),
  inventory_product_id uuid not null references public.inventory_products(id),
  location_inventory_id uuid not null references public.location_inventory(id),
  inventory_movement_id uuid references public.inventory_movements(id),
  quantity numeric not null,
  idempotency_key uuid not null,
  actor_user_id uuid not null,
  created_at timestamptz not null default now(),
  unique (purchase_document_id, idempotency_key),
  constraint purchase_document_receipts_qty_chk check (quantity > 0)
);

comment on table public.purchase_document_receipts is
  'Recepciones físicas por línea. No es purchase_receipts. No mueve costos promedio.';
comment on column public.purchase_document_receipts.quantity is
  'Cantidad en unidad de inventory_products (g, ml, unit).';
comment on column public.purchase_document_receipts.idempotency_key is
  'UUID por confirmación. Retry con la misma clave no duplica stock.';

create index purchase_document_receipts_line_idx
  on public.purchase_document_receipts (purchase_document_line_id);

create index purchase_document_receipts_document_idx
  on public.purchase_document_receipts (purchase_document_id, created_at);

-- Misma puerta que senda_map_purchase_document_line (MAP_REQUIRES_ELIGIBLE)
-- y que isInventoriableStoredLine / isInventoriableLine: no fiscal/servicio/
-- gasto/logística, no consumo/cargo, no descuento negativo, no not_applicable.
create or replace function public.senda_purchase_line_is_inventoriable(
  p_eligibility text,
  p_mapping_status text,
  p_classification text,
  p_quantity_kind text,
  p_reviewed_amount numeric,
  p_original_amount numeric
)
returns boolean
language sql
immutable
set search_path = pg_catalog
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
set search_path = pg_catalog, public
as $$
  select
    exists (
      select 1
      from public.purchase_document_lines as l
      where l.purchase_document_id = p_document_id
        and public.senda_purchase_line_is_inventoriable(
          l.inventory_eligibility,
          l.mapping_status,
          l.classification,
          l.quantity_kind,
          l.reviewed_amount,
          l.original_amount
        )
    )
    and not exists (
      select 1
      from public.purchase_document_lines as l
      where l.purchase_document_id = p_document_id
        and public.senda_purchase_line_is_inventoriable(
          l.inventory_eligibility,
          l.mapping_status,
          l.classification,
          l.quantity_kind,
          l.reviewed_amount,
          l.original_amount
        )
        and (
          l.mapping_status is distinct from 'mapped'
          or l.inventory_product_id is null
          or coalesce(l.inventory_physical_quantity, 0) <= 0
          or coalesce((
               select sum(r.quantity)
               from public.purchase_document_receipts as r
               where r.purchase_document_line_id = l.id
             ), 0)
             is distinct from l.inventory_physical_quantity
        )
    );
$$;

-- =============================================================================
-- 2. Trigger de cabecera: reserva received solo en transición real
-- =============================================================================
create or replace function public.purchase_documents_before_write()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  loc_org uuid;
  sup_org uuid;
  line_count integer;
begin
  select organization_id into loc_org
  from public.locations
  where id = new.location_id;

  if loc_org is null then
    raise exception 'LOCATION_NOT_FOUND';
  end if;

  new.updated_at := now();

  if new.supplier_id is not null
     and (tg_op = 'INSERT' or new.supplier_id is distinct from old.supplier_id) then
    select organization_id into sup_org
    from public.suppliers
    where id = new.supplier_id;
    if sup_org is null then
      raise exception 'SUPPLIER_NOT_FOUND';
    end if;
    if sup_org is distinct from loc_org then
      raise exception 'SUPPLIER_ORG_MISMATCH';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'received' then
      raise exception 'STATUS_RECEIVED_RESERVED';
    end if;
    new.organization_id := loc_org;
    new.created_by := coalesce(auth.uid(), new.created_by);
    if new.created_by is null then
      raise exception 'CREATED_BY_REQUIRED';
    end if;
    if new.status is distinct from 'draft' then
      raise exception 'STATUS_INSERT_NOT_ALLOWED';
    end if;
    if new.original_analysis is null then
      raise exception 'DRAFT_REQUIRES_ORIGINAL_ANALYSIS';
    end if;
    if new.file_sha256 is null or new.file_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception 'DRAFT_REQUIRES_FILE_HASH';
    end if;
    if new.storage_bucket is null or new.storage_object_path is null then
      raise exception 'DRAFT_REQUIRES_STORAGE';
    end if;
    if new.integrity_snapshot_sha256 is null then
      raise exception 'DRAFT_REQUIRES_INTEGRITY';
    end if;
    if new.storage_object_path is distinct from (
         loc_org::text || '/invoices/' || new.file_sha256
         || substring(new.storage_object_path from '\.[a-z0-9]+$')
       )
       or substring(new.storage_object_path from '\.[a-z0-9]+$') is null then
      raise exception 'DRAFT_REQUIRES_STORAGE_PATH';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.organization_id := old.organization_id;
    if new.location_id is distinct from old.location_id then
      raise exception 'LOCATION_IMMUTABLE';
    end if;
    if new.created_by is distinct from old.created_by then
      raise exception 'CREATED_BY_IMMUTABLE';
    end if;
    if new.original_analysis is distinct from old.original_analysis then
      raise exception 'ORIGINAL_ANALYSIS_IMMUTABLE';
    end if;
    if new.file_sha256 is distinct from old.file_sha256
       or new.integrity_snapshot_sha256 is distinct from old.integrity_snapshot_sha256
       or new.storage_bucket is distinct from old.storage_bucket
       or new.storage_object_path is distinct from old.storage_object_path then
      raise exception 'INTEGRITY_FIELDS_IMMUTABLE';
    end if;
    if new.issuer_tax_id_normalized is distinct from old.issuer_tax_id_normalized
       or new.voucher_type is distinct from old.voucher_type
       or new.point_of_sale is distinct from old.point_of_sale
       or new.voucher_number is distinct from old.voucher_number
       or new.supplier_id is distinct from old.supplier_id
       or new.document_type is distinct from old.document_type
       or new.document_number is distinct from old.document_number
       or new.document_date is distinct from old.document_date
       or new.currency is distinct from old.currency
       or new.notes is distinct from old.notes
       or new.classification is distinct from old.classification
       or new.issuer_name is distinct from old.issuer_name
       or new.reviewed_analysis is distinct from old.reviewed_analysis
       or new.corrections is distinct from old.corrections
       or new.commercial_decisions is distinct from old.commercial_decisions
       or new.eligible_line_count is distinct from old.eligible_line_count
       or new.fiscal_policy_applied is distinct from old.fiscal_policy_applied
       or new.fiscal_difference_accepted is distinct from old.fiscal_difference_accepted then
      raise exception 'DOCUMENTARY_IMMUTABLE';
    end if;
    if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
      raise exception 'CANCELLED_TERMINAL';
    end if;
    if old.status = 'cancelled' and new.unmapped_line_count is distinct from old.unmapped_line_count then
      raise exception 'CANCELLED_TERMINAL';
    end if;
    if new.status = 'received' and old.status is distinct from 'received' then
      if old.status is distinct from 'reviewed'
         or coalesce(auth.role(), '') is distinct from 'service_role'
         or not public.senda_purchase_document_is_fully_received(new.id) then
        raise exception 'STATUS_RECEIVED_RESERVED';
      end if;
    end if;
    if new.status is distinct from old.status
       and not (
         (old.status = 'draft' and new.status = 'reviewed')
         or (old.status = 'reviewed' and new.status = 'cancelled')
         or (
           old.status = 'reviewed'
           and new.status = 'received'
           and coalesce(auth.role(), '') = 'service_role'
           and public.senda_purchase_document_is_fully_received(new.id)
         )
       ) then
      raise exception 'STATUS_TRANSITION_FORBIDDEN';
    end if;
    if old.status = 'draft' and new.status = 'reviewed' then
      if new.reviewed_analysis is null then
        raise exception 'REVIEWED_REQUIRES_REVIEWED_ANALYSIS';
      end if;
      if new.eligible_line_count is null or new.eligible_line_count < 1 then
        raise exception 'REVIEWED_REQUIRES_ELIGIBLE_LINES';
      end if;
      select count(*) into line_count
      from public.purchase_document_lines
      where purchase_document_id = new.id;
      if coalesce(line_count, 0) < 1 then
        raise exception 'REVIEWED_REQUIRES_LINES';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- =============================================================================
-- 3. Auditoría: evento de recepción
-- =============================================================================
alter table public.purchase_document_audit
  drop constraint if exists purchase_document_audit_action_chk;

alter table public.purchase_document_audit
  add constraint purchase_document_audit_action_chk
  check (action in (
    'invoice_reviewed',
    'invoice_cancelled',
    'invoice_line_mapped',
    'invoice_line_received'
  ));

-- =============================================================================
-- 4. Bloquear cancel y remap si ya hay recepciones (sin reescribir save/map/cancel)
-- =============================================================================
create or replace function public.purchase_documents_block_cancel_with_receipts()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and new.status = 'cancelled'
     and exists (
       select 1
       from public.purchase_document_receipts r
       where r.purchase_document_id = new.id
     ) then
    raise exception 'CANCEL_HAS_RECEIPTS';
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_documents_block_cancel_with_receipts on public.purchase_documents;
create trigger purchase_documents_block_cancel_with_receipts
before update on public.purchase_documents
for each row
execute function public.purchase_documents_block_cancel_with_receipts();

create or replace function public.purchase_document_lines_block_receipted_remap()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and (
       new.inventory_product_id is distinct from old.inventory_product_id
       or new.mapping_status is distinct from old.mapping_status
       or new.inventory_physical_quantity is distinct from old.inventory_physical_quantity
     )
     and exists (
       select 1
       from public.purchase_document_receipts r
       where r.purchase_document_line_id = new.id
     ) then
    raise exception 'LINE_HAS_RECEIPTS';
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_document_lines_block_receipted_remap on public.purchase_document_lines;
create trigger purchase_document_lines_block_receipted_remap
before update on public.purchase_document_lines
for each row
execute function public.purchase_document_lines_block_receipted_remap();

-- =============================================================================
-- 5. RPC atómica
-- =============================================================================
create or replace function public.senda_receive_purchase_document_line(
  p_document_id uuid,
  p_line_id uuid,
  p_quantity numeric,
  p_idempotency_key uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_location uuid;
  v_org uuid;
  v_status text;
  v_currency text;
  v_line public.purchase_document_lines%rowtype;
  v_received numeric;
  v_remaining numeric;
  v_existing public.purchase_document_receipts%rowtype;
  v_receipt_id uuid;
  v_location_inventory_id uuid;
  v_movement_id uuid;
  v_product_org uuid;
  v_now timestamptz := clock_timestamp();
begin
  v_actor := public.senda_require_backend_actor(p_actor_user_id);

  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  select d.location_id, d.organization_id, d.status, d.currency
    into v_location, v_org, v_status, v_currency
  from public.purchase_documents d
  where d.id = p_document_id
  for update;

  if v_location is null then
    raise exception 'DOCUMENT_NOT_FOUND';
  end if;
  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;
  if v_status is distinct from 'reviewed' and v_status is distinct from 'received' then
    raise exception 'RECEIVE_REQUIRES_REVIEWED';
  end if;

  select * into v_line
  from public.purchase_document_lines l
  where l.id = p_line_id
  for update;

  if v_line.id is null or v_line.purchase_document_id is distinct from p_document_id then
    raise exception 'LINE_NOT_FOUND';
  end if;

  select * into v_existing
  from public.purchase_document_receipts r
  where r.purchase_document_id = p_document_id
    and r.idempotency_key = p_idempotency_key;

  if v_existing.id is not null then
    if v_existing.purchase_document_line_id is distinct from p_line_id
       or v_existing.quantity is distinct from p_quantity then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    select coalesce(sum(r.quantity), 0) into v_received
    from public.purchase_document_receipts r
    where r.purchase_document_line_id = p_line_id;
    return jsonb_build_object(
      'id', v_existing.id,
      'purchase_document_id', p_document_id,
      'purchase_document_line_id', p_line_id,
      'quantity', v_existing.quantity,
      'invoiced_quantity', v_line.inventory_physical_quantity,
      'received_quantity', v_received,
      'remaining_quantity', v_line.inventory_physical_quantity - v_received,
      'document_status', v_status,
      'inventory_movement_id', v_existing.inventory_movement_id,
      'idempotent', true
    );
  end if;

  if not public.senda_purchase_line_is_inventoriable(
    v_line.inventory_eligibility,
    v_line.mapping_status,
    v_line.classification,
    v_line.quantity_kind,
    v_line.reviewed_amount,
    v_line.original_amount
  ) then
    raise exception 'LINE_NOT_INVENTORIABLE';
  end if;
  if v_line.mapping_status is distinct from 'mapped'
     or v_line.inventory_product_id is null then
    raise exception 'LINE_NOT_MAPPED';
  end if;
  if coalesce(v_line.inventory_physical_quantity, 0) <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  select p.organization_id into v_product_org
  from public.inventory_products p
  where p.id = v_line.inventory_product_id;
  if v_product_org is null then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  if v_product_org is distinct from v_org then
    raise exception 'PRODUCT_ORG_MISMATCH';
  end if;

  select l.organization_id into v_product_org
  from public.locations l
  where l.id = v_location;
  if v_product_org is distinct from v_org then
    raise exception 'LOCATION_ORG_MISMATCH';
  end if;

  select coalesce(sum(r.quantity), 0) into v_received
  from public.purchase_document_receipts r
  where r.purchase_document_line_id = p_line_id;

  v_remaining := v_line.inventory_physical_quantity - v_received;
  if p_quantity > v_remaining then
    raise exception 'RECEIPT_EXCEEDS_INVOICED';
  end if;

  insert into public.location_inventory (
    location_id, inventory_product_id, minimum_stock, active
  ) values (
    v_location, v_line.inventory_product_id, 0, true
  )
  on conflict (location_id, inventory_product_id) do nothing;

  select li.id into v_location_inventory_id
  from public.location_inventory li
  where li.location_id = v_location
    and li.inventory_product_id = v_line.inventory_product_id
  for update;

  if v_location_inventory_id is null then
    raise exception 'LOCATION_INVENTORY_MISSING';
  end if;

  insert into public.purchase_document_receipts (
    purchase_document_id,
    purchase_document_line_id,
    organization_id,
    location_id,
    inventory_product_id,
    location_inventory_id,
    quantity,
    idempotency_key,
    actor_user_id,
    created_at
  ) values (
    p_document_id,
    p_line_id,
    v_org,
    v_location,
    v_line.inventory_product_id,
    v_location_inventory_id,
    p_quantity,
    p_idempotency_key,
    v_actor,
    v_now
  )
  returning id into v_receipt_id;

  insert into public.inventory_movements (
    location_inventory_id,
    movement_type,
    quantity,
    source_type,
    source_id,
    occurred_at,
    created_at
  ) values (
    v_location_inventory_id,
    'purchase',
    p_quantity,
    'purchase',
    v_receipt_id,
    v_now,
    v_now
  )
  returning id into v_movement_id;

  update public.purchase_document_receipts
     set inventory_movement_id = v_movement_id
   where id = v_receipt_id;

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
    p_quantity,
    null,
    null,
    coalesce(nullif(v_currency, ''), 'ARS'),
    null,
    v_now
  )
  on conflict (location_inventory_id) do update
    set quantity_on_hand = public.inventory_valuations.quantity_on_hand + excluded.quantity_on_hand,
        updated_at = v_now;

  if v_status is distinct from 'received'
     and public.senda_purchase_document_is_fully_received(p_document_id) then
    update public.purchase_documents
       set status = 'received'
     where id = p_document_id;
    v_status := 'received';
  end if;

  insert into public.purchase_document_audit (
    purchase_document_id, action, actor_user_id, payload
  ) values (
    p_document_id,
    'invoice_line_received',
    v_actor,
    jsonb_build_object(
      'line_id', p_line_id,
      'receipt_id', v_receipt_id,
      'inventory_movement_id', v_movement_id,
      'quantity', p_quantity,
      'actor_user_id', v_actor,
      'idempotency_key', p_idempotency_key
    )
  );

  return jsonb_build_object(
    'id', v_receipt_id,
    'purchase_document_id', p_document_id,
    'purchase_document_line_id', p_line_id,
    'quantity', p_quantity,
    'invoiced_quantity', v_line.inventory_physical_quantity,
    'received_quantity', v_received + p_quantity,
    'remaining_quantity', v_remaining - p_quantity,
    'document_status', v_status,
    'inventory_movement_id', v_movement_id,
    'idempotent', false
  );
end;
$$;

comment on function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid) is
  'Recepcion atomica service_role. Suma quantity_on_hand. No toca average_unit_cost ni Fudo.';

-- =============================================================================
-- 7. Owner = el DEFINER de mapeo que ya funciona
-- =============================================================================
do $$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'senda_map_purchase_document_line'
  order by p.oid
  limit 1;

  if v_owner is null then
    raise exception 'RECEIVE_ABORT: no se pudo clonar el owner de senda_map_purchase_document_line.';
  end if;

  execute format(
    'alter function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid) owner to %I',
    v_owner
  );
  execute format(
    'alter function public.senda_purchase_line_is_inventoriable(text, text, text, text, numeric, numeric) owner to %I',
    v_owner
  );
  execute format(
    'alter function public.senda_purchase_document_is_fully_received(uuid) owner to %I',
    v_owner
  );
end $$;

-- =============================================================================
-- 8. RLS y grants
-- =============================================================================
alter table public.purchase_document_receipts enable row level security;

drop policy if exists purchase_document_receipts_member_select on public.purchase_document_receipts;
create policy purchase_document_receipts_member_select
on public.purchase_document_receipts
for select
to authenticated
using (public.senda_is_purchase_member(location_id));

revoke all on table public.purchase_document_receipts from public, anon, authenticated, service_role;
grant select on table public.purchase_document_receipts to authenticated, service_role;

revoke all on function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.senda_purchase_line_is_inventoriable(text, text, text, text, numeric, numeric)
  from public, anon, service_role;
revoke all on function public.senda_purchase_document_is_fully_received(uuid)
  from public, anon, service_role;
revoke all on function public.purchase_documents_block_cancel_with_receipts()
  from public, anon, authenticated, service_role;
revoke all on function public.purchase_document_lines_block_receipted_remap()
  from public, anon, authenticated, service_role;

grant execute on function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)
  to service_role;
grant execute on function public.senda_purchase_line_is_inventoriable(text, text, text, text, numeric, numeric)
  to authenticated, service_role;
grant execute on function public.senda_purchase_document_is_fully_received(uuid)
  to authenticated, service_role;

commit;

-- SENDA OPS — Eliminación lógica de factura + reversión de stock/costos
-- RPC: senda_delete_purchase_invoice(jsonb) → jsonb
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción.
-- Después: apps/api/sql/verify-senda-delete-purchase-invoice.sql (solo lectura).
--
-- Contrato: apps/api/sql/proposed-senda-delete-purchase-invoice.md
--
-- Eliminación lógica (deleted_at). Conserva documento, líneas, recibos,
-- audit y movimientos de compra.
-- Reversión de stock: llama senda_adjust_inventory_quantity (idempotency_key =
-- receipt_id, quantity negativa = recibida). No inserta movimientos a mano.
-- NO desactiva triggers ni auditoría. NO altera CHECKs existentes vía regex.
-- Requiere senda_adjust_inventory_quantity ya instalado.
-- No REPLACE senda_receive / senda_confirm / senda_cancel / costos / adjust.
-- EXECUTE solo service_role.

begin;

do $guard$
declare
  missing_tables text;
begin
  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'DELETE_INVOICE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'DELETE_INVOICE_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;
  if to_regprocedure('public.senda_adjust_inventory_quantity(jsonb)') is null then
    raise exception
      'DELETE_INVOICE_ABORT: falta senda_adjust_inventory_quantity(jsonb). Instalar el ajuste de inventario antes (movement_type=adjustment, quantity firmada). Este script no modifica CHECKs.';
  end if;

  select string_agg(t.table_name, ', ' order by 1)
    into missing_tables
    from (
      values
        ('purchase_documents'),
        ('purchase_document_lines'),
        ('purchase_document_audit'),
        ('purchase_document_receipts'),
        ('locations'),
        ('inventory_movements'),
        ('inventory_valuations'),
        ('location_inventory')
    ) as t(table_name)
  where to_regclass(format('public.%I', t.table_name)) is null;
  if missing_tables is not null then
    raise exception 'DELETE_INVOICE_ABORT: faltan tablas: %', missing_tables;
  end if;
end
$guard$;

-- Soft-delete: columnas (no cambia status ni dispara CANCEL_HAS_RECEIPTS)
alter table public.purchase_documents
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

comment on column public.purchase_documents.deleted_at is
  'Eliminación lógica. Null = visible en listados. Conserva recibos y auditoría.';
comment on column public.purchase_documents.deleted_by is
  'Actor (auth.users) que marcó deleted_at vía senda_delete_purchase_invoice.';

-- Las líneas no se marcan: purchase_document_lines_before_write solo permite
-- UPDATE si el documento está reviewed. La visibilidad operativa depende de
-- purchase_documents.deleted_at; las líneas y recibos se conservan intactos.

create index if not exists purchase_documents_active_location_idx
  on public.purchase_documents (location_id, document_date desc)
  where deleted_at is null;

create index if not exists purchase_documents_deleted_at_idx
  on public.purchase_documents (deleted_at)
  where deleted_at is not null;

-- Log de eliminación (append-oriented; no reemplaza purchase_document_audit)
create table if not exists public.purchase_invoice_deletion_log (
  id uuid primary key default gen_random_uuid(),
  purchase_document_id uuid not null,
  organization_id uuid not null,
  location_id uuid not null,
  actor_user_id uuid not null,
  previous_status text,
  issuer_name text,
  document_number text,
  document_date date,
  reversed_receipts jsonb not null default '[]'::jsonb,
  reversed_movements jsonb not null default '[]'::jsonb,
  cost_rollbacks jsonb not null default '[]'::jsonb,
  storage_bucket text,
  storage_object_path text,
  deleted_at timestamptz not null default now(),
  constraint purchase_invoice_deletion_log_document_uniq unique (purchase_document_id)
);

-- Compatibilidad con borrador previo que usaba supplier_name
do $log_cols$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_invoice_deletion_log'
      and column_name = 'supplier_name'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_invoice_deletion_log'
      and column_name = 'issuer_name'
  ) then
    alter table public.purchase_invoice_deletion_log
      rename column supplier_name to issuer_name;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_invoice_deletion_log'
      and column_name = 'issuer_name'
  ) then
    alter table public.purchase_invoice_deletion_log
      add column issuer_name text;
  end if;
end
$log_cols$;

comment on table public.purchase_invoice_deletion_log is
  'Quién eliminó lógicamente una factura, cuándo y qué stock/costos se revirtieron.';

alter table public.purchase_invoice_deletion_log enable row level security;

revoke all on table public.purchase_invoice_deletion_log from public, anon;
revoke all on table public.purchase_invoice_deletion_log from authenticated;
grant select on table public.purchase_invoice_deletion_log to authenticated;
grant select, insert on table public.purchase_invoice_deletion_log to service_role;
revoke update, delete, truncate on table public.purchase_invoice_deletion_log from service_role;

do $deletion_log_rls$
begin
  if to_regprocedure('public.senda_is_org_active_member(uuid)') is null then
    return;
  end if;
  execute $p$
    drop policy if exists purchase_invoice_deletion_log_member_select
      on public.purchase_invoice_deletion_log;
    create policy purchase_invoice_deletion_log_member_select
    on public.purchase_invoice_deletion_log
    for select
    to authenticated
    using (public.senda_is_org_active_member(organization_id))
  $p$;
end
$deletion_log_rls$;

-- Idempotencia de stock: inventory_adjustments (location_id, idempotency_key)
-- con idempotency_key = receipt_id vía senda_adjust_inventory_quantity.
-- No crear índice propio sobre inventory_movements.
drop index if exists public.inventory_movements_invoice_delete_src_uniq;

-- Proteger documentos ya eliminados (sin tocar purchase_documents_before_write)
create or replace function public.purchase_documents_protect_logical_delete()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    if old.deleted_at is not null then
      raise exception 'DOCUMENT_ALREADY_DELETED';
    end if;
    if new.deleted_at is not null and old.deleted_at is null then
      if coalesce(auth.role(), '') is distinct from 'service_role' then
        raise exception 'DELETE_REQUIRES_SERVICE_ROLE';
      end if;
      if new.deleted_by is null then
        raise exception 'DELETE_REQUIRES_ACTOR';
      end if;
    elsif new.deleted_at is distinct from old.deleted_at
       or new.deleted_by is distinct from old.deleted_by then
      raise exception 'DELETED_AT_IMMUTABLE';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_documents_protect_logical_delete
  on public.purchase_documents;
create trigger purchase_documents_protect_logical_delete
before update on public.purchase_documents
for each row
execute function public.purchase_documents_protect_logical_delete();

-- Bloquear nuevas recepciones sobre factura eliminada (sin reescribir receive)
create or replace function public.purchase_document_receipts_block_deleted_document()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
    from public.purchase_documents d
    where d.id = new.purchase_document_id
      and d.deleted_at is not null
  ) then
    raise exception 'DOCUMENT_ALREADY_DELETED';
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_document_receipts_block_deleted_document
  on public.purchase_document_receipts;
create trigger purchase_document_receipts_block_deleted_document
before insert on public.purchase_document_receipts
for each row
execute function public.purchase_document_receipts_block_deleted_document();

drop function if exists public.senda_delete_purchase_invoice(jsonb);

create function public.senda_delete_purchase_invoice(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_doc uuid;
  v_location uuid;
  v_org uuid;
  v_status text;
  v_bucket text;
  v_path text;
  v_issuer text;
  v_number text;
  v_doc_date date;
  v_deleted_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_rec record;
  v_li uuid;
  v_li_location uuid;
  v_li_product uuid;
  v_on_hand numeric;
  v_product_name text;
  v_adjust jsonb;
  v_already uuid;
  v_already_mov uuid;
  v_reversed_receipts jsonb := '[]'::jsonb;
  v_reversed_movements jsonb := '[]'::jsonb;
  v_cost_rollbacks jsonb := '[]'::jsonb;
  v_receipt_ids uuid[];
  v_li_ids uuid[];
  v_li_row uuid;
  v_our_product uuid;
  v_restore_cost numeric;
  v_restore_at timestamptz;
  v_existing_last numeric;
  v_existing_avg numeric;
  v_has_cost_history boolean;
  v_moved integer;
  v_sqlstate text;
  v_sqlerrm text;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_doc := (p->>'purchase_document_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  if v_doc is null then
    raise exception 'INVALID_PAYLOAD';
  end if;

  select d.location_id, d.organization_id, d.status,
         d.storage_bucket, d.storage_object_path,
         d.issuer_name, d.document_number, d.document_date,
         d.deleted_at
    into v_location, v_org, v_status, v_bucket, v_path,
         v_issuer, v_number, v_doc_date, v_deleted_at
  from public.purchase_documents d
  where d.id = v_doc
  for update;

  if v_location is null then
    raise exception 'DOCUMENT_NOT_FOUND';
  end if;

  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;

  -- Idempotencia: ya eliminada lógicamente
  if v_deleted_at is not null then
    return jsonb_build_object(
      'id', v_doc,
      'organization_id', v_org,
      'location_id', v_location,
      'previous_status', v_status,
      'storage_bucket', v_bucket,
      'storage_object_path', v_path,
      'replay', true,
      'deleted_at', v_deleted_at
    );
  end if;

  select coalesce(array_agg(rec.id order by rec.created_at, rec.id), array[]::uuid[])
    into v_receipt_ids
  from public.purchase_document_receipts rec
  where rec.purchase_document_id = v_doc;

  -- 1) Revertir stock por cada recepción vía senda_adjust_inventory_quantity
  --    idempotency_key = receipt_id → no duplica movimientos.
  for v_rec in
    select
      rec.id as receipt_id,
      rec.quantity,
      rec.inventory_product_id,
      rec.location_inventory_id,
      rec.inventory_movement_id as original_movement_id,
      ip.name as product_name,
      ip.active as product_active
    from public.purchase_document_receipts rec
    left join public.inventory_products ip on ip.id = rec.inventory_product_id
    where rec.purchase_document_id = v_doc
    order by rec.created_at, rec.id
    for update of rec
  loop
    -- Replay: ajuste ya registrado para este recibo
    v_already := null;
    v_already_mov := null;
    select a.id, a.inventory_movement_id
      into v_already, v_already_mov
    from public.inventory_adjustments a
    where a.location_id = v_location
      and a.idempotency_key = v_rec.receipt_id
    limit 1;

    if v_already is not null then
      v_reversed_receipts := v_reversed_receipts || jsonb_build_array(jsonb_build_object(
        'receipt_id', v_rec.receipt_id,
        'quantity', v_rec.quantity,
        'inventory_product_id', v_rec.inventory_product_id,
        'skipped', 'already_reversed',
        'adjustment_id', v_already,
        'compensation_movement_id', v_already_mov
      ));
      v_reversed_movements := v_reversed_movements || jsonb_build_array(jsonb_build_object(
        'receipt_id', v_rec.receipt_id,
        'adjustment_id', v_already,
        'compensation_movement_id', v_already_mov,
        'replay', true
      ));
      continue;
    end if;

    -- Producto eliminado físicamente: no hay fila en inventory_products.
    -- No llamar adjust (crearía/recrearía inventario). Registrar y continuar.
    if v_rec.inventory_product_id is null or v_rec.product_name is null then
      v_reversed_receipts := v_reversed_receipts || jsonb_build_array(jsonb_build_object(
        'receipt_id', v_rec.receipt_id,
        'quantity', v_rec.quantity,
        'inventory_product_id', v_rec.inventory_product_id,
        'skipped', 'missing_inventory',
        'product_missing', true
      ));
      continue;
    end if;

    v_li := null;
    v_li_location := null;
    v_li_product := null;
    if v_rec.location_inventory_id is not null then
      select li.id, li.location_id, li.inventory_product_id
        into v_li, v_li_location, v_li_product
      from public.location_inventory li
      where li.id = v_rec.location_inventory_id
      for update;

      if v_li is not null then
        -- Referencia inconsistente: no descontar otro inventario ni tratar como missing.
        if v_li_location is distinct from v_location
           or v_li_product is distinct from v_rec.inventory_product_id then
          raise exception 'REVERSAL_INVENTORY_REF_MISMATCH:%:%',
            v_rec.receipt_id, v_rec.location_inventory_id
            using errcode = 'P0001';
        end if;
      end if;
      -- ID ausente (LI borrado): no caer a otro LI; missing_inventory más abajo.
    else
      select li.id into v_li
      from public.location_inventory li
      where li.location_id = v_location
        and li.inventory_product_id = v_rec.inventory_product_id
      for update;
    end if;

    -- Sin inventario asociado en el local: no crear LI vía adjust; permitir delete.
    if v_li is null then
      v_reversed_receipts := v_reversed_receipts || jsonb_build_array(jsonb_build_object(
        'receipt_id', v_rec.receipt_id,
        'quantity', v_rec.quantity,
        'inventory_product_id', v_rec.inventory_product_id,
        'skipped', 'missing_inventory',
        'product_missing', false,
        'product_inactive', coalesce(v_rec.product_active, false) is not true
      ));
      continue;
    end if;

    -- Hay producto + location_inventory: la reversión es obligatoria.
    -- Errores de vinculación/permisos/datos → abortan toda la operación (no omitir).
    -- Producto inactivo: sí se revierte si el inventario existe.

    -- Si hay LI pero no valuación, materializar saldo antes del adjust.
    if not exists (
      select 1
      from public.inventory_valuations iv
      where iv.location_inventory_id = v_li
    ) then
      select coalesce(sum(m.quantity), 0) into v_on_hand
      from public.inventory_movements m
      where m.location_inventory_id = v_li;

      insert into public.inventory_valuations (
        location_inventory_id,
        quantity_on_hand,
        average_unit_cost,
        last_purchase_unit_cost,
        currency,
        last_purchase_at,
        updated_at
      ) values (
        v_li, v_on_hand, null, null, 'ARS', null, v_now
      )
      on conflict (location_inventory_id) do nothing;
    end if;

    select iv.quantity_on_hand into v_on_hand
    from public.inventory_valuations iv
    where iv.location_inventory_id = v_li
    for update;

    if not found then
      raise exception 'REVERSAL_VALUATION_MISSING';
    end if;

    v_on_hand := coalesce(v_on_hand, 0);
    if v_on_hand < v_rec.quantity then
      v_product_name := coalesce(nullif(btrim(v_rec.product_name), ''), 'Producto');
      raise exception 'REVERSAL_INSUFFICIENT_STOCK:%:%:%',
        v_product_name, v_rec.quantity, v_on_hand
        using errcode = 'P0001';
    end if;

    begin
      v_adjust := public.senda_adjust_inventory_quantity(jsonb_build_object(
        'actor_user_id', v_actor,
        'organization_id', v_org,
        'location_id', v_location,
        'inventory_product_id', v_rec.inventory_product_id,
        'idempotency_key', v_rec.receipt_id,
        'quantity', -v_rec.quantity,
        'reason', 'Reversion por eliminacion de factura'
      ));
    exception
      when others then
        get stacked diagnostics
          v_sqlstate = returned_sqlstate,
          v_sqlerrm = message_text;
        -- Stock insuficiente → código estable. Cualquier otro error aborta el RPC
        -- (rollback completo: no se marca deleted_at).
        if v_sqlerrm ilike '%ADJUSTMENT_EXCEEDS_ON_HAND%'
           or v_sqlerrm ilike '%REVERSAL_INSUFFICIENT_STOCK%' then
          v_product_name := coalesce(nullif(btrim(v_rec.product_name), ''), 'Producto');
          raise exception 'REVERSAL_INSUFFICIENT_STOCK:%:%:%',
            v_product_name, v_rec.quantity, v_on_hand
            using errcode = 'P0001';
        end if;
        raise exception 'REVERSAL_ABORTED:%', left(v_sqlerrm, 120)
          using errcode = coalesce(nullif(v_sqlstate, ''), 'P0001');
    end;

    v_reversed_receipts := v_reversed_receipts || jsonb_build_array(jsonb_build_object(
      'receipt_id', v_rec.receipt_id,
      'quantity', v_rec.quantity,
      'inventory_product_id', v_rec.inventory_product_id,
      'location_inventory_id', v_li,
      'original_movement_id', v_rec.original_movement_id,
      'adjustment_id', v_adjust->>'id',
      'product_inactive', coalesce(v_rec.product_active, false) is not true
    ));
    v_reversed_movements := v_reversed_movements || jsonb_build_array(jsonb_build_object(
      'receipt_id', v_rec.receipt_id,
      'adjustment_id', v_adjust->>'id',
      'compensation_movement_id', v_adjust->>'inventory_movement_id',
      'quantity', -v_rec.quantity,
      'previous_quantity_on_hand', v_adjust->'previous_quantity_on_hand',
      'next_quantity_on_hand', v_adjust->'next_quantity_on_hand',
      'replay', coalesce((v_adjust->>'replay')::boolean, false)
    ));
  end loop;

  -- 2) Costos: recalcular excluyendo compras de facturas eliminadas (incluida esta)
  if to_regclass('public.inventory_cost_history') is not null
     and cardinality(v_receipt_ids) > 0 then
    select coalesce(array_agg(distinct x.li), array[]::uuid[])
      into v_li_ids
    from (
      select rec.location_inventory_id as li
      from public.purchase_document_receipts rec
      where rec.purchase_document_id = v_doc
        and rec.location_inventory_id is not null
      union
      select li.id
      from public.purchase_document_receipts rec
      join public.location_inventory li
        on li.location_id = rec.location_id
       and li.inventory_product_id = rec.inventory_product_id
      where rec.purchase_document_id = v_doc
    ) x
    where x.li is not null;

    foreach v_li_row in array v_li_ids
    loop
      select iv.average_unit_cost, iv.last_purchase_unit_cost
        into v_existing_avg, v_existing_last
      from public.inventory_valuations iv
      where iv.location_inventory_id = v_li_row
      for update;

      if not found then
        continue;
      end if;

      v_has_cost_history := exists (
        select 1
        from public.inventory_cost_history h
        where h.location_inventory_id = v_li_row
          and h.source_ref = any (v_receipt_ids)
      );

      if not v_has_cost_history then
        -- Esta factura no escribió costo; no tocar valuación de costos.
        continue;
      end if;

      select li.inventory_product_id into v_our_product
      from public.location_inventory li
      where li.id = v_li_row;

      -- Última compra válida: manual, o invoice cuyo recibo pertenece a factura NO eliminada
      -- (excluimos la actual porque aún no tiene deleted_at en esta lectura).
      v_restore_cost := null;
      v_restore_at := null;
      select h.new_unit_cost, h.effective_at
        into v_restore_cost, v_restore_at
      from public.inventory_cost_history h
      where h.location_inventory_id = v_li_row
        and (
          h.source = 'manual'
          or (
            h.source = 'invoice'
            and h.source_ref is not null
            and exists (
              select 1
              -- Alias `pr` (no `r`): evita colisión PL/pgSQL con variables de registro.
              from public.purchase_document_receipts pr
              join public.purchase_documents d on d.id = pr.purchase_document_id
              where pr.id = h.source_ref
                and d.deleted_at is null
                and d.id is distinct from v_doc
            )
          )
        )
      order by h.recorded_at desc, h.id desc
      limit 1;

      update public.inventory_valuations
         set average_unit_cost = v_restore_cost,
             last_purchase_unit_cost = v_restore_cost,
             last_purchase_at = v_restore_at,
             updated_at = v_now
       where location_inventory_id = v_li_row;

      v_cost_rollbacks := v_cost_rollbacks || jsonb_build_array(jsonb_build_object(
        'location_inventory_id', v_li_row,
        'inventory_product_id', v_our_product,
        'action', case when v_restore_cost is null then 'cleared' else 'restored' end,
        'previous_unit_cost', coalesce(v_existing_last, v_existing_avg),
        'restored_unit_cost', v_restore_cost,
        'excluded_deleted_invoices', true
      ));
    end loop;
  end if;

  -- 3) Auditoría persistente
  insert into public.purchase_invoice_deletion_log (
    purchase_document_id,
    organization_id,
    location_id,
    actor_user_id,
    previous_status,
    issuer_name,
    document_number,
    document_date,
    reversed_receipts,
    reversed_movements,
    cost_rollbacks,
    storage_bucket,
    storage_object_path,
    deleted_at
  ) values (
    v_doc,
    v_org,
    v_location,
    v_actor,
    v_status,
    v_issuer,
    v_number,
    v_doc_date,
    v_reversed_receipts,
    v_reversed_movements,
    v_cost_rollbacks,
    v_bucket,
    v_path,
    v_now
  )
  on conflict (purchase_document_id) do nothing;

  -- 4) Eliminación lógica de cabecera (conserva líneas, recibos, audit, movimientos)
  update public.purchase_documents
     set deleted_at = v_now,
         deleted_by = v_actor
   where id = v_doc
     and deleted_at is null;

  get diagnostics v_moved = row_count;
  if v_moved is distinct from 1 then
    raise exception 'DOCUMENT_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'id', v_doc,
    'organization_id', v_org,
    'location_id', v_location,
    'previous_status', v_status,
    'storage_bucket', v_bucket,
    'storage_object_path', v_path,
    'deleted_at', v_now,
    'replay', false,
    'reversed_receipt_count', jsonb_array_length(v_reversed_receipts),
    'reversed_movements', v_reversed_movements,
    'cost_rollbacks', v_cost_rollbacks
  );
end;
$$;

comment on function public.senda_delete_purchase_invoice(jsonb) is
  'Eliminación lógica de factura + compensación de stock/costos. Conserva historial. Solo service_role.';

revoke all on function public.senda_delete_purchase_invoice(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_delete_purchase_invoice(jsonb)
  to service_role;

revoke all on function public.purchase_documents_protect_logical_delete()
  from public, anon, authenticated;
revoke all on function public.purchase_document_receipts_block_deleted_document()
  from public, anon, authenticated;

do $$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'senda_cancel_purchase_invoice'
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
    raise exception 'DELETE_INVOICE_ABORT: no se pudo clonar owner.';
  end if;
  execute format(
    'alter function public.senda_delete_purchase_invoice(jsonb) owner to %I',
    v_owner
  );
  execute format(
    'alter function public.purchase_documents_protect_logical_delete() owner to %I',
    v_owner
  );
  execute format(
    'alter function public.purchase_document_receipts_block_deleted_document() owner to %I',
    v_owner
  );
end $$;

do $verify$
declare
  v_body text;
begin
  v_body := pg_get_functiondef('public.senda_delete_purchase_invoice(jsonb)'::regprocedure);
  if position('session_replication' || '_role' in lower(v_body)) > 0 then
    raise exception 'DELETE_INVOICE_ABORT: no debe desactivar triggers ni auditoría.';
  end if;
  if v_body not ilike '%REVERSAL_INSUFFICIENT_STOCK%' then
    raise exception 'DELETE_INVOICE_ABORT: falta REVERSAL_INSUFFICIENT_STOCK.';
  end if;
  if v_body not ilike '%senda_adjust_inventory_quantity%' then
    raise exception 'DELETE_INVOICE_ABORT: debe llamar senda_adjust_inventory_quantity.';
  end if;
  if v_body ilike '%insert into public.inventory_movements%' then
    raise exception 'DELETE_INVOICE_ABORT: no debe insertar inventory_movements a mano.';
  end if;
  if v_body not ilike '%deleted_at%' then
    raise exception 'DELETE_INVOICE_ABORT: debe marcar deleted_at (eliminación lógica).';
  end if;
  if v_body ilike '%delete from public.purchase_documents%' then
    raise exception 'DELETE_INVOICE_ABORT: no debe borrar filas de purchase_documents.';
  end if;
  if v_body ilike '%delete from public.purchase_document_receipts%' then
    raise exception 'DELETE_INVOICE_ABORT: no debe borrar recepciones.';
  end if;
  if v_body ilike '%delete from public.inventory_products%' then
    raise exception 'DELETE_INVOICE_ABORT: no debe borrar productos de inventario.';
  end if;
  if v_body ilike '%delete from public.inventory_movements%' then
    raise exception 'DELETE_INVOICE_ABORT: no debe borrar movimientos de stock.';
  end if;
  if v_body ilike '%DELETE_HAS_RECEIPTS%' then
    raise exception 'DELETE_INVOICE_ABORT: no debe bloquear por DELETE_HAS_RECEIPTS.';
  end if;
  if v_body not ilike '%REVERSAL_ABORTED%' then
    raise exception 'DELETE_INVOICE_ABORT: debe abortar con REVERSAL_ABORTED si falla adjust con inventario.';
  end if;
  if v_body not ilike '%REVERSAL_INVENTORY_REF_MISMATCH%' then
    raise exception 'DELETE_INVOICE_ABORT: debe validar location_inventory_id vs local/producto.';
  end if;
  if v_body not ilike '%purchase_document_receipts pr%'
     or v_body not ilike '%pr.purchase_document_id%' then
    raise exception 'DELETE_INVOICE_ABORT: cost restore debe usar alias pr en receipts.';
  end if;
  if v_body ~* 'from public\.purchase_document_receipts[[:space:]]+r[[:space:]/]' then
    raise exception 'DELETE_INVOICE_ABORT: alias SQL r sobre purchase_document_receipts (conflicto PL/pgSQL).';
  end if;
  if v_body ~* 'average_unit_cost[[:space:]]*=[[:space:]]*coalesce[[:space:]]*\([[:space:]]*v_restore_cost' then
    raise exception 'DELETE_INVOICE_ABORT: no forzar costo artificial; NULL debe quedar NULL.';
  end if;
  if v_body ilike '%adjust_error%' then
    raise exception 'DELETE_INVOICE_ABORT: no debe omitir errores de adjust como missing_inventory.';
  end if;
  if v_body ilike '%pg_get_constraintdef%' then
    raise exception 'DELETE_INVOICE_ABORT: el RPC no debe analizar constraintdef.';
  end if;
  if v_body ilike '%create or replace function public.senda_receive%'
     or v_body ilike '%create or replace function public.senda_cancel%'
     or v_body ilike '%create or replace function public.senda_confirm%' then
    raise exception 'DELETE_INVOICE_ABORT: no debe reescribir receive/cancel/confirm.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_documents'
      and column_name = 'deleted_at'
  ) then
    raise exception 'DELETE_INVOICE_ABORT: falta purchase_documents.deleted_at.';
  end if;
end
$verify$;

commit;

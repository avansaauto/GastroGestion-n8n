-- SENDA OPS — HOTFIX ejecutable: senda_delete_purchase_invoice(jsonb)
-- ============================================================================
-- Corrección del SQLSTATE 42703:
--   record "r" has no field "purchase_document_id"
-- Factura de referencia: 694d59af-d795-4f5d-92e0-cd1ee296ea88
--
-- Causa: conflicto entre variable PL/pgSQL de registro del loop de recepciones
-- y alias SQL `r` sobre purchase_document_receipts en la restauración de costos.
--
-- Este hotfix:
--   1) CREATE OR REPLACE de la RPC (misma firma jsonb → jsonb).
--   2) Renombra el loop a `v_rec` y usa alias SQL `pr` en cost restore.
--   3) Restaura costo desde historial válido restante; si no hay, deja NULL
--      (no fuerza 0). No borra inventory_cost_history.
--   4) Preserva grants service_role-only y clona owner de RPC hermanas.
--
-- NO modificar datos. NO borrar facturas. Instalar manualmente en Supabase
-- (proyecto SENDA, no GastroGest) → SQL Editor → Run.
-- Después: verify-senda-delete-purchase-invoice.sql (solo lectura).
-- Fuente de verdad alineada: proposed-senda-delete-purchase-invoice.sql
-- ============================================================================

begin;

do $guard$
begin
  if to_regprocedure('public.senda_delete_purchase_invoice(jsonb)') is null then
    raise exception
      'DELETE_HOTFIX_ABORT: falta senda_delete_purchase_invoice(jsonb). Instalar primero proposed-senda-delete-purchase-invoice.sql completo.';
  end if;
  if to_regprocedure('public.senda_adjust_inventory_quantity(jsonb)') is null then
    raise exception 'DELETE_HOTFIX_ABORT: falta senda_adjust_inventory_quantity(jsonb).';
  end if;
  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'DELETE_HOTFIX_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'DELETE_HOTFIX_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_documents'
      and column_name = 'deleted_at'
  ) then
    raise exception 'DELETE_HOTFIX_ABORT: falta purchase_documents.deleted_at.';
  end if;
end
$guard$;

create or replace function public.senda_delete_purchase_invoice(p jsonb)
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
    -- Mantener owner actual si no hay hermana a clonar.
    return;
  end if;
  execute format(
    'alter function public.senda_delete_purchase_invoice(jsonb) owner to %I',
    v_owner
  );
end $$;

do $verify$
declare
  v_body text;
begin
  v_body := pg_get_functiondef('public.senda_delete_purchase_invoice(jsonb)'::regprocedure);
  if v_body not ilike '%purchase_document_receipts pr%'
     or v_body not ilike '%pr.purchase_document_id%' then
    raise exception 'DELETE_HOTFIX_ABORT: cost restore debe usar alias pr.';
  end if;
  if v_body ~* 'from public\.purchase_document_receipts[[:space:]]+r[[:space:]/]' then
    raise exception 'DELETE_HOTFIX_ABORT: persiste alias SQL r sobre receipts.';
  end if;
  if v_body not ilike '%for v_rec in%' then
    raise exception 'DELETE_HOTFIX_ABORT: el loop de recepciones debe usar v_rec.';
  end if;
  if v_body ~* 'average_unit_cost[[:space:]]*=[[:space:]]*coalesce[[:space:]]*\([[:space:]]*v_restore_cost' then
    raise exception 'DELETE_HOTFIX_ABORT: no forzar costo artificial con coalesce.';
  end if;
  if v_body not ilike '%REVERSAL_INSUFFICIENT_STOCK%'
     or v_body not ilike '%senda_adjust_inventory_quantity%'
     or v_body not ilike '%deleted_at%' then
    raise exception 'DELETE_HOTFIX_ABORT: faltan contratos de reversión/soft-delete.';
  end if;
  if v_body ilike '%delete from public.purchase_documents%'
     or v_body ilike '%delete from public.inventory_cost_history%' then
    raise exception 'DELETE_HOTFIX_ABORT: no debe hard-delete documentos ni historial de costos.';
  end if;
  raise notice 'delete_invoice_hotfix: OK';
end
$verify$;

commit;

-- SENDA OPS — Etapa B: recepción escribe último costo de compra
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Antes: apps/api/sql/verify-senda-receive-purchase-cost-preflight.sql
-- Después: apps/api/sql/verify-senda-receive-purchase-cost.sql
-- Contrato: apps/api/sql/proposed-senda-receive-purchase-cost.md
--
-- REPLACE solo senda_receive_purchase_document_line.
-- Reutiliza senda_set_inventory_purchase_cost (Paso 447, ya instalado).
-- No recrea inventory_cost_history. No reejecuta 447.
-- No llama HTTP. No toca Fudo ni ventas.
--
-- Criterio: último costo de la línea facturada.
-- El stock usa p_quantity (parcial o total).
-- El RPC de costo recibe el neto y la cantidad facturada en unidad base,
-- sin prorratear ni redondear un importe parcial. Así el unitario es
-- round(round(neto, 2) / inventory_physical_quantity, 8), igual en
-- recepciones parciales y totales de la misma línea.
-- 10 kg (10000 g) a $200.000 → $20 / g. Receta 200 g → $4.000.
-- Misma fecha de factura: last-write-wins (el RPC usa effective_at < last_purchase_at).
-- Un costo manual posterior (effective_at = now) no lo pisa una factura
-- del mismo día a medianoche.

begin;

-- =============================================================================
-- 0. Guardias
-- =============================================================================
do $guard$
declare
  missing text;
begin
  if to_regprocedure('public.senda_set_inventory_purchase_cost(jsonb)') is null then
    raise exception 'RECEIVE_COST_ABORT: falta senda_set_inventory_purchase_cost(jsonb). No reejecutar el SQL 447 desde este archivo.';
  end if;
  if to_regclass('public.inventory_cost_history') is null then
    raise exception 'RECEIVE_COST_ABORT: falta inventory_cost_history.';
  end if;
  if to_regprocedure('public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)') is null then
    raise exception 'RECEIVE_COST_ABORT: falta senda_receive_purchase_document_line. Aplicar primero migrate-inventory-reception.sql.';
  end if;
  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'RECEIVE_COST_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'RECEIVE_COST_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;
  if to_regprocedure('public.senda_purchase_line_is_inventoriable(text, text, text, text, numeric, numeric)') is null then
    raise exception 'RECEIVE_COST_ABORT: falta senda_purchase_line_is_inventoriable.';
  end if;
  if to_regprocedure('public.senda_purchase_document_is_fully_received(uuid)') is null then
    raise exception 'RECEIVE_COST_ABORT: falta senda_purchase_document_is_fully_received.';
  end if;

  select string_agg(format('%s.%s', t.table_name, t.column_name), ', ' order by 1)
    into missing
  from (
    values
      ('purchase_documents', 'id'),
      ('purchase_documents', 'location_id'),
      ('purchase_documents', 'organization_id'),
      ('purchase_documents', 'status'),
      ('purchase_documents', 'currency'),
      ('purchase_documents', 'document_date'),
      ('purchase_document_lines', 'id'),
      ('purchase_document_lines', 'purchase_document_id'),
      ('purchase_document_lines', 'inventory_product_id'),
      ('purchase_document_lines', 'mapping_status'),
      ('purchase_document_lines', 'inventory_physical_quantity'),
      ('purchase_document_lines', 'reviewed_amount'),
      ('purchase_document_lines', 'original_amount'),
      ('purchase_document_receipts', 'id'),
      ('purchase_document_receipts', 'idempotency_key'),
      ('inventory_valuations', 'location_inventory_id'),
      ('inventory_valuations', 'quantity_on_hand'),
      ('inventory_valuations', 'average_unit_cost'),
      ('inventory_valuations', 'last_purchase_unit_cost')
  ) as t(table_name, column_name)
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = t.table_name
      and c.column_name = t.column_name
  );
  if missing is not null then
    raise exception 'RECEIVE_COST_ABORT: faltan columnas %', missing;
  end if;
end
$guard$;

-- =============================================================================
-- 1. RPC — misma firma, stock + costo en una transacción
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
  v_document_date date;
  v_line public.purchase_document_lines%rowtype;
  v_received numeric;
  v_remaining numeric;
  v_existing public.purchase_document_receipts%rowtype;
  v_receipt_id uuid;
  v_location_inventory_id uuid;
  v_movement_id uuid;
  v_product_org uuid;
  v_product_active boolean;
  v_net numeric;
  v_purchase_cost numeric;
  v_effective timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  v_actor := public.senda_require_backend_actor(p_actor_user_id);

  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  select d.location_id, d.organization_id, d.status, d.currency, d.document_date
    into v_location, v_org, v_status, v_currency, v_document_date
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

  v_net := coalesce(v_line.reviewed_amount, v_line.original_amount);
  if v_net is null then
    raise exception 'VALUATION_AMOUNT_REQUIRED';
  end if;
  if v_net < 0 then
    raise exception 'INVALID_PURCHASE_COST';
  end if;
  -- Sin redondeo intermedio de un parcial. El RPC instalado hace
  -- round(purchase_cost, 2) / purchase_quantity a 8 decimales.
  v_purchase_cost := v_net;
  v_effective := coalesce(v_document_date::timestamptz, v_now);

  select p.organization_id, p.active
    into v_product_org, v_product_active
  from public.inventory_products p
  where p.id = v_line.inventory_product_id;
  if v_product_org is null then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  if v_product_org is distinct from v_org then
    raise exception 'PRODUCT_ORG_MISMATCH';
  end if;
  -- Producto dado de baja: no recibir stock de facturas ya mapeadas.
  -- Requiere reactivación explícita (senda_set_inventory_product_active).
  if v_product_active is not true then
    raise exception 'PRODUCT_INACTIVE';
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

  perform public.senda_set_inventory_purchase_cost(jsonb_build_object(
    'actor_user_id', v_actor,
    'organization_id', v_org,
    'location_id', v_location,
    'inventory_product_id', v_line.inventory_product_id,
    'purchase_quantity', v_line.inventory_physical_quantity,
    'purchase_cost', v_purchase_cost,
    'source', 'invoice',
    'source_ref', v_receipt_id,
    'effective_at', v_effective
  ));

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
      'purchase_cost', v_purchase_cost,
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
  'Recepcion atomica service_role. Suma quantity_on_hand una vez y llama senda_set_inventory_purchase_cost (source=invoice) en la misma transaccion. No toca Fudo.';

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
    raise exception 'RECEIVE_COST_ABORT: no se pudo clonar el owner de senda_map_purchase_document_line.';
  end if;

  execute format(
    'alter function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid) owner to %I',
    v_owner
  );
end $$;

revoke all on function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)
  to service_role;

commit;

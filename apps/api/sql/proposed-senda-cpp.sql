-- SENDA OPS — Costo promedio ponderado móvil por local e insumo.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Antes: este archivo no lee datos de negocio.
-- Después: apps/api/sql/verify-senda-cpp.sql (solo lectura).
-- Prueba con fixtures, después de aplicar y siempre con ROLLBACK:
-- apps/api/sql/test-senda-cpp.sql. No usa insumos reales.
--
-- Reutiliza inventory_valuations.average_unit_cost, inventory_cost_history
-- y los RPC de recepción, costo y anulación. No crea tablas.
-- No toca n8n, Fudo, recetas, IVA ni la interfaz.
--
-- Fórmula, con el saldo leído antes de sumar la recepción:
--   si stock_anterior > 0 y CPP_anterior no es null:
--     CPP = round((stock_anterior * CPP_anterior + importe_recibido)
--                 / (stock_anterior + cantidad_recibida), 8)
--   si stock_anterior = 0:
--     CPP = round(importe_recibido / cantidad_recibida, 8)
--   si stock_anterior > 0 y CPP_anterior es null:
--     UNVALUED_STOCK. No se recibe y no se inventa un costo para ese stock.
-- last_purchase_unit_cost queda en el precio de esa compra
-- (importe_recibido / cantidad_recibida), no en el promedio.
-- Una factura más vieja igual entra al promedio. Solo deja quieto el último precio.
-- El importe es el de la línea (reviewed_amount o original_amount), sin IVA aparte.
--
-- Ajuste positivo: suma cantidad y no cambia el CPP. Esas unidades quedan
-- valuadas al CPP vigente. Si el CPP es null, siguen sin valor. No es una compra.
-- Venta, merma y ajuste negativo solo mueven la cantidad.
--
-- Anulación: Caso A solo si no hay consumos ni otros movimientos posteriores
-- que no sean compras, y el CPP compensado coincide con el que reconstruyen
-- las capas guardadas. Caso B aborta toda la transacción y no marca deleted_at.
-- Un saldo simulado que no queda negativo no alcanza.
-- No se recalculan costos de ventas ni mermas.
-- Las filas viejas de historial, sin stock anterior, no se recalculan.
-- Si una compra vieja tiene historial incompleto, la anulación automática se bloquea.

begin;

do $guard$
declare
  v_sale text;
  v_adjust text;
  v_tdef text;
  r record;
begin
  if to_regclass('public.inventory_cost_history') is null then
    raise exception 'CPP_ABORT: falta inventory_cost_history.';
  end if;
  if to_regprocedure('public.senda_set_inventory_purchase_cost(jsonb)') is null then
    raise exception 'CPP_ABORT: falta senda_set_inventory_purchase_cost(jsonb).';
  end if;
  if to_regprocedure('public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)') is null then
    raise exception 'CPP_ABORT: falta senda_receive_purchase_document_line.';
  end if;
  if to_regprocedure('public.senda_delete_purchase_invoice(jsonb)') is null then
    raise exception 'CPP_ABORT: falta senda_delete_purchase_invoice(jsonb).';
  end if;
  if to_regprocedure('public.senda_adjust_inventory_quantity(jsonb)') is null then
    raise exception 'CPP_ABORT: falta senda_adjust_inventory_quantity(jsonb).';
  end if;
  if to_regprocedure('public.register_sale_consumption(uuid, numeric, text, text)') is null then
    raise exception 'CPP_ABORT: falta register_sale_consumption.';
  end if;

  v_sale := pg_get_functiondef('public.register_sale_consumption(uuid, numeric, text, text)'::regprocedure);
  v_adjust := pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure);
  if v_sale ~* 'set[[:space:]]+average_unit_cost|average_unit_cost[[:space:]]*:='
     or v_adjust ~* 'set[[:space:]]+average_unit_cost|average_unit_cost[[:space:]]*:=' then
    raise exception 'CPP_ABORT: la venta o el ajuste ya escriben el CPP. No se agrega otra escritura.';
  end if;
  if position('from public.inventory_valuations' in lower(v_sale)) > 0
     and position('from public.location_inventory' in lower(v_sale))
         > position('from public.inventory_valuations' in lower(v_sale)) then
    raise exception 'CPP_ABORT: la venta bloquea la valuación antes que el inventario del local.';
  end if;

  for r in
    select t.tgname, p.oid as fn
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public'
      and c.relname = 'inventory_movements'
      and not t.tgisinternal
  loop
    begin
      v_tdef := pg_get_functiondef(r.fn);
    exception
      when others then
        raise exception 'CPP_ABORT: no se pudo leer el trigger %.', r.tgname;
    end;
    if v_tdef ~* 'quantity_on_hand|inventory_valuations' then
      raise exception 'CPP_ABORT: el trigger % también mueve el saldo. Habría doble escritura.', r.tgname;
    end if;
  end loop;

  if exists (
    select 1
    from public.inventory_cost_history h
    where h.source = 'invoice'
      and h.source_ref is not null
    group by h.source_ref
    having count(*) > 1
  ) then
    raise exception 'CPP_ABORT: hay más de un historial invoice para el mismo recibo.';
  end if;
end
$guard$;

alter table public.inventory_cost_history
  add column if not exists quantity_on_hand_before numeric,
  add column if not exists average_unit_cost_before numeric,
  add column if not exists receipt_idempotency_key uuid;

comment on column public.inventory_cost_history.quantity_on_hand_before is
  'Stock valuado antes de incorporar esta compra. Null en filas anteriores al CPP: no alcanzan para revertir el promedio.';
comment on column public.inventory_cost_history.average_unit_cost_before is
  'CPP antes de esta compra. Null si no había promedio o si la fila es anterior al CPP.';
comment on column public.inventory_cost_history.receipt_idempotency_key is
  'Clave idempotente de la recepción. Null en carga manual y en filas anteriores al CPP.';
comment on column public.inventory_cost_history.purchase_quantity is
  'Cantidad de esta operación en la unidad base. En compras nuevas es el tramo recibido, no la línea completa.';
comment on column public.inventory_cost_history.purchase_cost is
  'Importe incorporado al promedio en esta operación, ya redondeado a 2 decimales.';
comment on column public.inventory_valuations.average_unit_cost is
  'Costo promedio ponderado móvil por local e insumo, en la unidad base. Las recetas leen esta columna.';
comment on column public.inventory_valuations.last_purchase_unit_cost is
  'Precio unitario de la compra más reciente. Puede diferir del CPP.';

do $source_chk$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'inventory_cost_history'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'source'
      and pg_get_constraintdef(c.oid) ~* 'manual'
  loop
    execute format('alter table public.inventory_cost_history drop constraint %I', r.conname);
  end loop;
  alter table public.inventory_cost_history
    add constraint inventory_cost_history_source_check
    check (source in ('manual', 'invoice', 'invoice_reversal'));
end
$source_chk$;

create unique index if not exists inventory_cost_history_invoice_ref_uniq
  on public.inventory_cost_history (source_ref)
  where source = 'invoice' and source_ref is not null;

-- =============================================================================
-- Fórmulas puras. No escriben stock.
-- =============================================================================
create or replace function public.senda_cpp_allocate_receipt(
  p_net numeric,
  p_physical numeric,
  p_previously numeric,
  p_quantity numeric
) returns numeric
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_net numeric;
  v_unit numeric;
  v_prev numeric;
  v_qty numeric;
  v_start numeric;
  v_end numeric;
begin
  if p_physical is null or p_physical <= 0 or p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;
  if p_net is null or p_net < 0 then
    raise exception 'INVALID_PURCHASE_COST';
  end if;
  v_net := round(p_net, 2);
  v_prev := coalesce(p_previously, 0);
  if v_prev < 0 or v_prev >= p_physical then
    return 0;
  end if;
  v_qty := least(p_quantity, p_physical - v_prev);
  if v_net = 0 then
    return 0;
  end if;
  v_unit := round(v_net / p_physical, 8);
  if v_prev <= 0 then
    v_start := 0;
  else
    v_start := least(round(v_unit * v_prev, 2), v_net);
  end if;
  if v_prev + v_qty >= p_physical then
    v_end := v_net;
  else
    v_end := least(round(v_unit * (v_prev + v_qty), 2), v_net);
  end if;
  return round(v_end - v_start, 2);
end;
$$;

create or replace function public.senda_cpp_next_average(
  p_qty_before numeric,
  p_avg_before numeric,
  p_received numeric,
  p_amount numeric
) returns numeric
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if p_received is null or p_received <= 0 then
    raise exception 'INVALID_PURCHASE_QUANTITY';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'INVALID_PURCHASE_COST';
  end if;
  if coalesce(p_qty_before, 0) > 0 and p_avg_before is null then
    raise exception 'UNVALUED_STOCK: hay stock sin costo promedio. No se puede recibir esta compra hasta resolver el costo inicial. No se modificó el inventario.';
  end if;
  if coalesce(p_qty_before, 0) > 0 and p_avg_before is not null then
    return round(
      (p_qty_before * p_avg_before + p_amount) / (p_qty_before + p_received),
      8
    );
  end if;
  return round(p_amount / p_received, 8);
end;
$$;

create or replace function public.senda_cpp_replay_block_reason(
  p_on_hand numeric,
  p_ledger_sum numeric,
  p_receipt_id text,
  p_receipt_quantity numeric,
  p_movements jsonb
) returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_row jsonb;
  v_purchase_at timestamptz;
  v_purchase_id uuid;
  v_purchase_qty numeric;
  v_purchase_count integer := 0;
  v_sim numeric := 0;
  v_qty numeric;
  v_at timestamptz;
  v_id uuid;
  v_type text;
  v_source_id text;
begin
  if p_on_hand is distinct from p_ledger_sum then
    return 'REVERSAL_LEDGER_MISMATCH: el stock valuado no coincide con el libro de movimientos. No se puede anular esta compra automáticamente.';
  end if;
  if p_receipt_id is null or p_receipt_quantity is null or p_receipt_quantity <= 0 then
    return 'REVERSAL_PURCHASE_MOVEMENT_MISSING: no está el movimiento de la recepción. No se puede anular esta compra automáticamente.';
  end if;

  for v_row in
    select value
    from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb))
  loop
    if coalesce(v_row->>'movement_type', '') = 'purchase'
       and v_row->>'source_id' = p_receipt_id then
      v_purchase_count := v_purchase_count + 1;
      v_purchase_at := (v_row->>'created_at')::timestamptz;
      v_purchase_id := (v_row->>'id')::uuid;
      v_purchase_qty := (v_row->>'quantity')::numeric;
    end if;
  end loop;
  if v_purchase_count is distinct from 1
     or v_purchase_qty is distinct from p_receipt_quantity then
    return 'REVERSAL_PURCHASE_MOVEMENT_MISSING: no está el movimiento de la recepción. No se puede anular esta compra automáticamente.';
  end if;

  for v_row in
    select value
    from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb))
    order by (value->>'created_at')::timestamptz, (value->>'id')::uuid
  loop
    if v_row->>'id' is null or v_row->>'created_at' is null or v_row->>'quantity' is null then
      return 'REVERSAL_DEPENDENT_MOVEMENTS: un movimiento posterior no tiene cantidad. No se puede anular automáticamente.';
    end if;
    v_id := (v_row->>'id')::uuid;
    v_at := (v_row->>'created_at')::timestamptz;
    v_type := coalesce(v_row->>'movement_type', '');
    v_source_id := v_row->>'source_id';
    if v_id = v_purchase_id then
      continue;
    end if;
    if v_type = 'adjustment' and v_source_id = p_receipt_id then
      continue;
    end if;
    v_qty := (v_row->>'quantity')::numeric;
    -- Un saldo que no queda negativo no alcanza: venta, merma, ajuste o
    -- apertura posteriores no guardan el CPP que usaron.
    if (v_at, v_id) > (v_purchase_at, v_purchase_id)
       and (v_type is distinct from 'purchase' or v_qty <= 0) then
      return 'REVERSAL_DEPENDENT_MOVEMENTS: un movimiento posterior depende de esta compra y su costo histórico no se puede reconstruir. No se puede anular automáticamente.';
    end if;
    if v_qty < 0 and v_sim + v_qty < 0 then
      return 'REVERSAL_DEPENDENT_MOVEMENTS: un consumo posterior depende de esta compra y su costo histórico no se puede reconstruir. No se puede anular automáticamente.';
    end if;
    v_sim := v_sim + v_qty;
  end loop;

  if v_sim is distinct from p_on_hand - p_receipt_quantity then
    return 'REVERSAL_LEDGER_MISMATCH: el stock valuado no coincide con el libro de movimientos. No se puede anular esta compra automáticamente.';
  end if;
  return null;
end;
$$;

revoke all on function public.senda_cpp_allocate_receipt(numeric, numeric, numeric, numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.senda_cpp_next_average(numeric, numeric, numeric, numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.senda_cpp_replay_block_reason(numeric, numeric, text, numeric, jsonb)
  from public, anon, authenticated, service_role;

comment on column public.inventory_cost_history.previous_unit_cost is
  'CPP anterior a esta operación. En filas anteriores al CPP era el último costo, no el promedio.';
comment on column public.inventory_cost_history.new_unit_cost is
  'CPP después de esta operación. En filas anteriores al CPP coincidía con el último costo de compra.';
comment on column public.inventory_cost_history.source is
  'manual, invoice o invoice_reversal. Las filas anteriores al CPP no traen stock ni CPP anteriores.';

-- =============================================================================
-- Compensa el valor de un recibo. No mueve quantity_on_hand.
-- El llamador ya bloqueó location_inventory y después inventory_valuations.
-- =============================================================================
create or replace function public.senda_cpp_compensate_receipt(
  p_location_inventory_id uuid,
  p_receipt_id uuid,
  p_actor uuid,
  p_organization_id uuid,
  p_location_id uuid,
  p_product_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_on_hand numeric;
  v_avg numeric;
  v_last numeric;
  v_last_at timestamptz;
  v_ledger numeric;
  v_movements jsonb;
  v_reason text;
  v_hist_qty numeric;
  v_hist_cost numeric;
  v_hist_before_qty numeric;
  v_hist_before_avg numeric;
  v_hist_at timestamptz;
  v_hist_recorded timestamptz;
  v_hist_id uuid;
  v_hist_key uuid;
  v_later boolean;
  v_prev_cost numeric;
  v_prev_qty numeric;
  v_prev_at timestamptz;
  v_remaining numeric;
  v_value numeric;
  v_new_avg numeric;
  v_fold_qty numeric;
  v_fold_avg numeric;
  v_layer record;
  v_write_last numeric;
  v_write_last_at timestamptz;
  v_history_id uuid;
begin
  select iv.quantity_on_hand, iv.average_unit_cost,
         iv.last_purchase_unit_cost, iv.last_purchase_at
    into v_on_hand, v_avg, v_last, v_last_at
  from public.inventory_valuations iv
  where iv.location_inventory_id = p_location_inventory_id
  for update;
  if not found then
    raise exception 'REVERSAL_VALUATION_MISSING';
  end if;
  v_on_hand := coalesce(v_on_hand, 0);

  select coalesce(sum(m.quantity), 0)
    into v_ledger
  from public.inventory_movements m
  where m.location_inventory_id = p_location_inventory_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'movement_type', m.movement_type,
    'quantity', m.quantity,
    'source_type', m.source_type,
    'source_id', m.source_id,
    'created_at', m.created_at
  )), '[]'::jsonb)
    into v_movements
  from public.inventory_movements m
  where m.location_inventory_id = p_location_inventory_id;

  v_reason := public.senda_cpp_replay_block_reason(
    v_on_hand,
    v_ledger,
    p_receipt_id::text,
    (
      select pr.quantity
      from public.purchase_document_receipts pr
      where pr.id = p_receipt_id
    ),
    v_movements
  );
  if v_reason is not null then
    raise exception '%', v_reason using errcode = 'P0001';
  end if;

  select h.purchase_quantity, h.purchase_cost, h.quantity_on_hand_before,
         h.average_unit_cost_before, h.effective_at, h.recorded_at, h.id,
         h.receipt_idempotency_key
    into v_hist_qty, v_hist_cost, v_hist_before_qty, v_hist_before_avg,
         v_hist_at, v_hist_recorded, v_hist_id, v_hist_key
  from public.inventory_cost_history h
  where h.source = 'invoice'
    and h.source_ref = p_receipt_id
  order by h.recorded_at desc, h.id desc
  limit 1;

  if not found then
    if v_avg is not null then
      raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: el historial de esta compra no alcanza para revertir el promedio. No se puede anular automáticamente.'
        using errcode = 'P0001';
    end if;
    return null;
  end if;

  if v_hist_before_qty is null or v_hist_cost is null or v_hist_qty is null then
    raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: el historial de esta compra no alcanza para revertir el promedio. No se puede anular automáticamente.'
      using errcode = 'P0001';
  end if;
  if v_avg is null then
    raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: el historial de esta compra no alcanza para revertir el promedio. No se puede anular automáticamente.'
      using errcode = 'P0001';
  end if;

  v_value := v_on_hand * v_avg;
  if v_hist_cost > v_value + 0.05 then
    raise exception 'REVERSAL_COST_EXCEEDS_VALUE: el importe de la compra supera el valor del stock. No se puede anular automáticamente.'
      using errcode = 'P0001';
  end if;

  v_remaining := v_on_hand - v_hist_qty;
  if v_remaining < 0 then
    raise exception 'REVERSAL_INSUFFICIENT_STOCK';
  end if;
  if v_remaining = 0 then
    v_new_avg := v_avg;
  else
    v_new_avg := round(greatest(v_value - v_hist_cost, 0) / v_remaining, 8);
  end if;

  -- El CPP que queda tiene que salir de las capas guardadas, no de una estimación.
  -- Las ventas y las mermas no se reescriben.
  v_fold_qty := v_hist_before_qty;
  v_fold_avg := v_hist_before_avg;
  if v_fold_qty > 0 and v_fold_avg is null then
    raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: el stock anterior a esta compra no tiene promedio. No se puede anular automáticamente.'
      using errcode = 'P0001';
  end if;
  for v_layer in
    select h.purchase_quantity, h.purchase_cost, h.quantity_on_hand_before
    from public.inventory_cost_history h
    where h.location_inventory_id = p_location_inventory_id
      and h.source = 'invoice'
      and h.source_ref is distinct from p_receipt_id
      and (h.recorded_at, h.id) > (v_hist_recorded, v_hist_id)
    order by h.recorded_at, h.id
  loop
    if v_layer.quantity_on_hand_before is null
       or v_layer.purchase_quantity is null
       or v_layer.purchase_cost is null then
      raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: una compra posterior no tiene historial suficiente. No se puede anular automáticamente.'
        using errcode = 'P0001';
    end if;
    v_fold_avg := public.senda_cpp_next_average(
      v_fold_qty,
      v_fold_avg,
      v_layer.purchase_quantity,
      v_layer.purchase_cost
    );
    v_fold_qty := v_fold_qty + v_layer.purchase_quantity;
  end loop;
  if v_fold_qty is distinct from v_remaining then
    raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: el promedio que quedaría no se puede justificar con el historial. No se puede anular automáticamente.'
      using errcode = 'P0001';
  end if;
  if v_remaining > 0
     and (v_fold_avg is null or v_new_avg is distinct from v_fold_avg) then
    raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: la compensación no conserva el promedio del stock que sigue. No se puede anular automáticamente.'
      using errcode = 'P0001';
  end if;

  v_later := exists (
    select 1
    from public.inventory_cost_history h
    where h.location_inventory_id = p_location_inventory_id
      and h.source in ('manual', 'invoice')
      and not (h.source = 'invoice' and h.source_ref = p_receipt_id)
      and (h.effective_at, h.recorded_at, h.id) > (v_hist_at, v_hist_recorded, v_hist_id)
  );
  v_write_last := v_last;
  v_write_last_at := v_last_at;
  if not v_later then
    select h.purchase_cost, h.purchase_quantity, h.effective_at
      into v_prev_cost, v_prev_qty, v_prev_at
    from public.inventory_cost_history h
    where h.location_inventory_id = p_location_inventory_id
      and h.source in ('manual', 'invoice')
      and not (h.source = 'invoice' and h.source_ref = p_receipt_id)
      and h.purchase_quantity > 0
    order by h.effective_at desc nulls last, h.recorded_at desc, h.id desc
    limit 1;
    if found then
      v_write_last := round(v_prev_cost / v_prev_qty, 8);
      v_write_last_at := v_prev_at;
    end if;
  end if;

  update public.inventory_valuations
     set average_unit_cost = v_new_avg,
         last_purchase_unit_cost = v_write_last,
         last_purchase_at = v_write_last_at,
         updated_at = clock_timestamp()
   where location_inventory_id = p_location_inventory_id;

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
    purchase_cost,
    quantity_on_hand_before,
    average_unit_cost_before,
    receipt_idempotency_key
  ) values (
    p_organization_id,
    p_location_id,
    p_product_id,
    p_location_inventory_id,
    v_avg,
    v_new_avg,
    'invoice_reversal',
    p_receipt_id,
    coalesce(v_hist_at, clock_timestamp()),
    clock_timestamp(),
    p_actor,
    v_hist_qty,
    v_hist_cost,
    v_on_hand,
    v_avg,
    v_hist_key
  )
  returning id into v_history_id;

  return jsonb_build_object(
    'location_inventory_id', p_location_inventory_id,
    'inventory_product_id', p_product_id,
    'receipt_id', p_receipt_id,
    'action', 'compensated',
    'quantity_on_hand_before', v_on_hand,
    'average_unit_cost_before', v_avg,
    'purchase_quantity', v_hist_qty,
    'purchase_cost', v_hist_cost,
    'average_unit_cost', v_new_avg,
    'last_purchase_unit_cost', v_write_last,
    'history_id', v_history_id
  );
end;
$$;

revoke all on function public.senda_cpp_compensate_receipt(uuid, uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- =============================================================================
-- Costo: la factura escribe el CPP. No cambia la cantidad.
-- =============================================================================
create or replace function public.senda_set_inventory_purchase_cost(p jsonb)
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
  v_idem uuid;
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
  v_update_last boolean := false;
  v_history_id uuid;
  v_new_avg numeric;
  v_last_unit numeric;
  v_write_last numeric;
  v_write_last_at timestamptz;
  v_found boolean := false;
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
    v_idem := nullif(p->>'receipt_idempotency_key', '')::uuid;
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
  v_found := found;

  if v_source = 'manual'
     and v_found
     and coalesce(v_on_hand, 0) > 0
     and v_existing_avg is not null then
    raise exception 'MANUAL_COST_WITH_ON_HAND';
  end if;

  if v_source = 'invoice' and v_source_ref is not null and exists (
    select 1
    from public.inventory_cost_history h
    where h.source = 'invoice'
      and h.source_ref = v_source_ref
  ) then
    return jsonb_build_object(
      'inventory_product_id', v_product,
      'location_id', v_location,
      'purchase_quantity', v_qty,
      'purchase_cost', v_cost,
      'average_unit_cost', v_existing_avg,
      'last_purchase_unit_cost', v_existing_last,
      'quantity_on_hand', coalesce(v_on_hand, 0),
      'source', v_source,
      'replay', true,
      'skipped_stale', false
    );
  end if;

  if v_source = 'manual'
     and v_found
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
      'quantity_on_hand', coalesce(v_on_hand, 0),
      'source', v_source,
      'replay', true,
      'skipped_stale', false
    );
  end if;

  if v_source = 'invoice'
     and coalesce(v_on_hand, 0) > 0
     and v_existing_avg is null then
    raise exception 'UNVALUED_STOCK: hay stock sin costo promedio. No se puede recibir esta compra hasta resolver el costo inicial. No se modificó el inventario.';
  end if;

  if v_source = 'invoice' then
    v_new_avg := public.senda_cpp_next_average(
      coalesce(v_on_hand, 0), v_existing_avg, v_qty, v_cost
    );
    v_last_unit := v_unit_cost;
  else
    v_new_avg := v_unit_cost;
    v_last_unit := v_unit_cost;
  end if;

  v_update_last := v_source = 'manual'
    or not v_found
    or v_existing_last_at is null
    or v_effective >= v_existing_last_at;
  v_skipped_stale := v_source = 'invoice' and not v_update_last;
  if v_update_last then
    v_write_last := v_last_unit;
    v_write_last_at := v_effective;
  else
    v_write_last := v_existing_last;
    v_write_last_at := v_existing_last_at;
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
    v_new_avg,
    v_write_last,
    coalesce(nullif(v_currency, ''), 'ARS'),
    v_write_last_at,
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
    purchase_cost,
    quantity_on_hand_before,
    average_unit_cost_before,
    receipt_idempotency_key
  ) values (
    v_org,
    v_location,
    v_product,
    v_location_inventory_id,
    v_existing_avg,
    v_new_avg,
    v_source,
    v_source_ref,
    v_effective,
    v_now,
    v_actor,
    v_qty,
    v_cost,
    coalesce(v_on_hand, 0),
    v_existing_avg,
    v_idem
  )
  returning id into v_history_id;

  return jsonb_build_object(
    'inventory_product_id', v_product,
    'location_id', v_location,
    'purchase_quantity', v_qty,
    'purchase_cost', v_cost,
    'average_unit_cost', v_new_avg,
    'last_purchase_unit_cost', v_write_last,
    'quantity_on_hand', coalesce(v_on_hand, 0),
    'source', v_source,
    'history_id', v_history_id,
    'replay', v_replay,
    'skipped_stale', v_skipped_stale
  );
end;
$$;

comment on function public.senda_set_inventory_purchase_cost(jsonb) is
  'Escritor del CPP y del último precio de compra. Una factura pondera el stock anterior. No cambia quantity_on_hand. service_role.';

revoke all on function public.senda_set_inventory_purchase_cost(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_set_inventory_purchase_cost(jsonb)
  to service_role;

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
  v_slice numeric;
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
  -- El importe de la línea se parte recién cuando se conoce lo ya recibido.
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

  v_slice := public.senda_cpp_allocate_receipt(
    v_net,
    v_line.inventory_physical_quantity,
    v_received,
    p_quantity
  );
  v_purchase_cost := v_slice;

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

  -- Saldo y CPP anteriores, con el inventario del local ya bloqueado.
  perform 1
  from public.inventory_valuations iv
  where iv.location_inventory_id = v_location_inventory_id
  for update;

  perform public.senda_set_inventory_purchase_cost(jsonb_build_object(
    'actor_user_id', v_actor,
    'organization_id', v_org,
    'location_id', v_location,
    'inventory_product_id', v_line.inventory_product_id,
    'purchase_quantity', p_quantity,
    'purchase_cost', v_purchase_cost,
    'source', 'invoice',
    'source_ref', v_receipt_id,
    'effective_at', v_effective,
    'receipt_idempotency_key', p_idempotency_key
  ));

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
  'Recepcion atomica. Lee el saldo, incorpora el tramo al CPP y despues suma quantity_on_hand. No toca Fudo.';

revoke all on function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)
  to service_role;



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
  v_cost_step jsonb;
  v_receipt_ids uuid[];
  v_li_row uuid;
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

  -- Bloqueo estable de los inventarios antes de compensar, para no cruzar anulaciones.
  for v_li_row in
    select s.li_id
    from (
      select rec.location_inventory_id as li_id
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
    ) s
    where s.li_id is not null
    order by s.li_id
  loop
    perform 1
    from public.location_inventory li
    where li.id = v_li_row
    for update;
  end loop;

  -- 1) Revertir de la recepción más nueva a la más vieja.
  --    Primero el promedio, después la cantidad.
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
    order by rec.created_at desc, rec.id desc
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

    -- Sin fila de valuación no hay saldo económico que revertir. No se inventa uno
    -- a partir del libro: el select siguiente devuelve REVERSAL_VALUATION_MISSING.
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

    v_cost_step := public.senda_cpp_compensate_receipt(
      v_li,
      v_rec.receipt_id,
      v_actor,
      v_org,
      v_location,
      v_rec.inventory_product_id
    );
    if v_cost_step is not null then
      v_cost_rollbacks := v_cost_rollbacks || jsonb_build_array(v_cost_step);
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

  -- 2) El promedio ya se compensó por recepción. No se reescribe el historial.

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
  'Eliminación lógica. Revierte una compra solo si el libro sigue consistente y compensa el CPP. Conserva movimientos e historial.';

revoke all on function public.senda_delete_purchase_invoice(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_delete_purchase_invoice(jsonb)
  to service_role;



do $owners$
declare
  v_cost name;
  v_recv name;
  v_del name;
begin
  select pg_catalog.pg_get_userbyid(p.proowner) into v_cost
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'senda_set_inventory_purchase_cost'
  order by p.oid
  limit 1;
  select pg_catalog.pg_get_userbyid(p.proowner) into v_recv
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'senda_receive_purchase_document_line'
  order by p.oid
  limit 1;
  select pg_catalog.pg_get_userbyid(p.proowner) into v_del
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'senda_delete_purchase_invoice'
  order by p.oid
  limit 1;
  if v_cost is null or v_recv is null or v_del is null then
    raise exception 'CPP_ABORT: no están los RPC que usan el promedio.';
  end if;

  execute format('alter function public.senda_cpp_next_average(numeric, numeric, numeric, numeric) owner to %I', v_cost);
  execute format('alter function public.senda_cpp_allocate_receipt(numeric, numeric, numeric, numeric) owner to %I', v_recv);
  execute format('alter function public.senda_cpp_replay_block_reason(numeric, numeric, text, numeric, jsonb) owner to %I', v_del);
  execute format('alter function public.senda_cpp_compensate_receipt(uuid, uuid, uuid, uuid, uuid, uuid) owner to %I', v_del);
  execute format('grant execute on function public.senda_cpp_next_average(numeric, numeric, numeric, numeric) to %I', v_cost);
  execute format('grant execute on function public.senda_cpp_next_average(numeric, numeric, numeric, numeric) to %I', v_del);
  execute format('grant execute on function public.senda_cpp_allocate_receipt(numeric, numeric, numeric, numeric) to %I', v_recv);
  execute format('grant execute on function public.senda_cpp_replay_block_reason(numeric, numeric, text, numeric, jsonb) to %I', v_del);
  execute format('grant execute on function public.senda_cpp_compensate_receipt(uuid, uuid, uuid, uuid, uuid, uuid) to %I', v_del);
end
$owners$;

do $verify$
declare
  v_set text;
  v_recv text;
  v_del text;
  v_comp text;
  v_adj text;
  v_sale text;
  v_cost_at integer;
  v_qty_at integer;
  v_comp_at integer;
  v_adj_at integer;
begin
  v_set := pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure);
  v_recv := pg_get_functiondef('public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure);
  v_del := pg_get_functiondef('public.senda_delete_purchase_invoice(jsonb)'::regprocedure);
  v_comp := pg_get_functiondef('public.senda_cpp_compensate_receipt(uuid, uuid, uuid, uuid, uuid, uuid)'::regprocedure);
  v_adj := pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure);
  v_sale := pg_get_functiondef('public.register_sale_consumption(uuid, numeric, text, text)'::regprocedure);

  if position('senda_cpp_next_average' in v_set) = 0
     or position('UNVALUED_STOCK' in v_set) = 0 then
    raise exception 'CPP_ABORT: el costo no calcula el promedio o no bloquea el stock sin CPP.';
  end if;
  if v_set ~* 'set[[:space:]]+quantity_on_hand' then
    raise exception 'CPP_ABORT: el costo no puede cambiar el stock.';
  end if;
  if position('quantity_on_hand_before' in v_set) = 0
     or position('average_unit_cost_before' in v_set) = 0
     or position('receipt_idempotency_key' in v_set) = 0 then
    raise exception 'CPP_ABORT: el historial de compra está incompleto.';
  end if;
  if v_set ~* 'skipped_stale[[:space:]]*:=[[:space:]]*true' and position('senda_cpp_next_average' in v_set)
       > position('skipped_stale := true' in v_set) then
    raise exception 'CPP_ABORT: una factura vieja no debe saltearse el promedio.';
  end if;

  if position('senda_cpp_allocate_receipt' in v_recv) = 0 then
    raise exception 'CPP_ABORT: la recepción no parte el importe.';
  end if;
  v_cost_at := position('senda_set_inventory_purchase_cost' in v_recv);
  v_qty_at := position('quantity_on_hand + excluded.quantity_on_hand' in v_recv);
  if v_cost_at = 0 or v_qty_at = 0 or v_cost_at > v_qty_at then
    raise exception 'CPP_ABORT: el promedio se calcula después de sumar el stock.';
  end if;
  if position('from public.location_inventory' in lower(v_recv))
     > position('from public.inventory_valuations' in lower(v_recv)) then
    raise exception 'CPP_ABORT: la recepción bloquea la valuación antes que el inventario del local.';
  end if;
  if position('v_line.inventory_physical_quantity' in v_recv) > 0
     and position('''purchase_quantity'', v_line.inventory_physical_quantity' in v_recv) > 0 then
    raise exception 'CPP_ABORT: el promedio no puede usar la cantidad facturada completa.';
  end if;

  v_comp_at := position('senda_cpp_compensate_receipt' in v_del);
  v_adj_at := position('senda_adjust_inventory_quantity' in v_del);
  if v_comp_at = 0 or v_adj_at = 0 or v_comp_at > v_adj_at then
    raise exception 'CPP_ABORT: la compensación del promedio queda después del ajuste de stock.';
  end if;
  if position('order by rec.created_at desc, rec.id desc' in v_del) = 0 then
    raise exception 'CPP_ABORT: las recepciones no se revierten de la más nueva a la más vieja.';
  end if;
  if position('v_restore_cost' in v_del) > 0 then
    raise exception 'CPP_ABORT: la anulación todavía reescribe el costo histórico.';
  end if;
  if v_del ilike '%insert into public.inventory_movements%'
     or v_del ilike '%delete from public.inventory_cost_history%'
     or v_del ilike '%delete from public.inventory_movements%'
     or v_del ilike '%delete from public.purchase_documents%' then
    raise exception 'CPP_ABORT: la anulación borra o reescribe historia.';
  end if;
  if v_comp ~* 'update[[:space:]]+public\.inventory_cost_history'
     or v_comp ~* 'set[[:space:]]+quantity_on_hand'
     or position('v_fold_avg' in v_comp) = 0 then
    raise exception 'CPP_ABORT: la compensación reescribe historial o stock, o no justifica el CPP.';
  end if;
  if position('su costo histórico no se puede reconstruir' in pg_get_functiondef('public.senda_cpp_replay_block_reason(numeric, numeric, text, numeric, jsonb)'::regprocedure)) = 0 then
    raise exception 'CPP_ABORT: un saldo simulado no negativo todavía alcanza para anular.';
  end if;
  if v_sale ~* 'set[[:space:]]+average_unit_cost|average_unit_cost[[:space:]]*:='
     or v_adj ~* 'set[[:space:]]+average_unit_cost|average_unit_cost[[:space:]]*:=' then
    raise exception 'CPP_ABORT: la venta o el ajuste escriben el CPP.';
  end if;
end
$verify$;

commit;

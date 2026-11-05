-- SENDA OPS — verificación de solo lectura del CPP.
-- Correr DESPUÉS de proposed-senda-cpp.sql, en el SQL Editor de SENDA.
-- No inserta, no actualiza y no llama a los RPC de stock.
-- Si algo no coincide, lanza CPP_VERIFY_FAILED y no cambia datos.

do $verify$
declare
  v_set text;
  v_recv text;
  v_del text;
  v_comp text;
  v_adj text;
  v_sale text;
  v_src text;
  v_cost_at integer;
  v_qty_at integer;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_cost_history'
      and column_name = 'quantity_on_hand_before'
      and is_nullable = 'YES'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_cost_history'
      and column_name = 'average_unit_cost_before'
      and is_nullable = 'YES'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_cost_history'
      and column_name = 'receipt_idempotency_key'
      and is_nullable = 'YES'
  ) then
    raise exception 'CPP_VERIFY_FAILED: faltan columnas de auditoría del promedio, o no son nulas.';
  end if;

  select pg_get_constraintdef(c.oid)
    into v_src
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'inventory_cost_history'
    and c.conname = 'inventory_cost_history_source_check';
  if v_src is null or v_src not ilike '%invoice_reversal%' then
    raise exception 'CPP_VERIFY_FAILED: el historial no admite invoice_reversal.';
  end if;

  if to_regclass('public.inventory_cost_history_invoice_ref_uniq') is null then
    raise exception 'CPP_VERIFY_FAILED: falta el índice único del recibo.';
  end if;

  v_set := pg_get_functiondef('public.senda_set_inventory_purchase_cost(jsonb)'::regprocedure);
  v_recv := pg_get_functiondef('public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure);
  v_del := pg_get_functiondef('public.senda_delete_purchase_invoice(jsonb)'::regprocedure);
  v_comp := pg_get_functiondef('public.senda_cpp_compensate_receipt(uuid, uuid, uuid, uuid, uuid, uuid)'::regprocedure);
  v_adj := pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure);
  v_sale := pg_get_functiondef('public.register_sale_consumption(uuid, numeric, text, text)'::regprocedure);

  if position('senda_cpp_next_average' in v_set) = 0
     or position('quantity_on_hand_before' in v_set) = 0
     or position('UNVALUED_STOCK' in v_set) = 0
     or v_set ~* 'set[[:space:]]+quantity_on_hand' then
    raise exception 'CPP_VERIFY_FAILED: el costo no escribe el promedio sin tocar el stock.';
  end if;

  v_cost_at := position('senda_set_inventory_purchase_cost' in v_recv);
  v_qty_at := position('quantity_on_hand + excluded.quantity_on_hand' in v_recv);
  if position('senda_cpp_allocate_receipt' in v_recv) = 0
     or v_cost_at = 0
     or v_qty_at = 0
     or v_cost_at > v_qty_at
     or position('from public.location_inventory' in lower(v_recv))
        > position('from public.inventory_valuations' in lower(v_recv)) then
    raise exception 'CPP_VERIFY_FAILED: la recepción no lee el saldo antes de sumarlo.';
  end if;

  if position('senda_cpp_compensate_receipt' in v_del) = 0
     or position('senda_cpp_compensate_receipt' in v_del)
        > position('senda_adjust_inventory_quantity' in v_del)
     or position('order by rec.created_at desc, rec.id desc' in v_del) = 0
     or position('v_restore_cost' in v_del) > 0
     or v_del ilike '%delete from public.inventory_cost_history%'
     or v_del ilike '%insert into public.inventory_movements%' then
    raise exception 'CPP_VERIFY_FAILED: la anulación no cumple el caso A/B.';
  end if;

  if v_comp ~* 'update[[:space:]]+public\.inventory_cost_history'
     or v_comp ~* 'set[[:space:]]+quantity_on_hand'
     or position('senda_cpp_replay_block_reason' in v_comp) = 0
     or position('v_fold_avg' in v_comp) = 0 then
    raise exception 'CPP_VERIFY_FAILED: la compensación reescribe historia o no justifica el CPP.';
  end if;
  if position(
    'su costo histórico no se puede reconstruir'
    in pg_get_functiondef('public.senda_cpp_replay_block_reason(numeric, numeric, text, numeric, jsonb)'::regprocedure)
  ) = 0 then
    raise exception 'CPP_VERIFY_FAILED: un saldo simulado no negativo todavía alcanza para anular.';
  end if;

  if v_sale ~* 'set[[:space:]]+average_unit_cost|average_unit_cost[[:space:]]*:='
     or v_adj ~* 'set[[:space:]]+average_unit_cost|average_unit_cost[[:space:]]*:=' then
    raise exception 'CPP_VERIFY_FAILED: la venta o el ajuste escriben el CPP.';
  end if;

  if exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public'
      and c.relname = 'inventory_movements'
      and not t.tgisinternal
      and pg_get_functiondef(p.oid) ~* 'quantity_on_hand|inventory_valuations'
  ) then
    raise exception 'CPP_VERIFY_FAILED: hay un trigger que también mueve el saldo.';
  end if;
end
$verify$;

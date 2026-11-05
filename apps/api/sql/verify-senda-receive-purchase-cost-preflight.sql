-- SENDA OPS — preflight de SOLO LECTURA antes de Etapa B (costo al recibir).
-- No modifica tablas, políticas, grants ni datos. No llama RPCs.
-- Confirma que el SQL de costo de compra (Paso 447) está instalado y que
-- la recepción actual todavía no lo invoca.
-- No vuelve a ejecutar proposed-senda-set-inventory-purchase-cost.sql.

select
  'cost_rpc_installed' as check_id,
  to_regprocedure('public.senda_set_inventory_purchase_cost(jsonb)') is not null as ok
union all
select
  'cost_history_installed',
  to_regclass('public.inventory_cost_history') is not null
union all
select
  'receive_rpc_installed',
  to_regprocedure('public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)') is not null
union all
select
  'receive_does_not_call_cost_yet',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) not ilike '%senda_set_inventory_purchase_cost%'
union all
select
  'cost_execute_service_only',
  has_function_privilege('service_role', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.senda_set_inventory_purchase_cost(jsonb)', 'EXECUTE')
union all
select
  'receive_execute_service_only',
  has_function_privilege(
    'service_role',
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)',
    'EXECUTE'
  );

do $assert$
begin
  if to_regprocedure('public.senda_set_inventory_purchase_cost(jsonb)') is null then
    raise exception 'RECEIVE_COST_PREFLIGHT: falta senda_set_inventory_purchase_cost. No reejecutar 447 desde Etapa B.';
  end if;
  if to_regclass('public.inventory_cost_history') is null then
    raise exception 'RECEIVE_COST_PREFLIGHT: falta inventory_cost_history.';
  end if;
  if to_regprocedure('public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)') is null then
    raise exception 'RECEIVE_COST_PREFLIGHT: falta senda_receive_purchase_document_line.';
  end if;
end
$assert$;

-- SENDA OPS — verificación de SOLO LECTURA tras Etapa B.
-- No modifica tablas, políticas, grants ni datos. No llama RPCs.

select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.proconfig as search_path_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('senda_receive_purchase_document_line', 'senda_set_inventory_purchase_cost')
order by p.proname, arguments;

select
  r.rolname as grantee,
  has_function_privilege(
    r.oid,
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)',
    'EXECUTE'
  ) as receive_execute,
  has_function_privilege(
    r.oid,
    'public.senda_set_inventory_purchase_cost(jsonb)',
    'EXECUTE'
  ) as cost_execute
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

select
  'receive_calls_cost_rpc' as check_id,
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) ilike '%senda_set_inventory_purchase_cost%' as ok
union all
select
  'source_invoice',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) ilike '%invoice%'
union all
select
  'uses_line_net_amount',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) ilike '%reviewed_amount%'
  and pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) ilike '%inventory_physical_quantity%'
union all
select
  'cost_uses_invoiced_qty',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) ilike '%''purchase_quantity'', v_line.inventory_physical_quantity%'
union all
select
  'no_partial_cost_round',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) not ilike '%round(v_net * (p_quantity / v_line.inventory_physical_quantity)%'
union all
select
  'idempotent_before_stock',
  position(
    'idempotent' in lower(pg_get_functiondef(
      'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
    ))
  ) < position(
    'senda_set_inventory_purchase_cost' in lower(pg_get_functiondef(
      'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
    ))
  )
union all
select
  'stock_plus_once',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) ilike '%quantity_on_hand = public.inventory_valuations.quantity_on_hand + excluded.quantity_on_hand%'
union all
select
  'no_http',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) not ilike '%http%'
  and pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) not ilike '%net.%'
union all
select
  'no_fudo',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) not ilike '%pending_product_mappings%'
  and pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) not ilike '%sales_product_mappings%'
union all
select
  'execute_receive_service_only',
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
  if pg_get_functiondef(
       'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
     ) not ilike '%senda_set_inventory_purchase_cost%'
     or not has_function_privilege(
       'service_role',
       'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)',
       'EXECUTE'
     )
  then
    raise exception 'RECEIVE_COST_VERIFY_FAILED';
  end if;
end
$assert$;

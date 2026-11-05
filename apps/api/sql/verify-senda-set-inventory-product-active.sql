-- SENDA OPS — Verificación de SOLO LECTURA tras aplicar
-- proposed-senda-set-inventory-product-active.sql.
-- No modifica tablas, políticas, grants ni datos. No llama el RPC.
-- Si un chequeo falla, el bloque final aborta.

select
  'definer' as check_id,
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure('public.senda_set_inventory_product_active(jsonb)')
      and p.prosecdef
  ) as ok
union all
select
  'execute_service_only',
  to_regprocedure('public.senda_set_inventory_product_active(jsonb)') is not null
    and has_function_privilege('service_role', 'public.senda_set_inventory_product_active(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.senda_set_inventory_product_active(jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.senda_set_inventory_product_active(jsonb)', 'EXECUTE')
union all
select
  'sets_active_only',
  pg_get_functiondef('public.senda_set_inventory_product_active(jsonb)'::regprocedure)
    ilike '%update public.inventory_products%'
  and pg_get_functiondef('public.senda_set_inventory_product_active(jsonb)'::regprocedure)
    not ilike '%delete from public.inventory_products%'
  and pg_get_functiondef('public.senda_set_inventory_product_active(jsonb)'::regprocedure)
    not ilike '%set quantity_on_hand%'
  and pg_get_functiondef('public.senda_set_inventory_product_active(jsonb)'::regprocedure)
    not ilike '%insert into public.inventory_movements%'
union all
select
  'blocks_product_in_use',
  pg_get_functiondef('public.senda_set_inventory_product_active(jsonb)'::regprocedure)
    ilike '%PRODUCT_IN_USE%'
union all
select
  'no_authenticated_update_grant',
  not has_table_privilege('authenticated', 'public.inventory_products', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.inventory_products', 'DELETE')
union all
select
  'receive_blocks_inactive_product',
  to_regprocedure(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'
  ) is null
  or pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) ilike '%PRODUCT_INACTIVE%';

do $fail$
begin
  if exists (
    select 1
    from (
      select
        'definer' as check_id,
        exists (
          select 1 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.oid = to_regprocedure('public.senda_set_inventory_product_active(jsonb)')
            and p.prosecdef
        ) as ok
      union all
      select
        'execute_service_only',
        to_regprocedure('public.senda_set_inventory_product_active(jsonb)') is not null
          and has_function_privilege('service_role', 'public.senda_set_inventory_product_active(jsonb)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.senda_set_inventory_product_active(jsonb)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.senda_set_inventory_product_active(jsonb)', 'EXECUTE')
    ) checks
    where not ok
  ) then
    raise exception 'INVENTORY_PRODUCT_ACTIVE_VERIFY_FAILED';
  end if;
end
$fail$;

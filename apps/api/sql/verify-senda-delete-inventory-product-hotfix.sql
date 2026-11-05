-- SENDA OPS — Verificación de SOLO LECTURA tras
-- proposed-senda-delete-inventory-product-hotfix.sql.
-- No modifica tablas, políticas, grants ni datos.

select
  'delete_rpc_installed' as check_id,
  to_regprocedure('public.senda_delete_inventory_product(jsonb)') is not null as ok
union all
select
  'execute_service_only',
  has_function_privilege('service_role', 'public.senda_delete_inventory_product(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.senda_delete_inventory_product(jsonb)', 'EXECUTE')
union all
select
  'blocks_with_history',
  pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    ilike '%PRODUCT_HAS_HISTORY%'
union all
select
  'no_purchase_product_memory_ref',
  pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    not ilike '%purchase_product_memory%'
union all
select
  'checks_core_dependencies',
  pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    ilike '%purchase_document_receipts%'
  and pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    ilike '%purchase_document_lines%'
  and pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    ilike '%recipe_components%'
  and pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    ilike '%inventory_movements%'
union all
select
  'optional_tables_use_execute',
  pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    ilike '%inventory_cost_history%'
  and pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    ilike '%inventory_adjustments%'
  and pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    ~* 'execute'
union all
select
  'no_receipt_delete',
  pg_get_functiondef('public.senda_delete_inventory_product(jsonb)'::regprocedure)
    not ilike '%delete from public.purchase_document_receipts%';

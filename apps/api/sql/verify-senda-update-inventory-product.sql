-- SENDA OPS — verificación de SOLO LECTURA tras senda_update_inventory_product.
-- No modifica tablas, políticas, grants ni datos.

select
  'update_rpc_installed' as check_id,
  to_regprocedure('public.senda_update_inventory_product(jsonb)') is not null as ok
union all
select
  'category_column',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_products'
      and column_name = 'category'
  )
union all
select
  'execute_service_only',
  has_function_privilege('service_role', 'public.senda_update_inventory_product(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.senda_update_inventory_product(jsonb)', 'EXECUTE')
union all
select
  'no_quantity_overwrite',
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    not ilike '%quantity_on_hand%'
union all
select
  'min_stock_does_not_force_active',
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%coalesce(v_row.active, false)%'
  and pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%do update%set minimum_stock = coalesce(v_minimum, 0)%';

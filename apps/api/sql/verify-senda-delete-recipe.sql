-- GastroGest / SENDA — verificación SOLO LECTURA de senda_delete_recipe

select to_regprocedure('public.senda_delete_recipe(jsonb)') is not null as rpc_exists;

select
  has_function_privilege('service_role', 'public.senda_delete_recipe(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.senda_delete_recipe(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.senda_delete_recipe(jsonb)', 'EXECUTE')
  as execute_ok;

select
  pg_get_functiondef('public.senda_delete_recipe(jsonb)'::regprocedure)
    ilike '%RECIPE_STILL_ACTIVE%' as blocks_active,
  pg_get_functiondef('public.senda_delete_recipe(jsonb)'::regprocedure)
    ilike '%RECIPE_IN_USE%' as blocks_dependents,
  pg_get_functiondef('public.senda_delete_recipe(jsonb)'::regprocedure)
    not ilike '%inventory_movements%' as no_stock_touch;

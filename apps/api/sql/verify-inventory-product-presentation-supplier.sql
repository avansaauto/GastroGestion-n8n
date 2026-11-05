-- Verificación de solo lectura — presentación + proveedor habitual
-- NO escribe datos. Ejecutar tras proposed-inventory-product-presentation-supplier.sql

-- 1) Columnas
select
  'columns' as check_name,
  count(*) filter (where column_name = 'presentation_unit') = 1 as has_presentation_unit,
  count(*) filter (where column_name = 'conversion_factor') = 1 as has_conversion_factor,
  count(*) filter (where column_name = 'preferred_supplier_id') = 1 as has_preferred_supplier_id,
  count(*) filter (where column_name = 'divisible') = 1 as has_divisible
from information_schema.columns
where table_schema = 'public'
  and table_name = 'inventory_products'
  and column_name in (
    'presentation_unit', 'conversion_factor', 'preferred_supplier_id', 'divisible'
  );

-- 2) Helpers
select
  'helpers' as check_name,
  to_regprocedure('public.senda_normalize_presentation_unit(text)') is not null
    as has_normalize,
  to_regprocedure('public.senda_assert_presentation_coherence(text, text, numeric, boolean)') is not null
    as has_coherence,
  to_regprocedure('public.senda_inventory_product_has_history(uuid)') is not null
    as has_history,
  to_regprocedure('public.senda_assert_recipe_component_quantities(uuid, jsonb)') is not null
    as has_recipe_assert;

-- 3) Update RPC: divisible persistido + org/location match + lock
select
  'rpc_update' as check_name,
  to_regprocedure('public.senda_update_inventory_product(jsonb)') is not null as exists,
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%divisible%' as body_mentions_divisible,
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%ORG_LOCATION_MISMATCH%' as body_org_location_match,
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%PRESENTATION_LOCKED%' as body_presentation_locked,
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%senda_assert_presentation_coherence%' as body_coherence,
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%INVALID_NAME%' as preserves_invalid_name,
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%DUPLICATE_PRODUCT%' as preserves_duplicate,
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%INVALID_MINIMUM_STOCK%' as preserves_minimum,
  pg_get_functiondef('public.senda_update_inventory_product(jsonb)'::regprocedure)
    ilike '%never active%' as preserves_no_reactivate_comment;

-- 4) Operación controlada de presentación
select
  'rpc_set_presentation' as check_name,
  to_regprocedure('public.senda_set_inventory_product_presentation(jsonb)') is not null as exists,
  pg_get_functiondef('public.senda_set_inventory_product_presentation(jsonb)'::regprocedure)
    ilike '%CONFIRM_REQUIRED%' as requires_confirm,
  pg_get_functiondef('public.senda_set_inventory_product_presentation(jsonb)'::regprocedure)
    ilike '%stock_reinterpreted%' as reports_no_reinterpret,
  pg_get_functiondef('public.senda_set_inventory_product_presentation(jsonb)'::regprocedure)
    ilike '%ORG_LOCATION_MISMATCH%' as body_org_location_match;

-- 5) Supplier concurrent-safe
select
  'rpc_ensure_supplier' as check_name,
  to_regprocedure('public.senda_ensure_supplier_from_issuer(jsonb)') is not null as exists,
  pg_get_functiondef('public.senda_ensure_supplier_from_issuer(jsonb)'::regprocedure)
    ilike '%unique_violation%' as catches_unique_violation,
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'suppliers'
      and indexname = 'suppliers_org_tax_uidx'
  ) as has_tax_uidx,
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'suppliers'
      and indexname = 'suppliers_org_name_norm_uidx'
  ) as has_name_uidx;

-- 6) Recetas llaman assert (si los RPC existen)
select
  'recipe_rpc_assert' as check_name,
  case
    when to_regprocedure('public.senda_create_recipe(jsonb)') is null then null
    else pg_get_functiondef('public.senda_create_recipe(jsonb)'::regprocedure)
      ilike '%senda_assert_recipe_component_quantities%'
  end as create_calls_assert,
  case
    when to_regprocedure('public.senda_update_recipe(jsonb)') is null then null
    else pg_get_functiondef('public.senda_update_recipe(jsonb)'::regprocedure)
      ilike '%senda_assert_recipe_component_quantities%'
  end as update_calls_assert;

-- 7) Privilegios (solo service_role)
select
  'privileges' as check_name,
  has_function_privilege('service_role', 'public.senda_update_inventory_product(jsonb)', 'EXECUTE')
    as update_service_role,
  not has_function_privilege('authenticated', 'public.senda_update_inventory_product(jsonb)', 'EXECUTE')
    as update_not_authenticated,
  has_function_privilege('service_role', 'public.senda_set_inventory_product_presentation(jsonb)', 'EXECUTE')
    as set_presentation_service_role,
  not has_function_privilege('authenticated', 'public.senda_set_inventory_product_presentation(jsonb)', 'EXECUTE')
    as set_presentation_not_authenticated,
  has_function_privilege('service_role', 'public.senda_ensure_supplier_from_issuer(jsonb)', 'EXECUTE')
    as ensure_supplier_service_role;

-- 8) Coherencia dry-run (inmutable; sin tocar tablas). Solo si el helper existe.
do $smoke$
begin
  if to_regprocedure('public.senda_assert_presentation_coherence(text, text, numeric, boolean)') is null then
    raise notice 'coherence_smoke_skipped: helper ausente';
    return;
  end if;

  perform public.senda_assert_presentation_coherence('ml', null, null, null);
  perform public.senda_assert_presentation_coherence('ml', 'u', 750, false);
  perform public.senda_assert_presentation_coherence('g', 'unidad', 1000, true);

  begin
    perform public.senda_assert_presentation_coherence('ml', 'u', null, false);
    raise exception 'EXPECTED_INVALID_PRESENTATION_incomplete';
  exception
    when others then
      if SQLERRM not ilike '%INVALID_PRESENTATION%' then
        raise;
      end if;
  end;

  begin
    perform public.senda_assert_presentation_coherence('unit', 'u', 1, true);
    raise exception 'EXPECTED_INVALID_PRESENTATION_base';
  exception
    when others then
      if SQLERRM not ilike '%INVALID_PRESENTATION%' then
        raise;
      end if;
  end;

  begin
    perform public.senda_assert_presentation_coherence('ml', null, null, false);
    raise exception 'EXPECTED_INVALID_PRESENTATION_divisible_alone';
  exception
    when others then
      if SQLERRM not ilike '%INVALID_PRESENTATION%' then
        raise;
      end if;
  end;

  raise notice 'coherence_smoke_ok';
end
$smoke$;

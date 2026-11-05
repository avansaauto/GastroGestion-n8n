-- SENDA OPS — Verificación de SOLO LECTURA tras aplicar
-- proposed-senda-adjust-inventory-quantity.sql.
-- No modifica tablas, políticas, grants ni datos. No llama el RPC.

select
  'definer' as check_id,
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure('public.senda_adjust_inventory_quantity(jsonb)')
      and p.prosecdef
  ) as ok
union all
select
  'execute_service_only',
  to_regprocedure('public.senda_adjust_inventory_quantity(jsonb)') is not null
    and has_function_privilege('service_role', 'public.senda_adjust_inventory_quantity(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.senda_adjust_inventory_quantity(jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.senda_adjust_inventory_quantity(jsonb)', 'EXECUTE')
union all
select
  'writes_movement_before_balance',
  pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    ilike '%insert into public.inventory_movements%'
  and pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    ilike '%quantity_on_hand%'
  and pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    ilike '%REASON_REQUIRED%'
union all
select
  'stores_signed_quantity',
  pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    ilike '%v_qty%'
  and pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    not ilike '%abs(v_qty)%'
  and pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    not ilike '%v_abs%'
union all
select
  'keeps_costs',
  pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    not ilike '%set average_unit_cost%'
  and pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    not ilike '%last_purchase_unit_cost%'
union all
select
  'no_product_delete',
  pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    not ilike '%delete from public.inventory_products%'
union all
select
  'idempotency_and_non_negative',
  pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    ilike '%IDEMPOTENCY_CONFLICT%'
  and pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    ilike '%ADJUSTMENT_EXCEEDS_ON_HAND%'
  and pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    ilike '%replay%'
union all
select
  'li_insert_preserves_product_active',
  pg_get_functiondef('public.senda_adjust_inventory_quantity(jsonb)'::regprocedure)
    ilike '%coalesce(ip.active, false)%'
union all
select
  'movement_type_allows_adjustment',
  exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'inventory_movements'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'movement_type'
      and pg_get_constraintdef(c.oid) ~* '''adjustment'''
  )
  or not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'inventory_movements'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'movement_type'
  )
union all
select
  'movement_type_not_narrowed_to_two',
  not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'inventory_movements'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'movement_type'
      and pg_get_constraintdef(c.oid) ~* 'purchase'
      and pg_get_constraintdef(c.oid) ~* 'adjustment'
      and (
        select count(distinct m[1])
        from regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') as m
      ) = 2
      and exists (
        select 1
        from public.inventory_movements im
        where im.movement_type is not null
          and im.movement_type not in ('purchase', 'adjustment')
      )
  );

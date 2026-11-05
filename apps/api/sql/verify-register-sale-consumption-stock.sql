-- SENDA OPS — Verificación de SOLO LECTURA tras aplicar
-- proposed-register-sale-consumption-stock.sql.
-- No modifica funciones, permisos, triggers ni datos. No llama el RPC.
-- Si el bloque final aborta, la migración no quedó en el estado esperado.

select
  'signature' as check_id,
  pg_get_function_identity_arguments(p.oid)
    = 'p_location_inventory_id uuid, p_quantity numeric, p_source_type text, p_source_id text'
    and lower(regexp_replace(pg_get_function_result(p.oid), '\s+', ' ', 'g'))
      = 'table(inserted boolean, movement_id uuid)' as ok
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'register_sale_consumption'
union all
select
  'locks_location_then_valuation',
  position('from public.location_inventory' in lower(pg_get_functiondef(p.oid))) > 0
  and position('from public.location_inventory' in lower(pg_get_functiondef(p.oid)))
    < position('from public.inventory_valuations' in lower(pg_get_functiondef(p.oid)))
  and position('from public.inventory_valuations' in lower(pg_get_functiondef(p.oid)))
    < position('from public.inventory_movements' in lower(pg_get_functiondef(p.oid)))
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'register_sale_consumption'
union all
select
  'replay_before_discount',
  position('inserted := false' in lower(pg_get_functiondef(p.oid))) > 0
  and position('inserted := false' in lower(pg_get_functiondef(p.oid)))
    < position('set quantity_on_hand' in lower(pg_get_functiondef(p.oid)))
  and position('sale_idempotency_conflict' in lower(pg_get_functiondef(p.oid))) > 0
  and position('sale_exceeds_on_hand' in lower(pg_get_functiondef(p.oid)))
    < position('insert into public.inventory_movements' in lower(pg_get_functiondef(p.oid)))
  and position('insert into public.inventory_movements' in lower(pg_get_functiondef(p.oid)))
    < position('set quantity_on_hand' in lower(pg_get_functiondef(p.oid)))
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'register_sale_consumption'
union all
select
  'keeps_costs',
  lower(pg_get_functiondef(p.oid)) not like '%average_unit_cost%'
  and lower(pg_get_functiondef(p.oid)) not like '%last_purchase_unit_cost%'
  and lower(pg_get_functiondef(p.oid)) not like '%insert into public.inventory_valuations%'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'register_sale_consumption'
union all
select
  'single_balance_write',
  (
    select count(*)
    from regexp_matches(lower(pg_get_functiondef(p.oid)), 'set quantity_on_hand', 'g')
  ) = 1
  and lower(pg_get_functiondef(p.oid)) like '%where location_inventory_id = v_li%'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'register_sale_consumption'
union all
select
  'no_stock_trigger',
  not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc fn on fn.oid = t.tgfoid
    where n.nspname = 'public'
      and c.relname = 'inventory_movements'
      and not t.tgisinternal
      and pg_get_functiondef(fn.oid) ~* 'quantity_on_hand|inventory_valuations'
  );

select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'register_sale_consumption'
order by grantee, privilege_type;

select p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'register_sale_consumption';

do $verify$
begin
  if exists (
    select 1
    from (
      select
        position('from public.location_inventory' in lower(pg_get_functiondef(p.oid))) as li,
        position('from public.inventory_valuations' in lower(pg_get_functiondef(p.oid))) as val,
        position('inserted := false' in lower(pg_get_functiondef(p.oid))) as replay,
        position('set quantity_on_hand' in lower(pg_get_functiondef(p.oid))) as qty,
        lower(pg_get_functiondef(p.oid)) as body,
        pg_get_function_identity_arguments(p.oid) as args,
        lower(regexp_replace(pg_get_function_result(p.oid), '\s+', ' ', 'g')) as result_type
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'register_sale_consumption'
    ) f
    where f.args is distinct from 'p_location_inventory_id uuid, p_quantity numeric, p_source_type text, p_source_id text'
       or f.result_type is distinct from 'table(inserted boolean, movement_id uuid)'
       or f.li = 0 or f.val = 0 or f.li > f.val
       or f.replay = 0 or f.qty = 0 or f.replay > f.qty
       or f.body like '%average_unit_cost%'
       or f.body like '%last_purchase_unit_cost%'
       or f.body not like '%sale_exceeds_on_hand%'
       or f.body not like '%sale_idempotency_conflict%'
       or f.body not like '%invalid_quantity%'
       or f.body not like '%invalid_source%'
  ) then
    raise exception 'SALE_CONSUMPTION_VERIFY_FAILED';
  end if;
end
$verify$;

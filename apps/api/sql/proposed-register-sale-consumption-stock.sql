-- SENDA OPS — Descuento de stock en una venta.
-- Reemplaza el cuerpo de public.register_sale_consumption.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Antes: apps/api/sql/inspect-register-sale-consumption.sql (solo lectura).
-- Después: apps/api/sql/verify-register-sale-consumption-stock.sql (solo lectura).
--
-- Conserva la firma (uuid, numeric, text, text) y el resultado
-- inserted boolean, movement_id uuid. No agrega parámetros.
-- No hace GRANT ni REVOKE. No toca filas de inventario, facturas ni recetas.
-- No reescribe ventas históricas: el cuerpo nuevo solo corre en la próxima llamada.
-- proconfig se restaura con quote_ident y quote_literal. search_path="" del
-- catálogo es la cadena vacía y vuelve como SET search_path = ''.
--
-- n8n sigue llamando este RPC. Un reintento del mismo origen y la misma cantidad
-- devuelve inserted = false y el movement_id existente, sin descontar otra vez.
-- Stock insuficiente aborta con SALE_EXCEEDS_ON_HAND (SQLSTATE P0001) antes de
-- insertar. PostgREST responde HTTP 400 y no devuelve inserted. Un reintento
-- posterior, con el mismo origen, vuelve a intentar porque no quedó movimiento.
-- Esta migración no modifica el workflow.

begin;

do $guard$
declare
  v_args text;
  v_result text;
  v_old text;
  v_lang text;
  v_volatile "char";
  v_source_type text;
  r record;
  v_tdef text;
begin
  select
    pg_get_function_identity_arguments(p.oid),
    lower(regexp_replace(pg_get_function_result(p.oid), '\s+', ' ', 'g')),
    pg_get_functiondef(p.oid),
    l.lanname,
    p.provolatile
  into v_args, v_result, v_old, v_lang, v_volatile
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and p.proname = 'register_sale_consumption'
    and pg_get_function_identity_arguments(p.oid)
      = 'p_location_inventory_id uuid, p_quantity numeric, p_source_type text, p_source_id text';

  if v_args is null then
    raise exception 'SALE_CONSUMPTION_ABORT: no está register_sale_consumption(uuid, numeric, text, text) con los nombres que usa n8n.';
  end if;
  if v_result is distinct from 'table(inserted boolean, movement_id uuid)' then
    raise exception 'SALE_CONSUMPTION_ABORT: el resultado instalado es %. No se cambia la respuesta.', v_result;
  end if;
  if v_lang is distinct from 'plpgsql' or v_volatile is distinct from 'v' then
    raise exception 'SALE_CONSUMPTION_ABORT: la función instalada no es plpgsql volatile.';
  end if;
  if v_old ~* 'quantity_on_hand\s*=|set\s+quantity_on_hand' then
    raise exception 'SALE_CONSUMPTION_ABORT: el cuerpo instalado ya escribe quantity_on_hand. No se agrega otro descuento.';
  end if;
  if v_old ~* 'perform\s+(public\.)?\w+\s*\(|select\s+public\.\w+\s*\(' then
    raise exception 'SALE_CONSUMPTION_ABORT: el cuerpo instalado llama a otra función.';
  end if;
  if v_old ~* 'auth\.uid|senda_require_backend_actor|senda_actor_is_purchase_member|organization_members|request\.jwt' then
    raise exception 'SALE_CONSUMPTION_ABORT: la autorización instalada no cabe en la firma actual. No se reemplaza el cuerpo.';
  end if;

  select c.data_type
    into v_source_type
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'inventory_movements'
    and c.column_name = 'source_id';
  if v_source_type is distinct from 'text' and v_source_type is distinct from 'character varying' then
    raise exception 'SALE_CONSUMPTION_ABORT: inventory_movements.source_id es %.', coalesce(v_source_type, 'ausente');
  end if;

  if exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'inventory_movements'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'movement_type'
      and pg_get_constraintdef(c.oid) !~* '''sale'''
  ) then
    raise exception 'SALE_CONSUMPTION_ABORT: movement_type no admite sale.';
  end if;

  for r in
    select t.tgname, p.oid as fn
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public'
      and c.relname = 'inventory_movements'
      and not t.tgisinternal
  loop
    begin
      v_tdef := pg_get_functiondef(r.fn);
    exception
      when others then
        raise exception 'SALE_CONSUMPTION_ABORT: no se pudo leer el trigger %.', r.tgname;
    end;
    if v_tdef ~* 'quantity_on_hand|inventory_valuations|perform\s+(public\.)?\w+\s*\(' then
      raise exception 'SALE_CONSUMPTION_ABORT: el trigger % ya puede aplicar el saldo. No se agrega otro descuento.', r.tgname;
    end if;
  end loop;
end
$guard$;

create temp table sale_rpc_attr_before (
  owner_name text,
  is_definer boolean,
  config text[]
) on commit drop;

insert into sale_rpc_attr_before (owner_name, is_definer, config)
select pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'register_sale_consumption'
  and pg_get_function_identity_arguments(p.oid)
    = 'p_location_inventory_id uuid, p_quantity numeric, p_source_type text, p_source_id text';

create temp table sale_rpc_priv_before (
  grantee text,
  privilege_type text
) on commit drop;

insert into sale_rpc_priv_before (grantee, privilege_type)
select rp.grantee::text, rp.privilege_type::text
from information_schema.routine_privileges rp
where rp.routine_schema = 'public'
  and rp.routine_name = 'register_sale_consumption';

-- Decodifica un ítem de pg_proc.proconfig. Las comillas son las de
-- postgresql.conf: "" es la cadena vacía, no un identificador SQL.
create function pg_temp.sale_decode_proconfig(p_item text, out guc_name text, out guc_value text)
language plpgsql
as $$
declare
  v_eq integer;
  v_raw text;
  v_inner text;
  v_i integer;
  v_quoted boolean;
begin
  v_eq := strpos(p_item, '=');
  if v_eq < 2 then
    raise exception 'SALE_CONSUMPTION_ABORT: proconfig inválido.';
  end if;
  guc_name := lower(btrim(substr(p_item, 1, v_eq - 1)));
  v_raw := substr(p_item, v_eq + 1);
  v_quoted := length(v_raw) >= 2
    and left(v_raw, 1) = '"'
    and right(v_raw, 1) = '"';
  if v_quoted then
    v_inner := substr(v_raw, 2, length(v_raw) - 2);
    v_i := 1;
    while v_i <= length(v_inner) loop
      if substr(v_inner, v_i, 1) = '"' then
        if substr(v_inner, v_i + 1, 1) is distinct from '"' then
          v_quoted := false;
          exit;
        end if;
        v_i := v_i + 2;
      else
        v_i := v_i + 1;
      end if;
    end loop;
  end if;
  if v_quoted then
    guc_value := replace(v_inner, '""', '"');
  else
    guc_value := v_raw;
  end if;
end;
$$;

do $replace$
declare
  v_definer boolean;
  v_config text[];
  v_security text;
  v_item text;
  v_name text;
  v_value text;
  v_sql text;
begin
  select is_definer, config
    into v_definer, v_config
  from sale_rpc_attr_before;

  v_security := case when v_definer then 'security definer' else 'security invoker' end;

  v_sql := format($fn$
create or replace function public.register_sale_consumption(
  p_location_inventory_id uuid,
  p_quantity numeric,
  p_source_type text,
  p_source_id text
)
returns table (
  inserted boolean,
  movement_id uuid
)
language plpgsql
%s
as $func$
declare
  v_li uuid;
  v_on_hand numeric;
  v_next numeric;
  v_existing_id uuid;
  v_existing_qty numeric;
  v_movement uuid;
begin
  if p_quantity is null or p_quantity >= 0 or p_quantity <> p_quantity then
    raise exception 'INVALID_QUANTITY';
  end if;
  if p_source_type is null or btrim(p_source_type) = ''
     or p_source_id is null or btrim(p_source_id) = '' then
    raise exception 'INVALID_SOURCE';
  end if;
  if p_location_inventory_id is null then
    raise exception 'LOCATION_INVENTORY_MISSING';
  end if;

  select li.id
    into v_li
  from public.location_inventory li
  where li.id = p_location_inventory_id
  for update;
  if v_li is null then
    raise exception 'LOCATION_INVENTORY_MISSING';
  end if;

  select v.quantity_on_hand
    into v_on_hand
  from public.inventory_valuations v
  where v.location_inventory_id = v_li
  for update;

  begin
    select m.id, m.quantity
      into strict v_existing_id, v_existing_qty
    from public.inventory_movements m
    where m.location_inventory_id = v_li
      and m.movement_type = 'sale'
      and m.source_type = p_source_type
      and m.source_id = p_source_id
    for update;
  exception
    when no_data_found then
      v_existing_id := null;
    when too_many_rows then
      raise exception 'SALE_IDEMPOTENCY_CONFLICT';
  end;

  if v_existing_id is not null then
    if v_existing_qty is distinct from p_quantity then
      raise exception 'SALE_IDEMPOTENCY_CONFLICT';
    end if;
    inserted := false;
    movement_id := v_existing_id;
    return next;
    return;
  end if;

  v_on_hand := coalesce(v_on_hand, 0);
  v_next := v_on_hand + p_quantity;
  if v_next < 0 then
    raise exception 'SALE_EXCEEDS_ON_HAND';
  end if;

  begin
    insert into public.inventory_movements (
      location_inventory_id,
      movement_type,
      quantity,
      source_type,
      source_id,
      occurred_at,
      created_at
    ) values (
      v_li,
      'sale',
      p_quantity,
      p_source_type,
      p_source_id,
      now(),
      now()
    )
    returning id into v_movement;

    update public.inventory_valuations
       set quantity_on_hand = v_next,
           updated_at = now()
     where location_inventory_id = v_li;
    if not found then
      raise exception 'SALE_EXCEEDS_ON_HAND';
    end if;
  exception
    when unique_violation then
      select m.id, m.quantity
        into v_existing_id, v_existing_qty
      from public.inventory_movements m
      where m.location_inventory_id = v_li
        and m.movement_type = 'sale'
        and m.source_type = p_source_type
        and m.source_id = p_source_id
      order by m.created_at, m.id
      limit 1;
      if v_existing_id is not null and v_existing_qty is not distinct from p_quantity then
        inserted := false;
        movement_id := v_existing_id;
        return next;
        return;
      end if;
      raise exception 'SALE_IDEMPOTENCY_CONFLICT';
  end;

  inserted := true;
  movement_id := v_movement;
  return next;
  return;
end;
$func$
$fn$, v_security);

  execute v_sql;

  if v_config is not null then
    foreach v_item in array v_config loop
      select d.guc_name, d.guc_value
        into v_name, v_value
      from pg_temp.sale_decode_proconfig(v_item) as d;
      execute format(
        'alter function public.register_sale_consumption(uuid, numeric, text, text) set %I = %L',
        v_name,
        v_value
      );
    end loop;
  end if;
end
$replace$;

do $check$
declare
  v_body text;
  v_owner text;
  v_definer boolean;
  v_before_owner text;
  v_before_definer boolean;
  v_li integer;
  v_val integer;
  v_mov integer;
  v_insert integer;
  v_update integer;
  v_replay integer;
  v_exceeds integer;
  v_before text[];
  v_after text[];
  v_i integer;
  v_name text;
  v_value text;
  v_name_after text;
  v_value_after text;
  v_same boolean;
begin
  v_body := lower(pg_get_functiondef(
    'public.register_sale_consumption(uuid, numeric, text, text)'::regprocedure
  ));
  v_li := position('from public.location_inventory' in v_body);
  v_val := position('from public.inventory_valuations' in v_body);
  v_mov := position('from public.inventory_movements' in v_body);
  v_insert := position('insert into public.inventory_movements' in v_body);
  v_update := position('set quantity_on_hand' in v_body);
  v_replay := position('inserted := false' in v_body);
  v_exceeds := position('sale_exceeds_on_hand' in v_body);

  if v_li = 0 or v_val = 0 or v_mov = 0 or v_insert = 0 or v_update = 0
     or v_li > v_val or v_val > v_mov or v_exceeds = 0 or v_exceeds > v_insert
     or v_insert > v_update or v_replay = 0 or v_replay > v_update
     or v_body like '%average_unit_cost%'
     or v_body like '%last_purchase_unit_cost%'
     or v_body like '%insert into public.inventory_valuations%'
     or position('sale_idempotency_conflict' in v_body) = 0 then
    raise exception 'SALE_CONSUMPTION_ABORT: el cuerpo nuevo no cumple el orden de stock.';
  end if;

  select pg_get_userbyid(p.proowner), p.prosecdef
    into v_owner, v_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'register_sale_consumption';

  select owner_name, is_definer
    into v_before_owner, v_before_definer
  from sale_rpc_attr_before;

  if v_owner is distinct from v_before_owner or v_definer is distinct from v_before_definer then
    raise exception 'SALE_CONSUMPTION_ABORT: cambiaron owner o security definer.';
  end if;

  if exists (
    select grantee, privilege_type from sale_rpc_priv_before
    except
    select rp.grantee::text, rp.privilege_type::text
    from information_schema.routine_privileges rp
    where rp.routine_schema = 'public'
      and rp.routine_name = 'register_sale_consumption'
  ) or exists (
    select rp.grantee::text, rp.privilege_type::text
    from information_schema.routine_privileges rp
    where rp.routine_schema = 'public'
      and rp.routine_name = 'register_sale_consumption'
    except
    select grantee, privilege_type from sale_rpc_priv_before
  ) then
    raise exception 'SALE_CONSUMPTION_ABORT: los permisos de ejecución cambiaron.';
  end if;

  select config
    into v_before
  from sale_rpc_attr_before;

  select p.proconfig
    into v_after
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'register_sale_consumption'
    and pg_get_function_identity_arguments(p.oid)
      = 'p_location_inventory_id uuid, p_quantity numeric, p_source_type text, p_source_id text';

  v_same := v_before is not distinct from v_after;
  if not v_same
     and coalesce(cardinality(v_before), 0) = coalesce(cardinality(v_after), 0) then
    v_same := true;
    if v_before is not null then
      for v_i in 1 .. cardinality(v_before) loop
        select d.guc_name, d.guc_value
          into v_name, v_value
        from pg_temp.sale_decode_proconfig(v_before[v_i]) as d;
        select d.guc_name, d.guc_value
          into v_name_after, v_value_after
        from pg_temp.sale_decode_proconfig(v_after[v_i]) as d;
        if v_name is distinct from v_name_after
           or v_value is distinct from v_value_after then
          v_same := false;
          exit;
        end if;
      end loop;
    end if;
  end if;
  if not v_same then
    raise exception 'SALE_CONSUMPTION_ABORT: proconfig quedó distinto. antes=%, después=%', v_before, v_after;
  end if;
end
$check$;

drop function pg_temp.sale_decode_proconfig(text);

commit;

-- SENDA OPS — Evento de consumo de venta (contexto Fudo + resultado por línea).
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Después: apps/api/sql/verify-senda-sale-consumption-event.sql (solo lectura).
-- Contrato: apps/api/sql/proposed-senda-sale-consumption-event.md
--
-- Conserva public.register_sale_consumption sin cambiar su firma.
-- El envoltorio registra el contexto de la venta y llama al RPC de línea.
-- No reescribe movimientos históricos. No toca CPP, facturas ni recetas.

begin;

do $guard$
declare
  missing text;
begin
  if to_regprocedure('public.register_sale_consumption(uuid, numeric, text, text)') is null then
    raise exception 'SALE_EVENT_ABORT: falta register_sale_consumption(uuid, numeric, text, text).';
  end if;
  if to_regclass('public.organizations') is null then
    raise exception 'SALE_EVENT_ABORT: falta organizations.';
  end if;
  if to_regclass('public.locations') is null then
    raise exception 'SALE_EVENT_ABORT: falta locations.';
  end if;
  if to_regclass('public.location_inventory') is null then
    raise exception 'SALE_EVENT_ABORT: falta location_inventory.';
  end if;
  if to_regclass('public.inventory_movements') is null then
    raise exception 'SALE_EVENT_ABORT: falta inventory_movements.';
  end if;
  select string_agg(c.column_name, ', ' order by 1)
    into missing
  from (
    values
      ('locations', 'id'),
      ('locations', 'organization_id'),
      ('location_inventory', 'id'),
      ('location_inventory', 'location_id'),
      ('inventory_movements', 'id')
  ) as need(table_name, column_name)
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = need.table_name
   and c.column_name = need.column_name
  where c.column_name is null;
  if missing is not null then
    raise exception 'SALE_EVENT_ABORT: faltan columnas: %.', missing;
  end if;
  if to_regprocedure('public.senda_register_sale_consumption_event(jsonb)') is not null then
    raise exception 'SALE_EVENT_ABORT: senda_register_sale_consumption_event ya existe. No se vuelve a crear.';
  end if;
  if to_regclass('public.sale_consumption_events') is not null then
    raise exception 'SALE_EVENT_ABORT: sale_consumption_events ya existe.';
  end if;
end
$guard$;

create table public.sale_consumption_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null references public.locations (id),
  source_type text not null,
  source_id text not null,
  external_sale_id text,
  external_item_id text,
  external_product_id text,
  external_product_name text,
  recipe_id uuid,
  recipe_name text,
  sold_quantity numeric,
  sold_unit text,
  payload_digest text not null,
  status text not null
    constraint sale_consumption_events_status_chk
      check (status in ('complete', 'partial', 'failed', 'duplicate', 'reversed')),
  error_code text,
  error_message text,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_consumption_events_origin_uniq
    unique (location_id, source_type, source_id),
  constraint sale_consumption_events_source_chk
    check (btrim(source_type) <> '' and btrim(source_id) <> '')
);

create table public.sale_consumption_event_lines (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.sale_consumption_events (id) on delete cascade,
  location_inventory_id uuid not null references public.location_inventory (id),
  inventory_product_id uuid,
  quantity numeric not null,
  status text not null
    constraint sale_consumption_event_lines_status_chk
      check (status in ('registered', 'failed', 'duplicate')),
  inventory_movement_id uuid references public.inventory_movements (id),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  constraint sale_consumption_event_lines_qty_chk
    check (quantity < 0 and quantity = quantity)
);

create index sale_consumption_events_location_occurred_idx
  on public.sale_consumption_events (location_id, created_at desc);

create index sale_consumption_event_lines_event_idx
  on public.sale_consumption_event_lines (event_id);

comment on table public.sale_consumption_events is
  'Contexto de una venta Fudo (u otro origen) y estado del lote de consumos. No reemplaza inventory_movements.';
comment on column public.sale_consumption_events.source_id is
  'Identificador estable que n8n pasa también a register_sale_consumption. No es el product id de Fudo.';
comment on column public.sale_consumption_events.status is
  'complete | partial | failed | duplicate | reversed.';
comment on table public.sale_consumption_event_lines is
  'Resultado por ingrediente. SALE_EXCEEDS_ON_HAND queda como failed con error_code.';

alter table public.sale_consumption_events enable row level security;
alter table public.sale_consumption_event_lines enable row level security;

create policy sale_consumption_events_member_select
  on public.sale_consumption_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.organization_id = sale_consumption_events.organization_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

create policy sale_consumption_event_lines_member_select
  on public.sale_consumption_event_lines
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.sale_consumption_events e
      join public.organization_members m
        on m.organization_id = e.organization_id
      where e.id = sale_consumption_event_lines.event_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

revoke all on table public.sale_consumption_events from public, anon, authenticated;
revoke all on table public.sale_consumption_event_lines from public, anon, authenticated;
grant select on table public.sale_consumption_events to authenticated;
grant select on table public.sale_consumption_event_lines to authenticated;
grant select, insert, update on table public.sale_consumption_events to service_role;
grant select, insert, update on table public.sale_consumption_event_lines to service_role;

create or replace function public.senda_register_sale_consumption_event(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_location_id uuid;
  v_org_id uuid;
  v_source_type text;
  v_source_id text;
  v_digest text;
  v_existing public.sale_consumption_events%rowtype;
  v_event_id uuid;
  v_line jsonb;
  v_li uuid;
  v_qty numeric;
  v_product_id uuid;
  v_inserted boolean;
  v_movement uuid;
  v_line_status text;
  v_error_code text;
  v_error_message text;
  v_registered int := 0;
  v_failed int := 0;
  v_duplicate int := 0;
  v_status text;
  v_lines jsonb := '[]'::jsonb;
  v_result jsonb;
  v_row record;
  v_replay boolean := false;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_INPUT';
  end if;

  begin
    v_location_id := (p->>'location_id')::uuid;
  exception when others then
    raise exception 'INVALID_INPUT';
  end;
  if v_location_id is null then
    raise exception 'INVALID_INPUT';
  end if;

  v_source_type := btrim(coalesce(p->>'source_type', ''));
  v_source_id := btrim(coalesce(p->>'source_id', ''));
  if v_source_type = '' or v_source_id = '' then
    raise exception 'INVALID_INPUT';
  end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') < 1 then
    raise exception 'INVALID_INPUT';
  end if;

  select l.organization_id
    into v_org_id
  from public.locations l
  where l.id = v_location_id;
  if v_org_id is null then
    raise exception 'LOCATION_MISSING';
  end if;

  -- Digest estable: ordena por location_inventory_id para que el mismo lote
  -- no choque por reordenamiento de n8n.
  select md5(coalesce(string_agg(
    format('%s:%s', e.li, e.qty),
    '|' order by e.li
  ), ''))
    into v_digest
  from (
    select
      (value->>'location_inventory_id') as li,
      (value->>'quantity') as qty
    from jsonb_array_elements(p->'lines')
  ) e;

  select *
    into v_existing
  from public.sale_consumption_events e
  where e.location_id = v_location_id
    and e.source_type = v_source_type
    and e.source_id = v_source_id
  for update;

  if found then
    if v_existing.payload_digest is distinct from v_digest then
      raise exception 'SALE_EVENT_IDEMPOTENCY_CONFLICT';
    end if;

    -- Completo / duplicado / revertido: no re-descuenta.
    if v_existing.status in ('complete', 'duplicate', 'reversed') then
      return jsonb_build_object(
        'event_id', v_existing.id,
        'status', case
          when v_existing.status = 'reversed' then 'reversed'
          else 'duplicate'
        end,
        'replay', true,
        'lines', coalesce(v_existing.result->'lines', '[]'::jsonb)
      );
    end if;

    -- partial / failed: reintenta SOLO líneas failed. No toca registered.
    -- No inventa sale_reversal (cancelaciones Fudo siguen fuera de este RPC).
    v_event_id := v_existing.id;
    v_replay := true;

    for v_row in
      select l.id, l.location_inventory_id, l.quantity, l.status,
             l.inventory_movement_id, l.error_code, l.inventory_product_id
      from public.sale_consumption_event_lines l
      where l.event_id = v_event_id
      order by l.created_at, l.id
      for update of l
    loop
      if v_row.status is distinct from 'failed' then
        if v_row.status = 'registered' then
          v_registered := v_registered + 1;
        elsif v_row.status = 'duplicate' then
          v_duplicate := v_duplicate + 1;
        end if;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'location_inventory_id', v_row.location_inventory_id,
          'quantity', v_row.quantity,
          'status', v_row.status,
          'movement_id', v_row.inventory_movement_id,
          'error_code', v_row.error_code
        ));
        continue;
      end if;

      v_li := v_row.location_inventory_id;
      v_qty := v_row.quantity;
      v_product_id := v_row.inventory_product_id;
      v_movement := null;
      v_error_code := null;
      v_error_message := null;

      if v_product_id is null then
        select li.inventory_product_id
          into v_product_id
        from public.location_inventory li
        where li.id = v_li
          and li.location_id = v_location_id;
      end if;

      if v_product_id is null then
        v_line_status := 'failed';
        v_error_code := 'LOCATION_INVENTORY_MISSING';
        v_error_message := 'LOCATION_INVENTORY_MISSING';
        v_failed := v_failed + 1;
      else
        begin
          select r.inserted, r.movement_id
            into v_inserted, v_movement
          from public.register_sale_consumption(
            v_li, v_qty, v_source_type, v_source_id
          ) as r;
          if coalesce(v_inserted, false) then
            v_line_status := 'registered';
            v_registered := v_registered + 1;
          else
            -- Ya existía el movimiento (p. ej. carrera): no re-descuenta.
            v_line_status := 'duplicate';
            v_duplicate := v_duplicate + 1;
          end if;
        exception
          when others then
            v_line_status := 'failed';
            v_error_code := split_part(SQLERRM, ':', 1);
            if v_error_code is null or v_error_code = '' then
              v_error_code := 'SALE_LINE_FAILED';
            end if;
            v_error_message := SQLERRM;
            v_movement := null;
            v_failed := v_failed + 1;
        end;
      end if;

      update public.sale_consumption_event_lines
         set status = v_line_status,
             inventory_product_id = coalesce(v_product_id, inventory_product_id),
             inventory_movement_id = v_movement,
             error_code = v_error_code,
             error_message = v_error_message
       where id = v_row.id;

      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'location_inventory_id', v_li,
        'quantity', v_qty,
        'status', v_line_status,
        'movement_id', v_movement,
        'error_code', v_error_code
      ));
    end loop;

    if v_failed = 0 and (v_registered + v_duplicate) > 0 then
      v_status := 'complete';
    elsif v_registered > 0 and v_failed > 0 then
      v_status := 'partial';
    elsif v_registered = 0 and v_duplicate > 0 and v_failed = 0 then
      v_status := 'duplicate';
    else
      v_status := 'failed';
    end if;

    v_result := jsonb_build_object(
      'event_id', v_event_id,
      'status', v_status,
      'replay', true,
      'lines', v_lines
    );

    update public.sale_consumption_events
       set status = v_status,
           result = v_result,
           error_code = case when v_status = 'failed' then 'SALE_EVENT_FAILED' else null end,
           updated_at = clock_timestamp()
     where id = v_event_id;

    return v_result;
  end if;

  insert into public.sale_consumption_events (
    organization_id,
    location_id,
    source_type,
    source_id,
    external_sale_id,
    external_item_id,
    external_product_id,
    external_product_name,
    recipe_id,
    recipe_name,
    sold_quantity,
    sold_unit,
    payload_digest,
    status,
    result
  ) values (
    v_org_id,
    v_location_id,
    v_source_type,
    v_source_id,
    nullif(btrim(coalesce(p->>'external_sale_id', '')), ''),
    nullif(btrim(coalesce(p->>'external_item_id', '')), ''),
    nullif(btrim(coalesce(p->>'external_product_id', '')), ''),
    nullif(btrim(coalesce(p->>'external_product_name', '')), ''),
    case
      when nullif(btrim(coalesce(p->>'recipe_id', '')), '') is null then null
      else (btrim(p->>'recipe_id'))::uuid
    end,
    nullif(btrim(coalesce(p->>'recipe_name', '')), ''),
    case
      when p ? 'sold_quantity' and (p->>'sold_quantity') ~ '^-?[0-9]+(\.[0-9]+)?$'
        then (p->>'sold_quantity')::numeric
      else null
    end,
    nullif(btrim(coalesce(p->>'sold_unit', '')), ''),
    v_digest,
    'failed',
    '{}'::jsonb
  )
  returning id into v_event_id;

  for v_line in
    select value
    from jsonb_array_elements(p->'lines')
  loop
    begin
      v_li := (v_line->>'location_inventory_id')::uuid;
      v_qty := (v_line->>'quantity')::numeric;
    exception when others then
      raise exception 'INVALID_INPUT';
    end;
    if v_li is null or v_qty is null or v_qty >= 0 or v_qty <> v_qty then
      raise exception 'INVALID_INPUT';
    end if;

    select li.inventory_product_id
      into v_product_id
    from public.location_inventory li
    where li.id = v_li
      and li.location_id = v_location_id;
    if v_product_id is null then
      v_line_status := 'failed';
      v_error_code := 'LOCATION_INVENTORY_MISSING';
      v_error_message := 'LOCATION_INVENTORY_MISSING';
      v_movement := null;
      v_failed := v_failed + 1;
    else
      begin
        select r.inserted, r.movement_id
          into v_inserted, v_movement
        from public.register_sale_consumption(v_li, v_qty, v_source_type, v_source_id) as r;
        if coalesce(v_inserted, false) then
          v_line_status := 'registered';
          v_registered := v_registered + 1;
        else
          v_line_status := 'duplicate';
          v_duplicate := v_duplicate + 1;
        end if;
        v_error_code := null;
        v_error_message := null;
      exception
        when others then
          v_line_status := 'failed';
          v_error_code := split_part(SQLERRM, ':', 1);
          if v_error_code is null or v_error_code = '' then
            v_error_code := 'SALE_LINE_FAILED';
          end if;
          v_error_message := SQLERRM;
          v_movement := null;
          v_failed := v_failed + 1;
      end;
    end if;

    insert into public.sale_consumption_event_lines (
      event_id,
      location_inventory_id,
      inventory_product_id,
      quantity,
      status,
      inventory_movement_id,
      error_code,
      error_message
    ) values (
      v_event_id,
      v_li,
      v_product_id,
      v_qty,
      v_line_status,
      v_movement,
      v_error_code,
      v_error_message
    );

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'location_inventory_id', v_li,
      'quantity', v_qty,
      'status', v_line_status,
      'movement_id', v_movement,
      'error_code', v_error_code
    ));
  end loop;

  if v_failed = 0 and (v_registered + v_duplicate) > 0 then
    v_status := 'complete';
  elsif v_registered > 0 and v_failed > 0 then
    v_status := 'partial';
  elsif v_registered = 0 and v_duplicate > 0 and v_failed = 0 then
    v_status := 'duplicate';
  else
    v_status := 'failed';
  end if;

  v_result := jsonb_build_object(
    'event_id', v_event_id,
    'status', v_status,
    'replay', v_replay,
    'lines', v_lines
  );

  update public.sale_consumption_events
     set status = v_status,
         result = v_result,
         error_code = case when v_status = 'failed' then 'SALE_EVENT_FAILED' else null end,
         updated_at = clock_timestamp()
   where id = v_event_id;

  return v_result;
end;
$fn$;

revoke all on function public.senda_register_sale_consumption_event(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_register_sale_consumption_event(jsonb)
  to service_role;

comment on function public.senda_register_sale_consumption_event(jsonb) is
  'Contexto de venta + descuento vía register_sale_consumption. Conserva SALE_EXCEEDS_ON_HAND. Reintenta solo líneas failed; no inventa reversos.';

commit;

-- =============================================================================
-- Ensayo E2E aislado — espejo del payload Fudo venta 41068 / ítem 148651
-- Fernet Branca -120 ml + Coca-Cola -660 ml
--
-- Misma firma: public.senda_register_sale_consumption_event(jsonb)
-- Org/sucursal DESCARTABLES. ROLLBACK. NO OGHAM Barrio Chino. NO SENDA.
--
-- Prerrequisitos (vía run-test-senda-sale-consumption-event.mjs):
--   test-senda-cpp-fixture.sql + proposed-senda-cpp.sql
--   + proposed-senda-sale-consumption-event.sql
-- =============================================================================

do $guard$
begin
  if current_database() is distinct from 'senda_cpp_test'
     and coalesce(current_setting('senda.cpp_test', true), '') is distinct from 'on' then
    raise exception 'TEST_ABORT: solo corre en senda_cpp_test.';
  end if;
  if exists (
    select 1 from public.organizations
    where id = 'a01b3bf7-6af2-4078-9931-e70f55b4626e'
  ) then
    raise exception 'TEST_ABORT: esta base parece SENDA.';
  end if;
  if exists (
    select 1 from public.locations
    where id = 'd8d78b7d-eec5-4e90-8f2d-98268a875d00'
  ) then
    raise exception 'TEST_ABORT: no usar OGHAM Barrio Chino.';
  end if;
  perform set_config('senda.cpp_test', 'on', true);
end
$guard$;

begin;

do $pilot$
declare
  -- Sucursal descartable (NO Barrio Chino).
  v_org uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  v_location uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  v_actor uuid := 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  v_fernet uuid;
  v_coca uuid;
  v_doc uuid;
  v_line uuid;
  v_li_fernet uuid;
  v_li_coca uuid;
  v_recipe uuid := gen_random_uuid();
  v_result jsonb;
  v_event_id uuid;
  v_qty numeric;
  v_avg_fernet numeric;
  v_avg_coca numeric;
  v_avg_after numeric;
  v_moves integer;
  v_failed_code text;
  v_event_status text;
  v_sale_id text := '41068';
  v_item_id text := '148651';
  v_product_id text := '60';
begin
  insert into public.organizations (id) values (v_org) on conflict do nothing;
  insert into public.locations (id, organization_id) values (v_location, v_org)
  on conflict do nothing;

  v_fernet := public.cpp_test_product(v_org, 'Fernet Branca piloto 41068');
  v_coca := public.cpp_test_product(v_org, 'Coca-Cola piloto 41068');

  -- Stock valorado suficiente (CPP conocido).
  -- Fernet: 5000 ml a $0,50/ml → total $2500
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_fernet, 5000, 2500, date '2026-11-01') t;
  perform public.senda_receive_purchase_document_line(
    v_doc, v_line, 5000, gen_random_uuid(), v_actor);

  -- Coca: 10000 ml a $2,727…/ml (espejo $900/330) → total redondeado
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_coca, 10000, 27272.73, date '2026-11-01') t;
  perform public.senda_receive_purchase_document_line(
    v_doc, v_line, 10000, gen_random_uuid(), v_actor);

  select s.li, s.qty, s.avg into v_li_fernet, v_qty, v_avg_fernet
  from public.cpp_test_state(v_fernet) s;
  perform public.cpp_test_expect(v_qty = 5000, 'stock Fernet inicial 5000');
  perform public.cpp_test_expect(v_avg_fernet is not null, 'CPP Fernet inicial');

  select s.li, s.qty, s.avg into v_li_coca, v_qty, v_avg_coca
  from public.cpp_test_state(v_coca) s;
  perform public.cpp_test_expect(v_qty = 10000, 'stock Coca inicial 10000');
  perform public.cpp_test_expect(v_avg_coca is not null, 'CPP Coca inicial');

  -- -----------------------------------------------------------------------
  -- 1) Evento completo — contrato idéntico al payload n8n (ítem 148651)
  -- source_id = item_id; external_sale_id = venta_id
  -- -----------------------------------------------------------------------
  v_result := public.senda_register_sale_consumption_event(jsonb_build_object(
    'location_id', v_location,
    'source_type', 'fudo',
    'source_id', v_item_id,
    'external_sale_id', v_sale_id,
    'external_item_id', v_item_id,
    'external_product_id', v_product_id,
    'external_product_name', 'fernet branca y coca',
    'recipe_id', v_recipe,
    'recipe_name', 'Fernet con coca',
    -- Venta real: 2 u × (60 ml Fernet + 330 ml Coca) → -120 / -660
    'sold_quantity', 2,
    'sold_unit', 'unit',
    'lines', jsonb_build_array(
      jsonb_build_object('location_inventory_id', v_li_fernet, 'quantity', -120),
      jsonb_build_object('location_inventory_id', v_li_coca, 'quantity', -660)
    )
  ));

  perform public.cpp_test_expect(v_result->>'status' = 'complete', '1) evento complete');
  v_event_id := (v_result->>'event_id')::uuid;
  perform public.cpp_test_expect(v_event_id is not null, '1) event_id');

  select status into v_event_status
  from public.sale_consumption_events
  where id = v_event_id;
  perform public.cpp_test_expect(v_event_status = 'complete', '1) fila evento complete');
  perform public.cpp_test_expect(
    exists (
      select 1 from public.sale_consumption_events e
      where e.id = v_event_id and e.sold_quantity = 2
    ),
    '1) sold_quantity=2 persistido'
  );

  -- -----------------------------------------------------------------------
  -- 2) Descuento exacto
  -- -----------------------------------------------------------------------
  select s.qty into v_qty from public.cpp_test_state(v_fernet) s;
  perform public.cpp_test_expect(v_qty = 4880, '2) Fernet 5000-120=4880');
  select s.qty into v_qty from public.cpp_test_state(v_coca) s;
  perform public.cpp_test_expect(v_qty = 9340, '2) Coca 10000-660=9340');

  -- -----------------------------------------------------------------------
  -- 3) Historial de movimientos
  -- -----------------------------------------------------------------------
  select count(*) into v_moves
  from public.inventory_movements
  where source_type = 'fudo'
    and source_id = v_item_id
    and movement_type = 'sale';
  perform public.cpp_test_expect(v_moves = 2, '3) 2 movimientos sale');

  perform public.cpp_test_expect(
    exists (
      select 1 from public.inventory_movements m
      where m.source_type = 'fudo' and m.source_id = v_item_id
        and m.location_inventory_id = v_li_fernet and m.quantity = -120
        and m.movement_type = 'sale'
    ),
    '3) movimiento Fernet -120'
  );
  perform public.cpp_test_expect(
    exists (
      select 1 from public.inventory_movements m
      where m.source_type = 'fudo' and m.source_id = v_item_id
        and m.location_inventory_id = v_li_coca and m.quantity = -660
        and m.movement_type = 'sale'
    ),
    '3) movimiento Coca -660'
  );

  -- -----------------------------------------------------------------------
  -- 4) CPP / costos conservados (el RPC no toca average_unit_cost)
  -- -----------------------------------------------------------------------
  select s.avg into v_avg_after from public.cpp_test_state(v_fernet) s;
  perform public.cpp_test_expect(v_avg_after is not distinct from v_avg_fernet, '4) CPP Fernet intacto');
  select s.avg into v_avg_after from public.cpp_test_state(v_coca) s;
  perform public.cpp_test_expect(v_avg_after is not distinct from v_avg_coca, '4) CPP Coca intacto');

  -- -----------------------------------------------------------------------
  -- 5) Replay del mismo evento → duplicate, sin doble descuento
  -- -----------------------------------------------------------------------
  v_result := public.senda_register_sale_consumption_event(jsonb_build_object(
    'location_id', v_location,
    'source_type', 'fudo',
    'source_id', v_item_id,
    'external_sale_id', v_sale_id,
    'external_item_id', v_item_id,
    'external_product_id', v_product_id,
    'external_product_name', 'fernet branca y coca',
    'recipe_id', v_recipe,
    'recipe_name', 'Fernet con coca',
    'sold_quantity', 2,
    'sold_unit', 'unit',
    'lines', jsonb_build_array(
      jsonb_build_object('location_inventory_id', v_li_fernet, 'quantity', -120),
      jsonb_build_object('location_inventory_id', v_li_coca, 'quantity', -660)
    )
  ));
  perform public.cpp_test_expect(v_result->>'status' = 'duplicate', '5) replay duplicate');
  perform public.cpp_test_expect(coalesce((v_result->>'replay')::boolean, false), '5) replay true');

  select s.qty into v_qty from public.cpp_test_state(v_fernet) s;
  perform public.cpp_test_expect(v_qty = 4880, '5) Fernet sin re-descuento');
  select s.qty into v_qty from public.cpp_test_state(v_coca) s;
  perform public.cpp_test_expect(v_qty = 9340, '5) Coca sin re-descuento');
  select count(*) into v_moves
  from public.inventory_movements
  where source_type = 'fudo' and source_id = v_item_id and movement_type = 'sale';
  perform public.cpp_test_expect(v_moves = 2, '5) siguen 2 movimientos');

  -- -----------------------------------------------------------------------
  -- 6) Stock insuficiente → failed, sin saldo negativo
  -- -----------------------------------------------------------------------
  v_result := public.senda_register_sale_consumption_event(jsonb_build_object(
    'location_id', v_location,
    'source_type', 'fudo',
    'source_id', '148651-insuff',
    'external_sale_id', v_sale_id,
    'external_item_id', '148651-insuff',
    'external_product_id', v_product_id,
    'external_product_name', 'fernet branca y coca',
    'recipe_name', 'Fernet con coca',
    'sold_quantity', 2,
    'sold_unit', 'unit',
    'lines', jsonb_build_array(
      jsonb_build_object('location_inventory_id', v_li_fernet, 'quantity', -999999)
    )
  ));
  perform public.cpp_test_expect(v_result->>'status' = 'failed', '6) failed por stock');

  select l.error_code into v_failed_code
  from public.sale_consumption_event_lines l
  join public.sale_consumption_events e on e.id = l.event_id
  where e.source_id = '148651-insuff'
  limit 1;
  perform public.cpp_test_expect(
    v_failed_code = 'SALE_EXCEEDS_ON_HAND',
    '6) error_code SALE_EXCEEDS_ON_HAND'
  );

  select s.qty into v_qty from public.cpp_test_state(v_fernet) s;
  perform public.cpp_test_expect(v_qty = 4880, '6) Fernet no bajó');
  perform public.cpp_test_expect(v_qty >= 0, '6) sin saldo negativo');

  select s.avg into v_avg_after from public.cpp_test_state(v_fernet) s;
  perform public.cpp_test_expect(v_avg_after is not distinct from v_avg_fernet, '6) CPP intacto tras failed');

  raise notice 'OK fudo 41068/148651 pilot rehearsal (isolated)';
end
$pilot$;

rollback;

-- =============================================================================
-- Prueba integral aislada: factura → stock → venta evento → replay → insuficiente
-- Solo senda_cpp_test. ROLLBACK al final. NO SENDA.
--
-- Prerrequisitos:
--   test-senda-cpp-fixture.sql
--   proposed-senda-cpp.sql (receive + valuations)
--   proposed-senda-sale-consumption-event.sql
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
  perform set_config('senda.cpp_test', 'on', true);
end
$guard$;

begin;

do $cases$
declare
  v_org uuid := '11111111-1111-4111-8111-111111111111';
  v_location uuid := '22222222-2222-4222-8222-222222222222';
  v_actor uuid := '33333333-3333-4333-8333-333333333333';
  v_flour uuid;
  v_cheese uuid;
  v_doc uuid;
  v_line uuid;
  v_li_flour uuid;
  v_li_cheese uuid;
  v_recipe uuid := gen_random_uuid();
  v_result jsonb;
  v_status text;
  v_qty numeric;
  v_moves integer;
  v_event_id uuid;
  v_err text;
  v_failed_code text;
begin
  insert into public.organizations (id) values (v_org) on conflict do nothing;
  insert into public.locations (id, organization_id) values (v_location, v_org)
  on conflict do nothing;

  v_flour := public.cpp_test_product(v_org, 'harina piloto venta');
  v_cheese := public.cpp_test_product(v_org, 'queso piloto venta');

  -- Factura / recepción: stock valorado (espejo CPP opening).
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_flour, 1000, 5000, date '2026-11-01') t;
  perform public.senda_receive_purchase_document_line(
    v_doc, v_line, 1000, gen_random_uuid(), v_actor);

  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_cheese, 500, 10000, date '2026-11-01') t;
  perform public.senda_receive_purchase_document_line(
    v_doc, v_line, 500, gen_random_uuid(), v_actor);

  select s.li, s.qty into v_li_flour, v_qty from public.cpp_test_state(v_flour) s;
  perform public.cpp_test_expect(v_qty = 1000, 'stock harina 1000');
  select s.li, s.qty into v_li_cheese, v_qty from public.cpp_test_state(v_cheese) s;
  perform public.cpp_test_expect(v_qty = 500, 'stock queso 500');

  -- =========================================================================
  -- Venta completa (receta de 2 insumos) — source_id estable estilo Fudo
  -- =========================================================================
  v_result := public.senda_register_sale_consumption_event(jsonb_build_object(
    'location_id', v_location,
    'source_type', 'fudo',
    'source_id', '144696',
    'external_sale_id', '144696',
    'external_item_id', 'item-1',
    'external_product_id', '183',
    'external_product_name', 'Pizza piloto',
    'recipe_id', v_recipe,
    'recipe_name', 'Pizza piloto',
    'sold_quantity', 1,
    'sold_unit', 'unit',
    'lines', jsonb_build_array(
      jsonb_build_object('location_inventory_id', v_li_flour, 'quantity', -200),
      jsonb_build_object('location_inventory_id', v_li_cheese, 'quantity', -100)
    )
  ));
  v_status := v_result->>'status';
  v_event_id := (v_result->>'event_id')::uuid;
  perform public.cpp_test_expect(v_status = 'complete', 'venta complete');
  select s.qty into v_qty from public.cpp_test_state(v_flour) s;
  perform public.cpp_test_expect(v_qty = 800, 'harina tras venta 800');
  select s.qty into v_qty from public.cpp_test_state(v_cheese) s;
  perform public.cpp_test_expect(v_qty = 400, 'queso tras venta 400');
  select count(*) into v_moves
  from public.inventory_movements
  where source_type = 'fudo' and source_id = '144696' and movement_type = 'sale';
  perform public.cpp_test_expect(v_moves = 2, '2 movimientos sale');

  -- =========================================================================
  -- Replay idéntico: no re-descuenta
  -- =========================================================================
  v_result := public.senda_register_sale_consumption_event(jsonb_build_object(
    'location_id', v_location,
    'source_type', 'fudo',
    'source_id', '144696',
    'lines', jsonb_build_array(
      jsonb_build_object('location_inventory_id', v_li_flour, 'quantity', -200),
      jsonb_build_object('location_inventory_id', v_li_cheese, 'quantity', -100)
    )
  ));
  perform public.cpp_test_expect(v_result->>'status' = 'duplicate', 'replay duplicate');
  perform public.cpp_test_expect(coalesce((v_result->>'replay')::boolean, false), 'replay true');
  select s.qty into v_qty from public.cpp_test_state(v_flour) s;
  perform public.cpp_test_expect(v_qty = 800, 'harina intacta tras replay');
  select count(*) into v_moves
  from public.inventory_movements
  where source_type = 'fudo' and source_id = '144696' and movement_type = 'sale';
  perform public.cpp_test_expect(v_moves = 2, 'sigue 2 movimientos');

  -- =========================================================================
  -- Stock insuficiente: SALE_EXCEEDS_ON_HAND queda en el evento (failed)
  -- =========================================================================
  v_result := public.senda_register_sale_consumption_event(jsonb_build_object(
    'location_id', v_location,
    'source_type', 'fudo',
    'source_id', '144700',
    'external_sale_id', '144700',
    'external_product_name', 'Pizza grande',
    'recipe_id', v_recipe,
    'recipe_name', 'Pizza piloto',
    'sold_quantity', 1,
    'lines', jsonb_build_array(
      jsonb_build_object('location_inventory_id', v_li_flour, 'quantity', -9000)
    )
  ));
  perform public.cpp_test_expect(v_result->>'status' = 'failed', 'venta failed por stock');
  select l.error_code into v_failed_code
  from public.sale_consumption_event_lines l
  join public.sale_consumption_events e on e.id = l.event_id
  where e.source_id = '144700'
  limit 1;
  perform public.cpp_test_expect(
    v_failed_code = 'SALE_EXCEEDS_ON_HAND',
    'error_code SALE_EXCEEDS_ON_HAND persistido'
  );
  select s.qty into v_qty from public.cpp_test_state(v_flour) s;
  perform public.cpp_test_expect(v_qty = 800, 'stock no bajó en failed');

  -- =========================================================================
  -- Misma clave + payload distinto → conflicto
  -- =========================================================================
  begin
    perform public.senda_register_sale_consumption_event(jsonb_build_object(
      'location_id', v_location,
      'source_type', 'fudo',
      'source_id', '144696',
      'lines', jsonb_build_array(
        jsonb_build_object('location_inventory_id', v_li_flour, 'quantity', -201)
      )
    ));
    perform public.cpp_test_expect(false, 'debió conflictar digest');
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      perform public.cpp_test_expect(
        v_err ilike '%SALE_EVENT_IDEMPOTENCY_CONFLICT%',
        'SALE_EVENT_IDEMPOTENCY_CONFLICT'
      );
  end;

  -- =========================================================================
  -- Partial: 1 ok + 1 exceeds; luego reponer stock y reintentar failed only
  -- =========================================================================
  v_result := public.senda_register_sale_consumption_event(jsonb_build_object(
    'location_id', v_location,
    'source_type', 'fudo',
    'source_id', '144710',
    'external_sale_id', '144710',
    'external_product_name', 'Combo parcial',
    'recipe_name', 'Combo',
    'sold_quantity', 1,
    'lines', jsonb_build_array(
      jsonb_build_object('location_inventory_id', v_li_flour, 'quantity', -100),
      jsonb_build_object('location_inventory_id', v_li_cheese, 'quantity', -10000)
    )
  ));
  perform public.cpp_test_expect(v_result->>'status' = 'partial', 'venta partial');
  select s.qty into v_qty from public.cpp_test_state(v_flour) s;
  perform public.cpp_test_expect(v_qty = 700, 'harina descontó en partial');
  select s.qty into v_qty from public.cpp_test_state(v_cheese) s;
  perform public.cpp_test_expect(v_qty = 400, 'queso no descontó en partial');

  -- Reponer queso (ajuste positivo) y reintentar mismo evento.
  perform public.senda_adjust_inventory_quantity(jsonb_build_object(
    'actor_user_id', v_actor,
    'organization_id', v_org,
    'location_id', v_location,
    'inventory_product_id', v_cheese,
    'idempotency_key', gen_random_uuid(),
    'quantity', 20000,
    'reason', 'reposicion test parcial'
  ));

  v_result := public.senda_register_sale_consumption_event(jsonb_build_object(
    'location_id', v_location,
    'source_type', 'fudo',
    'source_id', '144710',
    'lines', jsonb_build_array(
      jsonb_build_object('location_inventory_id', v_li_flour, 'quantity', -100),
      jsonb_build_object('location_inventory_id', v_li_cheese, 'quantity', -10000)
    )
  ));
  perform public.cpp_test_expect(v_result->>'status' = 'complete', 'partial→complete tras retry');
  perform public.cpp_test_expect(coalesce((v_result->>'replay')::boolean, false), 'retry es replay');
  select s.qty into v_qty from public.cpp_test_state(v_flour) s;
  perform public.cpp_test_expect(v_qty = 700, 'harina no se re-descontó');
  select s.qty into v_qty from public.cpp_test_state(v_cheese) s;
  -- 400 + 20000 - 10000 = 10400
  perform public.cpp_test_expect(v_qty = 10400, 'queso descontó en retry');

  select count(*) into v_moves
  from public.inventory_movements
  where source_type = 'fudo' and source_id = '144710' and movement_type = 'sale';
  perform public.cpp_test_expect(v_moves = 2, 'partial retry: 2 sales finales');

  raise notice 'OK sale consumption event integral suite';
end
$cases$;

rollback;

-- Pruebas del CPP con fixtures. ROLLBACK al final de los casos de una sesión.
-- NO EJECUTAR en SENDA. Requiere test-senda-cpp-fixture.sql y proposed-senda-cpp.sql
-- ya aplicados sobre la base descartable senda_cpp_test.
-- La sección concurrente commitea solo en esa base y borra sus filas al terminar.

do $guard$
begin
  if current_database() is distinct from 'senda_cpp_test'
     and coalesce(current_setting('senda.cpp_test', true), '') is distinct from 'on' then
    raise exception 'TEST_ABORT: solo corre en la base descartable senda_cpp_test.';
  end if;
  if exists (
    select 1 from public.organizations
    where id = 'a01b3bf7-6af2-4078-9931-e70f55b4626e'
  ) then
    raise exception 'TEST_ABORT: esta base parece SENDA.';
  end if;
end
$guard$;

create or replace function public.cpp_test_product(p_org uuid, p_name text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.inventory_products (id, organization_id, name, active)
  values (v_id, p_org, p_name, true);
  return v_id;
end;
$$;

create or replace function public.cpp_test_open(
  p_org uuid,
  p_location uuid,
  p_product uuid,
  p_physical numeric,
  p_amount numeric,
  p_day date
) returns table (doc uuid, line uuid)
language plpgsql
as $$
declare
  v_doc uuid := gen_random_uuid();
  v_line uuid := gen_random_uuid();
begin
  insert into public.purchase_documents (
    id, location_id, organization_id, status, currency, document_date,
    issuer_name, document_number
  ) values (
    v_doc, p_location, p_org, 'reviewed', 'ARS', p_day, 'FIXTURE', 'CPP-TEST'
  );
  insert into public.purchase_document_lines (
    id, purchase_document_id, inventory_eligibility, mapping_status, classification,
    quantity_kind, reviewed_amount, original_amount, inventory_product_id,
    inventory_physical_quantity
  ) values (
    v_line, v_doc, 'eligible', 'mapped', 'ingredient',
    'unit', p_amount, p_amount, p_product, p_physical
  );
  doc := v_doc;
  line := v_line;
  return next;
end;
$$;

create or replace function public.cpp_test_state(p_product uuid)
returns table (qty numeric, avg numeric, last_cost numeric, li uuid)
language sql
stable
as $$
  select iv.quantity_on_hand, iv.average_unit_cost, iv.last_purchase_unit_cost, li.id
  from public.location_inventory li
  join public.inventory_valuations iv on iv.location_inventory_id = li.id
  where li.inventory_product_id = p_product;
$$;

create or replace function public.cpp_test_expect(p_ok boolean, p_name text)
returns void
language plpgsql
as $$
begin
  if p_ok is not true then
    raise exception 'CPP_TEST_FAILED: %', p_name;
  end if;
end;
$$;

begin;

do $cases$
declare
  v_org uuid := '11111111-1111-4111-8111-111111111111';
  v_location uuid := '22222222-2222-4222-8222-222222222222';
  v_actor uuid := '33333333-3333-4333-8333-333333333333';
  v_product uuid;
  v_doc uuid;
  v_line uuid;
  v_doc_b uuid;
  v_line_b uuid;
  v_key uuid;
  v_qty numeric;
  v_avg numeric;
  v_last numeric;
  v_li uuid;
  v_sum numeric;
  v_count integer;
  v_before numeric;
  v_before_avg numeric;
  v_new numeric;
  v_recv jsonb;
begin
  insert into public.organizations (id) values (v_org);
  insert into public.locations (id, organization_id) values (v_location, v_org);

  -- Dos compras a precios distintos: 10 kg a 120.000 y 10 kg a 140.000 → CPP 13.
  v_product := public.cpp_test_product(v_org, 'fixture cpp dos precios');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-01-01') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select t.doc, t.line into v_doc_b, v_line_b
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 140000, date '2026-01-02') t;
  perform public.senda_receive_purchase_document_line(v_doc_b, v_line_b, 10000, gen_random_uuid(), v_actor);
  select s.qty, s.avg, s.last_cost into v_qty, v_avg, v_last
  from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 20000, 'dos compras: cantidad');
  perform public.cpp_test_expect(v_avg = 13, 'dos compras: CPP 13');
  perform public.cpp_test_expect(v_last = 14, 'dos compras: último precio 14');
  perform public.cpp_test_expect(v_avg * 200 = 2600, 'dos compras: 200 g valen 2600');
  select h.quantity_on_hand_before, h.average_unit_cost_before, h.new_unit_cost
    into v_before, v_before_avg, v_new
  from public.inventory_cost_history h
  join public.location_inventory li on li.id = h.location_inventory_id
  where li.inventory_product_id = v_product
    and h.source = 'invoice'
  order by h.recorded_at desc, h.id desc
  limit 1;
  perform public.cpp_test_expect(v_before = 10000, 'dos compras: stock anterior de la segunda');
  perform public.cpp_test_expect(v_before_avg = 12, 'dos compras: CPP anterior 12');
  perform public.cpp_test_expect(v_new = 13, 'dos compras: el historial guarda el CPP, no el último precio');

  -- Compra, venta y compra nueva: quedan 6 kg a 12 y entran 10 kg a 140.000 → 13,25.
  v_product := public.cpp_test_product(v_org, 'fixture cpp compra venta compra');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-02-01') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select s.li into v_li from public.cpp_test_state(v_product) s;
  perform *
  from public.register_sale_consumption(v_li, -4000, 'senda_test', 'cpp-sale-between');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 140000, date '2026-02-02') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select s.qty, s.avg, s.last_cost into v_qty, v_avg, v_last
  from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 16000, 'compra venta compra: cantidad');
  perform public.cpp_test_expect(v_avg = 13.25, 'compra venta compra: CPP 13.25');
  perform public.cpp_test_expect(v_last = 14, 'compra venta compra: último precio');

  -- Dos recepciones parciales. Los tramos cierran el importe de la línea.
  v_product := public.cpp_test_product(v_org, 'fixture cpp parciales');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 3, 10, date '2026-03-01') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 1, gen_random_uuid(), v_actor);
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 2, gen_random_uuid(), v_actor);
  select coalesce(sum(h.purchase_cost), 0), count(*)
    into v_sum, v_count
  from public.inventory_cost_history h
  join public.location_inventory li on li.id = h.location_inventory_id
  where li.inventory_product_id = v_product
    and h.source = 'invoice';
  select s.qty, s.avg into v_qty, v_avg from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_count = 2, 'parciales: un historial por entrega');
  perform public.cpp_test_expect(v_sum = 10, 'parciales: los tramos suman 10');
  perform public.cpp_test_expect(v_qty = 3, 'parciales: cantidad');
  perform public.cpp_test_expect(v_avg = round(10::numeric / 3, 8), 'parciales: CPP');

  -- Stock cero: el CPP viejo no se pondera.
  v_product := public.cpp_test_product(v_org, 'fixture cpp stock cero');
  insert into public.location_inventory (location_id, inventory_product_id, minimum_stock, active)
  values (v_location, v_product, 0, true)
  returning id into v_li;
  insert into public.inventory_valuations (
    location_inventory_id, quantity_on_hand, average_unit_cost, currency, updated_at
  ) values (
    v_li, 0, 9, 'ARS', clock_timestamp()
  );
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10, 50, date '2026-03-02') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10, gen_random_uuid(), v_actor);
  select s.qty, s.avg into v_qty, v_avg from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 10, 'stock cero: cantidad');
  perform public.cpp_test_expect(v_avg = 5, 'stock cero: usa el costo nuevo');
  perform public.cpp_test_expect(v_avg is distinct from 9, 'stock cero: no conserva el promedio viejo');

  -- Venta y merma no mueven el CPP.
  v_product := public.cpp_test_product(v_org, 'fixture cpp venta merma');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-04-01') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select s.li into v_li from public.cpp_test_state(v_product) s;
  perform *
  from public.register_sale_consumption(v_li, -1500, 'senda_test', 'cpp-sale-keep');
  perform public.senda_adjust_inventory_quantity(jsonb_build_object(
    'actor_user_id', v_actor,
    'organization_id', v_org,
    'location_id', v_location,
    'inventory_product_id', v_product,
    'idempotency_key', gen_random_uuid(),
    'quantity', -200,
    'reason', 'merma de fixture'
  ));
  select s.qty, s.avg, s.last_cost into v_qty, v_avg, v_last
  from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 8300, 'venta y merma: cantidad');
  perform public.cpp_test_expect(v_avg = 12, 'venta y merma: CPP quieto');
  perform public.cpp_test_expect(v_last = 12, 'venta y merma: último precio quieto');

  -- Ajuste positivo: suma unidades valuadas al CPP vigente y no cambia el CPP.
  v_product := public.cpp_test_product(v_org, 'fixture cpp ajuste positivo');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-04-02') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  perform public.senda_adjust_inventory_quantity(jsonb_build_object(
    'actor_user_id', v_actor,
    'organization_id', v_org,
    'location_id', v_location,
    'inventory_product_id', v_product,
    'idempotency_key', gen_random_uuid(),
    'quantity', 1000,
    'reason', 'ajuste positivo de fixture'
  ));
  select s.qty, s.avg into v_qty, v_avg from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 11000, 'ajuste positivo: cantidad');
  perform public.cpp_test_expect(v_avg = 12, 'ajuste positivo: CPP quieto');
  perform public.cpp_test_expect(v_qty * v_avg = 132000, 'ajuste positivo: las unidades nuevas quedan al CPP vigente');

  -- Recepción repetida.
  v_product := public.cpp_test_product(v_org, 'fixture cpp repetida');
  v_key := gen_random_uuid();
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 4, 40, date '2026-04-03') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 4, v_key, v_actor);
  v_recv := public.senda_receive_purchase_document_line(v_doc, v_line, 4, v_key, v_actor);
  select s.qty, s.avg into v_qty, v_avg from public.cpp_test_state(v_product) s;
  select count(*) into v_count
  from public.inventory_movements m
  join public.location_inventory li on li.id = m.location_inventory_id
  where li.inventory_product_id = v_product
    and m.movement_type = 'purchase';
  perform public.cpp_test_expect((v_recv->>'idempotent')::boolean, 'repetida: idempotente');
  perform public.cpp_test_expect(v_qty = 4, 'repetida: no suma stock');
  perform public.cpp_test_expect(v_avg = 10, 'repetida: no cambia el CPP');
  perform public.cpp_test_expect(v_count = 1, 'repetida: un solo movimiento');

  -- Anulación sin dependencias.
  v_product := public.cpp_test_product(v_org, 'fixture cpp anulacion limpia');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-05-01') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  perform public.senda_delete_purchase_invoice(jsonb_build_object(
    'actor_user_id', v_actor,
    'purchase_document_id', v_doc
  ));
  select s.qty, s.avg into v_qty, v_avg from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 0, 'anulacion limpia: stock cero');
  perform public.cpp_test_expect(v_avg = 12, 'anulacion limpia: el CPP queda como referencia');
  perform public.cpp_test_expect(
    (select d.deleted_at is not null from public.purchase_documents d where d.id = v_doc),
    'anulacion limpia: deleted_at'
  );
  perform public.cpp_test_expect(
    (select count(*) = 1
     from public.inventory_cost_history h
     join public.location_inventory li on li.id = h.location_inventory_id
     where li.inventory_product_id = v_product
       and h.source = 'invoice_reversal'),
    'anulacion limpia: historial de reverso'
  );
  perform public.cpp_test_expect(
    (select count(*) = 1
     from public.inventory_movements m
     join public.location_inventory li on li.id = m.location_inventory_id
     where li.inventory_product_id = v_product
       and m.movement_type = 'purchase'),
    'anulacion limpia: conserva el movimiento de compra'
  );

  -- Anulación bloqueada: el stock final alcanza, pero la venta intermedia
  -- no entra si se saca la primera compra.
  v_product := public.cpp_test_product(v_org, 'fixture cpp anulacion bloqueada');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-05-02') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select s.li into v_li from public.cpp_test_state(v_product) s;
  perform *
  from public.register_sale_consumption(v_li, -4000, 'senda_test', 'cpp-sale-block');
  select t.doc, t.line into v_doc_b, v_line_b
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 140000, date '2026-05-03') t;
  perform public.senda_receive_purchase_document_line(v_doc_b, v_line_b, 10000, gen_random_uuid(), v_actor);
  begin
    perform public.senda_delete_purchase_invoice(jsonb_build_object(
      'actor_user_id', v_actor,
      'purchase_document_id', v_doc
    ));
    raise exception 'CPP_TEST_FAILED: anulacion bloqueada debía fallar';
  exception
    when others then
      if sqlerrm not like '%REVERSAL_DEPENDENT_MOVEMENTS%' then
        raise;
      end if;
  end;
  select s.qty, s.avg into v_qty, v_avg from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 16000, 'anulacion bloqueada: el stock no se tocó');
  perform public.cpp_test_expect(v_avg = 13.25, 'anulacion bloqueada: el CPP no se tocó');
  perform public.cpp_test_expect(
    (select d.deleted_at is null from public.purchase_documents d where d.id = v_doc)
    and (select b.deleted_at is null from public.purchase_documents b where b.id = v_doc_b),
    'anulacion bloqueada: los documentos siguen'
  );
  perform public.cpp_test_expect(
    (select count(*) = 3
     from public.inventory_movements m
     join public.location_inventory li on li.id = m.location_inventory_id
     where li.inventory_product_id = v_product)
    and (select m.quantity = -4000
         from public.inventory_movements m
         join public.location_inventory li on li.id = m.location_inventory_id
         where li.inventory_product_id = v_product
           and m.movement_type = 'sale'),
    'anulacion bloqueada: la venta sigue intacta'
  );
  perform public.cpp_test_expect(
    (select count(*) = 0
     from public.inventory_cost_history h
     join public.location_inventory li on li.id = h.location_inventory_id
     where li.inventory_product_id = v_product
       and h.source = 'invoice_reversal'),
    'anulacion bloqueada: no hay reverso de costo'
  );

  -- Compra, venta, compra nueva: anular la segunda sí cierra.
  -- La venta es anterior a esa compra y el CPP vuelve al de la primera.
  v_product := public.cpp_test_product(v_org, 'fixture cpp anular segunda tras venta');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-05-10') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select s.li into v_li from public.cpp_test_state(v_product) s;
  perform *
  from public.register_sale_consumption(v_li, -4000, 'senda_test', 'cpp-sale-before-second');
  select t.doc, t.line into v_doc_b, v_line_b
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 140000, date '2026-05-11') t;
  perform public.senda_receive_purchase_document_line(v_doc_b, v_line_b, 10000, gen_random_uuid(), v_actor);
  perform public.senda_delete_purchase_invoice(jsonb_build_object(
    'actor_user_id', v_actor,
    'purchase_document_id', v_doc_b
  ));
  select s.qty, s.avg, s.last_cost into v_qty, v_avg, v_last
  from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 6000, 'anular segunda: queda el stock posterior a la venta');
  perform public.cpp_test_expect(v_avg = 12, 'anular segunda: el CPP vuelve al de la primera compra');
  perform public.cpp_test_expect(v_last = 12, 'anular segunda: el último precio vuelve a la primera');
  perform public.cpp_test_expect(
    (select d.deleted_at is null from public.purchase_documents d where d.id = v_doc)
    and (select b.deleted_at is not null from public.purchase_documents b where b.id = v_doc_b),
    'anular segunda: solo se anula esa factura'
  );
  perform public.cpp_test_expect(
    (select m.quantity = -4000
     from public.inventory_movements m
     join public.location_inventory li on li.id = m.location_inventory_id
     where li.inventory_product_id = v_product
       and m.movement_type = 'sale'),
    'anular segunda: la venta no se reescribe'
  );

  -- Compra, otra compra y una venta que el stock final cubre.
  -- Anular la primera igual se bloquea: el costo de esa venta no está guardado.
  v_product := public.cpp_test_product(v_org, 'fixture cpp venta despues de dos compras');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-05-20') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select t.doc, t.line into v_doc_b, v_line_b
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 140000, date '2026-05-21') t;
  perform public.senda_receive_purchase_document_line(v_doc_b, v_line_b, 10000, gen_random_uuid(), v_actor);
  select s.li into v_li from public.cpp_test_state(v_product) s;
  perform *
  from public.register_sale_consumption(v_li, -4000, 'senda_test', 'cpp-sale-after-both');
  begin
    perform public.senda_delete_purchase_invoice(jsonb_build_object(
      'actor_user_id', v_actor,
      'purchase_document_id', v_doc
    ));
    raise exception 'CPP_TEST_FAILED: la venta posterior debía bloquear aunque el saldo alcance';
  exception
    when others then
      if sqlerrm not like '%REVERSAL_DEPENDENT_MOVEMENTS%' then
        raise;
      end if;
  end;
  select s.qty, s.avg into v_qty, v_avg from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 16000, 'venta posterior: stock quieto');
  perform public.cpp_test_expect(v_avg = 13, 'venta posterior: CPP quieto');
  perform public.cpp_test_expect(
    (select d.deleted_at is null from public.purchase_documents d where d.id = v_doc)
    and (select b.deleted_at is null from public.purchase_documents b where b.id = v_doc_b),
    'venta posterior: las facturas siguen activas'
  );
  perform public.cpp_test_expect(
    (select count(*) = 3
     from public.inventory_movements m
     join public.location_inventory li on li.id = m.location_inventory_id
     where li.inventory_product_id = v_product)
    and (select count(*) = 0
         from public.inventory_cost_history h
         join public.location_inventory li on li.id = h.location_inventory_id
         where li.inventory_product_id = v_product
           and h.source = 'invoice_reversal'),
    'venta posterior: movimientos intactos y sin reverso'
  );

  -- Otra compra posterior, sin consumo: se puede anular la primera.
  -- El pool queda al precio de la segunda.
  v_product := public.cpp_test_product(v_org, 'fixture cpp anulacion con compra posterior');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-06-01') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select t.doc, t.line into v_doc_b, v_line_b
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 140000, date '2026-06-02') t;
  perform public.senda_receive_purchase_document_line(v_doc_b, v_line_b, 10000, gen_random_uuid(), v_actor);
  perform public.senda_delete_purchase_invoice(jsonb_build_object(
    'actor_user_id', v_actor,
    'purchase_document_id', v_doc
  ));
  select s.qty, s.avg, s.last_cost into v_qty, v_avg, v_last
  from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 10000, 'anulacion posterior: queda la segunda compra');
  perform public.cpp_test_expect(v_avg = 14, 'anulacion posterior: CPP de la segunda');
  perform public.cpp_test_expect(v_last = 14, 'anulacion posterior: último precio');
  perform public.cpp_test_expect(
    (select d.deleted_at is not null from public.purchase_documents d where d.id = v_doc)
    and (select b.deleted_at is null from public.purchase_documents b where b.id = v_doc_b),
    'anulacion posterior: solo se anula la primera'
  );

  -- Historial viejo, sin stock anterior: no se estima la reversión.
  v_product := public.cpp_test_product(v_org, 'fixture cpp historial incompleto');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-07-01') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  update public.inventory_cost_history h
     set quantity_on_hand_before = null
   where h.location_inventory_id = (
     select li.id from public.location_inventory li
     where li.inventory_product_id = v_product
   );
  begin
    perform public.senda_delete_purchase_invoice(jsonb_build_object(
      'actor_user_id', v_actor,
      'purchase_document_id', v_doc
    ));
    raise exception 'CPP_TEST_FAILED: historial incompleto debía bloquear';
  exception
    when others then
      if sqlerrm not like '%REVERSAL_COST_HISTORY_INCOMPLETE%' then
        raise;
      end if;
  end;
  select s.qty into v_qty from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 10000, 'historial incompleto: stock quieto');
  perform public.cpp_test_expect(
    (select d.deleted_at is null from public.purchase_documents d where d.id = v_doc),
    'historial incompleto: documento quieto'
  );

  -- Stock y libro desincronizados.
  v_product := public.cpp_test_product(v_org, 'fixture cpp libro desincronizado');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-07-02') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  update public.inventory_valuations iv
     set quantity_on_hand = iv.quantity_on_hand + 5
   where iv.location_inventory_id = (
     select li.id from public.location_inventory li
     where li.inventory_product_id = v_product
   );
  begin
    perform public.senda_delete_purchase_invoice(jsonb_build_object(
      'actor_user_id', v_actor,
      'purchase_document_id', v_doc
    ));
    raise exception 'CPP_TEST_FAILED: libro desincronizado debía bloquear';
  exception
    when others then
      if sqlerrm not like '%REVERSAL_LEDGER_MISMATCH%' then
        raise;
      end if;
  end;
  perform public.cpp_test_expect(
    (select d.deleted_at is null from public.purchase_documents d where d.id = v_doc),
    'libro desincronizado: documento quieto'
  );

  -- Costo manual con stock y promedio: no escribe.
  v_product := public.cpp_test_product(v_org, 'fixture cpp manual');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-08-01') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select count(*) into v_count
  from public.inventory_cost_history h
  join public.location_inventory li on li.id = h.location_inventory_id
  where li.inventory_product_id = v_product;
  begin
    perform public.senda_set_inventory_purchase_cost(jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_org,
      'location_id', v_location,
      'inventory_product_id', v_product,
      'purchase_quantity', 1,
      'purchase_cost', 99,
      'source', 'manual'
    ));
    raise exception 'CPP_TEST_FAILED: el costo manual debía rechazarse';
  exception
    when others then
      if sqlerrm not like '%MANUAL_COST_WITH_ON_HAND%' then
        raise;
      end if;
  end;
  select s.avg into v_avg from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_avg = 12, 'manual: CPP quieto');
  perform public.cpp_test_expect(
    (select count(*) = v_count
     from public.inventory_cost_history h
     join public.location_inventory li on li.id = h.location_inventory_id
     where li.inventory_product_id = v_product),
    'manual: no agrega historial'
  );

  -- Mismo precio: el CPP no cambia y igual queda una fila de historial por entrega.
  v_product := public.cpp_test_product(v_org, 'fixture cpp mismo precio');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10, 100, date '2026-09-10') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10, gen_random_uuid(), v_actor);
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10, 100, date '2026-09-11') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10, gen_random_uuid(), v_actor);
  select s.qty, s.avg into v_qty, v_avg from public.cpp_test_state(v_product) s;
  select count(*) into v_count
  from public.inventory_cost_history h
  join public.location_inventory li on li.id = h.location_inventory_id
  where li.inventory_product_id = v_product
    and h.source = 'invoice';
  perform public.cpp_test_expect(v_qty = 20, 'mismo precio: cantidad');
  perform public.cpp_test_expect(v_avg = 10, 'mismo precio: CPP quieto');
  perform public.cpp_test_expect(v_count = 2, 'mismo precio: historial por entrega');

  -- Una factura con fecha anterior igual entra al promedio.
  -- El último precio sigue siendo el de la compra más nueva.
  v_product := public.cpp_test_product(v_org, 'fixture cpp factura vieja');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 140000, date '2026-10-02') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-10-01') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select s.qty, s.avg, s.last_cost into v_qty, v_avg, v_last
  from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 20000, 'factura vieja: cantidad');
  perform public.cpp_test_expect(v_avg = 13, 'factura vieja: el CPP sí cambia');
  perform public.cpp_test_expect(v_last = 14, 'factura vieja: el último precio no retrocede');

  -- Stock positivo sin CPP: la recepción se bloquea y no inventa un costo.
  v_product := public.cpp_test_product(v_org, 'fixture cpp stock sin costo');
  insert into public.location_inventory (location_id, inventory_product_id, minimum_stock, active)
  values (v_location, v_product, 0, true)
  returning id into v_li;
  insert into public.inventory_valuations (
    location_inventory_id, quantity_on_hand, average_unit_cost, currency, updated_at
  ) values (
    v_li, 1000, null, 'ARS', clock_timestamp()
  );
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 1000, 2000, date '2026-10-03') t;
  begin
    perform public.senda_receive_purchase_document_line(v_doc, v_line, 1000, gen_random_uuid(), v_actor);
    raise exception 'CPP_TEST_FAILED: el stock sin CPP debía bloquear la recepción';
  exception
    when others then
      if sqlerrm not like '%UNVALUED_STOCK%' then
        raise;
      end if;
  end;
  select s.qty, s.avg into v_qty, v_avg from public.cpp_test_state(v_product) s;
  perform public.cpp_test_expect(v_qty = 1000, 'stock sin costo: la cantidad no cambia');
  perform public.cpp_test_expect(v_avg is null, 'stock sin costo: el promedio sigue vacío');
  perform public.cpp_test_expect(
    (select count(*) = 0
     from public.inventory_movements m
     where m.location_inventory_id = v_li)
    and (select count(*) = 0
         from public.purchase_document_receipts pr
         where pr.inventory_product_id = v_product),
    'stock sin costo: no queda recepción ni movimiento'
  );

  -- Apertura posterior: no hay modelo para revaluarla, se bloquea.
  v_product := public.cpp_test_product(v_org, 'fixture cpp apertura');
  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-08-02') t;
  perform public.senda_receive_purchase_document_line(v_doc, v_line, 10000, gen_random_uuid(), v_actor);
  select s.li into v_li from public.cpp_test_state(v_product) s;
  insert into public.inventory_movements (
    location_inventory_id, movement_type, quantity, source_type, source_id, created_at
  ) values (
    v_li, 'opening', 1, 'manual', 'cpp-opening', clock_timestamp() + interval '1 minute'
  );
  update public.inventory_valuations
     set quantity_on_hand = quantity_on_hand + 1
   where location_inventory_id = v_li;
  begin
    perform public.senda_delete_purchase_invoice(jsonb_build_object(
      'actor_user_id', v_actor,
      'purchase_document_id', v_doc
    ));
    raise exception 'CPP_TEST_FAILED: la apertura posterior debía bloquear';
  exception
    when others then
      if sqlerrm not like '%REVERSAL_DEPENDENT_MOVEMENTS%' then
        raise;
      end if;
  end;
end
$cases$;

rollback;

-- CPP_CONCURRENT_START
-- Compras concurrentes. Los documentos se commitean y se borran en esta base descartable.
do $seed$
declare
  v_org uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  v_location uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  v_actor uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  v_product uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
  v_sale_product uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
  v_doc uuid;
  v_line uuid;
begin
  insert into public.organizations (id) values (v_org);
  insert into public.locations (id, organization_id) values (v_location, v_org);
  insert into public.inventory_products (id, organization_id, name, active)
  values
    (v_product, v_org, 'fixture cpp concurrente compras', true),
    (v_sale_product, v_org, 'fixture cpp concurrente venta', true);
  insert into public.location_inventory (id, location_id, inventory_product_id, minimum_stock, active)
  values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6', v_location, v_product, 0, true),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', v_location, v_sale_product, 0, true);

  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 120000, date '2026-09-01') t;
  create temp table cpp_conc_docs (
    kind text primary key,
    doc uuid,
    line uuid,
    product uuid,
    li uuid
  );
  insert into cpp_conc_docs values ('buy-a', v_doc, v_line, v_product, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6');

  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_product, 10000, 140000, date '2026-09-02') t;
  insert into cpp_conc_docs values ('buy-b', v_doc, v_line, v_product, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6');

  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_sale_product, 10000, 120000, date '2026-09-03') t;
  perform public.senda_receive_purchase_document_line(
    v_doc, v_line, 10000, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8', v_actor
  );
  insert into cpp_conc_docs values ('sale-base', v_doc, v_line, v_sale_product, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7');

  select t.doc, t.line into v_doc, v_line
  from public.cpp_test_open(v_org, v_location, v_sale_product, 10000, 140000, date '2026-09-04') t;
  insert into cpp_conc_docs values ('sale-buy', v_doc, v_line, v_sale_product, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7');
end
$seed$;

select dblink_connect('s2', 'dbname=senda_cpp_test user=postgres');

do $race_buy$
declare
  v_actor uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  v_doc uuid;
  v_line uuid;
  v_other uuid;
  v_other_line uuid;
  v_li uuid;
  v_sql text;
  v_seen boolean := false;
  i integer;
begin
  select doc, line, li into v_doc, v_line, v_li from cpp_conc_docs where kind = 'buy-a';
  select doc, line into v_other, v_other_line from cpp_conc_docs where kind = 'buy-b';
  perform 1 from public.location_inventory where id = v_li for update;

  v_sql := format(
    'select public.senda_receive_purchase_document_line(%L, %L, 10000, %L, %L) /* CPP-CONC-B */',
    v_other, v_other_line, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9', v_actor
  );
  perform dblink_send_query('s2', v_sql);
  for i in 1..30 loop
    if exists (
      select 1 from pg_stat_activity
      where pid <> pg_backend_pid()
        and query like '%CPP-CONC-B%'
    ) then
      v_seen := true;
      exit;
    end if;
    perform pg_sleep(0.1);
  end loop;
  if not v_seen then
    raise exception 'CPP_TEST_FAILED: la compra concurrente no arrancó';
  end if;

  perform public.senda_receive_purchase_document_line(
    v_doc, v_line, 10000, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1', v_actor
  );
end
$race_buy$;

select * from dblink_get_result('s2') as x(result jsonb);
select dblink_disconnect('s2');

do $check_buy$
declare
  v_qty numeric;
  v_avg numeric;
begin
  select s.qty, s.avg into v_qty, v_avg
  from public.cpp_test_state('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4') s;
  perform public.cpp_test_expect(v_qty = 20000, 'concurrente compras: cantidad');
  perform public.cpp_test_expect(v_avg = 13, 'concurrente compras: CPP 13');
end
$check_buy$;

select dblink_connect('s3', 'dbname=senda_cpp_test user=postgres');

begin;

do $race_sale$
declare
  v_actor uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  v_doc uuid;
  v_line uuid;
  v_li uuid;
  v_sql text;
  v_seen boolean := false;
  i integer;
begin
  select doc, line, li into v_doc, v_line, v_li from cpp_conc_docs where kind = 'sale-buy';
  perform 1 from public.location_inventory where id = v_li for update;
  v_sql := format(
    'select public.senda_receive_purchase_document_line(%L, %L, 10000, %L, %L) /* CPP-CONC-SALE */',
    v_doc, v_line, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2', v_actor
  );
  perform dblink_send_query('s3', v_sql);
  for i in 1..30 loop
    if exists (
      select 1 from pg_stat_activity
      where pid <> pg_backend_pid()
        and query like '%CPP-CONC-SALE%'
    ) then
      v_seen := true;
      exit;
    end if;
    perform pg_sleep(0.1);
  end loop;
  if not v_seen then
    raise exception 'CPP_TEST_FAILED: la compra concurrente con la venta no arrancó';
  end if;
  perform *
  from public.register_sale_consumption(v_li, -4000, 'senda_test', 'cpp-sale-race');
end
$race_sale$;

commit;

select * from dblink_get_result('s3') as x(result jsonb);
select dblink_disconnect('s3');

do $check_sale$
declare
  v_qty numeric;
  v_avg numeric;
begin
  select s.qty, s.avg into v_qty, v_avg
  from public.cpp_test_state('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5') s;
  perform public.cpp_test_expect(v_qty = 16000, 'concurrente venta: cantidad');
  perform public.cpp_test_expect(v_avg = 13.25, 'concurrente venta: CPP 13.25');
end
$check_sale$;

-- Limpieza de la sección concurrente. La base se destruye igual.
delete from public.inventory_cost_history
where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from public.inventory_adjustments
where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from public.inventory_movements m
using public.location_inventory li
where m.location_inventory_id = li.id
  and li.location_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
delete from public.inventory_valuations iv
using public.location_inventory li
where iv.location_inventory_id = li.id
  and li.location_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
delete from public.purchase_document_audit a
using public.purchase_documents d
where a.purchase_document_id = d.id
  and d.organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from public.purchase_invoice_deletion_log
where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from public.purchase_document_receipts
where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from public.purchase_document_lines l
using public.purchase_documents d
where l.purchase_document_id = d.id
  and d.organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from public.purchase_documents
where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from public.location_inventory
where location_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
delete from public.inventory_products
where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from public.locations
where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from public.organizations
where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

drop function public.cpp_test_expect(boolean, text);
drop function public.cpp_test_state(uuid);
drop function public.cpp_test_open(uuid, uuid, uuid, numeric, numeric, date);
drop function public.cpp_test_product(uuid, text);

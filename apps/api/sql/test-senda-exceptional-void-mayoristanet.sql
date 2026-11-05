-- =============================================================================
-- Pruebas de seguridad del void excepcional MAYORISTANET — senda_cpp_test
-- NO EJECUTAR en SENDA / producción.
--
-- Prerrequisitos:
--   1) test-senda-cpp-fixture.sql
--   2) proposed-senda-cpp.sql
--   3) proposed-senda-adjust-inventory-quantity.sql (si el fixture no alcanza)
--   4) proposed-senda-exceptional-void-mayoristanet-ef01f3a8.sql
--
-- Casos:
--   A) happy path + dry_run sin escrituras + confirm + rollback íntegro
--   B) recepción inesperada / cantidad distinta → fingerprint abort
--   C) movimiento posterior no allowlisted → abort
--   D) allowlisted con cantidad distinta → abort
--   E) duplicado de audit log → EXCEPTIONAL_AUDIT_CONFLICT
--   F) ejecución repetida tras éxito → replay (documento ya deleted)
--   G) confirm sin token → CONFIRM_REQUIRED
-- =============================================================================

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
  perform set_config('senda.cpp_test', 'on', true);
end
$guard$;

create or replace function public.cpp_test_mayoristanet_seed(
  p_org uuid,
  p_location uuid,
  p_actor uuid
) returns jsonb
language plpgsql
as $$
declare
  v_arroz uuid;
  v_aros uuid;
  v_clean uuid;
  v_doc uuid := gen_random_uuid();
  v_line uuid;
  v_receipt_arroz uuid;
  v_receipt_aros uuid;
  v_receipt_clean uuid;
  v_mov_arroz uuid;
  v_mov_aros_plus uuid;
  v_mov_aros_minus uuid;
  v_result jsonb;
  v_expected_receipts jsonb;
  v_expected_later jsonb;
begin
  v_arroz := public.cpp_test_product(p_org, 'test arroz excepcional harden');
  v_aros := public.cpp_test_product(p_org, 'test aros excepcional harden');
  v_clean := public.cpp_test_product(p_org, 'test limpio excepcional harden');

  insert into public.purchase_documents (
    id, location_id, organization_id, status, currency, document_date,
    issuer_name, document_number
  ) values (
    v_doc, p_location, p_org, 'reviewed', 'ARS', date '2026-07-15',
    'MAYORISTANET.COM S.A.', '0012-00611278-TEST'
  );

  insert into public.purchase_document_lines (
    id, purchase_document_id, inventory_eligibility, mapping_status, classification,
    quantity_kind, reviewed_amount, original_amount, inventory_product_id,
    inventory_physical_quantity
  ) values
    (gen_random_uuid(), v_doc, 'eligible', 'mapped', 'ingredient',
     'unit', 7115.64, 7115.64, v_arroz, 5000),
    (gen_random_uuid(), v_doc, 'eligible', 'mapped', 'ingredient',
     'unit', 104444.96, 104444.96, v_aros, 10000),
    (gen_random_uuid(), v_doc, 'eligible', 'mapped', 'ingredient',
     'unit', 11971.06, 11971.06, v_clean, 10000);

  select l.id into v_line from public.purchase_document_lines l
  where l.purchase_document_id = v_doc and l.inventory_product_id = v_arroz;
  perform public.senda_receive_purchase_document_line(
    v_doc, v_line, 5000, gen_random_uuid(), p_actor);

  select l.id into v_line from public.purchase_document_lines l
  where l.purchase_document_id = v_doc and l.inventory_product_id = v_aros;
  perform public.senda_receive_purchase_document_line(
    v_doc, v_line, 10000, gen_random_uuid(), p_actor);

  select l.id into v_line from public.purchase_document_lines l
  where l.purchase_document_id = v_doc and l.inventory_product_id = v_clean;
  perform public.senda_receive_purchase_document_line(
    v_doc, v_line, 10000, gen_random_uuid(), p_actor);

  update public.purchase_documents set status = 'received' where id = v_doc;

  select r.id into v_receipt_arroz from public.purchase_document_receipts r
  where r.purchase_document_id = v_doc and r.inventory_product_id = v_arroz;
  select r.id into v_receipt_aros from public.purchase_document_receipts r
  where r.purchase_document_id = v_doc and r.inventory_product_id = v_aros;
  select r.id into v_receipt_clean from public.purchase_document_receipts r
  where r.purchase_document_id = v_doc and r.inventory_product_id = v_clean;

  update public.inventory_cost_history h
     set quantity_on_hand_before = null,
         average_unit_cost_before = null
   where h.source = 'invoice'
     and h.source_ref in (v_receipt_arroz, v_receipt_aros, v_receipt_clean);

  v_result := public.senda_adjust_inventory_quantity(jsonb_build_object(
    'actor_user_id', p_actor, 'organization_id', p_org, 'location_id', p_location,
    'inventory_product_id', v_arroz, 'idempotency_key', gen_random_uuid(),
    'quantity', 1000, 'reason', 'merma'
  ));
  v_mov_arroz := (v_result->>'inventory_movement_id')::uuid;

  v_result := public.senda_adjust_inventory_quantity(jsonb_build_object(
    'actor_user_id', p_actor, 'organization_id', p_org, 'location_id', p_location,
    'inventory_product_id', v_aros, 'idempotency_key', gen_random_uuid(),
    'quantity', 1000, 'reason', 'perdida'
  ));
  v_mov_aros_plus := (v_result->>'inventory_movement_id')::uuid;

  v_result := public.senda_adjust_inventory_quantity(jsonb_build_object(
    'actor_user_id', p_actor, 'organization_id', p_org, 'location_id', p_location,
    'inventory_product_id', v_aros, 'idempotency_key', gen_random_uuid(),
    'quantity', -1000, 'reason', 'perdida'
  ));
  v_mov_aros_minus := (v_result->>'inventory_movement_id')::uuid;

  select coalesce(jsonb_agg(jsonb_build_object(
    'receipt_id', r.id,
    'inventory_product_id', r.inventory_product_id,
    'quantity', r.quantity
  ) order by r.created_at, r.id), '[]'::jsonb)
    into v_expected_receipts
  from public.purchase_document_receipts r
  where r.purchase_document_id = v_doc;

  v_expected_later := jsonb_build_array(
    jsonb_build_object(
      'id', v_mov_arroz, 'movement_type', 'adjustment',
      'quantity', 1000, 'inventory_product_id', v_arroz
    ),
    jsonb_build_object(
      'id', v_mov_aros_plus, 'movement_type', 'adjustment',
      'quantity', 1000, 'inventory_product_id', v_aros
    ),
    jsonb_build_object(
      'id', v_mov_aros_minus, 'movement_type', 'adjustment',
      'quantity', -1000, 'inventory_product_id', v_aros
    )
  );

  return jsonb_build_object(
    'document_id', v_doc,
    'arroz_product_id', v_arroz,
    'aros_product_id', v_aros,
    'clean_product_id', v_clean,
    'receipt_arroz', v_receipt_arroz,
    'receipt_aros', v_receipt_aros,
    'receipt_clean', v_receipt_clean,
    'mov_arroz', v_mov_arroz,
    'mov_aros_plus', v_mov_aros_plus,
    'mov_aros_minus', v_mov_aros_minus,
    'expected_receipts', v_expected_receipts,
    'expected_later_movements', v_expected_later
  );
end;
$$;

begin;

do $cases$
declare
  v_org uuid := '11111111-1111-4111-8111-111111111111';
  v_location uuid := '22222222-2222-4222-8222-222222222222';
  v_actor uuid := '33333333-3333-4333-8333-333333333333';
  v_seed jsonb;
  v_payload jsonb;
  v_result jsonb;
  v_err text;
  v_deleted timestamptz;
  v_qty numeric;
  v_count integer;
  v_moves_before integer;
  v_adj_before integer;
  v_cost_before integer;
  v_doc uuid;
  v_arroz uuid;
  v_extra_receipt uuid := gen_random_uuid();
begin
  insert into public.organizations (id) values (v_org) on conflict do nothing;
  insert into public.locations (id, organization_id) values (v_location, v_org)
  on conflict do nothing;

  -- =========================================================================
  -- A) dry_run sin escrituras + confirm happy path
  -- =========================================================================
  v_seed := public.cpp_test_mayoristanet_seed(v_org, v_location, v_actor);
  v_doc := (v_seed->>'document_id')::uuid;
  v_arroz := (v_seed->>'arroz_product_id')::uuid;

  select count(*) into v_moves_before from public.inventory_movements;
  select count(*) into v_adj_before from public.inventory_adjustments;
  select count(*) into v_cost_before from public.inventory_cost_history;

  v_payload := jsonb_build_object(
    'actor_user_id', v_actor,
    'dry_run', true,
    'document_id', v_doc,
    'arroz_product_id', v_arroz,
    'expected_receipts', v_seed->'expected_receipts',
    'expected_later_movements', v_seed->'expected_later_movements'
  );
  v_result := public.senda_exceptional_void_mayoristanet_ef01f3a8(v_payload);
  perform public.cpp_test_expect(
    coalesce((v_result->>'dry_run')::boolean, false)
    and coalesce((v_result->>'writes')::boolean, true) is false,
    'A: dry_run writes=false'
  );
  select deleted_at into v_deleted from public.purchase_documents where id = v_doc;
  perform public.cpp_test_expect(v_deleted is null, 'A: dry_run no soft-delete');
  select count(*) into v_count from public.inventory_movements;
  perform public.cpp_test_expect(v_count = v_moves_before, 'A: dry_run no movimientos nuevos');
  select count(*) into v_count from public.inventory_adjustments;
  perform public.cpp_test_expect(v_count = v_adj_before, 'A: dry_run no adjustments nuevos');
  select count(*) into v_count from public.inventory_cost_history;
  perform public.cpp_test_expect(v_count = v_cost_before, 'A: dry_run no cost history nuevo');
  select count(*) into v_count from public.purchase_invoice_deletion_log
  where purchase_document_id = v_doc;
  perform public.cpp_test_expect(v_count = 0, 'A: dry_run sin deletion_log');

  v_result := public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb_build_object(
    'actor_user_id', v_actor,
    'confirm', 'VOID_MAYORISTANET_0012-00611278',
    'document_id', v_doc,
    'arroz_product_id', v_arroz,
    'expected_receipts', v_seed->'expected_receipts',
    'expected_later_movements', v_seed->'expected_later_movements'
  ));
  perform public.cpp_test_expect(
    coalesce((v_result->>'exceptional')::boolean, false),
    'A: confirm exceptional'
  );
  select deleted_at into v_deleted from public.purchase_documents where id = v_doc;
  perform public.cpp_test_expect(v_deleted is not null, 'A: soft-deleted');
  select s.qty into v_qty from public.cpp_test_state(v_arroz) s;
  perform public.cpp_test_expect(v_qty = 0, 'A: arroz 0');
  select s.qty into v_qty
  from public.cpp_test_state((v_seed->>'aros_product_id')::uuid) s;
  perform public.cpp_test_expect(v_qty = 0, 'A: aros 0');
  select s.qty into v_qty
  from public.cpp_test_state((v_seed->>'clean_product_id')::uuid) s;
  perform public.cpp_test_expect(v_qty = 0, 'A: limpio 0');

  -- F) replay tras éxito
  v_result := public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb_build_object(
    'actor_user_id', v_actor,
    'confirm', 'VOID_MAYORISTANET_0012-00611278',
    'document_id', v_doc,
    'arroz_product_id', v_arroz,
    'expected_receipts', v_seed->'expected_receipts',
    'expected_later_movements', v_seed->'expected_later_movements'
  ));
  perform public.cpp_test_expect(
    coalesce((v_result->>'replay')::boolean, false),
    'F: replay tras deleted_at'
  );

  -- =========================================================================
  -- G) confirm requerido
  -- =========================================================================
  v_seed := public.cpp_test_mayoristanet_seed(v_org, v_location, v_actor);
  begin
    perform public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb_build_object(
      'actor_user_id', v_actor,
      'document_id', v_seed->>'document_id',
      'arroz_product_id', v_seed->>'arroz_product_id',
      'expected_receipts', v_seed->'expected_receipts',
      'expected_later_movements', v_seed->'expected_later_movements'
    ));
    perform public.cpp_test_expect(false, 'G: debió exigir confirm');
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      perform public.cpp_test_expect(v_err ilike '%CONFIRM_REQUIRED%', 'G: CONFIRM_REQUIRED');
  end;

  -- =========================================================================
  -- B) recepción con cantidad distinta → fingerprint abort; rollback íntegro
  -- =========================================================================
  v_seed := public.cpp_test_mayoristanet_seed(v_org, v_location, v_actor);
  v_doc := (v_seed->>'document_id')::uuid;
  select count(*) into v_moves_before from public.inventory_movements;
  select s.qty into v_qty
  from public.cpp_test_state((v_seed->>'arroz_product_id')::uuid) s;

  -- Mutar fingerprint esperado (qty arroz 4999 en vez de 5000)
  v_payload := jsonb_build_object(
    'actor_user_id', v_actor,
    'confirm', 'VOID_MAYORISTANET_0012-00611278',
    'document_id', v_doc,
    'arroz_product_id', v_seed->>'arroz_product_id',
    'expected_receipts', (
      select jsonb_agg(
        case
          when (e->>'receipt_id') = (v_seed->>'receipt_arroz')
            then jsonb_set(e, '{quantity}', '4999'::jsonb)
          else e
        end
      )
      from jsonb_array_elements(v_seed->'expected_receipts') e
    ),
    'expected_later_movements', v_seed->'expected_later_movements'
  );
  begin
    perform public.senda_exceptional_void_mayoristanet_ef01f3a8(v_payload);
    perform public.cpp_test_expect(false, 'B: debió abortar fingerprint');
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      perform public.cpp_test_expect(
        v_err ilike '%EXCEPTIONAL_RECEIPT_FINGERPRINT%',
        'B: RECEIPT_FINGERPRINT'
      );
  end;
  select deleted_at into v_deleted from public.purchase_documents where id = v_doc;
  perform public.cpp_test_expect(v_deleted is null, 'B: rollback sin soft-delete');
  select count(*) into v_count from public.inventory_movements;
  perform public.cpp_test_expect(v_count = v_moves_before, 'B: rollback sin movimientos nuevos');
  select s.qty into v_count
  from public.cpp_test_state((v_seed->>'arroz_product_id')::uuid) s;
  perform public.cpp_test_expect(v_count = v_qty, 'B: stock arroz intacto');

  -- =========================================================================
  -- B2) recepción extra inesperada
  -- =========================================================================
  v_seed := public.cpp_test_mayoristanet_seed(v_org, v_location, v_actor);
  v_doc := (v_seed->>'document_id')::uuid;
  insert into public.purchase_document_receipts (
    id, purchase_document_id, purchase_document_line_id, organization_id,
    location_id, inventory_product_id, quantity, idempotency_key, actor_user_id
  )
  select
    v_extra_receipt, v_doc, l.id, v_org, v_location,
    (v_seed->>'clean_product_id')::uuid, 1, gen_random_uuid(), v_actor
  from public.purchase_document_lines l
  where l.purchase_document_id = v_doc
    and l.inventory_product_id = (v_seed->>'clean_product_id')::uuid
  limit 1;

  begin
    perform public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb_build_object(
      'actor_user_id', v_actor,
      'confirm', 'VOID_MAYORISTANET_0012-00611278',
      'document_id', v_doc,
      'arroz_product_id', v_seed->>'arroz_product_id',
      'expected_receipts', v_seed->'expected_receipts',
      'expected_later_movements', v_seed->'expected_later_movements'
    ));
    perform public.cpp_test_expect(false, 'B2: debió abortar recepción extra');
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      perform public.cpp_test_expect(
        v_err ilike '%EXCEPTIONAL_RECEIPT_FINGERPRINT%',
        'B2: fingerprint por recepción extra'
      );
  end;

  -- =========================================================================
  -- C) movimiento posterior inesperado
  -- =========================================================================
  v_seed := public.cpp_test_mayoristanet_seed(v_org, v_location, v_actor);
  v_doc := (v_seed->>'document_id')::uuid;
  perform public.senda_adjust_inventory_quantity(jsonb_build_object(
    'actor_user_id', v_actor, 'organization_id', v_org, 'location_id', v_location,
    'inventory_product_id', v_seed->>'clean_product_id',
    'idempotency_key', gen_random_uuid(),
    'quantity', -1, 'reason', 'ajuste inesperado test'
  ));
  begin
    perform public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb_build_object(
      'actor_user_id', v_actor,
      'confirm', 'VOID_MAYORISTANET_0012-00611278',
      'document_id', v_doc,
      'arroz_product_id', v_seed->>'arroz_product_id',
      'expected_receipts', v_seed->'expected_receipts',
      'expected_later_movements', v_seed->'expected_later_movements'
    ));
    perform public.cpp_test_expect(false, 'C: debió abortar dependiente');
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      perform public.cpp_test_expect(
        v_err ilike '%EXCEPTIONAL_UNEXPECTED_DEPENDENT%',
        'C: UNEXPECTED_DEPENDENT'
      );
  end;
  select deleted_at into v_deleted from public.purchase_documents where id = v_doc;
  perform public.cpp_test_expect(v_deleted is null, 'C: sin soft-delete');

  -- =========================================================================
  -- D) allowlisted con cantidad distinta en fingerprint
  -- =========================================================================
  v_seed := public.cpp_test_mayoristanet_seed(v_org, v_location, v_actor);
  v_doc := (v_seed->>'document_id')::uuid;
  v_payload := jsonb_build_object(
    'actor_user_id', v_actor,
    'confirm', 'VOID_MAYORISTANET_0012-00611278',
    'document_id', v_doc,
    'arroz_product_id', v_seed->>'arroz_product_id',
    'expected_receipts', v_seed->'expected_receipts',
    'expected_later_movements', (
      select jsonb_agg(
        case
          when (e->>'id') = (v_seed->>'mov_arroz')
            then jsonb_set(e, '{quantity}', '999'::jsonb)
          else e
        end
      )
      from jsonb_array_elements(v_seed->'expected_later_movements') e
    )
  );
  begin
    perform public.senda_exceptional_void_mayoristanet_ef01f3a8(v_payload);
    perform public.cpp_test_expect(false, 'D: debió abortar later fingerprint');
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      perform public.cpp_test_expect(
        v_err ilike '%EXCEPTIONAL_LATER_FINGERPRINT%',
        'D: LATER_FINGERPRINT'
      );
  end;

  -- =========================================================================
  -- E) audit log duplicado → CONFLICT (abort, no DO NOTHING)
  -- =========================================================================
  v_seed := public.cpp_test_mayoristanet_seed(v_org, v_location, v_actor);
  v_doc := (v_seed->>'document_id')::uuid;
  insert into public.purchase_invoice_deletion_log (
    purchase_document_id, organization_id, location_id, actor_user_id,
    previous_status, issuer_name, document_number, document_date,
    reversed_receipts, reversed_movements, cost_rollbacks, deleted_at
  ) values (
    v_doc, v_org, v_location, v_actor,
    'received', 'MAYORISTANET.COM S.A.', '0012-00611278-TEST', date '2026-07-15',
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now()
  );
  begin
    perform public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb_build_object(
      'actor_user_id', v_actor,
      'confirm', 'VOID_MAYORISTANET_0012-00611278',
      'document_id', v_doc,
      'arroz_product_id', v_seed->>'arroz_product_id',
      'expected_receipts', v_seed->'expected_receipts',
      'expected_later_movements', v_seed->'expected_later_movements'
    ));
    perform public.cpp_test_expect(false, 'E: debió abortar audit conflict');
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      perform public.cpp_test_expect(
        v_err ilike '%EXCEPTIONAL_AUDIT_CONFLICT%',
        'E: AUDIT_CONFLICT'
      );
  end;
  -- El documento NO debe quedar soft-deleted por el intento fallido
  select deleted_at into v_deleted from public.purchase_documents where id = v_doc;
  perform public.cpp_test_expect(v_deleted is null, 'E: rollback íntegro tras audit conflict');

  raise notice 'OK exceptional void mayoristanet security suite';
end
$cases$;

rollback;

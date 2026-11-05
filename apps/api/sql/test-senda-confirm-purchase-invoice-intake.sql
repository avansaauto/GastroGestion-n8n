-- SENDA OPS — Pruebas funcionales de confirmación atómica
-- Requiere: proposed-senda-confirm-purchase-invoice-intake.sql y
-- proposed-senda-confirm-intake-unit-parity.sql aplicadas.
-- NO EJECUTAR en producción. NO se corre automáticamente.
-- Todo corre en una transacción que termina en ROLLBACK.
--
-- Fixtures: no inventa UUID. Descubre filas reales (documento reviewed con
-- ≥2 líneas inventariables unmapped + producto activo con base_unit coherente
-- con la unidad de la línea A + actor miembro). Opcionalmente fijá un documento
-- real en v_pin_document_id. Si no hay candidatas → CONFIRM_INTAKE_TEST_SKIP.

begin;

-- =============================================================================
-- Conversiones (espejo RPC). Ejecutable por superuser/owner tras instalar.
-- =============================================================================
do $conv$
declare
  v_factor numeric;
begin
  if to_regprocedure('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)') is null then
    raise notice 'CONFIRM_INTAKE_TEST_CONV_SKIP: assert_physical no instalado';
    return;
  end if;

  -- 7,22 kg → 7.220 g
  v_factor := public.senda_confirm_intake_assert_physical('kg', 'g', 7.22, null, 7220);
  if v_factor is distinct from 1000 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: kg→g factor=%', v_factor;
  end if;

  -- 2 latas × 8 kg → 16.000 g
  v_factor := public.senda_confirm_intake_assert_physical('lata', 'g', 2, 8000, 16000);
  if v_factor is distinct from 8000 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: lata factor=%', v_factor;
  end if;

  -- 1 pack de 10 bolsas × 1 kg → 10.000 g
  v_factor := public.senda_confirm_intake_assert_physical('pack', 'g', 1, 10000, 10000);
  if v_factor is distinct from 10000 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: pack factor=%', v_factor;
  end if;

  -- 1 bolsa de 5 kg → 5.000 g
  v_factor := public.senda_confirm_intake_assert_physical('bolsa', 'g', 1, 5000, 5000);
  if v_factor is distinct from 5000 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: bolsa factor=%', v_factor;
  end if;

  -- La Paulina: 2 barras × 3500 g = 7.000 g
  v_factor := public.senda_confirm_intake_assert_physical('barra', 'g', 2, 3500, 7000);
  if v_factor is distinct from 3500 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: barra factor=%', v_factor;
  end if;

  -- Doña Aurora: 1 plancha × 8880 g = 8.880 g
  v_factor := public.senda_confirm_intake_assert_physical('plancha', 'g', 1, 8880, 8880);
  if v_factor is distinct from 8880 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: plancha factor=%', v_factor;
  end if;

  -- Azúcar: 1 pack × 10000 g
  v_factor := public.senda_confirm_intake_assert_physical('pack', 'g', 1, 10000, 10000);
  if v_factor is distinct from 10000 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: azúcar factor=%', v_factor;
  end if;

  -- Leche: 1 pack × 12000 ml
  v_factor := public.senda_confirm_intake_assert_physical('pack', 'ml', 1, 12000, 12000);
  if v_factor is distinct from 12000 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: leche factor=%', v_factor;
  end if;

  -- Pan rallado: 2 bolsas × 5000 g = 10.000 g
  v_factor := public.senda_confirm_intake_assert_physical('bolsa', 'g', 2, 5000, 10000);
  if v_factor is distinct from 5000 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: pan factor=%', v_factor;
  end if;

  -- Pimienta: 1 bolsa × 1000 g
  v_factor := public.senda_confirm_intake_assert_physical('bolsa', 'g', 1, 1000, 1000);
  if v_factor is distinct from 1000 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: pimienta factor=%', v_factor;
  end if;

  -- kg → g exige el factor SI, no un factor de empaque
  begin
    perform public.senda_confirm_intake_assert_physical('kg', 'g', 2, 3500, 7000);
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: kg_to_g_accepted_wrong_factor';
  exception
    when others then
      if sqlerrm ilike '%CONFIRM_INTAKE_TEST_FAIL%' then
        raise;
      end if;
      if sqlerrm not ilike '%INVALID_CONVERSION%' then
        raise exception 'CONFIRM_INTAKE_TEST_FAIL: kg→g factor ajeno: %', sqlerrm;
      end if;
  end;

  -- Unidad desconocida
  begin
    perform public.senda_confirm_intake_assert_physical('xyz', 'g', 1, 1, 1);
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: unknown_unit_accepted';
  exception
    when others then
      if sqlerrm ilike '%CONFIRM_INTAKE_TEST_FAIL%' then
        raise;
      end if;
      if sqlerrm not ilike '%INCOMPATIBLE_UNITS%' then
        raise exception 'CONFIRM_INTAKE_TEST_FAIL: unidad desconocida: %', sqlerrm;
      end if;
  end;

  -- Empaque sin factor debe fallar
  begin
    perform public.senda_confirm_intake_assert_physical('barra', 'g', 2, null, 7000);
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: barra_without_factor_accepted';
  exception
    when others then
      if sqlerrm ilike '%CONFIRM_INTAKE_TEST_FAIL%' then
        raise;
      end if;
      if sqlerrm not ilike '%EQUIVALENCE_REQUIRED%' then
        raise exception 'CONFIRM_INTAKE_TEST_FAIL: barra sin factor: %', sqlerrm;
      end if;
  end;

  -- Empaque sin factor debe fallar
  begin
    perform public.senda_confirm_intake_assert_physical('lata', 'g', 2, null, 16000);
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: se esperaba EQUIVALENCE_REQUIRED';
  exception
    when others then
      if sqlerrm not ilike '%EQUIVALENCE_REQUIRED%' then
        raise exception 'CONFIRM_INTAKE_TEST_FAIL: empaque sin factor: %', sqlerrm;
      end if;
  end;

  raise notice 'CONFIRM_INTAKE_TEST_CONV_OK';
end
$conv$;

-- =============================================================================
-- Concurrencia (verificación técnica): el helper toma advisory lock por org+norm
-- antes de rechequear duplicados. Dos sesiones con el mismo nombre se serializan;
-- la segunda ve DUPLICATE_PRODUCT tras el commit de la primera.
-- =============================================================================
do $concurrency$
declare
  v_body text;
  v_lock_at int;
  v_dup_at int;
begin
  if to_regprocedure('public.senda_ensure_inventory_product_for_intake(jsonb)') is null then
    raise notice 'CONFIRM_INTAKE_TEST_CONCURRENCY_SKIP: ensure no instalado';
    return;
  end if;

  v_body := pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure);
  v_lock_at := strpos(lower(v_body), 'pg_advisory_xact_lock');
  v_dup_at := strpos(lower(v_body), 'duplicate_product');
  if v_lock_at = 0 then
    raise exception 'CONFIRM_INTAKE_TEST_CONCURRENCY_FAIL: falta pg_advisory_xact_lock';
  end if;
  if v_dup_at = 0 or v_lock_at >= v_dup_at then
    raise exception 'CONFIRM_INTAKE_TEST_CONCURRENCY_FAIL: el lock debe preceder al rechequeo DUPLICATE_PRODUCT';
  end if;
  if position('senda_ensure_inv:' in v_body) = 0 then
    raise exception 'CONFIRM_INTAKE_TEST_CONCURRENCY_FAIL: falta clave senda_ensure_inv';
  end if;

  raise notice 'CONFIRM_INTAKE_TEST_CONCURRENCY_OK: advisory lock antes de DUPLICATE_PRODUCT';
end
$concurrency$;

do $fixtures$
declare
  -- Pin opcional: UUID real de un purchase_documents reviewed. NULL = autodiscovery.
  v_pin_document_id uuid := null;

  v_actor uuid;
  v_org uuid;
  v_location uuid;
  v_doc uuid;
  v_line_a uuid;
  v_line_b uuid;
  v_product uuid;
  v_qty_a numeric;
  v_unit_a text;
  v_base_a text;
  v_factor_a numeric;
  v_physical_a numeric;
  v_qty_b numeric;
  v_unit_b text;
  v_physical_b numeric;
  v_recv_partial_qty numeric;
  v_recv_rest_qty numeric;
  v_key1 uuid := gen_random_uuid();
  v_key2 uuid := gen_random_uuid();
  v_recv_a uuid := gen_random_uuid();
  v_recv_b uuid := gen_random_uuid();
  v_recv_partial uuid := gen_random_uuid();
  v_result jsonb;
  v_result_replay jsonb;
  v_attempts integer;
  v_products_before integer;
  v_products_after integer;
  v_movements_before_confirm integer;
  v_movements_after_confirm integer;
  v_movements_after_replay integer;
  v_stock_after_confirm numeric;
  v_stock_after_replay numeric;
  v_err text;
  v_canon_a text;
  v_canon_b text;
  v_factor_b numeric;
begin
  if to_regprocedure('public.senda_confirm_purchase_invoice_intake(jsonb)') is null then
    raise exception 'CONFIRM_INTAKE_TEST_ABORT: RPC no instalado.';
  end if;

  -- Descubrir documento + 2 líneas unmapped inventariables
  select d.id, d.organization_id, d.location_id
    into v_doc, v_org, v_location
  from public.purchase_documents d
  where (v_pin_document_id is null or d.id = v_pin_document_id)
    and d.status = 'reviewed'
    and (
      select count(*)
      from public.purchase_document_lines l
      where l.purchase_document_id = d.id
        and l.mapping_status = 'unmapped'
        and public.senda_purchase_line_is_inventoriable(
          l.inventory_eligibility,
          l.mapping_status,
          l.classification,
          l.quantity_kind,
          l.reviewed_amount,
          l.original_amount
        )
    ) >= 2
  order by d.created_at desc nulls last, d.id
  limit 1;

  if v_doc is null then
    raise exception 'CONFIRM_INTAKE_TEST_SKIP: no hay documento reviewed con ≥2 líneas inventariables unmapped';
  end if;

  select l.id,
         coalesce(l.reviewed_quantity, l.original_quantity),
         coalesce(l.reviewed_unit, l.original_unit)
    into v_line_a, v_qty_a, v_unit_a
  from public.purchase_document_lines l
  where l.purchase_document_id = v_doc
    and l.mapping_status = 'unmapped'
    and public.senda_purchase_line_is_inventoriable(
      l.inventory_eligibility, l.mapping_status, l.classification,
      l.quantity_kind, l.reviewed_amount, l.original_amount
    )
  order by l.source_index nulls last, l.id
  limit 1;

  select l.id,
         coalesce(l.reviewed_quantity, l.original_quantity),
         coalesce(l.reviewed_unit, l.original_unit)
    into v_line_b, v_qty_b, v_unit_b
  from public.purchase_document_lines l
  where l.purchase_document_id = v_doc
    and l.id is distinct from v_line_a
    and l.mapping_status = 'unmapped'
    and public.senda_purchase_line_is_inventoriable(
      l.inventory_eligibility, l.mapping_status, l.classification,
      l.quantity_kind, l.reviewed_amount, l.original_amount
    )
  order by l.source_index nulls last, l.id
  limit 1;

  if v_line_a is null or v_line_b is null or v_qty_a is null or v_qty_a <= 0 then
    raise exception 'CONFIRM_INTAKE_TEST_SKIP: líneas/cantidades insuficientes en el documento %', v_doc;
  end if;

  -- Normalización mínima inline (helpers de conversión no tienen GRANT externo)
  v_canon_a := lower(btrim(coalesce(v_unit_a, '')));
  if v_canon_a in ('lt', 'lts', 'litro', 'litros') then v_canon_a := 'l'; end if;
  if v_canon_a in ('gr', 'grs', 'gramo', 'gramos') then v_canon_a := 'g'; end if;
  if v_canon_a in ('kilo', 'kilos', 'kilogramo', 'kilogramos') then v_canon_a := 'kg'; end if;
  if v_canon_a in ('u', 'un', 'unid', 'unidad', 'unidades') then v_canon_a := 'unit'; end if;

  select ip.id, ip.base_unit
    into v_product, v_base_a
  from public.inventory_products ip
  where ip.organization_id = v_org
    and ip.active is true
    and ip.base_unit in ('g', 'ml', 'unit')
    and (
      (v_canon_a = ip.base_unit)
      or (v_canon_a in ('l', 'ml', 'm3') and ip.base_unit = 'ml')
      or (v_canon_a in ('kg', 'g') and ip.base_unit = 'g')
      or (v_canon_a = 'unit' and ip.base_unit = 'unit')
    )
  order by ip.name, ip.id
  limit 1;

  if v_product is null then
    raise exception 'CONFIRM_INTAKE_TEST_SKIP: no hay producto activo convertible para unidad % (doc %)', v_unit_a, v_doc;
  end if;

  v_physical_a := case v_canon_a
    when 'l' then case v_base_a when 'ml' then round(v_qty_a * 1000, 6) when 'l' then round(v_qty_a, 6) else null end
    when 'ml' then case v_base_a when 'ml' then round(v_qty_a, 6) else null end
    when 'm3' then case v_base_a when 'ml' then round(v_qty_a * 1000000, 6) else null end
    when 'kg' then case v_base_a when 'g' then round(v_qty_a * 1000, 6) when 'kg' then round(v_qty_a, 6) else null end
    when 'g' then case v_base_a when 'g' then round(v_qty_a, 6) else null end
    when 'unit' then case v_base_a when 'unit' then round(v_qty_a, 6) else null end
    else null
  end;
  if v_physical_a is null or v_physical_a <= 0 then
    raise exception 'CONFIRM_INTAKE_TEST_SKIP: no se pudo derivar physical para línea A';
  end if;
  v_factor_a := round(v_physical_a / v_qty_a, 6);

  v_physical_b := null;
  v_factor_b := null;
  if v_qty_b is not null and v_qty_b > 0 then
    v_canon_b := lower(btrim(coalesce(v_unit_b, '')));
    if v_canon_b in ('lt', 'lts', 'litro', 'litros') then v_canon_b := 'l'; end if;
    if v_canon_b in ('gr', 'grs', 'gramo', 'gramos') then v_canon_b := 'g'; end if;
    if v_canon_b in ('kilo', 'kilos', 'kilogramo', 'kilogramos') then v_canon_b := 'kg'; end if;
    if v_canon_b in ('u', 'un', 'unid', 'unidad', 'unidades') then v_canon_b := 'unit'; end if;
    v_physical_b := case v_canon_b
      when v_base_a then round(v_qty_b, 6)
      when 'l' then case when v_base_a = 'ml' then round(v_qty_b * 1000, 6) else null end
      when 'ml' then case when v_base_a = 'ml' then round(v_qty_b, 6) else null end
      when 'kg' then case when v_base_a = 'g' then round(v_qty_b * 1000, 6) else null end
      when 'g' then case when v_base_a = 'g' then round(v_qty_b, 6) else null end
      when 'unit' then case when v_base_a = 'unit' then round(v_qty_b, 6) else null end
      else null
    end;
    if v_physical_b is not null then
      v_factor_b := round(v_physical_b / v_qty_b, 6);
    end if;
  end if;

  select m.user_id
    into v_actor
  from public.organization_members m
  where m.organization_id = v_org
    and m.status = 'active'
    and m.role in ('admin', 'operator')
    and public.senda_actor_is_purchase_member(v_location, m.user_id)
  order by m.user_id
  limit 1;

  if v_actor is null then
    raise exception 'CONFIRM_INTAKE_TEST_SKIP: no hay actor purchase member para org/sucursal del doc %', v_doc;
  end if;

  v_recv_partial_qty := round(v_physical_a / 2, 6);
  if v_recv_partial_qty <= 0 then
    v_recv_partial_qty := v_physical_a;
  end if;
  if v_recv_partial_qty >= v_physical_a then
    v_recv_partial_qty := round(v_physical_a * 0.4, 6);
  end if;
  if v_recv_partial_qty <= 0 then
    raise exception 'CONFIRM_INTAKE_TEST_SKIP: cantidad parcial inválida';
  end if;
  v_recv_rest_qty := round(v_physical_a - v_recv_partial_qty, 6);

  select count(*) into v_products_before
  from public.inventory_products where organization_id = v_org;

  -- -------------------------------------------------------------------------
  -- 1) Rollback completo: create ok + receive inválida ⇒ sin producto nuevo
  -- -------------------------------------------------------------------------
  begin
    perform public.senda_confirm_purchase_invoice_intake(jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_org,
      'location_id', v_location,
      'purchase_document_id', v_doc,
      'confirm_idempotency_key', gen_random_uuid(),
      'lines', jsonb_build_array(
        jsonb_build_object(
          'purchase_document_line_id', v_line_a,
          'action', 'create',
          'create', jsonb_build_object(
            'name', 'TEST CONFIRM ROLLBACK ' || substr(gen_random_uuid()::text, 1, 8),
            'base_unit', v_base_a,
            'category', 'test',
            'minimum_stock', 1
          ),
          'inventory_physical_quantity', v_physical_a,
          'conversion_factor', v_factor_a,
          'receive_quantity', v_physical_a * 1000,
          'receive_idempotency_key', gen_random_uuid()
        ),
        jsonb_build_object(
          'purchase_document_line_id', v_line_b,
          'action', 'pending'
        )
      )
    ));
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: se esperaba RECEIPT_EXCEEDS_INVOICED';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err not ilike '%RECEIPT_EXCEEDS_INVOICED%' and v_err not ilike '%INVALID_QUANTITY%' then
        raise exception 'CONFIRM_INTAKE_TEST_FAIL: rollback inesperado: %', v_err;
      end if;
  end;

  select count(*) into v_products_after
  from public.inventory_products where organization_id = v_org;
  if v_products_after is distinct from v_products_before then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: create no revirtió tras fallo de receive';
  end if;

  -- Snapshot previo al confirm exitoso
  select count(*) into v_movements_before_confirm
  from public.inventory_movements m
  join public.location_inventory li on li.id = m.location_inventory_id
  where li.location_id = v_location;

  -- -------------------------------------------------------------------------
  -- 2) Confirm parcial: A link+receive parcial, B pending
  -- -------------------------------------------------------------------------
  v_result := public.senda_confirm_purchase_invoice_intake(jsonb_build_object(
    'actor_user_id', v_actor,
    'organization_id', v_org,
    'location_id', v_location,
    'purchase_document_id', v_doc,
    'confirm_idempotency_key', v_key1,
    'lines', jsonb_build_array(
      jsonb_build_object(
        'purchase_document_line_id', v_line_a,
        'action', 'link_existing',
        'inventory_product_id', v_product,
        'inventory_physical_quantity', v_physical_a,
        'conversion_factor', v_factor_a,
        'receive_quantity', v_recv_partial_qty,
        'receive_idempotency_key', v_recv_partial
      ),
      jsonb_build_object(
        'purchase_document_line_id', v_line_b,
        'action', 'pending'
      )
    )
  ));

  if coalesce((v_result->>'idempotent')::boolean, true) then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: primer confirm no debería ser idempotent';
  end if;
  if coalesce((v_result->>'unmapped_line_count')::int, -1) < 1 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: se esperaba al menos una línea unmapped (pending)';
  end if;

  select count(*) into v_movements_after_confirm
  from public.inventory_movements m
  join public.location_inventory li on li.id = m.location_inventory_id
  where li.location_id = v_location;

  select coalesce(sum(v.quantity_on_hand), 0) into v_stock_after_confirm
  from public.inventory_valuations v
  join public.location_inventory li on li.id = v.location_inventory_id
  where li.location_id = v_location;

  if v_movements_after_confirm <= v_movements_before_confirm then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: el confirm parcial debía crear movimientos';
  end if;

  -- -------------------------------------------------------------------------
  -- 3) Reintento idempotente: movimientos y stock idénticos al post-confirm
  -- -------------------------------------------------------------------------
  v_result_replay := public.senda_confirm_purchase_invoice_intake(jsonb_build_object(
    'actor_user_id', v_actor,
    'organization_id', v_org,
    'location_id', v_location,
    'purchase_document_id', v_doc,
    'confirm_idempotency_key', v_key1,
    'lines', jsonb_build_array(
      jsonb_build_object(
        'purchase_document_line_id', v_line_a,
        'action', 'link_existing',
        'inventory_product_id', v_product,
        'inventory_physical_quantity', v_physical_a,
        'conversion_factor', v_factor_a,
        'receive_quantity', v_recv_partial_qty,
        'receive_idempotency_key', v_recv_partial
      ),
      jsonb_build_object(
        'purchase_document_line_id', v_line_b,
        'action', 'pending'
      )
    )
  ));

  if (v_result_replay->>'idempotent')::boolean is distinct from true then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: replay debía ser idempotent';
  end if;

  select count(*) into v_attempts
  from public.purchase_document_confirm_attempts
  where purchase_document_id = v_doc
    and confirm_idempotency_key = v_key1;
  if v_attempts is distinct from 1 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: replay no debe crear otro intento';
  end if;

  select count(*) into v_movements_after_replay
  from public.inventory_movements m
  join public.location_inventory li on li.id = m.location_inventory_id
  where li.location_id = v_location;

  select coalesce(sum(v.quantity_on_hand), 0) into v_stock_after_replay
  from public.inventory_valuations v
  join public.location_inventory li on li.id = v.location_inventory_id
  where li.location_id = v_location;

  if v_movements_after_replay is distinct from v_movements_after_confirm then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: replay alteró cantidad de movimientos (% → %)',
      v_movements_after_confirm, v_movements_after_replay;
  end if;
  if v_stock_after_replay is distinct from v_stock_after_confirm then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: replay alteró stock (% → %)',
      v_stock_after_confirm, v_stock_after_replay;
  end if;

  -- -------------------------------------------------------------------------
  -- 4) Misma clave + contenido distinto → conflicto
  -- -------------------------------------------------------------------------
  begin
    perform public.senda_confirm_purchase_invoice_intake(jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_org,
      'location_id', v_location,
      'purchase_document_id', v_doc,
      'confirm_idempotency_key', v_key1,
      'lines', jsonb_build_array(
        jsonb_build_object(
          'purchase_document_line_id', v_line_a,
          'action', 'link_existing',
          'inventory_product_id', v_product,
          'inventory_physical_quantity', v_physical_a,
          'conversion_factor', v_factor_a,
          'receive_quantity', v_recv_rest_qty,
          'receive_idempotency_key', gen_random_uuid()
        ),
        jsonb_build_object(
          'purchase_document_line_id', v_line_b,
          'action', 'pending'
        )
      )
    ));
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: se esperaba CONFIRM_IDEMPOTENCY_CONFLICT';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err not ilike '%CONFIRM_IDEMPOTENCY_CONFLICT%' then
        raise exception 'CONFIRM_INTAKE_TEST_FAIL: conflicto inesperado: %', v_err;
      end if;
  end;

  -- -------------------------------------------------------------------------
  -- 5) Pending sobre línea ya mapeada → PENDING_NOT_ALLOWED
  --    Nueva clave: completar resto de A (+ B si convertible)
  -- -------------------------------------------------------------------------
  begin
    perform public.senda_confirm_purchase_invoice_intake(jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_org,
      'location_id', v_location,
      'purchase_document_id', v_doc,
      'confirm_idempotency_key', gen_random_uuid(),
      'lines', jsonb_build_array(
        jsonb_build_object(
          'purchase_document_line_id', v_line_a,
          'action', 'pending'
        ),
        jsonb_build_object(
          'purchase_document_line_id', v_line_b,
          'action', 'pending'
        )
      )
    ));
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: se esperaba PENDING_NOT_ALLOWED';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err not ilike '%PENDING_NOT_ALLOWED%' then
        raise exception 'CONFIRM_INTAKE_TEST_FAIL: pending guard inesperado: %', v_err;
      end if;
  end;

  if v_physical_b is null then
    -- Completar solo resto de A; B sigue pending
    v_result := public.senda_confirm_purchase_invoice_intake(jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_org,
      'location_id', v_location,
      'purchase_document_id', v_doc,
      'confirm_idempotency_key', v_key2,
      'lines', jsonb_build_array(
        jsonb_build_object(
          'purchase_document_line_id', v_line_a,
          'action', 'link_existing',
          'inventory_product_id', v_product,
          'inventory_physical_quantity', v_physical_a,
          'conversion_factor', v_factor_a,
          'receive_quantity', v_recv_rest_qty,
          'receive_idempotency_key', v_recv_a
        ),
        jsonb_build_object(
          'purchase_document_line_id', v_line_b,
          'action', 'pending'
        )
      )
    ));
  else
    v_result := public.senda_confirm_purchase_invoice_intake(jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_org,
      'location_id', v_location,
      'purchase_document_id', v_doc,
      'confirm_idempotency_key', v_key2,
      'lines', jsonb_build_array(
        jsonb_build_object(
          'purchase_document_line_id', v_line_a,
          'action', 'link_existing',
          'inventory_product_id', v_product,
          'inventory_physical_quantity', v_physical_a,
          'conversion_factor', v_factor_a,
          'receive_quantity', v_recv_rest_qty,
          'receive_idempotency_key', v_recv_a
        ),
        jsonb_build_object(
          'purchase_document_line_id', v_line_b,
          'action', 'link_existing',
          'inventory_product_id', v_product,
          'inventory_physical_quantity', v_physical_b,
          'conversion_factor', v_factor_b,
          'receive_quantity', v_physical_b,
          'receive_idempotency_key', v_recv_b
        )
      )
    ));
  end if;

  if (v_result->>'idempotent')::boolean is distinct from false then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: segundo confirm no es replay';
  end if;

  select count(*) into v_attempts
  from public.purchase_document_confirm_attempts
  where purchase_document_id = v_doc;
  if v_attempts < 2 then
    raise exception 'CONFIRM_INTAKE_TEST_FAIL: debe haber ≥2 intentos por documento';
  end if;

  raise notice 'CONFIRM_INTAKE_TEST_OK doc=% movements_stable stock_stable', v_doc;
end
$fixtures$;

rollback;

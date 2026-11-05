-- =============================================================================
-- GastroGest / SENDA — ANULACIÓN EXCEPCIONAL ACOTADA (revisión manual)
-- =============================================================================
-- Caso: MAYORISTANET.COM S.A. 0012-00611278
-- Documento: ef01f3a8-0953-4d02-9849-cceee251f4f5
-- Sucursal: Barrio Chino (d8d78b7d-eec5-4e90-8f2d-98268a875d00)
--
-- NO APLICAR en producción sin autorización explícita.
-- NO EJECUTAR la anulación real desde este archivo sin confirm manual.
--
-- Cierre de seguridad (esta versión)
-- ----------------------------------
-- 1) Fingerprint exacto de 7 recepciones + 3 movimientos allowlisted.
-- 2) dry_run: locks + controles → return ANTES de cualquier escritura.
-- 3) confirm: revalida fingerprint y preflight bajo los mismos locks, luego
--    escribe compensación / reversiones / historial / soft-delete en UNA txn.
-- 4) Conflicto en purchase_invoice_deletion_log → ABORT (no DO NOTHING).
-- 5) EXECUTE solo service_role (postgres como owner). Sin ampliar a anon/auth.
--
-- Ejecución administrativa (service_role solo en backend):
--   cd apps/api
--   npm run mayoristanet:void:dry-run
--   MAYORISTANET_VOID_CONFIRM=VOID_MAYORISTANET_0012-00611278 npm run mayoristanet:void:confirm
-- Nunca en navegador ni compartiendo la service_role key.
-- Pruebas descartables: npm run mayoristanet:void:test
-- =============================================================================

create or replace function public.senda_exceptional_void_mayoristanet_ef01f3a8(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- Constantes del caso (producción). No reutilizar para otros documentos.
  c_doc uuid := 'ef01f3a8-0953-4d02-9849-cceee251f4f5';
  c_org uuid := 'a01b3bf7-6af2-4078-9931-e70f55b4626e';
  c_location uuid := 'd8d78b7d-eec5-4e90-8f2d-98268a875d00';
  c_number text := '0012-00611278';
  c_arroz uuid := '59ce5deb-f689-446f-8042-96b75a290c43';
  c_arroz_comp_key uuid := 'c0ffeeee-ef01-4f3a-8095-000000000001';
  c_confirm text := 'VOID_MAYORISTANET_0012-00611278';

  -- Recepciones esperadas: (receipt_id, inventory_product_id, quantity)
  c_receipts jsonb := jsonb_build_array(
    jsonb_build_object(
      'receipt_id', '77996487-fc0b-4602-9176-e25d889a6452',
      'inventory_product_id', 'd729ae83-0246-4e44-99c9-59a36d9665c9',
      'quantity', 7220
    ),
    jsonb_build_object(
      'receipt_id', '7911bc4a-9614-47f1-a37f-e6eb686072af',
      'inventory_product_id', 'f5c8b16a-244b-46bd-bb58-c1158e376b7c',
      'quantity', 3500
    ),
    jsonb_build_object(
      'receipt_id', '8415ae04-1c03-4d29-89b1-2eb88139c87c',
      'inventory_product_id', '2105ddb0-ac28-40fd-8e78-674036bbeaba',
      'quantity', 18190
    ),
    jsonb_build_object(
      'receipt_id', '76f64826-5ce1-4a91-a59e-0f712afe699f',
      'inventory_product_id', '59ce5deb-f689-446f-8042-96b75a290c43',
      'quantity', 5000
    ),
    jsonb_build_object(
      'receipt_id', '29bcd12a-c7dc-49d2-9f00-5beb72a62d1d',
      'inventory_product_id', 'a6009586-be28-46d2-a714-c705923dc677',
      'quantity', 16000
    ),
    jsonb_build_object(
      'receipt_id', '7865de64-8b3c-45f1-ac22-31e33fbdf0ad',
      'inventory_product_id', 'fd585880-ea34-4171-b7f0-c042703fd22c',
      'quantity', 10000
    ),
    jsonb_build_object(
      'receipt_id', 'da13fe2b-7718-416a-ad5b-98c03138df70',
      'inventory_product_id', '721b5c64-9e94-4b25-868e-d40295550511',
      'quantity', 10000
    )
  );

  -- Movimientos posteriores allowlisted: (id, movement_type, quantity, inventory_product_id)
  c_later jsonb := jsonb_build_array(
    jsonb_build_object(
      'id', '579a598f-c3ff-4ffc-b0b3-f33377f6651e',
      'movement_type', 'adjustment',
      'quantity', 1000,
      'inventory_product_id', '59ce5deb-f689-446f-8042-96b75a290c43'
    ),
    jsonb_build_object(
      'id', 'da65cf9a-21dd-4c8a-8116-fe020daaa86c',
      'movement_type', 'adjustment',
      'quantity', 1000,
      'inventory_product_id', '721b5c64-9e94-4b25-868e-d40295550511'
    ),
    jsonb_build_object(
      'id', '2aef7885-6c71-4fd7-b89b-fc2925376b36',
      'movement_type', 'adjustment',
      'quantity', -1000,
      'inventory_product_id', '721b5c64-9e94-4b25-868e-d40295550511'
    )
  );

  v_expected_receipts jsonb;
  v_expected_later jsonb;
  v_arroz uuid;
  v_actor uuid;
  v_dry boolean := false;
  v_confirm text;
  v_doc uuid;
  v_org uuid;
  v_location uuid;
  v_status text;
  v_issuer text;
  v_number text;
  v_doc_date date;
  v_deleted_at timestamptz;
  v_bucket text;
  v_path text;
  v_now timestamptz := clock_timestamp();

  v_li_row uuid;
  v_rec record;
  v_li uuid;
  v_on_hand numeric;
  v_avg numeric;
  v_last numeric;
  v_last_at timestamptz;
  v_ledger numeric;
  v_purchase_id uuid;
  v_purchase_at timestamptz;
  v_purchase_qty numeric;
  v_bad uuid;
  v_bad_type text;
  v_hist_qty numeric;
  v_hist_cost numeric;
  v_hist_before_qty numeric;
  v_hist_before_avg numeric;
  v_hist_at timestamptz;
  v_hist_recorded timestamptz;
  v_hist_id uuid;
  v_hist_key uuid;
  v_remaining numeric;
  v_history_id uuid;
  v_later_invoice boolean;
  v_comp jsonb;
  v_adjust jsonb;
  v_already uuid;
  v_sqlstate text;
  v_sqlerrm text;
  v_product_name text;
  v_receipt_count integer;
  v_later_count integer;
  v_missing integer;
  v_mismatch text;

  v_reversed_receipts jsonb := '[]'::jsonb;
  v_reversed_movements jsonb := '[]'::jsonb;
  v_cost_rollbacks jsonb := '[]'::jsonb;
  v_preflight jsonb := '[]'::jsonb;
  v_arroz_comp jsonb := null;
  v_moved integer;
  v_phase text;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_dry := coalesce((p->>'dry_run')::boolean, false);
  v_confirm := btrim(coalesce(p->>'confirm', ''));

  begin
    v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;

  v_doc := c_doc;
  v_arroz := c_arroz;
  v_expected_receipts := c_receipts;
  v_expected_later := c_later;

  -- Solo en base descartable: inyectar fingerprint de fixture.
  if current_database() = 'senda_cpp_test'
     and coalesce(current_setting('senda.cpp_test', true), '') = 'on' then
    begin
      if p ? 'document_id' then
        v_doc := (p->>'document_id')::uuid;
      end if;
      if p ? 'arroz_product_id' then
        v_arroz := (p->>'arroz_product_id')::uuid;
      end if;
      if p ? 'expected_receipts' then
        v_expected_receipts := p->'expected_receipts';
      end if;
      if p ? 'expected_later_movements' then
        v_expected_later := p->'expected_later_movements';
      end if;
    exception
      when invalid_text_representation then
        raise exception 'INVALID_PAYLOAD';
    end;
  end if;

  if not v_dry and v_confirm is distinct from c_confirm then
    raise exception 'CONFIRM_REQUIRED: pase confirm=%', c_confirm
      using errcode = 'P0001';
  end if;

  -- =========================================================================
  -- Fase locked: document + LIs. Controles bajo bloqueo. Sin escrituras aún.
  -- =========================================================================
  v_phase := 'lock_and_preflight';

  select
    d.id, d.organization_id, d.location_id, d.status, d.issuer_name,
    d.document_number, d.document_date, d.deleted_at,
    d.storage_bucket, d.storage_object_path
    into
      v_doc, v_org, v_location, v_status, v_issuer,
      v_number, v_doc_date, v_deleted_at,
      v_bucket, v_path
  from public.purchase_documents d
  where d.id = v_doc
  for update;

  if not found then
    raise exception 'DOCUMENT_NOT_FOUND';
  end if;

  if current_database() is distinct from 'senda_cpp_test' then
    if v_doc is distinct from c_doc
       or v_org is distinct from c_org
       or v_location is distinct from c_location
       or v_number is distinct from c_number
       or position('MAYORISTANET' in upper(coalesce(v_issuer, ''))) = 0 then
      raise exception 'EXCEPTIONAL_SCOPE_MISMATCH: este RPC solo aplica a MAYORISTANET 0012-00611278'
        using errcode = 'P0001';
    end if;
  end if;

  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;

  if v_deleted_at is not null then
    return jsonb_build_object(
      'id', v_doc,
      'replay', true,
      'deleted_at', v_deleted_at,
      'exceptional', true
    );
  end if;

  if v_status is distinct from 'received' then
    raise exception 'BAD_STATUS:%', v_status using errcode = 'P0001';
  end if;

  -- Log de borrado ya presente sin deleted_at → estado inconsistente: abortar.
  if exists (
    select 1
    from public.purchase_invoice_deletion_log l
    where l.purchase_document_id = v_doc
  ) then
    raise exception 'EXCEPTIONAL_AUDIT_CONFLICT: ya existe purchase_invoice_deletion_log para este documento'
      using errcode = 'P0001';
  end if;

  for v_li_row in
    select s.li_id
    from (
      select rec.location_inventory_id as li_id
      from public.purchase_document_receipts rec
      where rec.purchase_document_id = v_doc
        and rec.location_inventory_id is not null
      union
      select li.id
      from public.purchase_document_receipts rec
      join public.location_inventory li
        on li.location_id = rec.location_id
       and li.inventory_product_id = rec.inventory_product_id
      where rec.purchase_document_id = v_doc
    ) s
    where s.li_id is not null
    order by s.li_id
  loop
    perform 1 from public.location_inventory li where li.id = v_li_row for update;
  end loop;

  -- -------- Fingerprint exacto de recepciones (7) --------
  select count(*) into v_receipt_count
  from public.purchase_document_receipts r
  where r.purchase_document_id = v_doc;

  if v_receipt_count is distinct from jsonb_array_length(v_expected_receipts) then
    raise exception 'EXCEPTIONAL_RECEIPT_FINGERPRINT: count=% esperado=%',
      v_receipt_count, jsonb_array_length(v_expected_receipts)
      using errcode = 'P0001';
  end if;

  select count(*) into v_missing
  from jsonb_array_elements(v_expected_receipts) e
  where not exists (
    select 1
    from public.purchase_document_receipts r
    where r.purchase_document_id = v_doc
      and r.id = (e->>'receipt_id')::uuid
      and r.inventory_product_id = (e->>'inventory_product_id')::uuid
      and r.quantity is not distinct from (e->>'quantity')::numeric
  );
  if v_missing > 0 then
    raise exception 'EXCEPTIONAL_RECEIPT_FINGERPRINT: faltan o difieren % recepciones esperadas',
      v_missing
      using errcode = 'P0001';
  end if;

  select r.id::text into v_mismatch
  from public.purchase_document_receipts r
  where r.purchase_document_id = v_doc
    and not exists (
      select 1
      from jsonb_array_elements(v_expected_receipts) e
      where (e->>'receipt_id')::uuid = r.id
    )
  limit 1;
  if v_mismatch is not null then
    raise exception 'EXCEPTIONAL_RECEIPT_FINGERPRINT: recepción inesperada %', v_mismatch
      using errcode = 'P0001';
  end if;

  -- -------- Fingerprint exacto de movimientos posteriores allowlisted (3) --------
  -- Deben existir con id/tipo/cantidad/producto exactos, y ser el conjunto completo
  -- de posteriores no-purchase (salvo reversiones de recibo / compensación arroz).
  select count(*) into v_later_count
  from jsonb_array_elements(v_expected_later) e
  where not exists (
    select 1
    from public.inventory_movements m
    join public.location_inventory li on li.id = m.location_inventory_id
    where m.id = (e->>'id')::uuid
      and m.movement_type = e->>'movement_type'
      and m.quantity is not distinct from (e->>'quantity')::numeric
      and li.inventory_product_id = (e->>'inventory_product_id')::uuid
      and li.location_id = v_location
  );
  if v_later_count > 0 then
    raise exception 'EXCEPTIONAL_LATER_FINGERPRINT: faltan o difieren % movimientos allowlisted',
      v_later_count
      using errcode = 'P0001';
  end if;

  -- -------- Preflight por recepción (bajo locks) --------
  v_preflight := '[]'::jsonb;
  for v_rec in
    select
      rec.id as receipt_id,
      rec.quantity,
      rec.inventory_product_id,
      rec.location_inventory_id,
      ip.name as product_name
    from public.purchase_document_receipts rec
    left join public.inventory_products ip on ip.id = rec.inventory_product_id
    where rec.purchase_document_id = v_doc
    order by rec.created_at, rec.id
    for update of rec
  loop
    select li.id into v_li
    from public.location_inventory li
    where li.id = coalesce(
      v_rec.location_inventory_id,
      (
        select x.id
        from public.location_inventory x
        where x.location_id = v_location
          and x.inventory_product_id = v_rec.inventory_product_id
      )
    )
    for update;
    if v_li is null then
      raise exception 'REVERSAL_INVENTORY_MISSING:%', v_rec.receipt_id using errcode = 'P0001';
    end if;

    select iv.quantity_on_hand, iv.average_unit_cost
      into v_on_hand, v_avg
    from public.inventory_valuations iv
    where iv.location_inventory_id = v_li
    for update;
    if not found then
      raise exception 'REVERSAL_VALUATION_MISSING';
    end if;
    v_on_hand := coalesce(v_on_hand, 0);

    select coalesce(sum(m.quantity), 0) into v_ledger
    from public.inventory_movements m
    where m.location_inventory_id = v_li;
    if v_on_hand is distinct from v_ledger then
      raise exception 'REVERSAL_LEDGER_MISMATCH:%', v_rec.product_name using errcode = 'P0001';
    end if;

    select m.id, m.created_at, m.quantity
      into v_purchase_id, v_purchase_at, v_purchase_qty
    from public.inventory_movements m
    where m.location_inventory_id = v_li
      and m.movement_type = 'purchase'
      and m.source_id::text = v_rec.receipt_id::text;
    if not found or v_purchase_qty is distinct from v_rec.quantity then
      raise exception 'REVERSAL_PURCHASE_MOVEMENT_MISSING:%', v_rec.receipt_id
        using errcode = 'P0001';
    end if;

    -- Posteriores: solo allowlisted (por id) o compensación arroz / reversión recibo.
    select m.id, m.movement_type
      into v_bad, v_bad_type
    from public.inventory_movements m
    where m.location_inventory_id = v_li
      and (m.created_at, m.id) > (v_purchase_at, v_purchase_id)
      and m.id is distinct from v_purchase_id
      and not (
        m.movement_type = 'adjustment'
        and m.source_id::text = v_rec.receipt_id::text
      )
      and not (
        m.movement_type = 'adjustment'
        and m.source_id::text = c_arroz_comp_key::text
      )
      and not exists (
        select 1
        from jsonb_array_elements(v_expected_later) e
        where (e->>'id')::uuid = m.id
      )
    order by m.created_at, m.id
    limit 1;
    if v_bad is not null then
      raise exception 'EXCEPTIONAL_UNEXPECTED_DEPENDENT:%:%:%',
        v_rec.product_name, v_bad_type, v_bad
        using errcode = 'P0001';
    end if;

    -- Allowlisted en este LI deben coincidir exactamente (id+tipo+qty ya validado global).
    -- Además: no puede faltar ninguno de los allowlisted de este producto.
    select count(*) into v_missing
    from jsonb_array_elements(v_expected_later) e
    where (e->>'inventory_product_id')::uuid = v_rec.inventory_product_id
      and not exists (
        select 1
        from public.inventory_movements m
        where m.location_inventory_id = v_li
          and m.id = (e->>'id')::uuid
          and (m.created_at, m.id) > (v_purchase_at, v_purchase_id)
      );
    if v_missing > 0 then
      raise exception 'EXCEPTIONAL_LATER_FINGERPRINT: allowlisted ausente en libro de %',
        v_rec.product_name
        using errcode = 'P0001';
    end if;

    select h.purchase_quantity, h.purchase_cost, h.quantity_on_hand_before,
           h.average_unit_cost_before, h.effective_at, h.recorded_at, h.id,
           h.receipt_idempotency_key
      into v_hist_qty, v_hist_cost, v_hist_before_qty,
           v_hist_before_avg, v_hist_at, v_hist_recorded, v_hist_id,
           v_hist_key
    from public.inventory_cost_history h
    where h.location_inventory_id = v_li
      and h.source = 'invoice'
      and h.source_ref = v_rec.receipt_id
    order by h.recorded_at, h.id
    limit 1;
    if not found or v_hist_qty is null or v_hist_cost is null then
      raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE:%', v_rec.product_name
        using errcode = 'P0001';
    end if;
    if v_hist_qty is distinct from v_rec.quantity then
      raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: qty compra≠historial:%', v_rec.product_name
        using errcode = 'P0001';
    end if;
    if coalesce(v_hist_before_qty, 0) < 0 then
      raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: before negativo:%', v_rec.product_name
        using errcode = 'P0001';
    end if;
    if coalesce(v_hist_before_qty, 0) > 0 and v_hist_before_avg is null then
      raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE: stock previo sin promedio:%', v_rec.product_name
        using errcode = 'P0001';
    end if;

    v_later_invoice := exists (
      select 1
      from public.inventory_cost_history h
      where h.location_inventory_id = v_li
        and h.source = 'invoice'
        and h.source_ref is distinct from v_rec.receipt_id
        and (h.recorded_at, h.id) > (v_hist_recorded, v_hist_id)
    );
    if v_later_invoice then
      raise exception 'EXCEPTIONAL_LATER_INVOICE:%', v_rec.product_name
        using errcode = 'P0001';
    end if;

    v_preflight := v_preflight || jsonb_build_array(jsonb_build_object(
      'receipt_id', v_rec.receipt_id,
      'product', v_rec.product_name,
      'inventory_product_id', v_rec.inventory_product_id,
      'on_hand', v_on_hand,
      'received_qty', v_rec.quantity,
      'avg', v_avg,
      'before_qty_raw', v_hist_before_qty,
      'before_qty_effective', coalesce(v_hist_before_qty, 0)
    ));
  end loop;

  -- dry_run: salir sin escrituras (locks se liberan al terminar el statement).
  if v_dry then
    return jsonb_build_object(
      'dry_run', true,
      'id', v_doc,
      'document_number', v_number,
      'issuer_name', v_issuer,
      'exceptional', true,
      'phase', v_phase,
      'writes', false,
      'planned_arroz_compensation_qty', -1000,
      'planned_arroz_product_id', v_arroz,
      'expected_receipt_count', jsonb_array_length(v_expected_receipts),
      'expected_later_count', jsonb_array_length(v_expected_later),
      'preflight', v_preflight,
      'note', 'Sin escrituras. Para ejecutar: confirm=VOID_MAYORISTANET_0012-00611278'
    );
  end if;

  -- =========================================================================
  -- Fase write: revalidar fingerprint bajo los mismos locks, luego mutar.
  -- =========================================================================
  v_phase := 'revalidate_under_locks';

  select count(*) into v_receipt_count
  from public.purchase_document_receipts r
  where r.purchase_document_id = v_doc;
  if v_receipt_count is distinct from jsonb_array_length(v_expected_receipts) then
    raise exception 'EXCEPTIONAL_RECEIPT_FINGERPRINT: revalidate count=%', v_receipt_count
      using errcode = 'P0001';
  end if;

  select count(*) into v_missing
  from jsonb_array_elements(v_expected_receipts) e
  where not exists (
    select 1
    from public.purchase_document_receipts r
    where r.purchase_document_id = v_doc
      and r.id = (e->>'receipt_id')::uuid
      and r.inventory_product_id = (e->>'inventory_product_id')::uuid
      and r.quantity is not distinct from (e->>'quantity')::numeric
  );
  if v_missing > 0 then
    raise exception 'EXCEPTIONAL_RECEIPT_FINGERPRINT: revalidate mismatch'
      using errcode = 'P0001';
  end if;

  select count(*) into v_later_count
  from jsonb_array_elements(v_expected_later) e
  where not exists (
    select 1
    from public.inventory_movements m
    join public.location_inventory li on li.id = m.location_inventory_id
    where m.id = (e->>'id')::uuid
      and m.movement_type = e->>'movement_type'
      and m.quantity is not distinct from (e->>'quantity')::numeric
      and li.inventory_product_id = (e->>'inventory_product_id')::uuid
      and li.location_id = v_location
  );
  if v_later_count > 0 then
    raise exception 'EXCEPTIONAL_LATER_FINGERPRINT: revalidate mismatch'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.purchase_invoice_deletion_log l
    where l.purchase_document_id = v_doc
  ) then
    raise exception 'EXCEPTIONAL_AUDIT_CONFLICT: log apareció bajo lock'
      using errcode = 'P0001';
  end if;

  -- Revalidar que ningún LI tiene dependiente inesperado (bajo lock).
  for v_rec in
    select
      rec.id as receipt_id,
      rec.quantity,
      rec.inventory_product_id,
      rec.location_inventory_id,
      ip.name as product_name
    from public.purchase_document_receipts rec
    left join public.inventory_products ip on ip.id = rec.inventory_product_id
    where rec.purchase_document_id = v_doc
    order by rec.created_at, rec.id
  loop
    select li.id into v_li
    from public.location_inventory li
    where li.id = coalesce(
      v_rec.location_inventory_id,
      (
        select x.id from public.location_inventory x
        where x.location_id = v_location
          and x.inventory_product_id = v_rec.inventory_product_id
      )
    )
    for update;

    select m.id, m.created_at into v_purchase_id, v_purchase_at
    from public.inventory_movements m
    where m.location_inventory_id = v_li
      and m.movement_type = 'purchase'
      and m.source_id::text = v_rec.receipt_id::text;

    select m.id, m.movement_type into v_bad, v_bad_type
    from public.inventory_movements m
    where m.location_inventory_id = v_li
      and (m.created_at, m.id) > (v_purchase_at, v_purchase_id)
      and not (
        m.movement_type = 'adjustment'
        and m.source_id::text = v_rec.receipt_id::text
      )
      and not (
        m.movement_type = 'adjustment'
        and m.source_id::text = c_arroz_comp_key::text
      )
      and not exists (
        select 1 from jsonb_array_elements(v_expected_later) e
        where (e->>'id')::uuid = m.id
      )
    order by m.created_at, m.id
    limit 1;
    if v_bad is not null then
      raise exception 'EXCEPTIONAL_UNEXPECTED_DEPENDENT:revalidate:%:%:%',
        v_rec.product_name, v_bad_type, v_bad
        using errcode = 'P0001';
    end if;
  end loop;

  v_phase := 'write';

  -- 1) Neutralizar Arroz +1000 (append-only).
  v_comp := public.senda_adjust_inventory_quantity(jsonb_build_object(
    'actor_user_id', v_actor,
    'organization_id', v_org,
    'location_id', v_location,
    'inventory_product_id', v_arroz,
    'idempotency_key', c_arroz_comp_key,
    'quantity', -1000,
    'reason', 'Compensacion prueba MAYORISTANET 0012-00611278 (ef01f3a8)'
  ));
  v_arroz_comp := v_comp;

  -- 2) Compensar CPP + revertir cantidad (newest first). Exige remaining=0.
  for v_rec in
    select
      rec.id as receipt_id,
      rec.quantity,
      rec.inventory_product_id,
      rec.location_inventory_id,
      ip.name as product_name
    from public.purchase_document_receipts rec
    left join public.inventory_products ip on ip.id = rec.inventory_product_id
    where rec.purchase_document_id = v_doc
    order by rec.created_at desc, rec.id desc
    for update of rec
  loop
    -- One-shot: si ya hay reversión parcial, abortar (no skip silencioso).
    select a.id into v_already
    from public.inventory_adjustments a
    where a.location_id = v_location
      and a.idempotency_key = v_rec.receipt_id
    limit 1;
    if v_already is not null then
      raise exception 'EXCEPTIONAL_PARTIAL_REVERSAL:%', v_rec.receipt_id
        using errcode = 'P0001';
    end if;

    select li.id into v_li
    from public.location_inventory li
    where li.id = coalesce(
      v_rec.location_inventory_id,
      (
        select x.id from public.location_inventory x
        where x.location_id = v_location
          and x.inventory_product_id = v_rec.inventory_product_id
      )
    )
    for update;

    select iv.quantity_on_hand, iv.average_unit_cost,
           iv.last_purchase_unit_cost, iv.last_purchase_at
      into v_on_hand, v_avg, v_last, v_last_at
    from public.inventory_valuations iv
    where iv.location_inventory_id = v_li
    for update;
    v_on_hand := coalesce(v_on_hand, 0);
    if v_on_hand < v_rec.quantity then
      raise exception 'REVERSAL_INSUFFICIENT_STOCK:%:%:%',
        coalesce(v_rec.product_name, 'Producto'), v_rec.quantity, v_on_hand
        using errcode = 'P0001';
    end if;

    select h.purchase_quantity, h.purchase_cost, h.quantity_on_hand_before,
           h.average_unit_cost_before, h.effective_at, h.recorded_at, h.id,
           h.receipt_idempotency_key
      into v_hist_qty, v_hist_cost, v_hist_before_qty,
           v_hist_before_avg, v_hist_at, v_hist_recorded, v_hist_id,
           v_hist_key
    from public.inventory_cost_history h
    where h.location_inventory_id = v_li
      and h.source = 'invoice'
      and h.source_ref = v_rec.receipt_id
    order by h.recorded_at, h.id
    limit 1;

    if v_avg is null or v_hist_qty is null or v_hist_cost is null then
      raise exception 'REVERSAL_COST_HISTORY_INCOMPLETE:%', v_rec.product_name
        using errcode = 'P0001';
    end if;

    v_remaining := v_on_hand - v_hist_qty;
    if v_remaining is distinct from 0 then
      raise exception 'EXCEPTIONAL_REMAINING_NOT_ZERO:%:%',
        v_rec.product_name, v_remaining
        using errcode = 'P0001';
    end if;

    if v_hist_cost > (v_on_hand * v_avg) + 0.05 then
      raise exception 'REVERSAL_COST_EXCEEDS_VALUE:%', v_rec.product_name
        using errcode = 'P0001';
    end if;

    update public.inventory_valuations
       set average_unit_cost = v_avg,
           last_purchase_unit_cost = v_last,
           last_purchase_at = v_last_at,
           updated_at = clock_timestamp()
     where location_inventory_id = v_li;

    insert into public.inventory_cost_history (
      organization_id, location_id, inventory_product_id, location_inventory_id,
      previous_unit_cost, new_unit_cost, source, source_ref, effective_at, recorded_at,
      actor_user_id, purchase_quantity, purchase_cost,
      quantity_on_hand_before, average_unit_cost_before, receipt_idempotency_key
    ) values (
      v_org, v_location, v_rec.inventory_product_id, v_li,
      v_avg, v_avg, 'invoice_reversal', v_rec.receipt_id,
      coalesce(v_hist_at, clock_timestamp()), clock_timestamp(),
      v_actor, v_hist_qty, v_hist_cost, v_on_hand, v_avg, v_hist_key
    )
    returning id into v_history_id;

    v_cost_rollbacks := v_cost_rollbacks || jsonb_build_array(jsonb_build_object(
      'location_inventory_id', v_li,
      'inventory_product_id', v_rec.inventory_product_id,
      'receipt_id', v_rec.receipt_id,
      'action', 'compensated_exceptional_opening',
      'quantity_on_hand_before', v_on_hand,
      'average_unit_cost_before', v_avg,
      'purchase_quantity', v_hist_qty,
      'purchase_cost', v_hist_cost,
      'average_unit_cost', v_avg,
      'history_id', v_history_id,
      'before_qty_effective', coalesce(v_hist_before_qty, 0)
    ));

    begin
      v_adjust := public.senda_adjust_inventory_quantity(jsonb_build_object(
        'actor_user_id', v_actor,
        'organization_id', v_org,
        'location_id', v_location,
        'inventory_product_id', v_rec.inventory_product_id,
        'idempotency_key', v_rec.receipt_id,
        'quantity', -v_rec.quantity,
        'reason', 'Reversion excepcional MAYORISTANET 0012-00611278'
      ));
    exception
      when others then
        get stacked diagnostics
          v_sqlstate = returned_sqlstate,
          v_sqlerrm = message_text;
        if v_sqlerrm ilike '%ADJUSTMENT_EXCEEDS_ON_HAND%' then
          v_product_name := coalesce(nullif(btrim(v_rec.product_name), ''), 'Producto');
          raise exception 'REVERSAL_INSUFFICIENT_STOCK:%:%:%',
            v_product_name, v_rec.quantity, v_on_hand
            using errcode = 'P0001';
        end if;
        raise exception 'REVERSAL_ABORTED:%', left(v_sqlerrm, 120)
          using errcode = coalesce(nullif(v_sqlstate, ''), 'P0001');
    end;

    v_reversed_receipts := v_reversed_receipts || jsonb_build_array(jsonb_build_object(
      'receipt_id', v_rec.receipt_id,
      'quantity', v_rec.quantity,
      'inventory_product_id', v_rec.inventory_product_id,
      'location_inventory_id', v_li,
      'adjustment_id', v_adjust->>'id',
      'exceptional', true
    ));
    v_reversed_movements := v_reversed_movements || jsonb_build_array(jsonb_build_object(
      'receipt_id', v_rec.receipt_id,
      'adjustment_id', v_adjust->>'id',
      'compensation_movement_id', v_adjust->>'inventory_movement_id',
      'quantity', -v_rec.quantity,
      'previous_quantity_on_hand', v_adjust->'previous_quantity_on_hand',
      'next_quantity_on_hand', v_adjust->'next_quantity_on_hand'
    ));
  end loop;

  -- Auditoría: conflicto inesperado aborta toda la transacción (no DO NOTHING).
  begin
    insert into public.purchase_invoice_deletion_log (
      purchase_document_id, organization_id, location_id, actor_user_id,
      previous_status, issuer_name, document_number, document_date,
      reversed_receipts, reversed_movements, cost_rollbacks,
      storage_bucket, storage_object_path, deleted_at
    ) values (
      v_doc, v_org, v_location, v_actor,
      v_status, v_issuer, v_number, v_doc_date,
      v_reversed_receipts || jsonb_build_array(jsonb_build_object(
        'exceptional_arroz_compensation', v_arroz_comp
      )),
      v_reversed_movements,
      v_cost_rollbacks || jsonb_build_array(jsonb_build_object(
        'exceptional', true,
        'scope', 'MAYORISTANET_0012-00611278',
        'expected_receipts', v_expected_receipts,
        'expected_later_movements', v_expected_later,
        'opening_before_null_as_zero', true
      )),
      v_bucket, v_path, v_now
    );
  exception
    when unique_violation then
      raise exception 'EXCEPTIONAL_AUDIT_CONFLICT: unique_violation en purchase_invoice_deletion_log'
        using errcode = 'P0001';
  end;

  update public.purchase_documents
     set deleted_at = v_now,
         deleted_by = v_actor
   where id = v_doc
     and deleted_at is null;

  get diagnostics v_moved = row_count;
  if v_moved is distinct from 1 then
    raise exception 'EXCEPTIONAL_SOFT_DELETE_CONFLICT: no se pudo marcar deleted_at'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'id', v_doc,
    'organization_id', v_org,
    'location_id', v_location,
    'previous_status', v_status,
    'deleted_at', v_now,
    'exceptional', true,
    'phase', v_phase,
    'arroz_compensation', v_arroz_comp,
    'reversed_receipt_count', jsonb_array_length(v_reversed_receipts),
    'reversed_movements', v_reversed_movements,
    'cost_rollbacks', v_cost_rollbacks
  );
end;
$$;

comment on function public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb) is
  'ONE-SHOT: anulación excepcional MAYORISTANET 0012-00611278. Fingerprint 7+3. Abort on audit conflict. Eliminar tras uso.';

revoke all on function public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb)
  to service_role;

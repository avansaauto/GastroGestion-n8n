-- GastroGest / SENDA — verificación POST anulación excepcional MAYORISTANET
-- Documento: ef01f3a8-0953-4d02-9849-cceee251f4f5 / 0012-00611278
-- SOLO LECTURA. Ejecutar después del RPC excepcional autorizado.
--
-- Esperado:
--   document.deleted_at IS NOT NULL
--   deletion_log presente con exceptional=true en cost_rollbacks
--   7 productos con on_hand = 0 y ledger = 0
--   movimientos históricos de prueba (+1000 / ±1000) SIGUEN existiendo
--   + compensación Arroz −1000 (source_id c0ffeeee-ef01-4f3a-8095-000000000001)
--   + 7 ajustes de reversión (idempotency_key = receipt_id)
--   filas invoice_reversal en inventory_cost_history (una por recepción)

with
constants as (
  select
    'ef01f3a8-0953-4d02-9849-cceee251f4f5'::uuid as document_id,
    'd8d78b7d-eec5-4e90-8f2d-98268a875d00'::uuid as location_id,
    'c0ffeeee-ef01-4f3a-8095-000000000001'::uuid as arroz_comp_key,
    array[
      '59ce5deb-f689-446f-8042-96b75a290c43'::uuid,
      '721b5c64-9e94-4b25-868e-d40295550511'::uuid,
      '2105ddb0-ac28-40fd-8e78-674036bbeaba'::uuid,
      'd729ae83-0246-4e44-99c9-59a36d9665c9'::uuid,
      'f5c8b16a-244b-46bd-bb58-c1158e376b7c'::uuid,
      'a6009586-be28-46d2-a714-c705923dc677'::uuid,
      'fd585880-ea34-4171-b7f0-c042703fd22c'::uuid
    ] as product_ids,
    array[
      '579a598f-c3ff-4ffc-b0b3-f33377f6651e'::uuid,
      'da65cf9a-21dd-4c8a-8116-fe020daaa86c'::uuid,
      '2aef7885-6c71-4fd7-b89b-fc2925376b36'::uuid
    ] as test_movement_ids
),
doc as (
  select d.id, d.document_number, d.status, d.deleted_at, d.deleted_by
  from public.purchase_documents d
  join constants c on c.document_id = d.id
),
log as (
  select l.*
  from public.purchase_invoice_deletion_log l
  join constants c on c.document_id = l.purchase_document_id
),
receipts as (
  select r.id as receipt_id, r.inventory_product_id, r.quantity
  from public.purchase_document_receipts r
  join constants c on c.document_id = r.purchase_document_id
),
stock as (
  select
    p.name,
    li.id as location_inventory_id,
    v.quantity_on_hand,
    v.average_unit_cost,
    (
      select coalesce(sum(m.quantity), 0)
      from public.inventory_movements m
      where m.location_inventory_id = li.id
    ) as ledger_sum
  from constants c
  join public.location_inventory li
    on li.location_id = c.location_id
   and li.inventory_product_id = any (c.product_ids)
  join public.inventory_products p on p.id = li.inventory_product_id
  left join public.inventory_valuations v on v.location_inventory_id = li.id
),
hist_moves as (
  select m.id, m.quantity, m.source_id, m.movement_type
  from public.inventory_movements m
  join constants c on m.id = any (c.test_movement_ids)
),
arroz_comp as (
  select m.id, m.quantity, m.source_id
  from public.inventory_movements m
  join constants c on m.source_id::text = c.arroz_comp_key::text
  where m.movement_type = 'adjustment'
),
reversals as (
  select a.id, a.idempotency_key, a.quantity, a.reason
  from public.inventory_adjustments a
  join receipts r on r.receipt_id = a.idempotency_key
),
cost_rev as (
  select h.id, h.source_ref, h.source, h.purchase_quantity
  from public.inventory_cost_history h
  join receipts r on r.receipt_id = h.source_ref
  where h.source = 'invoice_reversal'
)
select 'document' as check_name,
       (select deleted_at is not null from doc) as ok,
       (select format('deleted_at=%s number=%s', deleted_at, document_number) from doc) as detail
union all
select 'deletion_log',
       (select count(*) = 1 from log),
       (select left(cost_rollbacks::text, 180) from log)
union all
select 'stock_zero_all_seven',
       (select bool_and(quantity_on_hand = 0 and ledger_sum = 0) from stock),
       (select string_agg(name || '=' || quantity_on_hand::text, ', ' order by name) from stock)
union all
select 'test_movements_preserved',
       (select count(*) = 3 from hist_moves),
       (select string_agg(id::text || ':' || quantity::text, ', ') from hist_moves)
union all
select 'arroz_compensation_present',
       (select count(*) = 1 and max(quantity) = -1000 from arroz_comp),
       (select coalesce(max(id::text), 'MISSING') from arroz_comp)
union all
select 'receipt_reversal_adjustments',
       (select count(*) = 7 from reversals),
       (select count(*)::text || ' adjustments' from reversals)
union all
select 'invoice_reversal_cost_rows',
       (select count(*) = 7 from cost_rev),
       (select count(*)::text || ' cost rows' from cost_rev)
union all
select 'drop_rpc_reminder',
       true,
       'Después de OK: DROP FUNCTION public.senda_exceptional_void_mayoristanet_ef01f3a8(jsonb);'
;

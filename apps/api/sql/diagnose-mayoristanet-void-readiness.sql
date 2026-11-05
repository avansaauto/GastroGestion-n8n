-- GastroGest / SENDA — SOLO LECTURA
-- Preflight para anulación excepcional de MAYORISTANET 0012-00611278
-- Documento: ef01f3a8-0953-4d02-9849-cceee251f4f5
-- Sucursal Barrio Chino: d8d78b7d-eec5-4e90-8f2d-98268a875d00
--
-- Qué valida:
-- 1) Saldos, libro y CPP de Arroz / Aros (y resto de líneas).
-- 2) Únicos bloqueos Case B: 3 ajustes de prueba (sin ventas posteriores).
-- 3) Historial de costo de apertura con quantity_on_hand_before NULL
--    → senda_cpp_compensate_receipt fallaría con REVERSAL_COST_HISTORY_INCOMPLETE
--    aunque se neutralicen los ajustes.
-- 4) Tras compensar Arroz −1000 g, remaining=0 en las 7 líneas (math del void).

with
constants as (
  select
    'ef01f3a8-0953-4d02-9849-cceee251f4f5'::uuid as document_id,
    'd8d78b7d-eec5-4e90-8f2d-98268a875d00'::uuid as location_id,
    array[
      '579a598f-c3ff-4ffc-b0b3-f33377f6651e'::uuid, -- Arroz +1000 merma
      'da65cf9a-21dd-4c8a-8116-fe020daaa86c'::uuid, -- Aros +1000 perdida
      '2aef7885-6c71-4fd7-b89b-fc2925376b36'::uuid  -- Aros -1000 perdida
    ] as allowlisted_movement_ids,
    '59ce5deb-f689-446f-8042-96b75a290c43'::uuid as arroz_product_id
),
doc as (
  select d.*
  from public.purchase_documents d
  join constants c on c.document_id = d.id
),
receipts as (
  select
    r.id as receipt_id,
    r.purchase_document_line_id,
    r.quantity as received_qty,
    r.created_at as received_at,
    r.location_inventory_id as receipt_li,
    r.inventory_product_id as receipt_product_id
  from public.purchase_document_receipts r
  join doc d on d.id = r.purchase_document_id
),
lines as (
  select
    l.id as line_id,
    l.inventory_product_id,
    l.reviewed_description,
    l.reviewed_amount,
    l.inventory_physical_quantity
  from public.purchase_document_lines l
  join receipts r on r.purchase_document_line_id = l.id
),
li as (
  select
    li.id as location_inventory_id,
    li.inventory_product_id,
    v.quantity_on_hand,
    v.average_unit_cost,
    v.last_purchase_unit_cost,
    (
      select coalesce(sum(m.quantity), 0)
      from public.inventory_movements m
      where m.location_inventory_id = li.id
    ) as ledger_sum
  from public.location_inventory li
  join doc d on d.location_id = li.location_id
  join lines l on l.inventory_product_id = li.inventory_product_id
  left join public.inventory_valuations v on v.location_inventory_id = li.id
),
purchase_move as (
  select
    r.receipt_id,
    m.id as purchase_movement_id,
    m.created_at as purchase_at,
    m.quantity as purchase_qty
  from receipts r
  join lines l on l.line_id = r.purchase_document_line_id
  join li on li.inventory_product_id = l.inventory_product_id
  join public.inventory_movements m
    on m.location_inventory_id = li.location_inventory_id
   and m.movement_type = 'purchase'
   and m.source_id::text = r.receipt_id::text
),
later_moves as (
  select
    l.reviewed_description,
    l.inventory_product_id,
    r.receipt_id,
    m.id as movement_id,
    m.movement_type,
    m.quantity,
    m.source_id,
    m.created_at,
    (m.id = any (c.allowlisted_movement_ids)) as allowlisted,
    a.reason as adjustment_reason
  from receipts r
  join lines l on l.line_id = r.purchase_document_line_id
  join li on li.inventory_product_id = l.inventory_product_id
  join purchase_move pm on pm.receipt_id = r.receipt_id
  join constants c on true
  join public.inventory_movements m
    on m.location_inventory_id = li.location_inventory_id
   and (m.created_at, m.id) > (pm.purchase_at, pm.purchase_movement_id)
   and not (
     m.movement_type = 'purchase'
     and m.source_id::text = r.receipt_id::text
   )
  left join public.inventory_adjustments a
    on a.inventory_movement_id = m.id
),
cost_hist as (
  select
    l.reviewed_description,
    r.receipt_id,
    h.id as cost_history_id,
    h.purchase_quantity,
    h.purchase_cost,
    h.quantity_on_hand_before,
    h.average_unit_cost_before,
    h.new_unit_cost,
    (
      h.quantity_on_hand_before is null
      or h.purchase_cost is null
      or h.purchase_quantity is null
    ) as incomplete_for_normal_cpp
  from receipts r
  join lines l on l.line_id = r.purchase_document_line_id
  join li on li.inventory_product_id = l.inventory_product_id
  left join public.inventory_cost_history h
    on h.location_inventory_id = li.location_inventory_id
   and h.source = 'invoice'
   and h.source_ref = r.receipt_id
),
line_math as (
  select
    l.reviewed_description,
    l.inventory_product_id,
    r.received_qty,
    li.quantity_on_hand,
    li.ledger_sum,
    li.average_unit_cost,
    li.quantity_on_hand is not distinct from li.ledger_sum as ledger_ok,
    li.quantity_on_hand >= r.received_qty as stock_covers_today,
    case
      when l.inventory_product_id = c.arroz_product_id
        then li.quantity_on_hand - 1000
      else li.quantity_on_hand
    end as on_hand_after_arroz_compensate,
    case
      when l.inventory_product_id = c.arroz_product_id
        then (li.quantity_on_hand - 1000) - r.received_qty
      else li.quantity_on_hand - r.received_qty
    end as remaining_after_void_if_compensated,
    ch.incomplete_for_normal_cpp,
    ch.quantity_on_hand_before,
    ch.purchase_cost,
    ch.purchase_quantity
  from receipts r
  join lines l on l.line_id = r.purchase_document_line_id
  join li on li.inventory_product_id = l.inventory_product_id
  join constants c on true
  left join cost_hist ch on ch.receipt_id = r.receipt_id
)

-- A) Cabecera
select
  'document' as section,
  d.id::text as document_id,
  d.document_number,
  d.issuer_name,
  d.status,
  d.deleted_at::text,
  d.location_id::text,
  null::text as detail
from doc d

union all

-- B) Bloqueos posteriores
select
  'later_movement' as section,
  lm.movement_id::text,
  lm.reviewed_description,
  lm.movement_type,
  lm.quantity::text,
  lm.allowlisted::text,
  lm.adjustment_reason,
  lm.created_at::text
from later_moves lm

union all

-- C) Math por línea
select
  'line_math' as section,
  lm.inventory_product_id::text,
  lm.reviewed_description,
  lm.received_qty::text,
  lm.quantity_on_hand::text,
  lm.remaining_after_void_if_compensated::text,
  lm.incomplete_for_normal_cpp::text,
  format(
    'ledger_ok=%s stock_today=%s before_qty=%s avg=%s',
    lm.ledger_ok,
    lm.stock_covers_today,
    lm.quantity_on_hand_before,
    lm.average_unit_cost
  )
from line_math lm

union all

-- D) Veredicto
select
  'verdict' as section,
  case
    when not exists (select 1 from doc) then 'DOCUMENT_MISSING'
    when exists (select 1 from doc where deleted_at is not null) then 'ALREADY_DELETED'
    when exists (select 1 from doc where status is distinct from 'received') then 'BAD_STATUS'
    when exists (select 1 from later_moves where not allowlisted) then 'UNEXPECTED_DEPENDENTS'
    when exists (select 1 from line_math where not ledger_ok) then 'LEDGER_MISMATCH'
    when exists (
      select 1 from line_math
      where remaining_after_void_if_compensated is distinct from 0
    ) then 'REMAINING_NOT_ZERO_AFTER_COMPENSATE'
    when exists (
      select 1 from line_math where incomplete_for_normal_cpp
    ) then 'READY_FOR_EXCEPTIONAL_ONLY'
    else 'READY_FOR_EXCEPTIONAL_ONLY'
  end,
  'Normal senda_delete_purchase_invoice: bloqueado por DEPENDENT_MOVEMENTS + COST_HISTORY_INCOMPLETE.',
  'Camino excepcional: compensar Arroz −1000 (append-only), tratar before NULL como apertura 0, exigir remaining=0, soft-delete.',
  'No modifica la política general del CPP.',
  null,
  null,
  null

order by 1, 2;

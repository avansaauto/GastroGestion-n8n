-- GastroGest / SENDA — diagnóstico SOLO LECTURA
-- Factura MAYORISTANET.COM S.A. 0012-00611278 (documento activo recibido)
-- Document id confirmado en entorno: ef01f3a8-0953-4d02-9849-cceee251f4f5
-- Sucursal Barrio Chino: d8d78b7d-eec5-4e90-8f2d-98268a875d00
--
-- Resultado esperado (evidencia ya tomada): bloqueo REVERSAL_DEPENDENT_MOVEMENTS
-- por ajustes posteriores en:
--   - Arroz Parboil Gallo Oro Bolsa (+1000, reason merma, 2026-10-27)
--   - Aros de Cebolla Rebozados Congelados Pickers Bolsa (+1000 / -1000, reason perdida, 2026-10-31)
-- Los otros 5 insumos no tienen movimientos posteriores.
-- NO ES un falso positivo de CPP: senda_cpp_replay_block_reason bloquea
-- cualquier movimiento no-purchase (o purchase qty<=0) posterior a la recepción.

with doc as (
  select id, location_id, document_number, issuer_name, status, deleted_at
  from public.purchase_documents
  where document_number = '0012-00611278'
    and deleted_at is null
    and status = 'received'
  order by created_at desc
  limit 1
),
receipts as (
  select r.id as receipt_id, r.purchase_document_line_id, r.quantity, r.created_at
  from public.purchase_document_receipts r
  join doc d on d.id = r.purchase_document_id
),
lines as (
  select l.id as line_id, l.inventory_product_id, l.reviewed_description, l.inventory_physical_quantity
  from public.purchase_document_lines l
  join receipts r on r.purchase_document_line_id = l.id
),
li as (
  select li.id as location_inventory_id, li.inventory_product_id, v.quantity_on_hand, v.average_unit_cost
  from public.location_inventory li
  join doc d on d.location_id = li.location_id
  join lines l on l.inventory_product_id = li.inventory_product_id
  left join public.inventory_valuations v on v.location_inventory_id = li.id
)
select
  p.name as product_name,
  r.quantity as received_qty,
  li.quantity_on_hand,
  li.average_unit_cost,
  m.id as movement_id,
  m.movement_type,
  m.quantity as movement_qty,
  m.source_type,
  m.source_id,
  m.created_at as movement_at,
  case
    when m.movement_type = 'purchase' and m.source_id::text = r.receipt_id::text then 'receipt'
    when m.created_at > purchase.created_at
      and (m.movement_type is distinct from 'purchase' or m.quantity <= 0)
      then 'BLOCKS_REVERSAL'
    else 'other'
  end as role
from receipts r
join lines l on l.line_id = r.purchase_document_line_id
join public.inventory_products p on p.id = l.inventory_product_id
join li on li.inventory_product_id = l.inventory_product_id
left join public.inventory_movements purchase
  on purchase.location_inventory_id = li.location_inventory_id
 and purchase.movement_type = 'purchase'
 and purchase.source_id::text = r.receipt_id::text
left join public.inventory_movements m
  on m.location_inventory_id = li.location_inventory_id
order by p.name, m.created_at nulls last;

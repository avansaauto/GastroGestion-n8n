-- SENDA OPS — rastro de SOLO LECTURA de una recepción.
-- No modifica tablas, políticas, grants ni datos. No llama RPCs.
-- Sustituir :document_id por el uuid de la factura (o filtrar por
-- document_number). Si no hay filas, no se asume pérdida: puede ser
-- otro local, otro status o una línea que nunca llamó al RPC de receive.

select
  d.id as document_id,
  d.document_number,
  d.document_date,
  d.status as document_status,
  d.location_id,
  d.organization_id,
  l.id as line_id,
  l.mapping_status,
  l.inventory_eligibility,
  l.classification,
  l.inventory_physical_quantity,
  l.inventory_product_id,
  l.reviewed_amount,
  l.original_amount,
  r.id as receipt_id,
  r.quantity as receipt_quantity,
  r.idempotency_key,
  r.created_at as received_at,
  r.inventory_movement_id,
  m.movement_type,
  m.quantity as movement_quantity,
  m.location_inventory_id,
  p.name as inventory_product_name,
  p.base_unit,
  p.active as product_active,
  iv.quantity_on_hand,
  iv.average_unit_cost,
  iv.last_purchase_unit_cost,
  iv.last_purchase_at
from public.purchase_documents d
join public.purchase_document_lines l
  on l.purchase_document_id = d.id
left join public.purchase_document_receipts r
  on r.purchase_document_line_id = l.id
left join public.inventory_movements m
  on m.id = r.inventory_movement_id
left join public.inventory_products p
  on p.id = coalesce(r.inventory_product_id, l.inventory_product_id)
left join public.location_inventory li
  on li.location_id = d.location_id
 and li.inventory_product_id = coalesce(r.inventory_product_id, l.inventory_product_id)
left join public.inventory_valuations iv
  on iv.location_inventory_id = li.id
where d.id = '00000000-0000-4000-8000-000000000000'
order by l.id, r.created_at;

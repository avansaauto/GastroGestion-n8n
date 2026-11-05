-- =============================================================================
-- SENDA OPS — Diagnóstico SOLO LECTURA: SENDA TEST + Ogham Barrio Chino
-- =============================================================================
-- Pegar en Supabase SQL Editor. NO ejecuta DML/DDL. No llama RPCs de escritura.
--
-- Objetivo: inventariar lo que existe en la base vs lo que la UI/API pueden
-- ocultar (p. ej. deleted_at IS NOT NULL, status cancelled, productos inactive).
--
-- Filtros por NOMBRE (sin UUID inventados). Proveedores ≠ negocios.
-- Si el nombre exacto no aparece, las secciones 0–1 listan candidatos.
--
-- Factura de error de borrado (referencia):
--   694d59af-d795-4f5d-92e0-cd1ee296ea88
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Esquema: columnas / tablas críticas presentes
-- -----------------------------------------------------------------------------
select
  '0_schema_tables' as section,
  c.relname as table_name,
  c.relkind
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'organizations',
    'locations',
    'organization_members',
    'suppliers',
    'purchase_documents',
    'purchase_document_lines',
    'purchase_document_receipts',
    'inventory_products',
    'location_inventory',
    'inventory_movements',
    'inventory_valuations',
    'inventory_cost_history',
    'inventory_adjustments',
    'purchase_invoice_deletion_log'
  )
order by c.relname;

select
  '0_schema_columns' as section,
  table_name,
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'organizations',
    'locations',
    'organization_members',
    'suppliers',
    'purchase_documents',
    'purchase_document_lines',
    'purchase_document_receipts',
    'inventory_products',
    'location_inventory',
    'inventory_movements',
    'inventory_valuations',
    'inventory_cost_history',
    'inventory_adjustments',
    'purchase_invoice_deletion_log'
  )
order by table_name, ordinal_position;

-- -----------------------------------------------------------------------------
-- 1) Candidatos de organización / local por nombre
--    (SENDA TEST, Ogham, Barrio Chino — y variantes cercanas)
-- -----------------------------------------------------------------------------
select
  '1_org_candidates' as section,
  o.id as organization_id,
  o.name as organization_name
from public.organizations o
where o.name ilike '%senda%'
   or o.name ilike '%ogham%'
   or o.name ilike '%test%'
order by o.name;

select
  '1_location_candidates' as section,
  l.id as location_id,
  l.name as location_name,
  l.organization_id,
  o.name as organization_name
from public.locations l
join public.organizations o on o.id = l.organization_id
where l.name ilike '%senda%'
   or l.name ilike '%ogham%'
   or l.name ilike '%chino%'
   or l.name ilike '%barrio%'
   or l.name ilike '%test%'
   or o.name ilike '%senda%'
   or o.name ilike '%ogham%'
order by o.name, l.name;

-- Columnas reales de suppliers (no asumir name / trade_name)
select
  '1_supplier_columns' as section,
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'suppliers'
order by ordinal_position;

-- Proveedores en orgs del ámbito (ids + org; el nombre comercial de factura
-- suele estar en purchase_documents.issuer_name, no en el negocio)
select
  '1_suppliers_in_scope_orgs' as section,
  s.id as supplier_id,
  s.organization_id,
  o.name as organization_name
from public.suppliers s
join public.organizations o on o.id = s.organization_id
where o.name ilike '%senda%'
   or o.name ilike '%ogham%'
   or o.name ilike 'SENDA TEST'
order by o.name, s.id;

-- -----------------------------------------------------------------------------
-- Ámbito de trabajo (CTE reutilizable en cada bloque vía WITH)
-- Orgs: nombre exacto o cercano a SENDA TEST / Ogham
-- Locales: Barrio Chino bajo Ogham; cualquier local de SENDA TEST
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 2) Identificadores y nombres reales del ámbito
-- -----------------------------------------------------------------------------
with target_orgs as (
  select o.id, o.name
  from public.organizations o
  where o.name ilike 'SENDA TEST'
     or o.name ilike 'Ogham%'
     or o.name ilike '%Ogham%'
),
target_locations as (
  select
    l.id as location_id,
    l.name as location_name,
    l.organization_id,
    o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where o.id in (select id from target_orgs)
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '2_scope_ids' as section,
  *
from target_locations
order by organization_name, location_name;

-- -----------------------------------------------------------------------------
-- 3) Membresías de las orgs del ámbito
-- -----------------------------------------------------------------------------
with target_orgs as (
  select o.id, o.name
  from public.organizations o
  where o.name ilike 'SENDA TEST'
     or o.name ilike 'Ogham%'
     or o.name ilike '%Ogham%'
)
select
  '3_memberships' as section,
  o.name as organization_name,
  m.organization_id,
  m.user_id,
  m.status
from public.organization_members m
join target_orgs o on o.id = m.organization_id
order by o.name, m.status, m.user_id;

-- -----------------------------------------------------------------------------
-- 4) Conteos de facturas por org/local (activas vs eliminadas lógicamente)
--    status: draft / reviewed / received / cancelled (CHECK confirmado)
-- -----------------------------------------------------------------------------
with target_locations as (
  select
    l.id as location_id,
    l.name as location_name,
    l.organization_id,
    o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '4_invoice_counts' as section,
  tl.organization_name,
  tl.location_name,
  tl.location_id,
  count(*) filter (
    where d.deleted_at is null
  ) as active_invoices,
  count(*) filter (
    where d.deleted_at is not null
  ) as logically_deleted_invoices,
  count(*) filter (
    where d.deleted_at is null and d.status = 'draft'
  ) as active_draft,
  count(*) filter (
    where d.deleted_at is null and d.status = 'reviewed'
  ) as active_reviewed,
  count(*) filter (
    where d.deleted_at is null and d.status = 'received'
  ) as active_received,
  count(*) filter (
    where d.deleted_at is null and d.status = 'cancelled'
  ) as active_cancelled,
  count(*) filter (
    where d.deleted_at is not null and d.status = 'reviewed'
  ) as deleted_reviewed,
  count(*) filter (
    where d.deleted_at is not null and d.status = 'received'
  ) as deleted_received,
  count(*) as total_rows
from target_locations tl
left join public.purchase_documents d on d.location_id = tl.location_id
group by tl.organization_name, tl.location_name, tl.location_id
order by tl.organization_name, tl.location_name;

-- -----------------------------------------------------------------------------
-- 5) Detalle de TODAS las facturas del ámbito (incl. eliminadas)
-- -----------------------------------------------------------------------------
with target_locations as (
  select
    l.id as location_id,
    l.name as location_name,
    l.organization_id,
    o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '5_all_invoices' as section,
  tl.organization_name,
  tl.location_name,
  d.id as purchase_document_id,
  d.supplier_id,
  d.issuer_name,
  d.document_number,
  d.document_date,
  d.status,
  d.location_id,
  d.organization_id,
  d.deleted_at,
  d.deleted_by,
  d.classification,
  d.eligible_line_count,
  d.unmapped_line_count,
  d.updated_at
from target_locations tl
join public.purchase_documents d on d.location_id = tl.location_id
order by tl.organization_name, tl.location_name, d.document_date desc nulls last, d.id;

-- -----------------------------------------------------------------------------
-- 6) Líneas y recepciones por factura
-- -----------------------------------------------------------------------------
with target_locations as (
  select
    l.id as location_id,
    l.name as location_name,
    l.organization_id,
    o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '6_lines_and_receipts_per_invoice' as section,
  tl.organization_name,
  tl.location_name,
  d.id as purchase_document_id,
  d.issuer_name,
  d.document_number,
  d.status,
  d.deleted_at,
  (select count(*) from public.purchase_document_lines l
    where l.purchase_document_id = d.id) as line_count,
  (select count(*) from public.purchase_document_receipts r
    where r.purchase_document_id = d.id) as receipt_count,
  (select coalesce(sum(r.quantity), 0) from public.purchase_document_receipts r
    where r.purchase_document_id = d.id) as receipt_qty_sum
from target_locations tl
join public.purchase_documents d on d.location_id = tl.location_id
order by tl.organization_name, d.document_date desc nulls last, d.id;

-- Detalle de recepciones
with target_locations as (
  select l.id as location_id
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '6b_receipt_detail' as section,
  d.id as purchase_document_id,
  d.issuer_name,
  d.status,
  d.deleted_at,
  rec.id as receipt_id,
  rec.purchase_document_line_id,
  rec.inventory_product_id,
  ip.name as product_name,
  ip.active as product_active,
  rec.location_inventory_id,
  rec.inventory_movement_id,
  rec.quantity,
  rec.location_id,
  rec.created_at
from public.purchase_document_receipts rec
join public.purchase_documents d on d.id = rec.purchase_document_id
left join public.inventory_products ip on ip.id = rec.inventory_product_id
where rec.location_id in (select location_id from target_locations)
order by d.document_date desc nulls last, rec.created_at, rec.id;

-- -----------------------------------------------------------------------------
-- 7) Productos de inventario (activos / inactivos) por org del ámbito
-- -----------------------------------------------------------------------------
with target_orgs as (
  select o.id, o.name
  from public.organizations o
  where o.name ilike 'SENDA TEST'
     or o.name ilike 'Ogham%'
     or o.name ilike '%Ogham%'
)
select
  '7_inventory_products' as section,
  o.name as organization_name,
  ip.id as inventory_product_id,
  ip.name,
  ip.base_unit,
  ip.active,
  ip.category
from public.inventory_products ip
join target_orgs o on o.id = ip.organization_id
order by o.name, ip.active desc, ip.name;

select
  '7b_product_counts' as section,
  o.name as organization_name,
  count(*) as total_products,
  count(*) filter (where ip.active is true) as active_products,
  count(*) filter (where ip.active is not true) as inactive_products
from public.inventory_products ip
join public.organizations o on o.id = ip.organization_id
where o.name ilike 'SENDA TEST'
   or o.name ilike 'Ogham%'
   or o.name ilike '%Ogham%'
group by o.name
order by o.name;

-- -----------------------------------------------------------------------------
-- 8) Stock actual por producto × local (+ costos unitarios)
-- -----------------------------------------------------------------------------
with target_locations as (
  select
    l.id as location_id,
    l.name as location_name,
    l.organization_id,
    o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '8_stock_and_costs' as section,
  tl.organization_name,
  tl.location_name,
  ip.id as inventory_product_id,
  ip.name as product_name,
  ip.active as product_active,
  li.id as location_inventory_id,
  li.active as location_inventory_active,
  coalesce(iv.quantity_on_hand, 0) as quantity_on_hand,
  case
    when coalesce(iv.quantity_on_hand, 0) > 0 then 'with_stock'
    else 'without_stock'
  end as stock_bucket,
  iv.average_unit_cost,
  iv.last_purchase_unit_cost,
  iv.currency,
  iv.last_purchase_at,
  iv.updated_at as valuation_updated_at
from target_locations tl
join public.location_inventory li on li.location_id = tl.location_id
join public.inventory_products ip on ip.id = li.inventory_product_id
left join public.inventory_valuations iv on iv.location_inventory_id = li.id
order by tl.organization_name, tl.location_name, ip.name;

select
  '8b_stock_summary' as section,
  tl.organization_name,
  tl.location_name,
  count(distinct li.id) as location_inventory_rows,
  count(distinct li.id) filter (
    where coalesce(iv.quantity_on_hand, 0) > 0
  ) as products_with_stock,
  count(distinct li.id) filter (
    where coalesce(iv.quantity_on_hand, 0) <= 0
  ) as products_without_stock,
  count(distinct ip.id) filter (where ip.active is true) as active_products_with_li,
  count(distinct ip.id) filter (where ip.active is not true) as inactive_products_with_li
from (
  select
    l.id as location_id,
    l.name as location_name,
    o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
) tl
left join public.location_inventory li on li.location_id = tl.location_id
left join public.inventory_products ip on ip.id = li.inventory_product_id
left join public.inventory_valuations iv on iv.location_inventory_id = li.id
group by tl.organization_name, tl.location_name
order by tl.organization_name, tl.location_name;

-- Productos de la org SIN location_inventory en el local del ámbito
with target_locations as (
  select
    l.id as location_id,
    l.name as location_name,
    l.organization_id,
    o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '8c_products_without_location_inventory' as section,
  tl.organization_name,
  tl.location_name,
  ip.id as inventory_product_id,
  ip.name,
  ip.active
from target_locations tl
join public.inventory_products ip on ip.organization_id = tl.organization_id
where not exists (
  select 1
  from public.location_inventory li
  where li.location_id = tl.location_id
    and li.inventory_product_id = ip.id
)
order by tl.organization_name, ip.name;

-- -----------------------------------------------------------------------------
-- 9) Movimientos de inventario vinculados a facturas (source_id = receipt_id)
-- -----------------------------------------------------------------------------
with target_locations as (
  select l.id as location_id, l.name as location_name, o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '9_invoice_linked_movements' as section,
  tl.organization_name,
  tl.location_name,
  d.id as purchase_document_id,
  d.issuer_name,
  d.status,
  d.deleted_at,
  rec.id as receipt_id,
  m.id as movement_id,
  m.movement_type,
  m.quantity,
  m.source_type,
  m.source_id,
  m.location_inventory_id,
  m.occurred_at,
  m.created_at
from target_locations tl
join public.purchase_documents d on d.location_id = tl.location_id
join public.purchase_document_receipts rec on rec.purchase_document_id = d.id
left join public.inventory_movements m
  on m.id = rec.inventory_movement_id
  or (m.source_id = rec.id)
order by d.document_date desc nulls last, rec.created_at;

-- -----------------------------------------------------------------------------
-- 10) Ajustes de inventario por eliminación (idempotency_key = receipt_id)
-- -----------------------------------------------------------------------------
with target_locations as (
  select l.id as location_id, l.name as location_name, o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '10_deletion_adjustments' as section,
  tl.organization_name,
  tl.location_name,
  d.id as purchase_document_id,
  d.deleted_at as document_deleted_at,
  rec.id as receipt_id,
  a.id as adjustment_id,
  a.quantity as adjustment_qty,
  a.previous_quantity_on_hand,
  a.next_quantity_on_hand,
  a.reason,
  a.idempotency_key,
  a.inventory_movement_id as compensation_movement_id,
  a.actor_user_id,
  a.created_at as adjustment_created_at
from target_locations tl
join public.purchase_documents d on d.location_id = tl.location_id
join public.purchase_document_receipts rec on rec.purchase_document_id = d.id
left join public.inventory_adjustments a
  on a.location_id = tl.location_id
 and a.idempotency_key = rec.id
order by d.deleted_at desc nulls last, a.created_at desc nulls last;

-- -----------------------------------------------------------------------------
-- 11) Historial de costos
--     Si falla “relation does not exist”: la etapa de costos no está instalada.
-- -----------------------------------------------------------------------------
select
  '11_cost_history' as section,
  o.name as organization_name,
  l.name as location_name,
  h.id as cost_history_id,
  h.inventory_product_id,
  ip.name as product_name,
  h.location_inventory_id,
  h.previous_unit_cost,
  h.new_unit_cost,
  h.source,
  h.source_ref,
  h.effective_at,
  h.recorded_at,
  h.purchase_quantity,
  h.purchase_cost,
  d.id as linked_document_id,
  d.issuer_name as linked_issuer,
  d.deleted_at as linked_document_deleted_at
from public.inventory_cost_history h
join public.organizations o on o.id = h.organization_id
join public.locations l on l.id = h.location_id
left join public.inventory_products ip on ip.id = h.inventory_product_id
left join public.purchase_document_receipts rec on rec.id = h.source_ref
left join public.purchase_documents d on d.id = rec.purchase_document_id
where (
    o.name ilike 'SENDA TEST'
    or o.name ilike 'Ogham%'
    or o.name ilike '%Ogham%'
  )
  and (
    o.name ilike 'SENDA TEST'
    or l.name ilike '%Barrio Chino%'
    or l.name ilike '%Chino%'
  )
order by h.recorded_at desc, h.id desc;

-- -----------------------------------------------------------------------------
-- 12) Log de eliminación de facturas
--     Si falla “relation does not exist”: aún no se instaló el RPC de delete.
-- -----------------------------------------------------------------------------
select
  '12_deletion_log' as section,
  o.name as organization_name,
  l.name as location_name,
  log.*
from public.purchase_invoice_deletion_log log
join public.organizations o on o.id = log.organization_id
join public.locations l on l.id = log.location_id
where o.name ilike 'SENDA TEST'
   or o.name ilike 'Ogham%'
   or o.name ilike '%Ogham%'
   or l.name ilike '%Barrio Chino%'
   or l.name ilike '%Chino%'
order by log.deleted_at desc;

-- -----------------------------------------------------------------------------
-- 13) Facturas en DB que la API de listado oculta
--     listSavedInvoices: deleted_at IS NULL AND status <> 'cancelled'
-- -----------------------------------------------------------------------------
with target_locations as (
  select
    l.id as location_id,
    l.name as location_name,
    o.name as organization_name
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '13_hidden_from_api_list' as section,
  tl.organization_name,
  tl.location_name,
  d.id as purchase_document_id,
  d.issuer_name,
  d.document_number,
  d.document_date,
  d.status,
  d.deleted_at,
  case
    when d.deleted_at is not null then 'hidden_logical_delete'
    when d.status = 'cancelled' then 'hidden_cancelled'
    else 'visible_in_list'
  end as api_list_visibility
from target_locations tl
join public.purchase_documents d on d.location_id = tl.location_id
where d.deleted_at is not null
   or d.status = 'cancelled'
order by api_list_visibility, d.document_date desc nulls last;

-- -----------------------------------------------------------------------------
-- 14) Referencias inconsistentes / huérfanos (ámbito)
-- -----------------------------------------------------------------------------
with target_locations as (
  select l.id as location_id, l.organization_id
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
-- 14a) receipt.location_inventory_id no coincide con location/product del recibo
select
  '14a_receipt_li_mismatch' as section,
  rec.id as receipt_id,
  rec.purchase_document_id,
  rec.location_id as receipt_location_id,
  rec.inventory_product_id as receipt_product_id,
  rec.location_inventory_id,
  li.location_id as li_location_id,
  li.inventory_product_id as li_product_id
from public.purchase_document_receipts rec
join target_locations tl on tl.location_id = rec.location_id
left join public.location_inventory li on li.id = rec.location_inventory_id
where rec.location_inventory_id is not null
  and (
    li.id is null
    or li.location_id is distinct from rec.location_id
    or li.inventory_product_id is distinct from rec.inventory_product_id
  );

-- 14b) receipt sin producto existente
with target_locations as (
  select l.id as location_id
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '14b_receipt_missing_product' as section,
  rec.id as receipt_id,
  rec.purchase_document_id,
  rec.inventory_product_id
from public.purchase_document_receipts rec
where rec.location_id in (select location_id from target_locations)
  and not exists (
    select 1 from public.inventory_products ip where ip.id = rec.inventory_product_id
  );

-- 14c) documentos con organization_id distinto al del local
with target_locations as (
  select l.id as location_id, l.organization_id
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '14c_document_org_location_mismatch' as section,
  d.id as purchase_document_id,
  d.organization_id as document_org,
  tl.organization_id as location_org,
  d.location_id,
  d.issuer_name,
  d.status,
  d.deleted_at
from public.purchase_documents d
join target_locations tl on tl.location_id = d.location_id
where d.organization_id is distinct from tl.organization_id;

-- 14d) líneas mapped sin inventory_product_id
with target_locations as (
  select l.id as location_id
  from public.locations l
  join public.organizations o on o.id = l.organization_id
  where (
      o.name ilike 'SENDA TEST'
      or o.name ilike 'Ogham%'
      or o.name ilike '%Ogham%'
    )
    and (
      o.name ilike 'SENDA TEST'
      or l.name ilike '%Barrio Chino%'
      or l.name ilike '%Chino%'
    )
)
select
  '14d_mapped_line_without_product' as section,
  l.id as line_id,
  l.purchase_document_id,
  l.mapping_status,
  l.inventory_product_id,
  l.original_description
from public.purchase_document_lines l
join public.purchase_documents d on d.id = l.purchase_document_id
where d.location_id in (select location_id from target_locations)
  and l.mapping_status = 'mapped'
  and l.inventory_product_id is null;

-- -----------------------------------------------------------------------------
-- 15) Factura del error de borrado (lectura puntual)
-- -----------------------------------------------------------------------------
select
  '15_failed_delete_document' as section,
  d.id,
  o.name as organization_name,
  loc.name as location_name,
  d.issuer_name,
  d.document_number,
  d.document_date,
  d.status,
  d.deleted_at,
  d.deleted_by,
  d.organization_id,
  d.location_id,
  d.supplier_id
from public.purchase_documents d
left join public.organizations o on o.id = d.organization_id
left join public.locations loc on loc.id = d.location_id
where d.id = '694d59af-d795-4f5d-92e0-cd1ee296ea88';

select
  '15b_failed_delete_receipts' as section,
  rec.*
from public.purchase_document_receipts rec
where rec.purchase_document_id = '694d59af-d795-4f5d-92e0-cd1ee296ea88'
order by rec.created_at, rec.id;

select
  '15c_failed_delete_cost_history' as section,
  h.*
from public.inventory_cost_history h
where h.source_ref in (
  select id from public.purchase_document_receipts
  where purchase_document_id = '694d59af-d795-4f5d-92e0-cd1ee296ea88'
)
order by h.recorded_at;

select
  '15d_failed_delete_log_row' as section,
  log.*
from public.purchase_invoice_deletion_log log
where log.purchase_document_id = '694d59af-d795-4f5d-92e0-cd1ee296ea88';

-- -----------------------------------------------------------------------------
-- Fin. Todas las consultas anteriores son SELECT / diagnóstico.
-- =============================================================================

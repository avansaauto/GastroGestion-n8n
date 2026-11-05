-- Diagnóstico solo lectura — pending resolved sin sales_product_mappings
-- NO escribe. Explica por qué el selector Fudo ocultaba productos vendidos.

-- Producto 60 / Barrio Chino
select
  'pending_60' as check_name,
  p.id,
  p.location_id,
  p.external_product_id,
  p.external_product_name,
  p.status,
  m.id as mapping_id,
  m.recipe_id,
  m.active as mapping_active
from public.pending_product_mappings p
left join public.sales_product_mappings m
  on m.location_id = p.location_id
 and m.source = p.source
 and m.external_product_id = p.external_product_id
where p.location_id = 'd8d78b7d-eec5-4e90-8f2d-98268a875d00'
  and p.source = 'fudo'
  and p.external_product_id = '60';

-- Huérfanos del local (resolved sin mapping activo)
select
  'orphans' as check_name,
  p.external_product_id,
  p.external_product_name,
  p.status,
  p.last_seen_at
from public.pending_product_mappings p
where p.location_id = 'd8d78b7d-eec5-4e90-8f2d-98268a875d00'
  and p.source = 'fudo'
  and p.status = 'resolved'
  and not exists (
    select 1
    from public.sales_product_mappings m
    where m.location_id = p.location_id
      and m.source = p.source
      and m.external_product_id = p.external_product_id
      and m.active is not false
  )
order by p.last_seen_at desc nulls last;

-- SENDA OPS — Inspección de SOLO LECTURA.
-- Definición de inventory_products_org_name_unique y duplicados activos.
-- No modifica tablas, índices, funciones ni filas. No es la migración.
--
-- Dónde: Supabase Dashboard → proyecto SENDA → SQL Editor → Run.
-- PostgREST no expone pg_catalog; este es el canal para ver la definición.

select
  c.relname as index_name,
  i.indisunique as is_unique,
  i.indisprimary as is_primary,
  pg_get_indexdef(i.indexrelid) as indexdef,
  pg_get_expr(i.indpred, i.indrelid) as partial_predicate,
  con.conname as constraint_name,
  con.contype as constraint_type,
  case when con.oid is null then null else pg_get_constraintdef(con.oid) end as constraintdef,
  case
    when con.oid is null then 'indice_independiente'
    when con.contype = 'u' then 'constraint_unique'
    else 'otra_constraint'
  end as association
from pg_class c
join pg_index i on i.indexrelid = c.oid
join pg_class t on t.oid = i.indrelid
join pg_namespace n on n.oid = t.relnamespace
left join pg_constraint con on con.conindid = c.oid
where n.nspname = 'public'
  and t.relname = 'inventory_products'
  and (
    c.relname = 'inventory_products_org_name_unique'
    or i.indisunique
  )
order by c.relname;

select
  count(*) filter (where active is true) as active_rows,
  count(*) filter (where active is false) as inactive_rows,
  count(*) filter (where active is null) as null_active_rows,
  count(*) as total_rows
from public.inventory_products;

-- Misma clave que la migración, escrita inline porque la función
-- senda_inventory_name_key todavía no existe.
select
  organization_id,
  btrim(regexp_replace(lower(translate(
    coalesce(name, ''),
    'ÁÀÄÂáàäâÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔóòöôÚÙÜÛúùüûÑñÇç',
    'AAAAAAAAEEEEEEEIIIIIIIIOOOOOOOOUUUUUUUUnnCc'
  )), '[^a-z0-9]+', ' ', 'g')) as name_key,
  count(*) as active_rows
from public.inventory_products
where active is true
group by organization_id, 2
having count(*) > 1;

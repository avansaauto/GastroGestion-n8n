-- SENDA OPS — Paso 335
-- Verificación de SOLO LECTURA tras aplicar migrate-inventory-reception.sql.
-- No modifica tablas, políticas ni datos. No crear recepciones de prueba.

select
  'purchase_document_receipts existe' as check_name,
  to_regclass('public.purchase_document_receipts') is not null as ok
union all
select
  'RPC receive definer',
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'senda_receive_purchase_document_line'
      and p.prosecdef
  )
union all
select
  'EXECUTE receive solo service_role',
  has_function_privilege(
    'service_role',
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)',
    'EXECUTE'
  )
union all
select
  'authenticated SELECT receipts',
  has_table_privilege('authenticated', 'public.purchase_document_receipts', 'SELECT')
  and not has_table_privilege('authenticated', 'public.purchase_document_receipts', 'INSERT')
union all
select
  'auditoria incluye invoice_line_received',
  exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'purchase_document_audit'
      and con.conname = 'purchase_document_audit_action_chk'
      and pg_get_constraintdef(con.oid) ilike '%invoice_line_received%'
  )
union all
select
  'received completo exige mapeo, producto y qty exacta',
  case
    when to_regprocedure('public.senda_purchase_document_is_fully_received(uuid)') is null then false
    else
      pg_get_functiondef('public.senda_purchase_document_is_fully_received(uuid)'::regprocedure)
        like '%mapping_status is distinct from ''mapped''%'
      and pg_get_functiondef('public.senda_purchase_document_is_fully_received(uuid)'::regprocedure)
        like '%inventory_physical_quantity, 0) <= 0%'
      and pg_get_functiondef('public.senda_purchase_document_is_fully_received(uuid)'::regprocedure)
        like '%is distinct from l.inventory_physical_quantity%'
  end
union all
select
  'received→received no revalida la reserva',
  case
    when to_regprocedure('public.purchase_documents_before_write()') is null then false
    else pg_get_functiondef('public.purchase_documents_before_write()'::regprocedure)
      like '%new.status = ''received'' and old.status is distinct from ''received''%'
  end
union all
select
  'save/map/cancel siguen existiendo',
  to_regprocedure('public.senda_save_purchase_invoice(jsonb)') is not null
  and to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is not null
  and to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is not null
union all
select
  'sin unique de un recibo por factura en la tabla nueva',
  not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'purchase_document_receipts'
      and con.contype = 'u'
      and pg_get_constraintdef(con.oid) ~* 'purchase_document_id\)'
      and pg_get_constraintdef(con.oid) !~* 'idempotency'
  );

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'purchase_document_receipts'
order by ordinal_position;

select pg_get_functiondef('public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure);

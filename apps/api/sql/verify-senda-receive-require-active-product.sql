-- SENDA OPS — Verificación de SOLO LECTURA tras aplicar
-- proposed-senda-receive-require-active-product.sql.
-- No modifica tablas, políticas, grants ni datos. No llama el RPC.

select
  'receive_rpc_installed' as check_id,
  to_regprocedure(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'
  ) is not null as ok
union all
select
  'blocks_product_inactive',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) ilike '%PRODUCT_INACTIVE%'
union all
select
  'reads_product_active',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) ilike '%v_product_active%'
union all
select
  'execute_service_only',
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
  'no_full_migrate_reinstall',
  pg_get_functiondef(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
  ) not ilike '%create table public.purchase_document_receipts%';

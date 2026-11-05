-- SENDA OPS — Verificación de SOLO LECTURA tras aplicar
-- hotfix-senda-delete-purchase-invoice.sql
-- (o proposed-senda-delete-purchase-invoice.sql).
-- No modifica tablas, políticas, grants ni datos. No llama el RPC.
--
-- Una sola lista de comprobaciones: imprime cada resultado (NOTICE) y
-- falla si CUALQUIERA devuelve false.
--
-- Pruebas que requieren escritura (stock, costos, idempotencia, rollback)
-- viven en proposed-senda-delete-purchase-invoice.functional-tests.sql
-- (BEGIN…ROLLBACK; no ejecutar contra producción sin autorización).

do $verify$
declare
  r record;
  v_failed text := null;
  v_body text;
begin
  if to_regprocedure('public.senda_delete_purchase_invoice(jsonb)') is null then
    raise exception 'DELETE_INVOICE_VERIFY_FAILED: falta senda_delete_purchase_invoice(jsonb)';
  end if;

  v_body := pg_get_functiondef('public.senda_delete_purchase_invoice(jsonb)'::regprocedure);

  for r in
    select check_id, ok
    from (
      select
        'delete_definer' as check_id,
        exists (
          select 1 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.oid = to_regprocedure('public.senda_delete_purchase_invoice(jsonb)')
            and p.prosecdef
        ) as ok
      union all
      select
        'execute_service_only',
        has_function_privilege('service_role', 'public.senda_delete_purchase_invoice(jsonb)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.senda_delete_purchase_invoice(jsonb)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.senda_delete_purchase_invoice(jsonb)', 'EXECUTE')
      union all
      select
        'no_session_replication_role',
        position(
          'session_replication' || '_role'
          in lower(v_body)
        ) = 0
      union all
      select
        'logical_delete_columns',
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'purchase_documents'
            and column_name = 'deleted_at'
        )
        and exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'purchase_documents'
            and column_name = 'deleted_by'
        )
      union all
      select
        'soft_delete_no_hard_delete',
        v_body ilike '%deleted_at%'
        and v_body not ilike '%delete from public.purchase_documents%'
        and v_body not ilike '%delete from public.purchase_document_receipts%'
      union all
      select
        'uses_adjust_rpc_not_manual_movements',
        v_body ilike '%senda_adjust_inventory_quantity%'
        and v_body ilike '%idempotency_key%'
        and v_body not ilike '%insert into public.inventory_movements%'
        and to_regprocedure('public.senda_adjust_inventory_quantity(jsonb)') is not null
      union all
      select
        'reverses_with_insufficient_stock_guard',
        v_body ilike '%REVERSAL_INSUFFICIENT_STOCK%'
      union all
      select
        'writes_deletion_log',
        to_regclass('public.purchase_invoice_deletion_log') is not null
        and v_body ilike '%purchase_invoice_deletion_log%'
      union all
      select
        'keeps_inventory_products_and_purchase_movements',
        v_body not ilike '%delete from public.inventory_products%'
        and v_body not ilike '%delete from public.inventory_movements%'
      union all
      select
        'cost_excludes_deleted_invoices',
        v_body ilike '%deleted_at is null%'
        and v_body ilike '%inventory_cost_history%'
        and v_body not ilike '%delete from public.inventory_cost_history%'
      union all
      select
        'cost_restore_null_when_no_prior',
        -- Asigna v_restore_cost directo (puede ser NULL); no coalesce a 0.
        v_body ilike '%average_unit_cost = v_restore_cost%'
        and v_body ilike '%last_purchase_unit_cost = v_restore_cost%'
        and v_body !~* 'average_unit_cost[[:space:]]*=[[:space:]]*coalesce[[:space:]]*\([[:space:]]*v_restore_cost'
        and v_body ilike '%when v_restore_cost is null then ''cleared''%'
      union all
      select
        'does_not_parse_constraintdef_in_rpc',
        v_body not ilike '%pg_get_constraintdef%'
      union all
      select
        'does_not_replace_receive_cancel_confirm_adjust',
        v_body not ilike '%create or replace function public.senda_receive%'
        and v_body not ilike '%create or replace function public.senda_confirm%'
        and v_body not ilike '%create or replace function public.senda_adjust%'
        and to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is not null
      union all
      select
        'protect_triggers_present',
        to_regprocedure('public.purchase_documents_protect_logical_delete()') is not null
        and to_regprocedure('public.purchase_document_receipts_block_deleted_document()') is not null
      union all
      select
        'abort_on_adjust_failure_when_inventory_exists',
        v_body ilike '%REVERSAL_ABORTED%'
        and v_body not ilike '%adjust_error%'
      union all
      select
        'missing_inventory_only_when_no_li_or_product',
        v_body ilike '%missing_inventory%'
        and v_body ilike '%product_missing%'
      union all
      select
        'idempotent_replay_by_receipt',
        v_body ilike '%already_reversed%'
        and v_body ilike '%inventory_adjustments%'
        and v_body ilike '%if v_deleted_at is not null%'
      union all
      select
        'rejects_inconsistent_location_inventory_ref',
        v_body ilike '%REVERSAL_INVENTORY_REF_MISMATCH%'
      union all
      select
        'cost_restore_avoids_loop_alias_r',
        v_body ilike '%purchase_document_receipts pr%'
        and v_body ilike '%pr.purchase_document_id%'
        -- No coincidir el prefijo de alias "rec".
        and v_body !~* 'from public\.purchase_document_receipts[[:space:]]+r[[:space:]/]'
        and v_body ilike '%for v_rec in%'
      union all
      select
        'allows_delete_without_receipts',
        -- Soft-delete ocurre tras el loop; receipts vacíos no abortan.
        v_body ilike '%set deleted_at = v_now%'
        and v_body ilike '%cardinality(v_receipt_ids)%'
      union all
      select
        'inactive_product_still_reverses_when_li_exists',
        v_body ilike '%product_inactive%'
        and v_body not ilike '%if%product_active%raise%'
    ) checks
    order by check_id
  loop
    raise notice 'delete_invoice_verify: % => %', r.check_id, r.ok;
    if not coalesce(r.ok, false) then
      v_failed := coalesce(v_failed || ', ', '') || r.check_id;
    end if;
  end loop;

  if v_failed is not null then
    raise exception 'DELETE_INVOICE_VERIFY_FAILED: %', v_failed;
  end if;

  raise notice 'delete_invoice_verify: ALL_CHECKS_PASSED';
end
$verify$;

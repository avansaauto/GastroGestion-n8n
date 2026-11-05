-- SENDA OPS — Paso 295
-- VERIFICACIÓN POST-MIGRACIÓN. SOLO LECTURA.
-- No modifica tablas, políticas, grants ni datos.
-- No llama RPC de escritura. No crea buckets. No escribe facturas.
--
-- Cuándo: después de ejecutar apps/api/sql/migrate-invoice-persistence.sql
-- Dónde: Supabase Dashboard → proyecto SENDA → SQL Editor.
-- Cómo: pegar el archivo entero y Run. Revisar que todo `ok` sea true.
-- Rol: postgres del dashboard (information_schema / pg_catalog).
--
-- Este archivo no autoriza endpoints ni un segundo COMMIT de migración.

-- =============================================================================
-- 1. Contrato: un renglón por chequeo (ok debe ser true)
-- =============================================================================
select check_id, check_name, expected, actual, ok
from (
  select
    'lines_table' as check_id,
    'Existe purchase_document_lines' as check_name,
    'present' as expected,
    case when to_regclass('public.purchase_document_lines') is null then 'missing' else 'present' end as actual,
    to_regclass('public.purchase_document_lines') is not null as ok
  union all
  select
    'audit_table',
    'Existe purchase_document_audit',
    'present',
    case when to_regclass('public.purchase_document_audit') is null then 'missing' else 'present' end,
    to_regclass('public.purchase_document_audit') is not null
  union all
  select
    'status_check',
    'CHECK de status intacto (draft/reviewed/received/cancelled)',
    'draft+reviewed+received+cancelled',
    coalesce((
      select pg_get_constraintdef(con.oid)
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'purchase_documents'
        and con.contype = 'c'
        and pg_get_constraintdef(con.oid) ilike '%status%'
      limit 1
    ), 'missing'),
    exists (
      select 1
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'purchase_documents'
        and con.contype = 'c'
        and pg_get_constraintdef(con.oid) ilike '%draft%'
        and pg_get_constraintdef(con.oid) ilike '%reviewed%'
        and pg_get_constraintdef(con.oid) ilike '%received%'
        and pg_get_constraintdef(con.oid) ilike '%cancelled%'
        and pg_get_constraintdef(con.oid) not ilike '%saved%'
        and pg_get_constraintdef(con.oid) not ilike '%voided%'
    )
  union all
  select
    'doc_columns',
    'Columnas de persistencia en purchase_documents',
    '20 columnas nuevas',
    (
      select count(*)::text
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'purchase_documents'
        and column_name in (
          'organization_id', 'classification', 'issuer_name', 'issuer_tax_id_normalized',
          'voucher_type', 'point_of_sale', 'voucher_number', 'file_sha256',
          'storage_bucket', 'storage_object_path', 'original_analysis', 'reviewed_analysis',
          'corrections', 'commercial_decisions', 'integrity_snapshot_sha256',
          'eligible_line_count', 'unmapped_line_count', 'fiscal_policy_applied',
          'fiscal_difference_accepted', 'created_by'
        )
    ),
    (
      select count(*) = 20
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'purchase_documents'
        and column_name in (
          'organization_id', 'classification', 'issuer_name', 'issuer_tax_id_normalized',
          'voucher_type', 'point_of_sale', 'voucher_number', 'file_sha256',
          'storage_bucket', 'storage_object_path', 'original_analysis', 'reviewed_analysis',
          'corrections', 'commercial_decisions', 'integrity_snapshot_sha256',
          'eligible_line_count', 'unmapped_line_count', 'fiscal_policy_applied',
          'fiscal_difference_accepted', 'created_by'
        )
    )
  union all
  select
    'fiscal_col',
    'organizations.invoice_fiscal_tolerances',
    'present',
    case when exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'organizations'
        and column_name = 'invoice_fiscal_tolerances'
    ) then 'present' else 'missing' end,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'organizations'
        and column_name = 'invoice_fiscal_tolerances'
    )
  union all
  select
    'hash_uniq',
    'Índice único (org, file_sha256) excluye cancelled',
    'purchase_documents_file_sha256_uniq',
    coalesce((
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'purchase_documents_file_sha256_uniq'
    ), 'missing'),
    exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = 'purchase_documents_file_sha256_uniq'
        and indexdef ilike '%file_sha256%'
        and indexdef ilike '%cancelled%'
    )
  union all
  select
    'voucher_uniq',
    'Índice único fiscal excluye cancelled',
    'purchase_documents_voucher_uniq',
    coalesce((
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'purchase_documents_voucher_uniq'
    ), 'missing'),
    exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = 'purchase_documents_voucher_uniq'
        and indexdef ilike '%issuer_tax_id_normalized%'
        and indexdef ilike '%cancelled%'
    )
  union all
  select
    'qty_chk',
    'CHECK qty fisica requiere producto',
    'purchase_document_lines_qty_requires_product_chk',
    coalesce((
      select pg_get_constraintdef(con.oid)
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'purchase_document_lines'
        and con.conname = 'purchase_document_lines_qty_requires_product_chk'
    ), 'missing'),
    exists (
      select 1
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'purchase_document_lines'
        and con.conname = 'purchase_document_lines_qty_requires_product_chk'
        and pg_get_constraintdef(con.oid) ilike '%inventory_product_id%is not null%'
        and pg_get_constraintdef(con.oid) ~* 'inventory_physical_quantity\s*=\s*\(?0'
    )
  union all
  select
    'rls_docs',
    'RLS en purchase_documents',
    'true',
    (
      select c.relrowsecurity::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'purchase_documents'
    ),
    exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'purchase_documents' and c.relrowsecurity
    )
  union all
  select
    'rls_lines',
    'RLS en purchase_document_lines',
    'true',
    (
      select c.relrowsecurity::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'purchase_document_lines'
    ),
    exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'purchase_document_lines' and c.relrowsecurity
    )
  union all
  select
    'rls_audit',
    'RLS en purchase_document_audit',
    'true',
    (
      select c.relrowsecurity::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'purchase_document_audit'
    ),
    exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'purchase_document_audit' and c.relrowsecurity
    )
  union all
  select
    'fn_save',
    'RPC save (jsonb) SECURITY DEFINER',
    'senda_save_purchase_invoice(jsonb) definer',
    case
      when to_regprocedure('public.senda_save_purchase_invoice(jsonb)') is null then 'missing'
      else (
        select format('%s(%s) definer=%s', p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef)
        from pg_proc p
        where p.oid = to_regprocedure('public.senda_save_purchase_invoice(jsonb)')
      )
    end,
    to_regprocedure('public.senda_save_purchase_invoice(jsonb)') is not null
      and exists (
        select 1 from pg_proc p
        where p.oid = to_regprocedure('public.senda_save_purchase_invoice(jsonb)')
          and p.prosecdef
      )
  union all
  select
    'fn_cancel',
    'RPC cancel (uuid, uuid) SECURITY DEFINER',
    'senda_cancel_purchase_invoice(uuid, uuid) definer',
    case
      when to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is null then 'missing'
      else (
        select format('%s(%s) definer=%s', p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef)
        from pg_proc p
        where p.oid = to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)')
      )
    end,
    to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is not null
      and exists (
        select 1 from pg_proc p
        where p.oid = to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)')
          and p.prosecdef
      )
  union all
  select
    'fn_map',
    'RPC map (uuid, uuid, numeric, uuid) SECURITY DEFINER',
    'senda_map_purchase_document_line(..., actor) definer',
    case
      when to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is null then 'missing'
      else (
        select format('%s(%s) definer=%s', p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef)
        from pg_proc p
        where p.oid = to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)')
      )
    end,
    to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is not null
      and exists (
        select 1 from pg_proc p
        where p.oid = to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)')
          and p.prosecdef
      )
  union all
  select
    'old_cancel',
    'Sin overload cancel(uuid)',
    'absent',
    case when to_regprocedure('public.senda_cancel_purchase_invoice(uuid)') is null
      then 'absent' else 'present' end,
    to_regprocedure('public.senda_cancel_purchase_invoice(uuid)') is null
  union all
  select
    'old_map',
    'Sin overload map(uuid, uuid, numeric)',
    'absent',
    case when to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric)') is null
      then 'absent' else 'present' end,
    to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric)') is null
  union all
  select
    'save_body',
    'Save llama a senda_require_backend_actor',
    'senda_require_backend_actor',
    case
      when to_regprocedure('public.senda_save_purchase_invoice(jsonb)') is null then 'missing'
      when pg_get_functiondef('public.senda_save_purchase_invoice(jsonb)'::regprocedure)
           like '%senda_require_backend_actor%'
        then 'ok'
      else 'mismatch'
    end,
    to_regprocedure('public.senda_save_purchase_invoice(jsonb)') is not null
      and pg_get_functiondef('public.senda_save_purchase_invoice(jsonb)'::regprocedure)
          like '%senda_require_backend_actor%'
  union all
  select
    'cancel_body',
    'Cancel llama a senda_require_backend_actor',
    'senda_require_backend_actor',
    case
      when to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is null then 'missing'
      when pg_get_functiondef('public.senda_cancel_purchase_invoice(uuid, uuid)'::regprocedure)
           like '%senda_require_backend_actor%'
        then 'ok'
      else 'mismatch'
    end,
    to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is not null
      and pg_get_functiondef('public.senda_cancel_purchase_invoice(uuid, uuid)'::regprocedure)
          like '%senda_require_backend_actor%'
  union all
  select
    'map_body',
    'Map llama a senda_require_backend_actor',
    'senda_require_backend_actor',
    case
      when to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is null then 'missing'
      when pg_get_functiondef('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)'::regprocedure)
           like '%senda_require_backend_actor%'
        then 'ok'
      else 'mismatch'
    end,
    to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is not null
      and pg_get_functiondef('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)'::regprocedure)
          like '%senda_require_backend_actor%'
  union all
  select
    'require_body',
    'require_backend_actor exige service_role y actor no nulo',
    'BACKEND_ROLE_REQUIRED + ACTOR_REQUIRED',
    case
      when to_regprocedure('public.senda_require_backend_actor(uuid)') is null then 'missing'
      when pg_get_functiondef('public.senda_require_backend_actor(uuid)'::regprocedure)
             like '%BACKEND_ROLE_REQUIRED%'
           and pg_get_functiondef('public.senda_require_backend_actor(uuid)'::regprocedure)
             like '%service_role%'
           and pg_get_functiondef('public.senda_require_backend_actor(uuid)'::regprocedure)
             like '%ACTOR_REQUIRED%'
           and pg_get_functiondef('public.senda_require_backend_actor(uuid)'::regprocedure)
             like '%p_user_id is null%'
        then 'ok'
      else 'mismatch'
    end,
    to_regprocedure('public.senda_require_backend_actor(uuid)') is not null
      and pg_get_functiondef('public.senda_require_backend_actor(uuid)'::regprocedure)
          like '%BACKEND_ROLE_REQUIRED%'
      and pg_get_functiondef('public.senda_require_backend_actor(uuid)'::regprocedure)
          like '%service_role%'
      and pg_get_functiondef('public.senda_require_backend_actor(uuid)'::regprocedure)
          like '%ACTOR_REQUIRED%'
      and pg_get_functiondef('public.senda_require_backend_actor(uuid)'::regprocedure)
          like '%p_user_id is null%'
  union all
  select
    'exec_save_auth',
    'authenticated sin EXECUTE de save',
    'false',
    case
      when to_regprocedure('public.senda_save_purchase_invoice(jsonb)') is null then 'missing'
      else has_function_privilege(
        'authenticated',
        'public.senda_save_purchase_invoice(jsonb)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_save_purchase_invoice(jsonb)') is not null
      and not has_function_privilege(
        'authenticated',
        'public.senda_save_purchase_invoice(jsonb)',
        'EXECUTE'
      )
  union all
  select
    'exec_cancel_auth',
    'authenticated sin EXECUTE de cancel',
    'false',
    case
      when to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is null then 'missing'
      else has_function_privilege(
        'authenticated',
        'public.senda_cancel_purchase_invoice(uuid, uuid)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is not null
      and not has_function_privilege(
        'authenticated',
        'public.senda_cancel_purchase_invoice(uuid, uuid)',
        'EXECUTE'
      )
  union all
  select
    'exec_map_auth',
    'authenticated sin EXECUTE de map',
    'false',
    case
      when to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is null then 'missing'
      else has_function_privilege(
        'authenticated',
        'public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is not null
      and not has_function_privilege(
        'authenticated',
        'public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)',
        'EXECUTE'
      )
  union all
  select
    'exec_save_service',
    'service_role EXECUTE de save',
    'true',
    case
      when to_regprocedure('public.senda_save_purchase_invoice(jsonb)') is null then 'missing'
      else has_function_privilege(
        'service_role',
        'public.senda_save_purchase_invoice(jsonb)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_save_purchase_invoice(jsonb)') is not null
      and has_function_privilege(
        'service_role',
        'public.senda_save_purchase_invoice(jsonb)',
        'EXECUTE'
      )
  union all
  select
    'exec_cancel_service',
    'service_role EXECUTE de cancel',
    'true',
    case
      when to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is null then 'missing'
      else has_function_privilege(
        'service_role',
        'public.senda_cancel_purchase_invoice(uuid, uuid)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_cancel_purchase_invoice(uuid, uuid)') is not null
      and has_function_privilege(
        'service_role',
        'public.senda_cancel_purchase_invoice(uuid, uuid)',
        'EXECUTE'
      )
  union all
  select
    'exec_map_service',
    'service_role EXECUTE de map',
    'true',
    case
      when to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is null then 'missing'
      else has_function_privilege(
        'service_role',
        'public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is not null
      and has_function_privilege(
        'service_role',
        'public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)',
        'EXECUTE'
      )
  union all
  select
    'exec_member_auth',
    'authenticated EXECUTE de senda_is_purchase_member',
    'true',
    case
      when to_regprocedure('public.senda_is_purchase_member(uuid)') is null then 'missing'
      else has_function_privilege(
        'authenticated',
        'public.senda_is_purchase_member(uuid)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_is_purchase_member(uuid)') is not null
      and has_function_privilege(
        'authenticated',
        'public.senda_is_purchase_member(uuid)',
        'EXECUTE'
      )
  union all
  select
    'exec_actor_auth',
    'authenticated sin EXECUTE de senda_actor_is_purchase_member',
    'false',
    case
      when to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then 'missing'
      else has_function_privilege(
        'authenticated',
        'public.senda_actor_is_purchase_member(uuid, uuid)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is not null
      and not has_function_privilege(
        'authenticated',
        'public.senda_actor_is_purchase_member(uuid, uuid)',
        'EXECUTE'
      )
  union all
  select
    'exec_require_auth',
    'authenticated sin EXECUTE de senda_require_backend_actor',
    'false',
    case
      when to_regprocedure('public.senda_require_backend_actor(uuid)') is null then 'missing'
      else has_function_privilege(
        'authenticated',
        'public.senda_require_backend_actor(uuid)',
        'EXECUTE'
      )::text
    end,
    to_regprocedure('public.senda_require_backend_actor(uuid)') is not null
      and not has_function_privilege(
        'authenticated',
        'public.senda_require_backend_actor(uuid)',
        'EXECUTE'
      )
  union all
  select
    'tbl_docs_auth_write',
    'authenticated sin INSERT/UPDATE/DELETE en documentos',
    'false,false,false',
    case when to_regclass('public.purchase_documents') is null then 'missing' else concat_ws(',',
      has_table_privilege('authenticated', 'public.purchase_documents', 'INSERT')::text,
      has_table_privilege('authenticated', 'public.purchase_documents', 'UPDATE')::text,
      has_table_privilege('authenticated', 'public.purchase_documents', 'DELETE')::text
    ) end,
    to_regclass('public.purchase_documents') is not null
      and not has_table_privilege('authenticated', 'public.purchase_documents', 'INSERT')
      and not has_table_privilege('authenticated', 'public.purchase_documents', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.purchase_documents', 'DELETE')
  union all
  select
    'tbl_lines_auth_write',
    'authenticated sin INSERT/UPDATE/DELETE en lineas',
    'false,false,false',
    case when to_regclass('public.purchase_document_lines') is null then 'missing' else concat_ws(',',
      has_table_privilege('authenticated', 'public.purchase_document_lines', 'INSERT')::text,
      has_table_privilege('authenticated', 'public.purchase_document_lines', 'UPDATE')::text,
      has_table_privilege('authenticated', 'public.purchase_document_lines', 'DELETE')::text
    ) end,
    to_regclass('public.purchase_document_lines') is not null
      and not has_table_privilege('authenticated', 'public.purchase_document_lines', 'INSERT')
      and not has_table_privilege('authenticated', 'public.purchase_document_lines', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.purchase_document_lines', 'DELETE')
  union all
  select
    'tbl_audit_auth_write',
    'authenticated sin INSERT/UPDATE/DELETE en auditoria',
    'false,false,false',
    case when to_regclass('public.purchase_document_audit') is null then 'missing' else concat_ws(',',
      has_table_privilege('authenticated', 'public.purchase_document_audit', 'INSERT')::text,
      has_table_privilege('authenticated', 'public.purchase_document_audit', 'UPDATE')::text,
      has_table_privilege('authenticated', 'public.purchase_document_audit', 'DELETE')::text
    ) end,
    to_regclass('public.purchase_document_audit') is not null
      and not has_table_privilege('authenticated', 'public.purchase_document_audit', 'INSERT')
      and not has_table_privilege('authenticated', 'public.purchase_document_audit', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.purchase_document_audit', 'DELETE')
  union all
  select
    'tbl_docs_auth_select',
    'authenticated SELECT documentos',
    'true',
    case when to_regclass('public.purchase_documents') is null then 'missing'
         else has_table_privilege('authenticated', 'public.purchase_documents', 'SELECT')::text end,
    to_regclass('public.purchase_documents') is not null
      and has_table_privilege('authenticated', 'public.purchase_documents', 'SELECT')
  union all
  select
    'tbl_service_write',
    'service_role sin INSERT/UPDATE/DELETE en documentos',
    'false,false,false',
    case when to_regclass('public.purchase_documents') is null then 'missing' else concat_ws(',',
      has_table_privilege('service_role', 'public.purchase_documents', 'INSERT')::text,
      has_table_privilege('service_role', 'public.purchase_documents', 'UPDATE')::text,
      has_table_privilege('service_role', 'public.purchase_documents', 'DELETE')::text
    ) end,
    to_regclass('public.purchase_documents') is not null
      and not has_table_privilege('service_role', 'public.purchase_documents', 'INSERT')
      and not has_table_privilege('service_role', 'public.purchase_documents', 'UPDATE')
      and not has_table_privilege('service_role', 'public.purchase_documents', 'DELETE')
  union all
  select
    'no_inventory_triggers',
    'Sin triggers nuevos en inventory_* / purchase_items / receipts',
    '0 senda/purchase_document',
    (
      select count(*)::text
      from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_table in (
          'purchase_items', 'purchase_receipts',
          'inventory_products', 'location_inventory',
          'inventory_valuations', 'inventory_movements'
        )
        and (
          trigger_name ilike '%senda%'
          or trigger_name ilike '%purchase_document%'
          or action_statement ilike '%purchase_document%'
        )
    ),
    not exists (
      select 1
      from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_table in (
          'purchase_items', 'purchase_receipts',
          'inventory_products', 'location_inventory',
          'inventory_valuations', 'inventory_movements'
        )
        and (
          trigger_name ilike '%senda%'
          or trigger_name ilike '%purchase_document%'
          or action_statement ilike '%purchase_document%'
        )
    )
) checks
order by check_id;

-- Si alguna fila del bloque 1 tiene ok = false, no aplicar más pasos: revisar grants/default privileges.

-- =============================================================================
-- 2. Grants crudos (tablas de persistencia)
-- =============================================================================
select table_name, grantee, privilege_type, is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'purchase_documents', 'purchase_document_lines', 'purchase_document_audit'
  )
order by table_name, grantee, privilege_type;

-- =============================================================================
-- 3. EXECUTE crudo (funciones senda_* y triggers)
-- =============================================================================
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as args,
  r.rolname as grantee,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') as has_execute,
  p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public'
  and p.proname in (
    'senda_save_purchase_invoice',
    'senda_cancel_purchase_invoice',
    'senda_map_purchase_document_line',
    'senda_is_purchase_member',
    'senda_actor_is_purchase_member',
    'senda_require_backend_actor',
    'purchase_documents_before_write',
    'purchase_document_lines_before_write',
    'purchase_document_audit_before_write'
  )
  and r.rolname in ('anon', 'authenticated', 'service_role')
order by p.proname, args, r.rolname;

-- =============================================================================
-- 4. Políticas RLS
-- =============================================================================
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'purchase_documents', 'purchase_document_lines', 'purchase_document_audit'
  )
order by tablename, policyname;

-- =============================================================================
-- 5. Triggers
-- =============================================================================
select event_object_table, trigger_name, action_timing, event_manipulation, action_statement
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table in (
    'purchase_documents', 'purchase_document_lines', 'purchase_document_audit'
  )
order by event_object_table, trigger_name;

-- =============================================================================
-- 6. Conteos (no deben haber subido por esta migración)
-- =============================================================================
select 'purchase_documents' as object, count(*)::bigint as n from purchase_documents
union all select 'purchase_document_lines', count(*) from purchase_document_lines
union all select 'purchase_document_audit', count(*) from purchase_document_audit
union all select 'purchase_items', count(*) from purchase_items
union all select 'purchase_receipts', count(*) from purchase_receipts
union all select 'suppliers', count(*) from suppliers
union all select 'inventory_products', count(*) from inventory_products
union all select 'location_inventory', count(*) from location_inventory
union all select 'inventory_valuations', count(*) from inventory_valuations
union all select 'inventory_movements', count(*) from inventory_movements
order by 1;

-- =============================================================================
-- 7. Storage (la migración no crea bucket)
-- =============================================================================
select id, name, public, created_at
from storage.buckets
order by name;

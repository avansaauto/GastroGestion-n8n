-- SENDA OPS — Verificación de SOLO LECTURA tras aplicar
-- proposed-senda-confirm-purchase-invoice-intake.sql.
-- No modifica tablas, políticas, grants ni datos. No llama el RPC.
-- Si un chequeo falla, el bloque final aborta.
--
-- Pruebas funcionales (rollback / reintento / parcial) con fixtures:
-- apps/api/sql/test-senda-confirm-purchase-invoice-intake.sql

select
  'confirm_definer' as check_id,
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure('public.senda_confirm_purchase_invoice_intake(jsonb)')
      and p.prosecdef
  ) as ok
union all
select
  'ensure_definer',
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure('public.senda_ensure_inventory_product_for_intake(jsonb)')
      and p.prosecdef
  )
union all
select
  'execute_service_only_confirm',
  to_regprocedure('public.senda_confirm_purchase_invoice_intake(jsonb)') is not null
    and has_function_privilege('service_role', 'public.senda_confirm_purchase_invoice_intake(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.senda_confirm_purchase_invoice_intake(jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.senda_confirm_purchase_invoice_intake(jsonb)', 'EXECUTE')
union all
select
  'ensure_not_executable_externally',
  to_regprocedure('public.senda_ensure_inventory_product_for_intake(jsonb)') is not null
    and not has_function_privilege('service_role', 'public.senda_ensure_inventory_product_for_intake(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.senda_ensure_inventory_product_for_intake(jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.senda_ensure_inventory_product_for_intake(jsonb)', 'EXECUTE')
union all
select
  'reuses_map_receive_active',
  pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%senda_map_purchase_document_line%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%senda_receive_purchase_document_line%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%senda_set_inventory_product_active%'
union all
select
  'no_inline_movements_or_cost',
  pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    not ilike '%insert into public.inventory_movements%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    not ilike '%average_unit_cost%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    not ilike '%purchase_cost%'
union all
select
  'attempts_table_and_unique_key',
  to_regclass('public.purchase_document_confirm_attempts') is not null
  and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_document_confirm_attempts'
      and column_name = 'confirm_idempotency_key'
  )
  and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_document_confirm_attempts'
      and column_name = 'payload_digest'
  )
  and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_document_confirm_attempts'
      and column_name = 'result'
  )
  and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_document_confirm_attempts'
      and column_name = 'status'
  )
  and exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'purchase_document_confirm_attempts'
      and c.contype = 'u'
      and pg_get_constraintdef(c.oid) ilike '%confirm_idempotency_key%'
  )
union all
select
  'attempts_select_authenticated_insert_service',
  has_table_privilege('authenticated', 'public.purchase_document_confirm_attempts', 'SELECT')
  and has_table_privilege('service_role', 'public.purchase_document_confirm_attempts', 'INSERT')
  and not has_table_privilege('authenticated', 'public.purchase_document_confirm_attempts', 'INSERT')
  and not has_table_privilege('anon', 'public.purchase_document_confirm_attempts', 'SELECT')
union all
select
  'idempotency_replay_and_conflict',
  pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%purchase_document_confirm_attempts%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%CONFIRM_IDEMPOTENCY_CONFLICT%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%idempotent%'
union all
select
  'pending_guard_and_partial_receive',
  pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%PENDING_NOT_ALLOWED%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%RECEIPT_EXCEEDS_INVOICED%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%LINE_HAS_RECEIPTS%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%LINE_ALREADY_MAPPED%'
union all
select
  'validates_duplicates_active_units',
  pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%DUPLICATE_LINE%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%LINES_MISMATCH%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%PRODUCT_INACTIVE%'
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%INCOMPATIBLE_UNITS%'
union all
select
  'ensure_validates_actor_org_location_no_fallback',
  pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%senda_require_backend_actor%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%LOCATION_ORG_MISMATCH%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%NOT_A_MEMBER%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%minimum_stock%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    not ilike '%undefined_column%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%category%'
union all
select
  'audit_preserves_actions_plus_intake',
  exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'purchase_document_audit'
      and c.conname = 'purchase_document_audit_action_chk'
      and pg_get_constraintdef(c.oid) ilike '%invoice_intake_confirmed%'
      and pg_get_constraintdef(c.oid) ilike '%invoice_reviewed%'
      and pg_get_constraintdef(c.oid) ilike '%invoice_cancelled%'
      and pg_get_constraintdef(c.oid) ilike '%invoice_line_mapped%'
      and pg_get_constraintdef(c.oid) ilike '%invoice_line_received%'
  )
union all
select
  'conversion_helpers_internal',
  to_regprocedure('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)') is not null
  and to_regprocedure('public.senda_confirm_intake_canonical_unit(text)') is not null
  and not has_function_privilege(
    'service_role',
    'public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)',
    'EXECUTE'
  )
  and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
    ilike '%senda_confirm_intake_assert_physical%'
  and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
    ilike '%EQUIVALENCE_REQUIRED%'
  and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
    ilike '%INVALID_CONVERSION%'
  and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
    ilike '%INCOMPATIBLE_UNITS%'
union all
select
  'blocks_only_active_name',
  pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%DUPLICATE_PRODUCT%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%ip.active is true%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    not ilike '%INACTIVE_PRODUCT_EXISTS%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    not ilike '%update public.inventory_products%'
union all
select
  'ensure_concurrent_name_lock',
  pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%pg_advisory_xact_lock%'
  and pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
    ilike '%hashtext%'
  and strpos(
    lower(pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)),
    'pg_advisory_xact_lock'
  ) < strpos(
    lower(pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)),
    'duplicate_product'
  )
union all
select
  'preflight_required_category',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_products'
      and column_name = 'category'
  )
union all
select
  'receive_cost_still_in_receive_rpc',
  to_regprocedure(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'
  ) is not null
  and (
    pg_get_functiondef(
      'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
    ) ilike '%purchase_cost%'
    or pg_get_functiondef(
      'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure
    ) ilike '%inventory_valuations%'
  );

do $fail$
begin
  if exists (
    select 1
    from (
      select
        'confirm_definer' as check_id,
        exists (
          select 1 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.oid = to_regprocedure('public.senda_confirm_purchase_invoice_intake(jsonb)')
            and p.prosecdef
        ) as ok
      union all
      select
        'execute_service_only_confirm',
        to_regprocedure('public.senda_confirm_purchase_invoice_intake(jsonb)') is not null
          and has_function_privilege('service_role', 'public.senda_confirm_purchase_invoice_intake(jsonb)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.senda_confirm_purchase_invoice_intake(jsonb)', 'EXECUTE')
      union all
      select
        'ensure_not_executable_externally',
        to_regprocedure('public.senda_ensure_inventory_product_for_intake(jsonb)') is not null
          and not has_function_privilege('service_role', 'public.senda_ensure_inventory_product_for_intake(jsonb)', 'EXECUTE')
      union all
      select
        'attempts_table_and_unique_key',
        to_regclass('public.purchase_document_confirm_attempts') is not null
      union all
      select
        'idempotency_replay_and_conflict',
        pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
          ilike '%CONFIRM_IDEMPOTENCY_CONFLICT%'
      union all
      select
        'pending_guard_and_partial_receive',
        pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
          ilike '%PENDING_NOT_ALLOWED%'
      union all
      select
        'audit_preserves_actions_plus_intake',
        exists (
          select 1
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
          where n.nspname = 'public'
            and t.relname = 'purchase_document_audit'
            and c.conname = 'purchase_document_audit_action_chk'
            and pg_get_constraintdef(c.oid) ilike '%invoice_intake_confirmed%'
            and pg_get_constraintdef(c.oid) ilike '%invoice_line_received%'
        )
      union all
      select
        'conversion_helpers_internal',
        to_regprocedure('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)') is not null
          and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
            ilike '%senda_confirm_intake_assert_physical%'
      union all
      select
        'ensure_concurrent_name_lock',
        pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)
          ilike '%pg_advisory_xact_lock%'
          and strpos(
            lower(pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)),
            'pg_advisory_xact_lock'
          ) < strpos(
            lower(pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure)),
            'duplicate_product'
          )
    ) checks
    where not ok
  ) then
    raise exception 'CONFIRM_INTAKE_VERIFY_FAILED';
  end if;
end
$fail$;

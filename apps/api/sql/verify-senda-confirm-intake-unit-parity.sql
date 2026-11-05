-- SENDA OPS — Verificación de solo lectura de la paridad de unidades.
-- Correr DESPUÉS de proposed-senda-confirm-intake-unit-parity.sql.
-- No escribe. Cada fila debe quedar ok = true.
-- Proyecto SENDA. No GastroGest.

select check_name, ok
from (
  select
    'helpers_present' as check_name,
    to_regprocedure('public.senda_confirm_intake_canonical_unit(text)') is not null
    and to_regprocedure('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)') is not null
      as ok
  union all
  select
    'helpers_not_executable_by_service_role',
    not has_function_privilege(
      'service_role',
      'public.senda_confirm_intake_canonical_unit(text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)',
      'EXECUTE'
    )
  union all
  select
    'packaging_matches_invoice_units',
    pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''barra''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''barras''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''plancha''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''planchas''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''botella''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''botellas''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''horma''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''hormas''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''bloque''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure)
      ilike '%''bloques''%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%''barra''%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%''plancha''%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%''botella''%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%''horma''%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%''bloque''%'
  union all
  select
    'si_aliases_present',
    pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure) ilike '%''cl''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure) ilike '%''mg''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure) ilike '%''docena''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure) ilike '%''uni''%'
    and pg_get_functiondef('public.senda_confirm_intake_canonical_unit(text)'::regprocedure) ilike '%''und''%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%when ''cl'' then 10%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%when ''mg'' then 0.001%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%when ''docena'' then 12%'
  union all
  select
    'rejection_rules_kept',
    pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%EQUIVALENCE_REQUIRED%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%INVALID_CONVERSION%'
    and pg_get_functiondef('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)'::regprocedure)
      ilike '%INCOMPATIBLE_UNITS%'
  union all
  select
    'confirm_rpc_unchanged_caller',
    pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
      ilike '%senda_confirm_intake_assert_physical%'
    and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
      ilike '%CONFIRM_IDEMPOTENCY_CONFLICT%'
    and pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure)
      not ilike '%insert into public.inventory_movements%'
) checks
order by check_name;

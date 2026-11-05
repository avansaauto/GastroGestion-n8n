-- SENDA OPS — Obsoleto: usar hotfix-senda-delete-purchase-invoice.sql
-- ============================================================================
-- Este archivo era solo diagnóstico/propuesta del bug 42703
-- (alias SQL `r` vs variable PL/pgSQL del loop).
--
-- Instalación ejecutable (CREATE OR REPLACE):
--   apps/api/sql/hotfix-senda-delete-purchase-invoice.sql
--
-- Verificación solo lectura:
--   apps/api/sql/verify-senda-delete-purchase-invoice.sql
-- ============================================================================

select
  'use_hotfix_senda_delete_purchase_invoice.sql' as next_step,
  to_regprocedure('public.senda_delete_purchase_invoice(jsonb)') is not null
    as function_exists;

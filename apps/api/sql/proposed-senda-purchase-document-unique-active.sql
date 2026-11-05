-- SENDA OPS — Unicidad de comprobante y hash solo entre facturas activas.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción.
-- Después: apps/api/sql/verify-senda-purchase-document-unique-active.sql (solo lectura).
--
-- Recrea los dos índices únicos parciales para que deleted_at deje de ocupar
-- la identidad fiscal y el hash. Sigue excluyendo status = cancelled.
-- No cambia el estado a cancelled. No borra documentos, archivos ni auditoría.
-- No modifica senda_delete_purchase_invoice ni el flujo de recepción.

begin;

do $guard$
begin
  if to_regclass('public.purchase_documents') is null then
    raise exception 'UNIQUE_ACTIVE_ABORT: falta purchase_documents.';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_documents'
      and column_name = 'deleted_at'
  ) then
    raise exception 'UNIQUE_ACTIVE_ABORT: falta purchase_documents.deleted_at.';
  end if;
  if to_regclass('public.purchase_documents_file_sha256_uniq') is null
     or to_regclass('public.purchase_documents_voucher_uniq') is null then
    raise exception 'UNIQUE_ACTIVE_ABORT: falta uno de los índices únicos actuales.';
  end if;
end
$guard$;

drop index public.purchase_documents_file_sha256_uniq;
create unique index purchase_documents_file_sha256_uniq
  on public.purchase_documents (organization_id, file_sha256)
  where file_sha256 is not null
    and file_sha256 <> ''
    and status is distinct from 'cancelled'
    and deleted_at is null;

drop index public.purchase_documents_voucher_uniq;
create unique index purchase_documents_voucher_uniq
  on public.purchase_documents (
    organization_id,
    issuer_tax_id_normalized,
    coalesce(voucher_type, ''),
    coalesce(point_of_sale, ''),
    voucher_number
  )
  where issuer_tax_id_normalized is not null
    and voucher_number is not null
    and status is distinct from 'cancelled'
    and deleted_at is null;

do $check$
declare
  v_hash text;
  v_voucher text;
begin
  select indexdef into v_hash
  from pg_indexes
  where schemaname = 'public'
    and indexname = 'purchase_documents_file_sha256_uniq';
  if v_hash is null
     or v_hash not ilike '%organization_id%'
     or v_hash not ilike '%file_sha256%'
     or v_hash not ilike '%cancelled%'
     or v_hash not ilike '%deleted_at is null%' then
    raise exception 'UNIQUE_ACTIVE_ABORT: índice de hash inesperado: %', coalesce(v_hash, 'missing');
  end if;

  select indexdef into v_voucher
  from pg_indexes
  where schemaname = 'public'
    and indexname = 'purchase_documents_voucher_uniq';
  if v_voucher is null
     or v_voucher not ilike '%organization_id%'
     or v_voucher not ilike '%issuer_tax_id_normalized%'
     or v_voucher not ilike '%voucher_number%'
     or v_voucher not ilike '%cancelled%'
     or v_voucher not ilike '%deleted_at is null%' then
    raise exception 'UNIQUE_ACTIVE_ABORT: índice fiscal inesperado: %', coalesce(v_voucher, 'missing');
  end if;
end
$check$;

commit;

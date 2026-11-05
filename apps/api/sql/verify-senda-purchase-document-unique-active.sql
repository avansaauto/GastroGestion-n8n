-- SENDA OPS — verificación de SOLO LECTURA tras la unicidad activa.
-- No inserta, no actualiza, no borra.

select
  'hash_excludes_deleted' as check_id,
  indexdef ilike '%deleted_at is null%'
    and indexdef ilike '%cancelled%'
    and indexdef ilike '%organization_id%'
    and indexdef ilike '%file_sha256%' as ok
from pg_indexes
where schemaname = 'public'
  and indexname = 'purchase_documents_file_sha256_uniq'
union all
select
  'voucher_excludes_deleted',
  indexdef ilike '%deleted_at is null%'
    and indexdef ilike '%cancelled%'
    and indexdef ilike '%organization_id%'
    and indexdef ilike '%issuer_tax_id_normalized%'
    and indexdef ilike '%voucher_number%'
from pg_indexes
where schemaname = 'public'
  and indexname = 'purchase_documents_voucher_uniq';

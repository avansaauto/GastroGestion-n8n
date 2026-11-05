-- Solo lectura. Confirmar catálogo Fudo + credenciales de integración.

select to_regclass('public.fudo_product_catalog') is not null as catalog_table;
select to_regclass('public.integration_credentials') is not null as credentials_table;

select
  con.conname
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'fudo_product_catalog'
  and con.contype = 'u';

select
  c.relrowsecurity as rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('fudo_product_catalog', 'integration_credentials');

select polname, tablename
from pg_policies
where schemaname = 'public'
  and tablename in ('fudo_product_catalog', 'integration_credentials');

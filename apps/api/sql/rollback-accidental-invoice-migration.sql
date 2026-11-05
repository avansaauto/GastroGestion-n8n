-- SENDA OPS — Paso 287
-- ROLLBACK CONTROLADO de proposed-invoice-persistence.sql
-- NO EJECUTAR hasta revisar el Bloque 0.
-- NO correr desde Cursor contra Supabase.
--
-- Alcance: solo objetos introducidos por esa migración accidental.
-- No toca inventario, movimientos, valuaciones, productos, recetas,
-- organizaciones, locales, miembros, suppliers, purchase_items ni
-- purchase_receipts.
-- Sin CASCADE. RLS de purchase_documents permanece habilitado.
-- No se crean políticas nuevas ni se reconstruyen definiciones previas.
--
-- Procedimiento en el SQL Editor de Supabase (proyecto SENDA):
--   1. Pegar SOLO el BLOQUE 0. Run. Guardar el resultado.
--   2. Confirmar: cinco tablas de compras en 0; seis políticas; función y
--      trigger e índices presentes. Si algo no calza, detenerse.
--   3. Pegar SOLO el BLOQUE 1 (desde BEGIN hasta COMMIT, inclusive). Run.
--      Si aparece ROLLBACK ABORT, no se confirmó ningún cambio.
--   4. Pegar SOLO el BLOQUE 2. Run. still_present debe ser false; las
--      columnas de purchase_documents deben ser las 10 originales;
--      relrowsecurity de purchase_documents debe seguir true.
--
-- Si el editor avisa "there is already a transaction in progress", correr
-- el Bloque 1 como una sola consulta, no sentencia por sentencia.

-- =============================================================================
-- BLOQUE 0 — Preflight de solo lectura (ejecutar solo)
-- =============================================================================

select 'purchase_documents' as table_name, count(*)::bigint as n from public.purchase_documents
union all select 'purchase_document_lines', count(*) from public.purchase_document_lines
union all select 'purchase_document_audit', count(*) from public.purchase_document_audit
union all select 'purchase_items', count(*) from public.purchase_items
union all select 'purchase_receipts', count(*) from public.purchase_receipts
order by 1;

select column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'purchase_documents'
order by ordinal_position;

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('purchase_documents', 'purchase_document_lines', 'purchase_document_audit')
order by tablename, policyname;

select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer, p.prorettype::regtype as return_type,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'purchase_documents_assign_organization';

select tg.tgname, tg.tgtype, tg.tgenabled, pg_get_triggerdef(tg.oid) as definition,
       tg.tgfoid::regprocedure as function_signature
from pg_trigger tg
join pg_class c on c.oid = tg.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'purchase_documents'
  and not tg.tgisinternal
order by tg.tgname;

select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'purchase_documents'
  and indexname in ('purchase_documents_file_sha256_uniq', 'purchase_documents_voucher_uniq');

select
  src.relname as from_table,
  con.conname,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class src on src.oid = con.conrelid
join pg_class dst on dst.oid = con.confrelid
join pg_namespace n on n.oid = dst.relnamespace
where n.nspname = 'public'
  and con.contype = 'f'
  and dst.relname in ('purchase_document_lines', 'purchase_document_audit');

select relname, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and relname in (
    'organizations', 'locations', 'organization_members', 'suppliers',
    'purchase_documents', 'purchase_items', 'purchase_receipts',
    'inventory_products', 'product_purchase_formats', 'location_inventory',
    'inventory_valuations', 'inventory_movements', 'pending_product_mappings',
    'recipes', 'recipe_components', 'sales_product_mappings',
    'purchase_document_lines', 'purchase_document_audit'
  )
order by relname;

-- =============================================================================
-- BLOQUE 1 — Rollback transaccional
-- =============================================================================

begin;

create function pg_temp.norm_expr(p_expr text)
returns text
language sql
immutable
as $norm$
  select trim(both from regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(coalesce(p_expr, '')), '::[a-z0-9_.]+', '', 'g'),
          '\y(pg_catalog|public)\.', '', 'g'
        ),
        'execute procedure', 'execute function', 'g'
      ),
      '[()]', '', 'g'
    ),
    '\s+', ' ', 'g'
  ))
$norm$;

do $do$
declare
  n bigint;
  extra_policies text;
  unexpected_fk text;
  unexpected_dep text;
  func_count integer;
  func_def text;
  func_secdef boolean;
  func_rettype text;
  func_nargs integer;
  trig_count integer;
  trig_type integer;
  trig_enabled char;
  trig_fn text;
  trig_cols text[];
  trig_def text;
  idx_unique boolean;
  idx_primary boolean;
  idx_cols text[];
  idx_pred text;
  pol record;
  expected record;
  extra_policies_docs text;
  expected_doc_cols constant text[] := array[
    'id', 'location_id', 'supplier_id', 'document_type', 'document_number',
    'document_date', 'status', 'currency', 'notes', 'created_at'
  ];
  added_cols constant text[] := array[
    'organization_id', 'classification', 'issuer_tax_id_normalized',
    'voucher_type', 'point_of_sale', 'voucher_number', 'file_sha256',
    'storage_bucket', 'storage_object_path', 'original_analysis',
    'reviewed_analysis', 'commercial_decisions', 'integrity_snapshot_sha256',
    'created_by', 'updated_at'
  ];
  missing_original text;
  missing_added text;
  docs_using constant text := $e$exists select 1 from locations l join organization_members m on m.organization_id = l.organization_id where l.id = purchase_documents.location_id and m.user_id = auth.uid() and m.status = 'active'$e$;
  lines_using constant text := $e$exists select 1 from purchase_documents d join locations l on l.id = d.location_id join organization_members m on m.organization_id = l.organization_id where d.id = purchase_document_lines.purchase_document_id and m.user_id = auth.uid() and m.status = 'active'$e$;
  audit_using constant text := $e$exists select 1 from purchase_documents d join locations l on l.id = d.location_id join organization_members m on m.organization_id = l.organization_id where d.id = purchase_document_audit.purchase_document_id and m.user_id = auth.uid() and m.status = 'active'$e$;
  hash_pred constant text := $e$file_sha256 is not null and status is distinct from 'voided'$e$;
  voucher_pred constant text := $e$issuer_tax_id_normalized is not null and voucher_number is not null and status is distinct from 'voided'$e$;
  trigger_expected constant text := $e$create trigger purchase_documents_assign_organization before insert or update of location_id on purchase_documents for each row execute function purchase_documents_assign_organization$e$;
begin
  select count(*) into n from public.purchase_documents;
  if n <> 0 then
    raise exception 'ROLLBACK ABORT: purchase_documents tiene % filas', n;
  end if;
  select count(*) into n from public.purchase_document_lines;
  if n <> 0 then
    raise exception 'ROLLBACK ABORT: purchase_document_lines tiene % filas', n;
  end if;
  select count(*) into n from public.purchase_document_audit;
  if n <> 0 then
    raise exception 'ROLLBACK ABORT: purchase_document_audit tiene % filas', n;
  end if;
  select count(*) into n from public.purchase_items;
  if n <> 0 then
    raise exception 'ROLLBACK ABORT: purchase_items tiene % filas; no se toca esa tabla', n;
  end if;
  select count(*) into n from public.purchase_receipts;
  if n <> 0 then
    raise exception 'ROLLBACK ABORT: purchase_receipts tiene % filas; no se toca esa tabla', n;
  end if;

  select string_agg(col, ', ' order by col) into missing_original
  from unnest(expected_doc_cols) as col
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'purchase_documents'
      and c.column_name = col
  );
  if missing_original is not null then
    raise exception 'ROLLBACK ABORT: faltan columnas originales de purchase_documents: %', missing_original;
  end if;

  select string_agg(col, ', ' order by col) into missing_added
  from unnest(added_cols) as col
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'purchase_documents'
      and c.column_name = col
  );
  if missing_added is not null then
    raise exception 'ROLLBACK ABORT: no están todas las columnas de la migración: %', missing_added;
  end if;

  select count(*), min(pg_get_functiondef(p.oid)), bool_or(p.prosecdef),
         min(p.prorettype::regtype::text), min(p.pronargs)
    into func_count, func_def, func_secdef, func_rettype, func_nargs
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname = 'purchase_documents_assign_organization';
  if func_count <> 1 then
    raise exception 'ROLLBACK ABORT: se esperaba 1 función purchase_documents_assign_organization(); hay %', func_count;
  end if;
  if func_secdef or func_rettype is distinct from 'trigger' or func_nargs is distinct from 0 then
    raise exception 'ROLLBACK ABORT: la función no es TRIGGER / 0 args / SECURITY INVOKER';
  end if;
  if func_def is null
     or func_def !~ 'LOCATION_NOT_FOUND'
     or func_def !~ 'new.organization_id'
     or func_def !~ 'new.updated_at'
     or func_def ~* 'security definer'
  then
    raise exception 'ROLLBACK ABORT: el cuerpo de purchase_documents_assign_organization() no coincide con la migración';
  end if;

  select count(*) into trig_count
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname = 'purchase_documents'
    and tg.tgname = 'purchase_documents_assign_organization'
    and not tg.tgisinternal;
  if trig_count <> 1 then
    raise exception 'ROLLBACK ABORT: se esperaba el trigger purchase_documents_assign_organization; hay %', trig_count;
  end if;

  select tg.tgtype, tg.tgenabled, tg.tgfoid::regprocedure::text, pg_get_triggerdef(tg.oid),
         coalesce((
           select array_agg(a.attname order by u.ord)
           from unnest(tg.tgattr) with ordinality as u(attnum, ord)
           join pg_attribute a on a.attrelid = tg.tgrelid and a.attnum = u.attnum
         ), array[]::text[])
    into trig_type, trig_enabled, trig_fn, trig_def, trig_cols
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname = 'purchase_documents'
    and tg.tgname = 'purchase_documents_assign_organization'
    and not tg.tgisinternal;

  -- tgtype 23 = ROW + BEFORE + INSERT + UPDATE
  if trig_type is distinct from 23 then
    raise exception 'ROLLBACK ABORT: el trigger no es BEFORE INSERT OR UPDATE FOR EACH ROW (tgtype=%)', trig_type;
  end if;
  if trig_enabled not in ('O', 'A') then
    raise exception 'ROLLBACK ABORT: el trigger no está habilitado (tgenabled=%)', trig_enabled;
  end if;
  if pg_temp.norm_expr(trig_fn) is distinct from pg_temp.norm_expr('purchase_documents_assign_organization()') then
    raise exception 'ROLLBACK ABORT: el trigger no llama a purchase_documents_assign_organization(): %', trig_fn;
  end if;
  if trig_cols is distinct from array['location_id']::text[] then
    raise exception 'ROLLBACK ABORT: el trigger no es UPDATE OF location_id (columnas=%)', trig_cols;
  end if;
  if pg_temp.norm_expr(trig_def) is distinct from pg_temp.norm_expr(trigger_expected) then
    raise exception 'ROLLBACK ABORT: pg_get_triggerdef no coincide con la migración: %', trig_def;
  end if;

  select i.indisunique, i.indisprimary,
         (select array_agg(a.attname order by u.ord)
          from unnest(i.indkey) with ordinality as u(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.attnum),
         pg_get_expr(i.indpred, i.indrelid)
    into idx_unique, idx_primary, idx_cols, idx_pred
  from pg_index i
  join pg_class idx on idx.oid = i.indexrelid
  join pg_class tbl on tbl.oid = i.indrelid
  join pg_namespace ns on ns.oid = tbl.relnamespace
  where ns.nspname = 'public'
    and tbl.relname = 'purchase_documents'
    and idx.relname = 'purchase_documents_file_sha256_uniq';
  if not found or idx_unique is not true or idx_primary is not false then
    raise exception 'ROLLBACK ABORT: falta el índice único purchase_documents_file_sha256_uniq';
  end if;
  if idx_cols is distinct from array['organization_id', 'file_sha256']::text[] then
    raise exception 'ROLLBACK ABORT: columnas inesperadas en purchase_documents_file_sha256_uniq: %', idx_cols;
  end if;
  if pg_temp.norm_expr(idx_pred) is distinct from pg_temp.norm_expr(hash_pred) then
    raise exception 'ROLLBACK ABORT: predicado inesperado en purchase_documents_file_sha256_uniq: %', idx_pred;
  end if;

  select i.indisunique, i.indisprimary,
         (select array_agg(a.attname order by u.ord)
          from unnest(i.indkey) with ordinality as u(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.attnum),
         pg_get_expr(i.indpred, i.indrelid)
    into idx_unique, idx_primary, idx_cols, idx_pred
  from pg_index i
  join pg_class idx on idx.oid = i.indexrelid
  join pg_class tbl on tbl.oid = i.indrelid
  join pg_namespace ns on ns.oid = tbl.relnamespace
  where ns.nspname = 'public'
    and tbl.relname = 'purchase_documents'
    and idx.relname = 'purchase_documents_voucher_uniq';
  if not found or idx_unique is not true or idx_primary is not false then
    raise exception 'ROLLBACK ABORT: falta el índice único purchase_documents_voucher_uniq';
  end if;
  if idx_cols is distinct from array[
    'organization_id', 'issuer_tax_id_normalized', 'voucher_type', 'point_of_sale', 'voucher_number'
  ]::text[] then
    raise exception 'ROLLBACK ABORT: columnas inesperadas en purchase_documents_voucher_uniq: %', idx_cols;
  end if;
  if pg_temp.norm_expr(idx_pred) is distinct from pg_temp.norm_expr(voucher_pred) then
    raise exception 'ROLLBACK ABORT: predicado inesperado en purchase_documents_voucher_uniq: %', idx_pred;
  end if;

  select string_agg(policyname, ', ' order by policyname) into extra_policies
  from pg_policies
  where schemaname = 'public'
    and tablename = 'purchase_document_lines'
    and policyname is distinct from 'purchase_document_lines_member_all';
  if extra_policies is not null then
    raise exception 'ROLLBACK ABORT: políticas inesperadas en purchase_document_lines: %', extra_policies;
  end if;

  select string_agg(policyname, ', ' order by policyname) into extra_policies
  from pg_policies
  where schemaname = 'public'
    and tablename = 'purchase_document_audit'
    and policyname not in (
      'purchase_document_audit_member_select',
      'purchase_document_audit_member_insert'
    );
  if extra_policies is not null then
    raise exception 'ROLLBACK ABORT: políticas inesperadas en purchase_document_audit: %', extra_policies;
  end if;

  for expected in
    select * from (values
      ('purchase_documents', 'purchase_documents_member_select', 'SELECT', docs_using, ''),
      ('purchase_documents', 'purchase_documents_member_insert', 'INSERT', '', docs_using),
      ('purchase_documents', 'purchase_documents_member_update', 'UPDATE', docs_using, docs_using),
      ('purchase_document_lines', 'purchase_document_lines_member_all', 'ALL', lines_using, lines_using),
      ('purchase_document_audit', 'purchase_document_audit_member_select', 'SELECT', audit_using, ''),
      ('purchase_document_audit', 'purchase_document_audit_member_insert', 'INSERT', '', audit_using)
    ) as v(table_name, policy_name, cmd, using_expr, check_expr)
  loop
    select p.policyname, p.cmd, p.permissive, p.roles, p.qual, p.with_check
      into pol
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = expected.table_name
      and p.policyname = expected.policy_name;
    if not found then
      raise exception 'ROLLBACK ABORT: falta la política %.%', expected.table_name, expected.policy_name;
    end if;
    if pol.cmd is distinct from expected.cmd then
      raise exception 'ROLLBACK ABORT: %.% cmd=%; se esperaba %',
        expected.table_name, expected.policy_name, pol.cmd, expected.cmd;
    end if;
    if pol.permissive is distinct from 'PERMISSIVE' then
      raise exception 'ROLLBACK ABORT: %.% no es PERMISSIVE', expected.table_name, expected.policy_name;
    end if;
    if pol.roles is distinct from array['authenticated']::name[] then
      raise exception 'ROLLBACK ABORT: %.% roles=%; se esperaba {authenticated}',
        expected.table_name, expected.policy_name, pol.roles;
    end if;
    if pg_temp.norm_expr(pol.qual) is distinct from pg_temp.norm_expr(expected.using_expr) then
      raise exception 'ROLLBACK ABORT: %.% USING inesperado: %',
        expected.table_name, expected.policy_name, pol.qual;
    end if;
    if pg_temp.norm_expr(pol.with_check) is distinct from pg_temp.norm_expr(expected.check_expr) then
      raise exception 'ROLLBACK ABORT: %.% WITH CHECK inesperado: %',
        expected.table_name, expected.policy_name, pol.with_check;
    end if;
  end loop;

  select string_agg(policyname || '/' || cmd, ', ' order by policyname)
    into extra_policies_docs
  from pg_policies
  where schemaname = 'public'
    and tablename = 'purchase_documents'
    and policyname not in (
      'purchase_documents_member_select',
      'purchase_documents_member_insert',
      'purchase_documents_member_update'
    );
  if extra_policies_docs is not null then
    raise notice 'Se conservan políticas previas de purchase_documents: %', extra_policies_docs;
  else
    raise notice 'purchase_documents no tiene políticas distintas de las tres de la migración.';
  end if;

  select string_agg(src.relname || ':' || con.conname, ', ') into unexpected_fk
  from pg_constraint con
  join pg_class src on src.oid = con.conrelid
  join pg_namespace srcn on srcn.oid = src.relnamespace
  join pg_class dst on dst.oid = con.confrelid
  join pg_namespace dstn on dstn.oid = dst.relnamespace
  where con.contype = 'f'
    and dstn.nspname = 'public'
    and dst.relname in ('purchase_document_lines', 'purchase_document_audit')
    and not (srcn.nspname = 'public' and src.relname in ('purchase_document_lines', 'purchase_document_audit'));
  if unexpected_fk is not null then
    raise exception 'ROLLBACK ABORT: FKs inesperadas hacia tablas nuevas: %', unexpected_fk;
  end if;

  select string_agg(distinct dependent::text, ', ') into unexpected_dep
  from (
    select (dep.classid::regclass)::text || ':' || dep.objid::text as dependent
    from pg_depend dep
    join pg_attribute a on a.attrelid = dep.refobjid and a.attnum = dep.refobjsubid
    join pg_class c on c.oid = a.attrelid
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relname = 'purchase_documents'
      and a.attname = any (added_cols)
      and dep.deptype = 'n'
      and dep.classid <> 'pg_constraint'::regclass
      and dep.classid <> 'pg_attrdef'::regclass
  ) deps;
  if unexpected_dep is not null then
    raise exception 'ROLLBACK ABORT: dependencias inesperadas sobre columnas agregadas: %', unexpected_dep;
  end if;
end
$do$;

drop function pg_temp.norm_expr(text);

drop policy if exists purchase_documents_member_select on public.purchase_documents;
drop policy if exists purchase_documents_member_insert on public.purchase_documents;
drop policy if exists purchase_documents_member_update on public.purchase_documents;
drop policy if exists purchase_document_lines_member_all on public.purchase_document_lines;
drop policy if exists purchase_document_audit_member_select on public.purchase_document_audit;
drop policy if exists purchase_document_audit_member_insert on public.purchase_document_audit;

drop trigger if exists purchase_documents_assign_organization on public.purchase_documents;
drop function if exists public.purchase_documents_assign_organization() restrict;

drop index if exists public.purchase_documents_file_sha256_uniq restrict;
drop index if exists public.purchase_documents_voucher_uniq restrict;

drop table if exists public.purchase_document_audit restrict;
drop table if exists public.purchase_document_lines restrict;

alter table public.purchase_documents
  drop column if exists organization_id restrict,
  drop column if exists classification restrict,
  drop column if exists issuer_tax_id_normalized restrict,
  drop column if exists voucher_type restrict,
  drop column if exists point_of_sale restrict,
  drop column if exists voucher_number restrict,
  drop column if exists file_sha256 restrict,
  drop column if exists storage_bucket restrict,
  drop column if exists storage_object_path restrict,
  drop column if exists original_analysis restrict,
  drop column if exists reviewed_analysis restrict,
  drop column if exists commercial_decisions restrict,
  drop column if exists integrity_snapshot_sha256 restrict,
  drop column if exists created_by restrict,
  drop column if exists updated_at restrict;

-- No se ejecuta DISABLE ROW LEVEL SECURITY sobre purchase_documents.
-- No se crea ninguna política. No se altera inventario ni organizaciones.

commit;

-- =============================================================================
-- BLOQUE 2 — Verificación posterior (ejecutar después del COMMIT)
-- =============================================================================

select 'table:purchase_document_lines' as object, to_regclass('public.purchase_document_lines') is not null as still_present
union all select 'table:purchase_document_audit', to_regclass('public.purchase_document_audit') is not null
union all select 'function:purchase_documents_assign_organization',
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'purchase_documents_assign_organization'
  )
union all select 'trigger:purchase_documents_assign_organization',
  exists (
    select 1 from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'purchase_documents'
      and tg.tgname = 'purchase_documents_assign_organization'
  )
union all select 'index:purchase_documents_file_sha256_uniq',
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'purchase_documents_file_sha256_uniq')
union all select 'index:purchase_documents_voucher_uniq',
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'purchase_documents_voucher_uniq')
union all select 'policy:purchase_documents_member_select',
  exists (select 1 from pg_policies where tablename = 'purchase_documents' and policyname = 'purchase_documents_member_select')
union all select 'policy:purchase_documents_member_insert',
  exists (select 1 from pg_policies where tablename = 'purchase_documents' and policyname = 'purchase_documents_member_insert')
union all select 'policy:purchase_documents_member_update',
  exists (select 1 from pg_policies where tablename = 'purchase_documents' and policyname = 'purchase_documents_member_update')
union all select 'policy:purchase_document_lines_member_all',
  exists (select 1 from pg_policies where tablename = 'purchase_document_lines' and policyname = 'purchase_document_lines_member_all')
union all select 'policy:purchase_document_audit_member_select',
  exists (select 1 from pg_policies where tablename = 'purchase_document_audit' and policyname = 'purchase_document_audit_member_select')
union all select 'policy:purchase_document_audit_member_insert',
  exists (select 1 from pg_policies where tablename = 'purchase_document_audit' and policyname = 'purchase_document_audit_member_insert');

select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'purchase_documents'
order by ordinal_position;
-- Esperado: id, location_id, supplier_id, document_type, document_number,
-- document_date, status, currency, notes, created_at.

select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'purchase_documents'
order by policyname;

select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'organizations', 'locations', 'organization_members', 'suppliers',
    'purchase_documents', 'purchase_items', 'purchase_receipts',
    'inventory_products', 'product_purchase_formats', 'location_inventory',
    'inventory_valuations', 'inventory_movements', 'pending_product_mappings',
    'recipes', 'recipe_components', 'sales_product_mappings'
  )
order by c.relname;

select 'inventory_products' as table_name, count(*)::bigint as n from public.inventory_products
union all select 'location_inventory', count(*) from public.location_inventory
union all select 'inventory_valuations', count(*) from public.inventory_valuations
union all select 'inventory_movements', count(*) from public.inventory_movements
union all select 'pending_product_mappings', count(*) from public.pending_product_mappings
union all select 'purchase_documents', count(*) from public.purchase_documents
union all select 'purchase_items', count(*) from public.purchase_items
union all select 'purchase_receipts', count(*) from public.purchase_receipts
order by 1;

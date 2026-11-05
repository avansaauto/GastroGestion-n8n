-- SENDA OPS — Paso 295
-- MIGRACIÓN DEFINITIVA de persistencia de facturas (Pasos 290–294).
-- NO EJECUTAR hasta autorización explícita. No es un archivo de supabase/migrations.
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA → SQL Editor → Run.
-- Después: apps/api/sql/verify-invoice-persistence.sql (solo lectura).
--
-- Inspect 289 confirmó:
--   CHECK purchase_documents.status IN ('draft','reviewed','received','cancelled')
--   10 columnas originales; 0 filas en purchase_* y suppliers
--   RLS on, 0 políticas en tablas de compras
--   inventory_products.organization_id NOT NULL FK organizations
-- Paso 292: escritura solo por RPC SECURITY DEFINER.
-- Paso 293: membresia DEFINER con user_id explicito, qty fisica sin SKU = 0,
--   FOR UPDATE entre cancel/map, auditoria generada en servidor.
-- Paso 294: EXECUTE de save/cancel/map solo a service_role.
--   actor_user_id lo inyecta el backend (getUser). HMAC fuera de PG.
-- No reutilizar proposed-invoice-persistence.sql ni proposed-invoice-persistence-289.sql.
-- No altera inventory_*, purchase_items, purchase_receipts ni el CHECK de status.
-- No crea buckets. No implementa endpoints.

begin;

do $guard$
declare
  leftover text;
  status_check text;
  leftover_index text;
begin
  if to_regclass('public.purchase_document_lines') is not null then
    raise exception 'MIGRACIÓN ABORT: purchase_document_lines ya existe.';
  end if;
  if to_regclass('public.purchase_document_audit') is not null then
    raise exception 'MIGRACIÓN ABORT: purchase_document_audit ya existe.';
  end if;
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'senda_save_purchase_invoice',
        'senda_cancel_purchase_invoice',
        'senda_map_purchase_document_line',
        'senda_actor_is_purchase_member',
        'senda_require_backend_actor'
      )
  ) then
    raise exception 'MIGRACIÓN ABORT: funciones RPC de persistencia ya existen.';
  end if;

  select string_agg(column_name, ', ' order by column_name) into leftover
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'purchase_documents'
    and column_name in (
      'organization_id', 'file_sha256', 'original_analysis', 'reviewed_analysis'
    );
  if leftover is not null then
    raise exception 'MIGRACIÓN ABORT: purchase_documents ya tiene columnas de la propuesta (%).', leftover;
  end if;

  select string_agg(indexname, ', ' order by indexname) into leftover_index
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'purchase_documents'
    and indexname in (
      'purchase_documents_file_sha256_uniq',
      'purchase_documents_voucher_uniq'
    );
  if leftover_index is not null then
    raise exception 'MIGRACIÓN ABORT: índices de unicidad ya existen (%).', leftover_index;
  end if;

  select pg_get_constraintdef(con.oid) into status_check
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'purchase_documents'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%status%'
  limit 1;
  if status_check is null
     or status_check not ilike '%draft%'
     or status_check not ilike '%reviewed%'
     or status_check not ilike '%received%'
     or status_check not ilike '%cancelled%'
  then
    raise exception 'MIGRACIÓN ABORT: CHECK de status no coincide con draft/reviewed/received/cancelled: %', status_check;
  end if;
end
$guard$;

-- =============================================================================
-- A. Datos
-- =============================================================================
-- status existente (NO modificar el CHECK):
--   draft      transitorio interno del RPC de save; no es un estado de producto
--   reviewed   factura confirmada, sin recepción ni stock
--   received   recepción confirmada (paso futuro; bloqueado)
--   cancelled  anulación terminal; sale de los únicos parciales

alter table public.purchase_documents
  add column if not exists organization_id uuid references public.organizations(id),
  add column if not exists classification text,
  add column if not exists issuer_name text,
  add column if not exists issuer_tax_id_normalized text,
  add column if not exists voucher_type text,
  add column if not exists point_of_sale text,
  add column if not exists voucher_number text,
  add column if not exists file_sha256 text,
  add column if not exists storage_bucket text,
  add column if not exists storage_object_path text,
  add column if not exists original_analysis jsonb,
  add column if not exists reviewed_analysis jsonb,
  add column if not exists corrections jsonb,
  add column if not exists commercial_decisions jsonb,
  add column if not exists integrity_snapshot_sha256 text,
  add column if not exists eligible_line_count integer,
  add column if not exists unmapped_line_count integer,
  add column if not exists fiscal_policy_applied jsonb,
  add column if not exists fiscal_difference_accepted boolean,
  add column if not exists created_by uuid,
  add column if not exists updated_at timestamptz default now();

comment on column public.purchase_documents.organization_id is
  'Derivada del local en INSERT. Congelada en UPDATE.';
comment on column public.purchase_documents.original_analysis is
  'Snapshot HMAC. Inmutable. El HMAC lo verifica el backend, no PostgreSQL.';
comment on column public.purchase_documents.unmapped_line_count is
  'Elegibles sin inventory_product_id. Unico conteo mutable tras reviewed (mapeo).';
comment on column public.purchase_documents.fiscal_policy_applied is
  'Umbrales de redondeo/revision usados al guardar, por moneda.';

-- Membresia: SECURITY DEFINER + search_path fijo.
-- No usar INVOKER desde una RPC DEFINER (correria como el dueno).
-- El aislamiento es m.user_id = p_user_id (JWT capturado), no current_user.
create or replace function public.senda_actor_is_purchase_member(p_location_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.locations l
    join public.organization_members m on m.organization_id = l.organization_id
    where l.id = p_location_id
      and p_user_id is not null
      and m.user_id = p_user_id
      and m.status = 'active'
      and m.role in ('admin', 'operator')
  );
$$;

create or replace function public.senda_is_purchase_member(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.senda_actor_is_purchase_member(p_location_id, auth.uid());
$$;

-- Escritura: solo service_role (cliente admin de la API). authenticated no EXECUTE.
-- p_user_id lo pone el backend tras auth.getUser; no se toma del body del browser.
create or replace function public.senda_require_backend_actor(p_user_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'BACKEND_ROLE_REQUIRED';
  end if;
  if p_user_id is null then
    raise exception 'ACTOR_REQUIRED';
  end if;
  return p_user_id;
end;
$$;

create or replace function public.purchase_documents_before_write()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  loc_org uuid;
  sup_org uuid;
  line_count integer;
begin
  select organization_id into loc_org
  from public.locations
  where id = new.location_id;

  if loc_org is null then
    raise exception 'LOCATION_NOT_FOUND';
  end if;

  new.updated_at := now();

  if new.supplier_id is not null
     and (tg_op = 'INSERT' or new.supplier_id is distinct from old.supplier_id) then
    select organization_id into sup_org
    from public.suppliers
    where id = new.supplier_id;
    if sup_org is null then
      raise exception 'SUPPLIER_NOT_FOUND';
    end if;
    if sup_org is distinct from loc_org then
      raise exception 'SUPPLIER_ORG_MISMATCH';
    end if;
  end if;

  if new.status = 'received' then
    raise exception 'STATUS_RECEIVED_RESERVED';
  end if;

  if tg_op = 'INSERT' then
    new.organization_id := loc_org;
    new.created_by := coalesce(auth.uid(), new.created_by);
    if new.created_by is null then
      raise exception 'CREATED_BY_REQUIRED';
    end if;
    if new.status is distinct from 'draft' then
      raise exception 'STATUS_INSERT_NOT_ALLOWED';
    end if;
    if new.original_analysis is null then
      raise exception 'DRAFT_REQUIRES_ORIGINAL_ANALYSIS';
    end if;
    if new.file_sha256 is null or new.file_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception 'DRAFT_REQUIRES_FILE_HASH';
    end if;
    if new.storage_bucket is null or new.storage_object_path is null then
      raise exception 'DRAFT_REQUIRES_STORAGE';
    end if;
    if new.integrity_snapshot_sha256 is null then
      raise exception 'DRAFT_REQUIRES_INTEGRITY';
    end if;
    if new.storage_object_path is distinct from (
         loc_org::text || '/invoices/' || new.file_sha256
         || substring(new.storage_object_path from '\.[a-z0-9]+$')
       )
       or substring(new.storage_object_path from '\.[a-z0-9]+$') is null then
      raise exception 'DRAFT_REQUIRES_STORAGE_PATH';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.organization_id := old.organization_id;
    if new.location_id is distinct from old.location_id then
      raise exception 'LOCATION_IMMUTABLE';
    end if;
    if new.created_by is distinct from old.created_by then
      raise exception 'CREATED_BY_IMMUTABLE';
    end if;
    if new.original_analysis is distinct from old.original_analysis then
      raise exception 'ORIGINAL_ANALYSIS_IMMUTABLE';
    end if;
    if new.file_sha256 is distinct from old.file_sha256
       or new.integrity_snapshot_sha256 is distinct from old.integrity_snapshot_sha256
       or new.storage_bucket is distinct from old.storage_bucket
       or new.storage_object_path is distinct from old.storage_object_path then
      raise exception 'INTEGRITY_FIELDS_IMMUTABLE';
    end if;
    if new.issuer_tax_id_normalized is distinct from old.issuer_tax_id_normalized
       or new.voucher_type is distinct from old.voucher_type
       or new.point_of_sale is distinct from old.point_of_sale
       or new.voucher_number is distinct from old.voucher_number
       or new.supplier_id is distinct from old.supplier_id
       or new.document_type is distinct from old.document_type
       or new.document_number is distinct from old.document_number
       or new.document_date is distinct from old.document_date
       or new.currency is distinct from old.currency
       or new.notes is distinct from old.notes
       or new.classification is distinct from old.classification
       or new.issuer_name is distinct from old.issuer_name
       or new.reviewed_analysis is distinct from old.reviewed_analysis
       or new.corrections is distinct from old.corrections
       or new.commercial_decisions is distinct from old.commercial_decisions
       or new.eligible_line_count is distinct from old.eligible_line_count
       or new.fiscal_policy_applied is distinct from old.fiscal_policy_applied
       or new.fiscal_difference_accepted is distinct from old.fiscal_difference_accepted then
      raise exception 'DOCUMENTARY_IMMUTABLE';
    end if;
    if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
      raise exception 'CANCELLED_TERMINAL';
    end if;
    if old.status = 'cancelled' and new.unmapped_line_count is distinct from old.unmapped_line_count then
      raise exception 'CANCELLED_TERMINAL';
    end if;
    if new.status is distinct from old.status
       and not (
         (old.status = 'draft' and new.status = 'reviewed')
         or (old.status = 'reviewed' and new.status = 'cancelled')
       ) then
      raise exception 'STATUS_TRANSITION_FORBIDDEN';
    end if;
    if old.status = 'draft' and new.status = 'reviewed' then
      if new.reviewed_analysis is null then
        raise exception 'REVIEWED_REQUIRES_REVIEWED_ANALYSIS';
      end if;
      if new.eligible_line_count is null or new.eligible_line_count < 1 then
        raise exception 'REVIEWED_REQUIRES_ELIGIBLE_LINES';
      end if;
      select count(*) into line_count
      from public.purchase_document_lines
      where purchase_document_id = new.id;
      if coalesce(line_count, 0) < 1 then
        raise exception 'REVIEWED_REQUIRES_LINES';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists purchase_documents_assign_organization on public.purchase_documents;
drop trigger if exists purchase_documents_before_write on public.purchase_documents;
create trigger purchase_documents_before_write
before insert or update on public.purchase_documents
for each row
execute function public.purchase_documents_before_write();

create unique index if not exists purchase_documents_file_sha256_uniq
  on public.purchase_documents (organization_id, file_sha256)
  where file_sha256 is not null
    and file_sha256 <> ''
    and status is distinct from 'cancelled';

create unique index if not exists purchase_documents_voucher_uniq
  on public.purchase_documents (
    organization_id,
    issuer_tax_id_normalized,
    coalesce(voucher_type, ''),
    coalesce(point_of_sale, ''),
    voucher_number
  )
  where issuer_tax_id_normalized is not null
    and voucher_number is not null
    and status is distinct from 'cancelled';

create table if not exists public.purchase_document_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_document_id uuid not null references public.purchase_documents(id) on delete cascade,
  source_line_id text not null,
  source_index integer,
  original_description text,
  original_quantity numeric,
  original_unit text,
  original_unit_price numeric,
  original_amount numeric,
  reviewed_description text,
  reviewed_quantity numeric,
  reviewed_unit text,
  reviewed_unit_price numeric,
  reviewed_amount numeric,
  classification text,
  inventory_eligibility text,
  quantity_kind text,
  inventory_physical_quantity numeric not null default 0,
  mapping_status text not null default 'not_applicable',
  inventory_product_id uuid references public.inventory_products(id),
  original_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (purchase_document_id, source_line_id),
  constraint purchase_document_lines_mapping_status_chk
    check (mapping_status in ('unmapped', 'mapped', 'not_applicable')),
  constraint purchase_document_lines_physical_qty_chk
    check (inventory_physical_quantity >= 0),
  constraint purchase_document_lines_negative_not_stock_chk
    check (
      inventory_physical_quantity = 0
      or coalesce(reviewed_amount, original_amount, 0) >= 0
    ),
  constraint purchase_document_lines_mapping_product_chk
    check (
      (mapping_status = 'mapped' and inventory_product_id is not null)
      or (mapping_status in ('unmapped', 'not_applicable') and inventory_product_id is null)
    ),
  constraint purchase_document_lines_qty_requires_product_chk
    check (inventory_product_id is not null or inventory_physical_quantity = 0)
);

comment on table public.purchase_document_lines is
  'Lineas documentales. INSERT solo con padre draft. UPDATE de mapeo solo con padre reviewed. original/reviewed congelados.';
comment on column public.purchase_document_lines.mapping_status is
  'unmapped | mapped | not_applicable. unmapped no habilita stock.';
comment on column public.purchase_document_lines.inventory_physical_quantity is
  'Propuesta fisica. 0 en bonificaciones y servicios. Nunca un importe negativo.';

create or replace function public.purchase_document_lines_before_write()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  parent_status text;
  doc_org uuid;
  prod_org uuid;
begin
  select d.status, d.organization_id into parent_status, doc_org
  from public.purchase_documents d
  where d.id = new.purchase_document_id;

  if parent_status is null then
    raise exception 'DOCUMENT_NOT_FOUND';
  end if;

  if tg_op = 'INSERT' then
    if parent_status is distinct from 'draft' then
      raise exception 'LINES_INSERT_REQUIRES_DRAFT';
    end if;
    new.inventory_product_id := null;
    if new.mapping_status = 'mapped' then
      new.mapping_status := 'unmapped';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if parent_status is distinct from 'reviewed' then
      raise exception 'LINES_UPDATE_REQUIRES_REVIEWED';
    end if;
    if new.original_description is distinct from old.original_description
       or new.original_quantity is distinct from old.original_quantity
       or new.original_unit is distinct from old.original_unit
       or new.original_unit_price is distinct from old.original_unit_price
       or new.original_amount is distinct from old.original_amount
       or new.original_payload is distinct from old.original_payload
       or new.source_line_id is distinct from old.source_line_id
       or new.source_index is distinct from old.source_index
       or new.reviewed_description is distinct from old.reviewed_description
       or new.reviewed_quantity is distinct from old.reviewed_quantity
       or new.reviewed_unit is distinct from old.reviewed_unit
       or new.reviewed_unit_price is distinct from old.reviewed_unit_price
       or new.reviewed_amount is distinct from old.reviewed_amount
       or new.classification is distinct from old.classification
       or new.inventory_eligibility is distinct from old.inventory_eligibility
       or new.quantity_kind is distinct from old.quantity_kind then
      raise exception 'DOCUMENTARY_LINE_IMMUTABLE';
    end if;
  end if;

  if new.inventory_product_id is not null then
    select organization_id into prod_org
    from public.inventory_products
    where id = new.inventory_product_id;
    if prod_org is null then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;
    if prod_org is distinct from doc_org then
      raise exception 'PRODUCT_ORG_MISMATCH';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists purchase_document_lines_protect_originals on public.purchase_document_lines;
drop trigger if exists purchase_document_lines_before_write on public.purchase_document_lines;
create trigger purchase_document_lines_before_write
before insert or update on public.purchase_document_lines
for each row
execute function public.purchase_document_lines_before_write();

create table if not exists public.purchase_document_audit (
  id uuid primary key default gen_random_uuid(),
  purchase_document_id uuid not null references public.purchase_documents(id) on delete cascade,
  actor_user_id uuid,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint purchase_document_audit_action_chk
    check (action in ('invoice_reviewed', 'invoice_cancelled', 'invoice_line_mapped'))
);

comment on table public.purchase_document_audit is
  'Append-only. INSERT solo via RPC service_role. actor_user_id = usuario verificado por el backend.';

create or replace function public.purchase_document_audit_before_write()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'AUDIT_APPEND_ONLY';
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    if new.actor_user_id is null then
      raise exception 'AUDIT_REQUIRES_USER';
    end if;
    return new;
  end if;
  if auth.uid() is null then
    raise exception 'AUDIT_REQUIRES_USER';
  end if;
  new.actor_user_id := auth.uid();
  return new;
end;
$$;

drop trigger if exists purchase_document_audit_append_only on public.purchase_document_audit;
drop trigger if exists purchase_document_audit_before_write on public.purchase_document_audit;
create trigger purchase_document_audit_before_write
before insert or update or delete on public.purchase_document_audit
for each row
execute function public.purchase_document_audit_before_write();

alter table public.organizations
  add column if not exists invoice_fiscal_tolerances jsonb;

comment on column public.organizations.invoice_fiscal_tolerances is
  'Opcional. {"ARS":{"rounding":"0.05","reviewMax":"2.00"}}. Los importes extraidos no se reescriben.';

-- =============================================================================
-- A2. RPC transaccionales (unica via de escritura: service_role del backend)
-- =============================================================================
-- authenticated NO tiene EXECUTE. El browser no puede llamar estas RPC.
-- La API usa getSupabaseAdmin() (SUPABASE_SERVICE_ROLE_KEY, nunca el frontend).
-- actor_user_id lo fija el backend con auth.getUser (JWT del usuario), no el body.

create or replace function public.senda_save_purchase_invoice(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_actor uuid;
  v_location_id uuid;
  v_line jsonb;
  v_eligibility text;
  v_eligible integer;
  v_line_count integer;
begin
  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  v_location_id := (p->>'location_id')::uuid;
  if v_location_id is null then
    raise exception 'LOCATION_REQUIRED';
  end if;
  if not public.senda_actor_is_purchase_member(v_location_id, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') < 1 then
    raise exception 'SAVE_REQUIRES_LINES';
  end if;

  select count(*) into v_eligible
  from jsonb_array_elements(p->'lines') as t(line)
  where t.line->>'inventory_eligibility' = 'eligible';
  if coalesce(v_eligible, 0) < 1 then
    raise exception 'SAVE_NOT_ALLOWED_NO_INVENTORY';
  end if;

  insert into public.purchase_documents (
    location_id,
    supplier_id,
    document_type,
    document_number,
    document_date,
    status,
    currency,
    notes,
    classification,
    issuer_name,
    issuer_tax_id_normalized,
    voucher_type,
    point_of_sale,
    voucher_number,
    file_sha256,
    storage_bucket,
    storage_object_path,
    original_analysis,
    reviewed_analysis,
    corrections,
    commercial_decisions,
    integrity_snapshot_sha256,
    eligible_line_count,
    unmapped_line_count,
    fiscal_policy_applied,
    fiscal_difference_accepted,
    created_by
  ) values (
    v_location_id,
    (p->>'supplier_id')::uuid,
    coalesce(p->>'document_type', 'invoice'),
    p->>'document_number',
    (p->>'document_date')::date,
    'draft',
    coalesce(p->>'currency', 'ARS'),
    p->>'notes',
    p->>'classification',
    p->>'issuer_name',
    p->>'issuer_tax_id_normalized',
    p->>'voucher_type',
    p->>'point_of_sale',
    p->>'voucher_number',
    p->>'file_sha256',
    p->>'storage_bucket',
    p->>'storage_object_path',
    p->'original_analysis',
    p->'reviewed_analysis',
    coalesce(p->'corrections', '{}'::jsonb),
    coalesce(p->'commercial_decisions', '[]'::jsonb),
    p->>'integrity_snapshot_sha256',
    v_eligible,
    v_eligible,
    p->'fiscal_policy_applied',
    coalesce((p->>'fiscal_difference_accepted')::boolean, false),
    v_actor
  ) returning id into v_id;

  for v_line in select t.line from jsonb_array_elements(p->'lines') as t(line)
  loop
    v_eligibility := coalesce(v_line->>'inventory_eligibility', 'ineligible');
    insert into public.purchase_document_lines (
      purchase_document_id,
      source_line_id,
      source_index,
      original_description,
      original_quantity,
      original_unit,
      original_unit_price,
      original_amount,
      reviewed_description,
      reviewed_quantity,
      reviewed_unit,
      reviewed_unit_price,
      reviewed_amount,
      classification,
      inventory_eligibility,
      quantity_kind,
      inventory_physical_quantity,
      mapping_status,
      inventory_product_id,
      original_payload
    ) values (
      v_id,
      v_line->>'source_line_id',
      (v_line->>'source_index')::integer,
      v_line->>'original_description',
      (v_line->>'original_quantity')::numeric,
      v_line->>'original_unit',
      (v_line->>'original_unit_price')::numeric,
      (v_line->>'original_amount')::numeric,
      v_line->>'reviewed_description',
      (v_line->>'reviewed_quantity')::numeric,
      v_line->>'reviewed_unit',
      (v_line->>'reviewed_unit_price')::numeric,
      (v_line->>'reviewed_amount')::numeric,
      v_line->>'classification',
      v_eligibility,
      v_line->>'quantity_kind',
      0,
      case when v_eligibility = 'eligible' then 'unmapped' else 'not_applicable' end,
      null,
      coalesce(v_line->'original_payload', '{}'::jsonb)
    );
  end loop;

  update public.purchase_documents
     set status = 'reviewed'
   where id = v_id;

  select count(*) into v_line_count
  from public.purchase_document_lines
  where purchase_document_id = v_id;

  insert into public.purchase_document_audit (
    purchase_document_id, action, actor_user_id, payload
  ) values (
    v_id,
    'invoice_reviewed',
    v_actor,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'location_id', v_location_id,
      'file_sha256', p->>'file_sha256',
      'integrity_snapshot_sha256', p->>'integrity_snapshot_sha256',
      'eligible_line_count', v_eligible,
      'line_count', v_line_count
    )
  );

  return v_id;
end;
$$;

drop function if exists public.senda_cancel_purchase_invoice(uuid);

create or replace function public.senda_cancel_purchase_invoice(p_id uuid, p_actor_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_location uuid;
  v_status text;
begin
  v_actor := public.senda_require_backend_actor(p_actor_user_id);

  select location_id, status into v_location, v_status
  from public.purchase_documents
  where id = p_id
  for update;

  if v_location is null then
    raise exception 'DOCUMENT_NOT_FOUND';
  end if;
  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;
  if v_status is distinct from 'reviewed' then
    raise exception 'CANCEL_REQUIRES_REVIEWED';
  end if;

  update public.purchase_documents
     set status = 'cancelled'
   where id = p_id;

  insert into public.purchase_document_audit (
    purchase_document_id, action, actor_user_id, payload
  ) values (
    p_id,
    'invoice_cancelled',
    v_actor,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'previous_status', v_status
    )
  );
end;
$$;

drop function if exists public.senda_map_purchase_document_line(uuid, uuid, numeric);

create or replace function public.senda_map_purchase_document_line(
  p_line_id uuid,
  p_inventory_product_id uuid,
  p_inventory_physical_quantity numeric,
  p_actor_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_doc uuid;
  v_location uuid;
  v_status text;
  v_eligibility text;
  v_old_product uuid;
  v_unmapped integer;
  v_qty numeric;
begin
  v_actor := public.senda_require_backend_actor(p_actor_user_id);

  select l.purchase_document_id into v_doc
  from public.purchase_document_lines l
  where l.id = p_line_id;

  if v_doc is null then
    raise exception 'LINE_NOT_FOUND';
  end if;

  select d.location_id, d.status into v_location, v_status
  from public.purchase_documents d
  where d.id = v_doc
  for update;

  select l.inventory_eligibility, l.inventory_product_id
    into v_eligibility, v_old_product
  from public.purchase_document_lines l
  where l.id = p_line_id
  for update;

  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;
  if v_status is distinct from 'reviewed' then
    raise exception 'MAP_REQUIRES_REVIEWED';
  end if;
  if v_eligibility is distinct from 'eligible' then
    raise exception 'MAP_REQUIRES_ELIGIBLE';
  end if;

  v_qty := case
    when p_inventory_product_id is null then 0
    else coalesce(p_inventory_physical_quantity, 0)
  end;

  update public.purchase_document_lines
     set inventory_product_id = p_inventory_product_id,
         mapping_status = case
           when p_inventory_product_id is null then 'unmapped'
           else 'mapped'
         end,
         inventory_physical_quantity = v_qty
   where id = p_line_id;

  select count(*) into v_unmapped
  from public.purchase_document_lines
  where purchase_document_id = v_doc
    and mapping_status = 'unmapped';

  update public.purchase_documents
     set unmapped_line_count = v_unmapped
   where id = v_doc;

  insert into public.purchase_document_audit (
    purchase_document_id, action, actor_user_id, payload
  ) values (
    v_doc,
    'invoice_line_mapped',
    v_actor,
    jsonb_build_object(
      'line_id', p_line_id,
      'previous_product_id', v_old_product,
      'inventory_product_id', p_inventory_product_id,
      'actor_user_id', v_actor,
      'inventory_physical_quantity', v_qty
    )
  );
end;
$$;

comment on function public.senda_save_purchase_invoice(jsonb) is
  'Save atomico service_role. actor_user_id del backend. HMAC fuera de PG.';
comment on function public.senda_cancel_purchase_invoice(uuid, uuid) is
  'Anula reviewed -> cancelled. Solo service_role. No borra Storage.';
comment on function public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid) is
  'Mapeo posterior. Solo service_role. No toca importes ni stock.';

-- =============================================================================
-- B. RLS y permisos efectivos
-- =============================================================================
-- authenticated: SELECT (RLS). EXECUTE solo senda_is_purchase_member.
--                Sin EXECUTE de save/cancel/map. Sin INSERT/UPDATE/DELETE.
-- anon / PUBLIC: nada.
-- service_role: SELECT (bypass RLS) + EXECUTE de RPC de escritura.
--               Sin GRANT de tabla INSERT/UPDATE/DELETE. La escritura es DEFINER.
-- postgres / owner: bypass. Triggers igual aplican.
-- INSERT/UPDATE policies quedan como red de seguridad si un GRANT se filtra.

alter table public.purchase_documents enable row level security;
alter table public.purchase_document_lines enable row level security;
alter table public.purchase_document_audit enable row level security;

drop policy if exists purchase_documents_member_select on public.purchase_documents;
create policy purchase_documents_member_select
on public.purchase_documents
for select
to authenticated
using (public.senda_is_purchase_member(location_id));

drop policy if exists purchase_documents_member_insert on public.purchase_documents;
create policy purchase_documents_member_insert
on public.purchase_documents
for insert
to authenticated
with check (
  public.senda_is_purchase_member(location_id)
  and status = 'draft'
);

drop policy if exists purchase_documents_member_update on public.purchase_documents;
create policy purchase_documents_member_update
on public.purchase_documents
for update
to authenticated
using (public.senda_is_purchase_member(location_id))
with check (public.senda_is_purchase_member(location_id));

drop policy if exists purchase_document_lines_member_select on public.purchase_document_lines;
create policy purchase_document_lines_member_select
on public.purchase_document_lines
for select
to authenticated
using (
  exists (
    select 1 from public.purchase_documents d
    where d.id = purchase_document_lines.purchase_document_id
      and public.senda_is_purchase_member(d.location_id)
  )
);

drop policy if exists purchase_document_lines_member_insert on public.purchase_document_lines;
create policy purchase_document_lines_member_insert
on public.purchase_document_lines
for insert
to authenticated
with check (
  exists (
    select 1 from public.purchase_documents d
    where d.id = purchase_document_lines.purchase_document_id
      and public.senda_is_purchase_member(d.location_id)
      and d.status = 'draft'
  )
);

drop policy if exists purchase_document_lines_member_update on public.purchase_document_lines;
create policy purchase_document_lines_member_update
on public.purchase_document_lines
for update
to authenticated
using (
  exists (
    select 1 from public.purchase_documents d
    where d.id = purchase_document_lines.purchase_document_id
      and public.senda_is_purchase_member(d.location_id)
      and d.status = 'reviewed'
  )
)
with check (
  exists (
    select 1 from public.purchase_documents d
    where d.id = purchase_document_lines.purchase_document_id
      and public.senda_is_purchase_member(d.location_id)
      and d.status = 'reviewed'
  )
);

drop policy if exists purchase_document_lines_member_all on public.purchase_document_lines;

drop policy if exists purchase_document_audit_member_select on public.purchase_document_audit;
create policy purchase_document_audit_member_select
on public.purchase_document_audit
for select
to authenticated
using (
  exists (
    select 1 from public.purchase_documents d
    where d.id = purchase_document_audit.purchase_document_id
      and public.senda_is_purchase_member(d.location_id)
  )
);

drop policy if exists purchase_document_audit_member_insert on public.purchase_document_audit;

revoke all on table public.purchase_documents from public, anon, authenticated, service_role;
revoke all on table public.purchase_document_lines from public, anon, authenticated, service_role;
revoke all on table public.purchase_document_audit from public, anon, authenticated, service_role;

grant select on table public.purchase_documents to authenticated, service_role;
grant select on table public.purchase_document_lines to authenticated, service_role;
grant select on table public.purchase_document_audit to authenticated, service_role;

revoke all on function public.senda_actor_is_purchase_member(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.senda_require_backend_actor(uuid) from public, anon, authenticated, service_role;
revoke all on function public.senda_is_purchase_member(uuid) from public, anon;
revoke all on function public.purchase_documents_before_write() from public, anon, authenticated, service_role;
revoke all on function public.purchase_document_lines_before_write() from public, anon, authenticated, service_role;
revoke all on function public.purchase_document_audit_before_write() from public, anon, authenticated, service_role;
revoke all on function public.senda_save_purchase_invoice(jsonb) from public, anon, authenticated;
revoke all on function public.senda_cancel_purchase_invoice(uuid, uuid) from public, anon, authenticated;
revoke all on function public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid) from public, anon, authenticated;

grant execute on function public.senda_is_purchase_member(uuid) to authenticated;
grant execute on function public.senda_save_purchase_invoice(jsonb) to service_role;
grant execute on function public.senda_cancel_purchase_invoice(uuid, uuid) to service_role;
grant execute on function public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid) to service_role;

-- =============================================================================
-- C. Storage — NO crear bucket
-- =============================================================================
-- Bucket futuro privado: invoice-documents
-- Path: {organization_id}/invoices/{file_sha256}.{ext}
-- Backend: HMAC + upload + rpc senda_save_purchase_invoice via service_role.
-- El RPC es el commit de PostgreSQL. Storage queda fuera a proposito.
-- Fallo upload: no RPC. Fallo RPC: objeto huerfano; job 24 h.
-- Unique hash (no cancelled): reintento idempotente (23505).
-- Unique voucher (no cancelled) / otro hash: 409.

commit;

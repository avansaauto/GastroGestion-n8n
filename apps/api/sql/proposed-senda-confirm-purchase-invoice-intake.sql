-- SENDA OPS — Confirmación atómica de factura (documento + líneas)
-- RPC: senda_confirm_purchase_invoice_intake(jsonb)
-- Helper interno: senda_ensure_inventory_product_for_intake(jsonb)
-- Intentos: purchase_document_confirm_attempts
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción.
-- Después: apps/api/sql/verify-senda-confirm-purchase-invoice-intake.sql (solo lectura).
-- Opcional: apps/api/sql/test-senda-confirm-purchase-invoice-intake.sql (fixtures + ROLLBACK).
--
-- Contrato: apps/api/sql/proposed-senda-invoice-create-map-receive.md
--
-- No REPLACE senda_receive / senda_map / senda_set_inventory_product_active.
-- No toca Fudo ni anulación. EXECUTE del RPC solo service_role.
-- El helper create NO tiene GRANT: solo lo invoca el RPC (mismo owner).
-- Si los helpers ya están instalados, no reejecutar este archivo.
-- La paridad de empaques va en proposed-senda-confirm-intake-unit-parity.sql.

begin;

-- =============================================================================
-- 0. Preflight
-- =============================================================================
do $guard$
declare
  missing_tables text;
  missing_cols text;
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'senda_confirm_purchase_invoice_intake'
      and pg_get_function_identity_arguments(p.oid) = 'p jsonb'
  ) then
    raise exception 'CONFIRM_INTAKE_RPC_EXISTS';
  end if;

  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'CONFIRM_INTAKE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regprocedure('public.senda_actor_is_purchase_member(uuid, uuid)') is null then
    raise exception 'CONFIRM_INTAKE_ABORT: falta senda_actor_is_purchase_member(uuid, uuid).';
  end if;
  if to_regprocedure('public.senda_map_purchase_document_line(uuid, uuid, numeric, uuid)') is null then
    raise exception 'CONFIRM_INTAKE_ABORT: falta senda_map_purchase_document_line.';
  end if;
  if to_regprocedure('public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)') is null then
    raise exception 'CONFIRM_INTAKE_ABORT: falta senda_receive_purchase_document_line.';
  end if;
  if to_regprocedure('public.senda_set_inventory_product_active(jsonb)') is null then
    raise exception 'CONFIRM_INTAKE_ABORT: falta senda_set_inventory_product_active(jsonb).';
  end if;
  if to_regprocedure('public.senda_purchase_line_is_inventoriable(text, text, text, text, numeric, numeric)') is null then
    raise exception 'CONFIRM_INTAKE_ABORT: falta senda_purchase_line_is_inventoriable.';
  end if;
  if to_regprocedure('public.senda_is_org_active_member(uuid)') is null then
    raise exception 'CONFIRM_INTAKE_ABORT: falta senda_is_org_active_member(uuid).';
  end if;

  select string_agg(t.table_name, ', ' order by 1)
    into missing_tables
    from (
      values
        ('purchase_documents'),
        ('purchase_document_lines'),
        ('purchase_document_audit'),
        ('purchase_document_receipts'),
        ('inventory_products'),
        ('location_inventory'),
        ('locations'),
        ('organizations')
    ) as t(table_name)
  where to_regclass(format('public.%I', t.table_name)) is null;
  if missing_tables is not null then
    raise exception 'CONFIRM_INTAKE_ABORT: faltan tablas: %', missing_tables;
  end if;

  select string_agg(c.column_name, ', ' order by 1)
    into missing_cols
    from (
      values
        ('organization_id'),
        ('location_id'),
        ('status')
    ) as c(column_name)
  where not exists (
    select 1
    from information_schema.columns col
    where col.table_schema = 'public'
      and col.table_name = 'purchase_documents'
      and col.column_name = c.column_name
  );
  if missing_cols is not null then
    raise exception 'CONFIRM_INTAKE_ABORT: faltan columnas en purchase_documents: %', missing_cols;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'inventory_products' and column_name = 'active'
  ) then
    raise exception 'CONFIRM_INTAKE_ABORT: falta inventory_products.active.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'inventory_products' and column_name = 'category'
  ) then
    raise exception 'CONFIRM_INTAKE_ABORT: falta inventory_products.category.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'location_inventory'
      and column_name = 'minimum_stock'
  ) then
    raise exception 'CONFIRM_INTAKE_ABORT: falta location_inventory.minimum_stock.';
  end if;
end
$guard$;

-- =============================================================================
-- 1. Persistencia de intentos de confirmación (idempotencia por intento)
-- =============================================================================
create table public.purchase_document_confirm_attempts (
  id uuid primary key default gen_random_uuid(),
  purchase_document_id uuid not null references public.purchase_documents (id) on delete cascade,
  confirm_idempotency_key uuid not null,
  payload_digest text not null,
  status text not null default 'succeeded'
    constraint purchase_document_confirm_attempts_status_chk
      check (status in ('succeeded')),
  result jsonb not null,
  actor_user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint purchase_document_confirm_attempts_key_uniq
    unique (confirm_idempotency_key)
);

create index purchase_document_confirm_attempts_document_idx
  on public.purchase_document_confirm_attempts (purchase_document_id, created_at desc);

comment on table public.purchase_document_confirm_attempts is
  'Intentos exitosos de senda_confirm_purchase_invoice_intake. Misma clave + digest → replay; misma clave + digest distinto → conflicto. Varias filas por documento permiten confirmar pendientes después.';
comment on column public.purchase_document_confirm_attempts.confirm_idempotency_key is
  'Clave de idempotencia del intento. Única globalmente.';
comment on column public.purchase_document_confirm_attempts.payload_digest is
  'MD5 del array canónico de líneas del intento.';
comment on column public.purchase_document_confirm_attempts.result is
  'Respuesta jsonb del intento exitoso (replay).';
comment on column public.purchase_document_confirm_attempts.status is
  'Solo succeeded: los fallos hacen rollback de la transacción y no persisten.';

alter table public.purchase_document_confirm_attempts enable row level security;

create policy purchase_document_confirm_attempts_member_select
  on public.purchase_document_confirm_attempts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.purchase_documents d
      where d.id = purchase_document_id
        and public.senda_is_org_active_member(d.organization_id)
    )
  );

revoke all on table public.purchase_document_confirm_attempts
  from public, anon, authenticated;
grant select on table public.purchase_document_confirm_attempts to authenticated;
grant insert on table public.purchase_document_confirm_attempts to service_role;

-- Auditoría: extender el CHECK existente sin perder acciones ya permitidas.
-- Origen conocido: migrate-invoice-persistence + migrate-inventory-reception.
do $audit$
declare
  v_def text;
  v_actions text[];
  v_sql text;
begin
  select pg_get_constraintdef(c.oid)
    into v_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'purchase_document_audit'
    and c.conname = 'purchase_document_audit_action_chk';

  if v_def is null then
    raise exception 'CONFIRM_INTAKE_ABORT: falta purchase_document_audit_action_chk.';
  end if;

  if v_def ilike '%invoice_intake_confirmed%' then
    return;
  end if;

  select coalesce(array_agg(distinct m[1] order by m[1]), '{}'::text[])
    into v_actions
  from regexp_matches(v_def, '''([^'']+)''', 'g') as x(m);

  if not (
    'invoice_reviewed' = any (v_actions)
    and 'invoice_cancelled' = any (v_actions)
    and 'invoice_line_mapped' = any (v_actions)
    and 'invoice_line_received' = any (v_actions)
  ) then
    raise exception
      'CONFIRM_INTAKE_ABORT: purchase_document_audit_action_chk incompatible (se esperaban invoice_reviewed, invoice_cancelled, invoice_line_mapped, invoice_line_received). Def: %',
      v_def;
  end if;

  v_actions := v_actions || array['invoice_intake_confirmed'];

  alter table public.purchase_document_audit
    drop constraint purchase_document_audit_action_chk;

  v_sql := format(
    'alter table public.purchase_document_audit add constraint purchase_document_audit_action_chk check (action in (%s))',
    (
      select string_agg(quote_literal(a), ', ' order by a)
      from unnest(v_actions) as a
    )
  );
  execute v_sql;
end
$audit$;

-- =============================================================================
-- 2. Conversión de unidades (espejo de apps/api/src/http/invoiceUnits.ts)
-- API: resuelve factor SI / exige factor de empaque / calcula physical y envía
--      conversion_factor efectivo + inventory_physical_quantity.
-- RPC: revalida contra unidad/cantidad de la línea y base_unit del producto.
-- =============================================================================
create function public.senda_confirm_intake_canonical_unit(p_unit text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v text;
  v_token text;
  i int;
begin
  v := lower(btrim(coalesce(p_unit, '')));
  v := translate(v, 'áéíóúàèìòùäëïöüñ', 'aeiouaeiouaeiouun');
  v := regexp_replace(v, '\([^)]*\)', ' ', 'g');
  v := regexp_replace(v, '\s+', ' ', 'g');
  v := btrim(v);
  if v = '' then return null; end if;

  v_token := v;
  for i in 1..2 loop
    if v_token in ('m3', 'm³', 'm^3') then return 'm3'; end if;
    if v_token in ('l', 'lt', 'lts', 'litro', 'litros') then return 'l'; end if;
    if v_token in ('ml', 'mililitro', 'mililitros') then return 'ml'; end if;
    if v_token in ('cl', 'centilitro', 'centilitros') then return 'cl'; end if;
    if v_token in ('kg', 'kilo', 'kilos', 'kilogramo', 'kilogramos') then return 'kg'; end if;
    if v_token in ('g', 'gr', 'grs', 'gramo', 'gramos') then return 'g'; end if;
    if v_token in ('mg', 'miligramo', 'miligramos') then return 'mg'; end if;
    if v_token in ('docena', 'docenas') then return 'docena'; end if;
    if v_token in ('unit', 'u', 'un', 'uni', 'und', 'unid', 'unidad', 'unidades') then return 'unit'; end if;
    if v_token in (
      'caja', 'cajas', 'pack', 'packs', 'bulto', 'bultos', 'barril', 'barriles',
      'bidon', 'bidones', 'maple', 'cajon', 'cajones', 'pallet', 'palet',
      'pieza', 'piezas', 'lata', 'latas', 'bolsa', 'bolsas',
      'botella', 'botellas', 'plancha', 'planchas', 'barra', 'barras',
      'horma', 'hormas', 'bloque', 'bloques'
    ) then
      return v_token;
    end if;
    exit when i = 2 or position(' ' in v_token) = 0;
    v_token := split_part(v_token, ' ', 1);
  end loop;

  if v_token = '' then return null; end if;
  return v_token;
end;
$$;

create function public.senda_confirm_intake_assert_physical(
  p_invoice_unit text,
  p_base_unit text,
  p_invoice_qty numeric,
  p_conversion_factor numeric,
  p_physical numeric
)
returns numeric
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_from text;
  v_to text;
  v_packaging boolean;
  v_from_family text;
  v_to_family text;
  v_from_to_base numeric;
  v_to_to_base numeric;
  v_known numeric;
  v_factor numeric;
  v_expected numeric;
begin
  if p_invoice_qty is null or p_invoice_qty <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;
  if p_physical is null or p_physical <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  v_from := public.senda_confirm_intake_canonical_unit(p_invoice_unit);
  v_to := public.senda_confirm_intake_canonical_unit(p_base_unit);
  if v_to is null then
    raise exception 'INCOMPATIBLE_UNITS';
  end if;

  -- Sin unidad de factura: equivalencia explícita solo hacia g, ml o unit.
  if v_from is null then
    if v_to in ('g', 'ml', 'unit') then
      if p_conversion_factor is null or p_conversion_factor <= 0 then
        raise exception 'EQUIVALENCE_REQUIRED';
      end if;
      v_factor := round(p_conversion_factor, 6);
    else
      raise exception 'INCOMPATIBLE_UNITS';
    end if;
  else
    v_packaging := v_from in (
      'caja', 'cajas', 'pack', 'packs', 'bulto', 'bultos', 'barril', 'barriles',
      'bidon', 'bidones', 'maple', 'cajon', 'cajones', 'pallet', 'palet',
      'pieza', 'piezas', 'lata', 'latas', 'bolsa', 'bolsas',
      'botella', 'botellas', 'plancha', 'planchas', 'barra', 'barras',
      'horma', 'hormas', 'bloque', 'bloques'
    ) or v_to in (
      'caja', 'cajas', 'pack', 'packs', 'bulto', 'bultos', 'barril', 'barriles',
      'bidon', 'bidones', 'maple', 'cajon', 'cajones', 'pallet', 'palet',
      'pieza', 'piezas', 'lata', 'latas', 'bolsa', 'bolsas',
      'botella', 'botellas', 'plancha', 'planchas', 'barra', 'barras',
      'horma', 'hormas', 'bloque', 'bloques'
    );

    if v_packaging then
      if p_conversion_factor is null or p_conversion_factor <= 0 then
        raise exception 'EQUIVALENCE_REQUIRED';
      end if;
      v_factor := round(p_conversion_factor, 6);
    elsif v_from = v_to then
      v_known := 1;
      if p_conversion_factor is not null then
        if round(p_conversion_factor, 6) is distinct from round(v_known, 6) then
          raise exception 'INVALID_CONVERSION';
        end if;
        v_factor := round(p_conversion_factor, 6);
      else
        v_factor := v_known;
      end if;
    else
      v_from_family := case
        when v_from in ('l', 'cl', 'ml', 'm3') then 'volume'
        when v_from in ('kg', 'g', 'mg') then 'mass'
        when v_from in ('unit', 'docena') then 'count'
        else null
      end;
      v_to_family := case
        when v_to in ('l', 'cl', 'ml', 'm3') then 'volume'
        when v_to in ('kg', 'g', 'mg') then 'mass'
        when v_to in ('unit', 'docena') then 'count'
        else null
      end;
      if v_from_family is null or v_to_family is null or v_from_family is distinct from v_to_family then
        -- unit ↔ otra dimensión: factor explícito. docena no hereda esa excepción.
        if v_from = 'unit' or v_to = 'unit' then
          if p_conversion_factor is null or p_conversion_factor <= 0 then
            raise exception 'EQUIVALENCE_REQUIRED';
          end if;
          v_factor := round(p_conversion_factor, 6);
        else
          raise exception 'INCOMPATIBLE_UNITS';
        end if;
      else
        v_from_to_base := case v_from
          when 'l' then 1000
          when 'cl' then 10
          when 'ml' then 1
          when 'm3' then 1000000
          when 'kg' then 1000
          when 'g' then 1
          when 'mg' then 0.001
          when 'unit' then 1
          when 'docena' then 12
        end;
        v_to_to_base := case v_to
          when 'l' then 1000
          when 'cl' then 10
          when 'ml' then 1
          when 'm3' then 1000000
          when 'kg' then 1000
          when 'g' then 1
          when 'mg' then 0.001
          when 'unit' then 1
          when 'docena' then 12
        end;
        v_known := round(v_from_to_base / v_to_to_base, 6);
        if v_known is null or v_known <= 0 then
          raise exception 'INCOMPATIBLE_UNITS';
        end if;
        if p_conversion_factor is not null then
          if round(p_conversion_factor, 6) is distinct from v_known then
            raise exception 'INVALID_CONVERSION';
          end if;
          v_factor := round(p_conversion_factor, 6);
        else
          v_factor := v_known;
        end if;
      end if;
    end if;
  end if;

  v_expected := round(p_invoice_qty * v_factor, 6);
  if round(p_physical, 6) is distinct from v_expected then
    raise exception 'INVALID_CONVERSION';
  end if;

  return v_factor;
end;
$$;

revoke all on function public.senda_confirm_intake_canonical_unit(text)
  from public, anon, authenticated, service_role;
revoke all on function public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)
  from public, anon, authenticated, service_role;

-- =============================================================================
-- 3. Helper create (DEFINER, sin GRANT — solo callable desde el RPC owner)
-- =============================================================================
create function public.senda_ensure_inventory_product_for_intake(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_name text;
  v_base text;
  v_category text;
  v_id uuid;
  v_norm text;
  v_existing public.inventory_products%rowtype;
  v_minimum numeric;
  v_location uuid;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
    v_location := nullif(p->>'location_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  if v_org is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;
  if v_location is null then
    raise exception 'LOCATION_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id = v_location
      and l.organization_id = v_org
  ) then
    raise exception 'LOCATION_ORG_MISMATCH';
  end if;

  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;

  v_name := nullif(btrim(coalesce(p->>'name', '')), '');
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'INVALID_NAME';
  end if;

  v_base := lower(btrim(coalesce(p->>'base_unit', '')));
  if v_base in ('gr', 'gramo', 'gramos') then v_base := 'g'; end if;
  if v_base in ('mililitro', 'mililitros') then v_base := 'ml'; end if;
  if v_base in ('u', 'un', 'unidad', 'unidades') then v_base := 'unit'; end if;
  if v_base not in ('g', 'ml', 'unit') then
    raise exception 'INVALID_BASE_UNIT';
  end if;

  v_category := nullif(btrim(coalesce(p->>'category', '')), '');

  if p ? 'minimum_stock' and nullif(p->>'minimum_stock', '') is not null then
    begin
      v_minimum := (p->>'minimum_stock')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'INVALID_MINIMUM_STOCK';
    end;
    if v_minimum is null or v_minimum < 0 then
      raise exception 'INVALID_MINIMUM_STOCK';
    end if;
  else
    v_minimum := 0;
  end if;

  v_norm := lower(
    regexp_replace(
      translate(
        v_name,
        'ÁÀÄÂáàäâÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔóòöôÚÙÜÛúùüûÑñ',
        'AAAAAAAAEEEEEEEIIIIIIIIOOOOOOOOUUUUUUUUnn'
      ),
      '[^a-z0-9]+',
      ' ',
      'g'
    )
  );
  v_norm := btrim(v_norm);

  -- Serializa altas concurrentes del mismo nombre normalizado en la org.
  -- SELECT FOR UPDATE solo bloquea filas existentes; sin lock dos inserts
  -- podrían pasar el chequeo cuando aún no hay fila.
  perform pg_advisory_xact_lock(
    hashtext('senda_ensure_inv:' || v_org::text),
    hashtext(v_norm)
  );

  -- Solo un insumo activo ocupa el nombre. El inactivo queda intacto.
  select *
    into v_existing
  from public.inventory_products ip
  where ip.organization_id = v_org
    and ip.active is true
    and btrim(lower(regexp_replace(
      translate(
        ip.name,
        'ÁÀÄÂáàäâÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔóòöôÚÙÜÛúùüûÑñ',
        'AAAAAAAAEEEEEEEIIIIIIIIOOOOOOOOUUUUUUUUnn'
      ),
      '[^a-z0-9]+', ' ', 'g'
    ))) = v_norm
  order by ip.id
  limit 1
  for update;

  if v_existing.id is not null then
    raise exception 'DUPLICATE_PRODUCT';
  end if;

  insert into public.inventory_products (
    organization_id, name, base_unit, active, category
  ) values (
    v_org, v_name, v_base, true, v_category
  )
  returning id into v_id;

  insert into public.location_inventory (
    location_id, inventory_product_id, minimum_stock, active
  ) values (
    v_location, v_id, v_minimum, true
  )
  on conflict (location_id, inventory_product_id) do update
    set minimum_stock = excluded.minimum_stock,
        active = true;

  return v_id;
end;
$$;

comment on function public.senda_ensure_inventory_product_for_intake(jsonb) is
  'Alta de insumo para confirmación atómica. Sin GRANT público: solo el RPC confirm (mismo owner). Duplicado solo contra insumos activos. Un inactivo no se reactiva ni se modifica.';

revoke all on function public.senda_ensure_inventory_product_for_intake(jsonb)
  from public, anon, authenticated, service_role;

-- =============================================================================
-- 4. RPC principal
-- =============================================================================
create function public.senda_confirm_purchase_invoice_intake(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_location uuid;
  v_doc uuid;
  v_key uuid;
  v_digest text;
  v_status text;
  v_doc_org uuid;
  v_doc_location uuid;
  v_line jsonb;
  v_line_id uuid;
  v_action text;
  v_product_id uuid;
  v_physical numeric;
  v_receive numeric;
  v_receive_key uuid;
  v_factor numeric;
  v_payload_ids uuid[];
  v_expected_ids uuid[];
  v_row public.purchase_document_lines%rowtype;
  v_lines_out jsonb := '[]'::jsonb;
  v_line_out jsonb;
  v_receive_result jsonb;
  v_created boolean;
  v_reactivated boolean;
  v_mapped boolean;
  v_unmapped integer;
  v_result jsonb;
  v_sorted jsonb;
  v_attempt public.purchase_document_confirm_attempts%rowtype;
  v_has_receipts boolean;
  v_received_sum numeric;
  v_authorized numeric;
  v_product_active boolean;
  v_product_org uuid;
  v_product_base text;
  v_invoice_qty numeric;
  v_invoice_unit text;
  v_create_base text;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
    v_location := (p->>'location_id')::uuid;
    v_doc := (p->>'purchase_document_id')::uuid;
    v_key := (p->>'confirm_idempotency_key')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;

  if v_org is null or v_location is null or v_doc is null or v_key is null then
    raise exception 'INVALID_PAYLOAD';
  end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' then
    raise exception 'INVALID_PAYLOAD';
  end if;
  if jsonb_array_length(p->'lines') < 1 then
    raise exception 'INVALID_PAYLOAD';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id = v_location
      and l.organization_id = v_org
  ) then
    raise exception 'LOCATION_ORG_MISMATCH';
  end if;

  if not public.senda_actor_is_purchase_member(v_location, v_actor) then
    raise exception 'NOT_A_MEMBER';
  end if;

  select d.organization_id, d.location_id, d.status
    into v_doc_org, v_doc_location, v_status
  from public.purchase_documents d
  where d.id = v_doc
  for update;

  if v_doc_location is null then
    raise exception 'DOCUMENT_NOT_FOUND';
  end if;
  if v_doc_location is distinct from v_location then
    raise exception 'LOCATION_MISMATCH';
  end if;
  if v_doc_org is distinct from v_org then
    raise exception 'ORGANIZATION_MISMATCH';
  end if;
  if v_status is distinct from 'reviewed' and v_status is distinct from 'received' then
    raise exception 'CONFIRM_REQUIRES_REVIEWED';
  end if;

  -- Digest canónico: líneas ordenadas por purchase_document_line_id
  select coalesce(jsonb_agg(elem order by elem->>'purchase_document_line_id'), '[]'::jsonb)
    into v_sorted
  from jsonb_array_elements(p->'lines') as t(elem);

  v_digest := md5(v_sorted::text);

  select *
    into v_attempt
  from public.purchase_document_confirm_attempts a
  where a.confirm_idempotency_key = v_key
  for update;

  if v_attempt.id is not null then
    if v_attempt.purchase_document_id is distinct from v_doc then
      raise exception 'CONFIRM_IDEMPOTENCY_CONFLICT';
    end if;
    if v_attempt.payload_digest is distinct from v_digest then
      raise exception 'CONFIRM_IDEMPOTENCY_CONFLICT';
    end if;
    return coalesce(v_attempt.result, '{}'::jsonb) || jsonb_build_object('idempotent', true);
  end if;

  -- IDs esperados: elegibles inventariables del documento
  select coalesce(array_agg(l.id order by l.id), '{}'::uuid[])
    into v_expected_ids
  from public.purchase_document_lines l
  where l.purchase_document_id = v_doc
    and public.senda_purchase_line_is_inventoriable(
      l.inventory_eligibility,
      l.mapping_status,
      l.classification,
      l.quantity_kind,
      l.reviewed_amount,
      l.original_amount
    );

  begin
    select coalesce(
      (
        select array_agg(x order by x)
        from (
          select distinct (elem->>'purchase_document_line_id')::uuid as x
          from jsonb_array_elements(p->'lines') as t(elem)
        ) s
      ),
      '{}'::uuid[]
    )
      into v_payload_ids;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;

  if coalesce(array_length(v_payload_ids, 1), 0) is distinct from jsonb_array_length(p->'lines') then
    raise exception 'DUPLICATE_LINE';
  end if;
  if v_payload_ids is distinct from v_expected_ids then
    raise exception 'LINES_MISMATCH';
  end if;

  -- Procesamiento determinista: orden por source_index, id
  for v_line in
    select elem
    from jsonb_array_elements(p->'lines') as t(elem)
    join public.purchase_document_lines l
      on l.id = (elem->>'purchase_document_line_id')::uuid
    order by l.source_index nulls last, l.id
  loop
    v_line_id := (v_line->>'purchase_document_line_id')::uuid;
    v_action := lower(btrim(coalesce(v_line->>'action', '')));
    v_created := false;
    v_reactivated := false;
    v_mapped := false;
    v_product_id := null;
    v_receive_result := null;
    v_factor := null;
    v_physical := null;
    v_receive := null;

    select * into v_row
    from public.purchase_document_lines l
    where l.id = v_line_id
    for update;

    if v_row.id is null or v_row.purchase_document_id is distinct from v_doc then
      raise exception 'LINE_NOT_FOUND';
    end if;

    v_has_receipts := exists (
      select 1
      from public.purchase_document_receipts r
      where r.purchase_document_line_id = v_line_id
    );

    if v_action = 'pending' then
      if v_row.mapping_status is distinct from 'unmapped' or v_has_receipts then
        raise exception 'PENDING_NOT_ALLOWED';
      end if;
      v_lines_out := v_lines_out || jsonb_build_array(jsonb_build_object(
        'purchase_document_line_id', v_line_id,
        'action', 'pending',
        'inventory_product_id', null,
        'created', false,
        'reactivated', false,
        'mapped', false,
        'inventory_physical_quantity', null,
        'receive', null
      ));
      continue;
    end if;

    if v_action not in ('link_existing', 'create', 'reactivate') then
      raise exception 'INVALID_ACTION';
    end if;

    begin
      v_physical := nullif(v_line->>'inventory_physical_quantity', '')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'INVALID_QUANTITY';
    end;
    if v_physical is null or v_physical <= 0 then
      raise exception 'INVALID_QUANTITY';
    end if;

    if v_line ? 'conversion_factor' and nullif(v_line->>'conversion_factor', '') is not null then
      begin
        v_factor := (v_line->>'conversion_factor')::numeric;
      exception
        when invalid_text_representation then
          raise exception 'INVALID_CONVERSION';
      end;
      if v_factor is null or v_factor <= 0 then
        raise exception 'INVALID_CONVERSION';
      end if;
    else
      v_factor := null;
    end if;

    v_invoice_qty := coalesce(v_row.reviewed_quantity, v_row.original_quantity);
    v_invoice_unit := coalesce(v_row.reviewed_unit, v_row.original_unit);

    if v_action = 'create' then
      if v_row.mapping_status is distinct from 'unmapped' or v_has_receipts then
        raise exception 'LINE_ALREADY_MAPPED';
      end if;
      v_create_base := lower(btrim(coalesce(v_line->'create'->>'base_unit', '')));
      if v_create_base in ('gr', 'gramo', 'gramos') then v_create_base := 'g'; end if;
      if v_create_base in ('mililitro', 'mililitros') then v_create_base := 'ml'; end if;
      if v_create_base in ('u', 'un', 'unidad', 'unidades') then v_create_base := 'unit'; end if;
      if v_create_base not in ('g', 'ml', 'unit') then
        raise exception 'INVALID_BASE_UNIT';
      end if;
      v_factor := public.senda_confirm_intake_assert_physical(
        v_invoice_unit,
        v_create_base,
        v_invoice_qty,
        v_factor,
        v_physical
      );
      v_product_id := public.senda_ensure_inventory_product_for_intake(
        coalesce(v_line->'create', '{}'::jsonb)
        || jsonb_build_object(
          'actor_user_id', v_actor,
          'organization_id', v_org,
          'location_id', v_location
        )
      );
      v_created := true;
      v_product_base := v_create_base;
      v_product_active := true;
      v_product_org := v_org;
    elsif v_action = 'reactivate' then
      begin
        v_product_id := (v_line->>'inventory_product_id')::uuid;
      exception
        when invalid_text_representation then
          raise exception 'INVALID_PAYLOAD';
      end;
      if v_product_id is null then
        raise exception 'PRODUCT_REQUIRED';
      end if;
      perform public.senda_set_inventory_product_active(jsonb_build_object(
        'actor_user_id', v_actor,
        'organization_id', v_org,
        'inventory_product_id', v_product_id,
        'active', true,
        'expected_active', false
      ));
      v_reactivated := true;
      select ip.active, ip.organization_id, ip.base_unit
        into v_product_active, v_product_org, v_product_base
      from public.inventory_products ip
      where ip.id = v_product_id;
    else
      begin
        v_product_id := (v_line->>'inventory_product_id')::uuid;
      exception
        when invalid_text_representation then
          raise exception 'INVALID_PAYLOAD';
      end;
      if v_product_id is null then
        raise exception 'PRODUCT_REQUIRED';
      end if;
      select ip.active, ip.organization_id, ip.base_unit
        into v_product_active, v_product_org, v_product_base
      from public.inventory_products ip
      where ip.id = v_product_id;
    end if;

    if v_product_org is null then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;
    if v_product_org is distinct from v_org then
      raise exception 'PRODUCT_ORG_MISMATCH';
    end if;
    if v_product_active is distinct from true then
      raise exception 'PRODUCT_INACTIVE';
    end if;
    if v_product_base is null or v_product_base not in ('g', 'ml', 'unit') then
      raise exception 'INCOMPATIBLE_UNITS';
    end if;

    if v_action is distinct from 'create' then
      v_factor := public.senda_confirm_intake_assert_physical(
        v_invoice_unit,
        v_product_base,
        v_invoice_qty,
        v_factor,
        v_physical
      );
    end if;

    if v_row.mapping_status = 'mapped'
       and v_row.inventory_product_id is not distinct from v_product_id
       and coalesce(v_row.inventory_physical_quantity, -1) is not distinct from v_physical then
      v_mapped := true;
    elsif v_has_receipts then
      raise exception 'LINE_HAS_RECEIPTS';
    else
      perform public.senda_map_purchase_document_line(
        v_line_id,
        v_product_id,
        v_physical,
        v_actor
      );
      v_mapped := true;
    end if;

    begin
      v_receive := nullif(v_line->>'receive_quantity', '')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'INVALID_QUANTITY';
    end;

    if v_receive is not null and v_receive > 0 then
      begin
        v_receive_key := (v_line->>'receive_idempotency_key')::uuid;
      exception
        when invalid_text_representation then
          raise exception 'IDEMPOTENCY_KEY_REQUIRED';
      end;
      if v_receive_key is null then
        raise exception 'IDEMPOTENCY_KEY_REQUIRED';
      end if;

      select coalesce(sum(r.quantity), 0)
        into v_received_sum
      from public.purchase_document_receipts r
      where r.purchase_document_line_id = v_line_id;

      v_authorized := coalesce(
        (
          select l.inventory_physical_quantity
          from public.purchase_document_lines l
          where l.id = v_line_id
        ),
        v_physical
      );

      if v_receive > v_physical then
        raise exception 'RECEIPT_EXCEEDS_INVOICED';
      end if;
      if v_received_sum + v_receive > v_authorized then
        raise exception 'RECEIPT_EXCEEDS_INVOICED';
      end if;

      v_receive_result := public.senda_receive_purchase_document_line(
        v_doc,
        v_line_id,
        v_receive,
        v_receive_key,
        v_actor
      );
    end if;

    v_line_out := jsonb_build_object(
      'purchase_document_line_id', v_line_id,
      'action', v_action,
      'inventory_product_id', v_product_id,
      'created', v_created,
      'reactivated', v_reactivated,
      'mapped', v_mapped,
      'inventory_physical_quantity', v_physical,
      'receive', v_receive_result
    );
    v_lines_out := v_lines_out || jsonb_build_array(v_line_out);
  end loop;

  select count(*) into v_unmapped
  from public.purchase_document_lines
  where purchase_document_id = v_doc
    and mapping_status = 'unmapped';

  select status into v_status
  from public.purchase_documents
  where id = v_doc;

  v_result := jsonb_build_object(
    'purchase_document_id', v_doc,
    'document_status', v_status,
    'idempotent', false,
    'unmapped_line_count', v_unmapped,
    'lines', v_lines_out
  );

  insert into public.purchase_document_confirm_attempts (
    purchase_document_id,
    confirm_idempotency_key,
    payload_digest,
    status,
    result,
    actor_user_id
  ) values (
    v_doc,
    v_key,
    v_digest,
    'succeeded',
    v_result,
    v_actor
  );

  insert into public.purchase_document_audit (
    purchase_document_id, action, actor_user_id, payload
  ) values (
    v_doc,
    'invoice_intake_confirmed',
    v_actor,
    jsonb_build_object(
      'confirm_idempotency_key', v_key,
      'payload_digest', v_digest,
      'unmapped_line_count', v_unmapped,
      'line_count', jsonb_array_length(v_lines_out)
    )
  );

  return v_result;
end;
$$;

comment on function public.senda_confirm_purchase_invoice_intake(jsonb) is
  'Confirmación atómica create/link/reactivate/map/receive. Intentos en purchase_document_confirm_attempts. Solo service_role. Reutiliza map/receive/active. No recalcula costos.';

revoke all on function public.senda_confirm_purchase_invoice_intake(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_confirm_purchase_invoice_intake(jsonb)
  to service_role;

-- Owner alineado a map (incluye helper interno)
do $$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'senda_map_purchase_document_line'
  order by p.oid
  limit 1;
  if v_owner is null then
    raise exception 'CONFIRM_INTAKE_ABORT: no se pudo clonar owner de map.';
  end if;
  execute format(
    'alter function public.senda_confirm_intake_canonical_unit(text) owner to %I',
    v_owner
  );
  execute format(
    'alter function public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric) owner to %I',
    v_owner
  );
  execute format(
    'alter function public.senda_ensure_inventory_product_for_intake(jsonb) owner to %I',
    v_owner
  );
  execute format(
    'alter function public.senda_confirm_purchase_invoice_intake(jsonb) owner to %I',
    v_owner
  );
  execute format(
    'alter table public.purchase_document_confirm_attempts owner to %I',
    v_owner
  );
end $$;

-- Verificación in-transaction mínima
do $verify$
declare
  v_body text;
  v_ensure text;
  v_audit text;
begin
  v_body := pg_get_functiondef('public.senda_confirm_purchase_invoice_intake(jsonb)'::regprocedure);
  v_ensure := pg_get_functiondef('public.senda_ensure_inventory_product_for_intake(jsonb)'::regprocedure);

  select pg_get_constraintdef(c.oid)
    into v_audit
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'purchase_document_audit'
    and c.conname = 'purchase_document_audit_action_chk';

  if v_body not ilike '%senda_map_purchase_document_line%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el confirm no llama a map.';
  end if;
  if v_body not ilike '%senda_receive_purchase_document_line%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el confirm no llama a receive.';
  end if;
  if v_body not ilike '%senda_set_inventory_product_active%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el confirm no llama a set_inventory_product_active.';
  end if;
  if v_body not ilike '%senda_confirm_intake_assert_physical%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el confirm no revalida conversiones.';
  end if;
  if v_body not ilike '%purchase_document_confirm_attempts%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el confirm no persiste intentos.';
  end if;
  if v_body not ilike '%PENDING_NOT_ALLOWED%' then
    raise exception 'CONFIRM_INTAKE_ABORT: falta validación PENDING_NOT_ALLOWED.';
  end if;
  if v_body not ilike '%CONFIRM_IDEMPOTENCY_CONFLICT%' then
    raise exception 'CONFIRM_INTAKE_ABORT: falta CONFIRM_IDEMPOTENCY_CONFLICT.';
  end if;
  if v_body ilike '%insert into public.inventory_movements%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el confirm no debe insertar movimientos propios.';
  end if;
  if v_body ilike '%average_unit_cost%' or v_body ilike '%purchase_cost%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el confirm no debe recalcular costos.';
  end if;
  if v_ensure ilike '%undefined_column%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el helper no debe ocultar undefined_column.';
  end if;
  if v_ensure not ilike '%LOCATION_ORG_MISMATCH%'
     or v_ensure not ilike '%NOT_A_MEMBER%'
     or v_ensure not ilike '%senda_require_backend_actor%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el helper debe validar actor/org/sucursal.';
  end if;
  if v_ensure not ilike '%pg_advisory_xact_lock%' then
    raise exception 'CONFIRM_INTAKE_ABORT: el helper debe usar pg_advisory_xact_lock contra altas concurrentes.';
  end if;
  if has_function_privilege('service_role', 'public.senda_ensure_inventory_product_for_intake(jsonb)', 'EXECUTE') then
    raise exception 'CONFIRM_INTAKE_ABORT: el helper no debe tener EXECUTE para service_role.';
  end if;
  if has_function_privilege('service_role', 'public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)', 'EXECUTE') then
    raise exception 'CONFIRM_INTAKE_ABORT: assert_physical no debe tener EXECUTE para service_role.';
  end if;
  if v_audit is null
     or v_audit not ilike '%invoice_intake_confirmed%'
     or v_audit not ilike '%invoice_line_received%'
     or v_audit not ilike '%invoice_line_mapped%'
     or v_audit not ilike '%invoice_reviewed%'
     or v_audit not ilike '%invoice_cancelled%' then
    raise exception 'CONFIRM_INTAKE_ABORT: audit action chk incompleto tras extender: %', v_audit;
  end if;
end
$verify$;

commit;

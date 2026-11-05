-- SENDA OPS — Catálogo persistente de productos Fudo.
-- NO EJECUTAR hasta autorización explícita.
-- Aplicar en: Supabase Dashboard → SQL Editor → Run.
-- Después: apps/api/sql/verify-fudo-product-catalog.sql (solo lectura).
--
-- Separado de pending_product_mappings y sales_product_mappings.
-- No crea recetas, no toca stock ni RPC de consumo.
-- Escritura: solo service_role (el API upserta con credencial de integración).
-- Lectura: miembros activos de la organización (authenticated + RLS).

begin;

do $guard$
begin
  if to_regclass('public.fudo_product_catalog') is not null then
    raise exception 'MIGRACIÓN ABORT: fudo_product_catalog ya existe.';
  end if;
  if to_regclass('public.integration_credentials') is not null then
    raise exception 'MIGRACIÓN ABORT: integration_credentials ya existe.';
  end if;
end
$guard$;

create table public.fudo_product_catalog (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null references public.locations (id),
  source text not null default 'fudo' check (source = 'fudo'),
  external_product_id text not null,
  name text not null,
  active boolean not null default true,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fudo_product_catalog_external_id_not_blank
    check (btrim(external_product_id) <> ''),
  constraint fudo_product_catalog_name_not_blank
    check (btrim(name) <> ''),
  constraint fudo_product_catalog_location_external_uniq
    unique (location_id, source, external_product_id)
);

create index fudo_product_catalog_location_active_idx
  on public.fudo_product_catalog (location_id, active);

comment on table public.fudo_product_catalog is
  'Catálogo Fudo sincronizado por sucursal. No es pending_product_mappings ni crea recetas.';

-- Credenciales de integración (alcance específico). El secreto NO se guarda en claro.
create table public.integration_credentials (
  id uuid primary key,
  secret_hash text not null,
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null references public.locations (id),
  scopes text[] not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  expires_at timestamptz,
  label text,
  created_at timestamptz not null default now(),
  constraint integration_credentials_secret_hash_hex
    check (secret_hash ~ '^[0-9a-f]{64}$'),
  constraint integration_credentials_scopes_not_empty
    check (cardinality(scopes) >= 1)
);

comment on table public.integration_credentials is
  'Credenciales machine (snd_). secret_hash = HMAC-SHA256(pepper, secret). Sin service_role al cliente.';

alter table public.fudo_product_catalog enable row level security;
alter table public.integration_credentials enable row level security;

create policy fudo_product_catalog_member_select
  on public.fudo_product_catalog
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.organization_id = fudo_product_catalog.organization_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

-- integration_credentials: sin políticas para authenticated/anon.
-- Solo service_role (bypass RLS) lee secret_hash desde la API.

revoke all on table public.fudo_product_catalog from public, anon, authenticated;
revoke all on table public.integration_credentials from public, anon, authenticated;

grant select on table public.fudo_product_catalog to authenticated;
grant select, insert, update, delete on table public.fudo_product_catalog to service_role;
grant select, insert, update, delete on table public.integration_credentials to service_role;

commit;

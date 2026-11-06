-- SENDA OPS — Integración Fudo por local.
-- NO EJECUTAR hasta autorización explícita.
-- Idempotente. No borra fudo_product_catalog, integration_credentials,
-- recetas, stock ni organizaciones.
--
-- location_provider_integrations guarda API Key y API Secret cifrados
-- (AES-256-GCM, clave PROVIDER_CREDENTIALS_KEY). No son tokens snd_.
-- integration_sync_jobs identifica un trabajo. n8n recibe el id, no los secretos.
-- Lectura y escritura: solo service_role. La API verifica membresía admin.

begin;

create table if not exists public.location_provider_integrations (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null references public.locations (id),
  provider text not null default 'fudo' check (provider = 'fudo'),
  status text not null check (status in ('connected', 'disconnected', 'invalid', 'error')),
  api_key_ciphertext text,
  api_secret_ciphertext text,
  key_last4 text,
  last_connection_ok_at timestamptz,
  last_connection_error text,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint location_provider_integrations_location_provider_uniq unique (location_id, provider),
  constraint location_provider_integrations_sync_status
    check (last_sync_status is null or last_sync_status in ('queued', 'running', 'succeeded', 'failed')),
  constraint location_provider_integrations_secrets_together check (
    (api_key_ciphertext is null and api_secret_ciphertext is null)
    or (api_key_ciphertext is not null and api_secret_ciphertext is not null)
  )
);

create table if not exists public.integration_sync_jobs (
  id uuid primary key,
  integration_id uuid not null references public.location_provider_integrations (id),
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null references public.locations (id),
  provider text not null default 'fudo' check (provider = 'fudo'),
  kind text not null default 'catalog' check (kind = 'catalog'),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  error text,
  received integer not null default 0,
  upserted integer not null default 0,
  deactivated integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists integration_sync_jobs_location_created_idx
  on public.integration_sync_jobs (location_id, created_at desc);

comment on table public.location_provider_integrations is
  'Credenciales de proveedor por sucursal, cifradas. No sustituye a integration_credentials (snd_).';

comment on table public.integration_sync_jobs is
  'Trabajo de sincronización. El identificador viaja a n8n; los secretos no.';

alter table public.location_provider_integrations enable row level security;
alter table public.integration_sync_jobs enable row level security;

revoke all on table public.location_provider_integrations from public, anon, authenticated;
revoke all on table public.integration_sync_jobs from public, anon, authenticated;

grant select, insert, update, delete on table public.location_provider_integrations to service_role;
grant select, insert, update, delete on table public.integration_sync_jobs to service_role;

commit;

-- Credencial machine para que n8n ejecute trabajos de cualquier local conectado.
-- NO insertar todavía. Alcance distinto de fudo.catalog.sync (ese sigue siendo el de OGHAM).
-- scopes: array['fudo.sync.run']
-- organization_id / location_id: un local interno de la plataforma, no el del cliente.
-- El endpoint /run usa el local del trabajo, no el de esta credencial.

-- GastroGest / SENDA — SELECT RLS para historial de inventario
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Causa observada: inventory_movements con RLS y sin política SELECT
-- ⇒ el JWT autenticado recibe [] sin error. El historial de sucursal
-- queda vacío pese a existir movimientos (p. ej. Barrio Chino / MAYORISTANET).
-- inventory_adjustments: authenticated sin GRANT SELECT ⇒ permission denied
-- al enriquecer motivos de merma/ajuste.
--
-- La API ya mitiga con service_role tras validar membresía. Esta migración
-- habilita lectura directa del JWT para el mismo alcance.
--
-- Requiere senda_is_org_active_member(uuid) (DEFINER).
-- authenticated: solo SELECT. anon: nada. service_role: no se toca.

begin;

do $guard$
declare
  missing text;
  existing_policies int;
begin
  if to_regprocedure('public.senda_is_org_active_member(uuid)') is null then
    raise exception 'INVENTORY_MOVEMENTS_SELECT_ABORT: falta senda_is_org_active_member(uuid).';
  end if;

  select string_agg(t.table_name, ', ' order by 1)
    into missing
  from (
    values
      ('inventory_movements'),
      ('inventory_adjustments'),
      ('location_inventory'),
      ('locations')
  ) as t(table_name)
  where to_regclass(format('public.%I', t.table_name)) is null;
  if missing is not null then
    raise exception 'INVENTORY_MOVEMENTS_SELECT_ABORT: faltan tablas: %', missing;
  end if;

  select count(*)
    into existing_policies
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename in ('inventory_movements', 'inventory_adjustments')
    and cmd = 'SELECT';
  if existing_policies > 0 then
    raise exception 'INVENTORY_MOVEMENTS_SELECT_POLICY_EXISTS';
  end if;
end
$guard$;

alter table public.inventory_movements enable row level security;
alter table public.inventory_adjustments enable row level security;

grant select on table public.inventory_movements to authenticated;
grant select on table public.inventory_adjustments to authenticated;

create policy inventory_movements_member_select
on public.inventory_movements
for select
to authenticated
using (
  exists (
    select 1
    from public.location_inventory li
    join public.locations l on l.id = li.location_id
    where li.id = inventory_movements.location_inventory_id
      and public.senda_is_org_active_member(l.organization_id)
  )
);

create policy inventory_adjustments_member_select
on public.inventory_adjustments
for select
to authenticated
using (
  public.senda_is_org_active_member(organization_id)
);

commit;

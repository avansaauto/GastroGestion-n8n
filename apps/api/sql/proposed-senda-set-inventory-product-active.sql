-- SENDA OPS — Eliminación de inventario
-- RPC TRANSACCIONAL senda_set_inventory_product_active.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Después: apps/api/sql/verify-senda-set-inventory-product-active.sql (solo lectura).
--
-- Contrato: apps/api/sql/proposed-senda-set-inventory-product-active.md
--
-- Baja lógica del insumo. Conserva movimientos, valuaciones, mappings y recetas.
-- Bloquea si recetas activas lo usan. No escribe quantity_on_hand.
-- EXECUTE solo service_role. No GRANT UPDATE/DELETE sobre inventory_products.
--
-- Dependencia de recepción: senda_receive_purchase_document_line debe rechazar
-- productos inactivos con PRODUCT_INACTIVE. Aplicar antes el parche independiente
-- proposed-senda-receive-require-active-product.sql (no reejecutar
-- migrate-inventory-reception). Este RPC no REPLACE la recepción.

begin;

do $guard$
declare
  missing text;
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'senda_set_inventory_product_active'
      and pg_get_function_identity_arguments(p.oid) = 'p jsonb'
  ) then
    raise exception 'INVENTORY_PRODUCT_ACTIVE_RPC_EXISTS';
  end if;

  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'INVENTORY_PRODUCT_ACTIVE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;

  select string_agg(t.table_name, ', ' order by 1)
    into missing
    from (
      values
        ('inventory_products'),
        ('recipe_components'),
        ('recipes'),
        ('organizations'),
        ('organization_members')
    ) as t(table_name)
  where to_regclass(format('public.%I', t.table_name)) is null;
  if missing is not null then
    raise exception 'INVENTORY_PRODUCT_ACTIVE_ABORT: faltan tablas: %', missing;
  end if;

  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'inventory_products'
      and c.column_name = 'active'
  ) then
    raise exception 'INVENTORY_PRODUCT_ACTIVE_ABORT: falta inventory_products.active.';
  end if;
end
$guard$;

create function public.senda_set_inventory_product_active(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_product_id uuid;
  v_desired boolean;
  v_expected boolean;
  v_product public.inventory_products%rowtype;
  v_used_by jsonb;
  v_replay boolean := false;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
    v_product_id := (p->>'inventory_product_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  if v_org is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;
  if v_product_id is null then
    raise exception 'PRODUCT_REQUIRED';
  end if;

  if jsonb_typeof(p->'active') is distinct from 'boolean' then
    raise exception 'INVALID_PAYLOAD';
  end if;
  v_desired := (p->>'active')::boolean;

  if jsonb_typeof(p->'expected_active') is distinct from 'boolean' then
    raise exception 'EXPECTED_REQUIRED';
  end if;
  v_expected := (p->>'expected_active')::boolean;

  if not exists (select 1 from public.organizations o where o.id = v_org) then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;

  if not exists (
    select 1
    from public.organization_members m
    where m.organization_id = v_org
      and v_actor is not null
      and m.user_id = v_actor
      and m.status = 'active'
      and m.role in ('admin', 'operator')
  ) then
    raise exception 'NOT_A_MEMBER';
  end if;

  select *
    into v_product
  from public.inventory_products ip
  where ip.id = v_product_id
    and ip.organization_id = v_org
  for update;
  if v_product.id is null then
    raise exception 'PRODUCT_NOT_IN_ORG';
  end if;

  if (v_product.active is true) is not distinct from v_desired then
    v_replay := true;
    v_used_by := '[]'::jsonb;
  else
    if (v_product.active is true) is distinct from v_expected then
      raise exception 'CONCURRENT_UPDATE';
    end if;

    if v_desired is not true then
      select coalesce(
        jsonb_agg(
          jsonb_build_object('recipe_id', parent.id, 'name', parent.name)
          order by parent.name
        ),
        '[]'::jsonb
      )
        into v_used_by
      from public.recipe_components c
      join public.recipes parent
        on parent.id = c.recipe_id
      where c.inventory_product_id = v_product_id
        and parent.organization_id = v_org
        and parent.active is true;
      if jsonb_array_length(v_used_by) > 0 then
        raise exception 'PRODUCT_IN_USE';
      end if;
    else
      v_used_by := '[]'::jsonb;
    end if;

    update public.inventory_products
       set active = v_desired
     where id = v_product_id
       and organization_id = v_org;
  end if;

  return jsonb_build_object(
    'inventory_product_id', v_product_id,
    'organization_id', v_org,
    'active', v_desired,
    'replay', v_replay,
    'used_by', v_used_by
  );
end;
$$;

comment on function public.senda_set_inventory_product_active(jsonb) is
  'Baja lógica de insumo. Conserva historial y stock. Bloquea recetas activas. Recepción de facturas mapeadas debe fallar con PRODUCT_INACTIVE hasta reactivar. Solo service_role.';

revoke all on function public.senda_set_inventory_product_active(jsonb) from public, anon, authenticated;
grant execute on function public.senda_set_inventory_product_active(jsonb) to service_role;

do $verify$
declare
  v_body text;
begin
  v_body := pg_get_functiondef('public.senda_set_inventory_product_active(jsonb)'::regprocedure);
  if v_body ilike '%delete from public.inventory_products%'
     or v_body ilike '%delete from public.inventory_movements%'
     or v_body ilike '%set quantity_on_hand%'
     or v_body ilike '%insert into public.inventory_movements%'
     or v_body ilike '%purchase_documents%' then
    raise exception 'INVENTORY_PRODUCT_ACTIVE_ABORT: el RPC no debe borrar ni mover stock.';
  end if;
end
$verify$;

commit;

-- SENDA OPS — Paso 437
-- RPC TRANSACCIONAL senda_set_recipe_active.
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción. Si un guardia falla,
-- ROLLBACK.
-- Después: apps/api/sql/verify-senda-set-recipe-active.sql (solo lectura).
--
-- Contrato: apps/api/sql/proposed-senda-set-recipe-active.md
--
-- No hay REPLACE de senda_create_recipe, senda_update_recipe ni
-- senda_save_fudo_recipe. Si senda_set_recipe_active ya existe, aborta
-- (RECIPE_STATUS_RPC_EXISTS).
--
-- Reutiliza senda_require_backend_actor. No la recrea. No GRANT/REVOKE sobre ella.
-- EXECUTE solo service_role.
--
-- Membresía: admin/operator activo de la organización. No exige local.
-- Cambia únicamente recipes.active. Conserva BOM, categoría, rendimiento,
-- mappings Fudo y pendientes. No escribe stock ni ventas.
-- Bloquea desactivar si una receta activa la usa como subreceta (RECIPE_IN_USE).
-- Concurrencia por expected_active + FOR UPDATE.

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
      and p.proname = 'senda_set_recipe_active'
      and pg_get_function_identity_arguments(p.oid) = 'p jsonb'
  ) then
    raise exception 'RECIPE_STATUS_RPC_EXISTS';
  end if;

  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'RECIPE_STATUS_ABORT: falta senda_require_backend_actor(uuid).';
  end if;

  select string_agg(t.table_name, ', ' order by 1)
    into missing
    from (
      values
        ('recipes'),
        ('recipe_components'),
        ('sales_product_mappings'),
        ('organizations'),
        ('organization_members')
    ) as t(table_name)
  where to_regclass(format('public.%I', t.table_name)) is null;
  if missing is not null then
    raise exception 'RECIPE_STATUS_ABORT: faltan tablas: %', missing;
  end if;

  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'recipes'
      and c.column_name = 'active'
  ) then
    raise exception 'RECIPE_STATUS_ABORT: falta recipes.active.';
  end if;
end
$guard$;

create function public.senda_set_recipe_active(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_recipe_id uuid;
  v_desired boolean;
  v_expected boolean;
  v_recipe public.recipes%rowtype;
  v_used_by jsonb;
  v_mapping_count integer;
  v_replay boolean := false;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);

  begin
    v_org := (p->>'organization_id')::uuid;
    v_recipe_id := (p->>'recipe_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'INVALID_PAYLOAD';
  end;
  if v_org is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;
  if v_recipe_id is null then
    raise exception 'RECIPE_REQUIRED';
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
    into v_recipe
  from public.recipes r
  where r.id = v_recipe_id
    and r.organization_id = v_org
  for update;
  if v_recipe.id is null then
    raise exception 'RECIPE_NOT_IN_ORG';
  end if;

  if (v_recipe.active is true) is not distinct from v_desired then
    v_replay := true;
    v_used_by := '[]'::jsonb;
  else
    if (v_recipe.active is true) is distinct from v_expected then
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
      where c.component_recipe_id = v_recipe_id
        and parent.organization_id = v_org
        and parent.active is true;
      if jsonb_array_length(v_used_by) > 0 then
        raise exception 'RECIPE_IN_USE';
      end if;
    else
      v_used_by := '[]'::jsonb;
    end if;

    update public.recipes
       set active = v_desired
     where id = v_recipe_id
       and organization_id = v_org;
  end if;

  select count(*)
    into v_mapping_count
  from public.sales_product_mappings
  where recipe_id = v_recipe_id
    and active is not false;

  return jsonb_build_object(
    'recipe_id', v_recipe_id,
    'active', v_desired,
    'replay', v_replay,
    'used_by', coalesce(v_used_by, '[]'::jsonb),
    'active_mapping_count', coalesce(v_mapping_count, 0)
  );
exception
  when invalid_text_representation then
    raise exception 'INVALID_PAYLOAD';
  when serialization_failure or deadlock_detected then
    raise exception 'CONCURRENT_UPDATE';
end;
$$;

comment on function public.senda_set_recipe_active(jsonb) is
  'Activa o desactiva una receta de organización. Conserva BOM y mappings Fudo. service_role + actor getUser. Sin stock.';

revoke all on function public.senda_set_recipe_active(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_set_recipe_active(jsonb)
  to service_role;

do $verify$
declare
  v_definer boolean;
  v_body text;
begin
  select p.prosecdef, pg_get_functiondef(p.oid)
    into v_definer, v_body
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = to_regprocedure('public.senda_set_recipe_active(jsonb)');
  if not coalesce(v_definer, false) then
    raise exception 'RECIPE_STATUS_VERIFY_FAILED: no es SECURITY DEFINER';
  end if;
  if not has_function_privilege('service_role', 'public.senda_set_recipe_active(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.senda_set_recipe_active(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.senda_set_recipe_active(jsonb)', 'EXECUTE') then
    raise exception 'RECIPE_STATUS_VERIFY_FAILED: EXECUTE no es solo service_role';
  end if;
  v_body := coalesce(v_body, '');
  if v_body not ilike '%EXPECTED_REQUIRED%'
     or v_body not ilike '%CONCURRENT_UPDATE%'
     or v_body not ilike '%RECIPE_IN_USE%'
     or v_body not ilike '%update public.recipes%'
     or v_body not ilike '%set active = v_desired%'
     or v_body ilike '%delete from public.recipes%'
     or v_body ilike '%delete from public.recipe_components%'
     or v_body ilike '%insert into public.sales_product_mappings%'
     or v_body ilike '%update public.sales_product_mappings%'
     or v_body ilike '%delete from public.sales_product_mappings%'
     or v_body ilike '%pending_product_mappings%'
     or v_body ilike '%register_sale_consumption%'
     or v_body ilike '%inventory_movements%' then
    raise exception 'RECIPE_STATUS_VERIFY_FAILED: cuerpo inesperado';
  end if;
end
$verify$;

commit;

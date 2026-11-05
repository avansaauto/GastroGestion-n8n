-- GastroGest / SENDA — RPC senda_delete_recipe
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- REQUERIDO para eliminar recetas que tienen filas en location_recipe_prices:
-- service_role tiene SELECT/INSERT/UPDATE ahí, pero DELETE está revocado
-- (escritura de precios solo vía senda_set_location_recipe_price).
-- Sin este RPC DEFINER, la API responde RECIPE_PRICE_DELETE_DENIED y no muta.
--
-- Reglas:
-- - Solo recetas inactivas.
-- - Bloquea si otras recetas la usan como subreceta (activas o no).
-- - Borra sales_product_mappings, location_recipe_prices y recipe_components propios.
-- - Un mapping Fudo NO se trata como venta histórica.
-- - No toca inventory_movements ni stock.
--
-- Después: verify-senda-delete-recipe.sql (solo lectura).

begin;

do $guard$
begin
  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'RECIPE_DELETE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regclass('public.recipes') is null then
    raise exception 'RECIPE_DELETE_ABORT: falta recipes.';
  end if;
  if to_regprocedure('public.senda_delete_recipe(jsonb)') is not null then
    raise exception 'RECIPE_DELETE_ABORT: senda_delete_recipe ya existe.';
  end if;
end
$guard$;

create function public.senda_delete_recipe(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_recipe uuid;
  v_row public.recipes%rowtype;
  v_used_by jsonb;
  v_mappings int := 0;
  v_prices int := 0;
  v_components int := 0;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);
  v_org := (p->>'organization_id')::uuid;
  v_recipe := (p->>'recipe_id')::uuid;
  if v_org is null or v_recipe is null then
    raise exception 'INVALID_PAYLOAD';
  end if;

  if not exists (
    select 1
    from public.organization_members m
    where m.organization_id = v_org
      and m.user_id = v_actor
      and m.status = 'active'
      and m.role in ('admin', 'operator')
  ) then
    raise exception 'NOT_A_MEMBER';
  end if;

  select * into v_row
  from public.recipes r
  where r.id = v_recipe
    and r.organization_id = v_org
  for update;
  if v_row.id is null then
    raise exception 'RECIPE_NOT_IN_ORG';
  end if;
  if v_row.active is true then
    raise exception 'RECIPE_STILL_ACTIVE';
  end if;

  select coalesce(
    jsonb_agg(jsonb_build_object('recipe_id', parent.id, 'name', parent.name) order by parent.name),
    '[]'::jsonb
  )
    into v_used_by
  from public.recipe_components c
  join public.recipes parent on parent.id = c.recipe_id
  where c.component_recipe_id = v_recipe
    and parent.organization_id = v_org;
  if jsonb_array_length(v_used_by) > 0 then
    raise exception 'RECIPE_IN_USE';
  end if;

  if to_regclass('public.sales_product_mappings') is not null then
    delete from public.sales_product_mappings where recipe_id = v_recipe;
    get diagnostics v_mappings = row_count;
  end if;
  if to_regclass('public.location_recipe_prices') is not null then
    delete from public.location_recipe_prices where recipe_id = v_recipe;
    get diagnostics v_prices = row_count;
  end if;

  delete from public.recipe_components where recipe_id = v_recipe;
  get diagnostics v_components = row_count;

  delete from public.recipes where id = v_recipe and organization_id = v_org;

  return jsonb_build_object(
    'recipe_id', v_recipe,
    'deleted', true,
    'removed_mapping_count', v_mappings,
    'removed_price_count', v_prices,
    'removed_component_count', v_components,
    'used_by', v_used_by
  );
end;
$$;

revoke all on function public.senda_delete_recipe(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_delete_recipe(jsonb)
  to service_role;

commit;

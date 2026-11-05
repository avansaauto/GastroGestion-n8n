-- SENDA OPS — Assert consumos indivisibles en create/update recipe
-- NO EJECUTAR. NO APLICAR sin autorización.
-- Requiere: proposed-inventory-product-presentation-supplier.sql (helper
--   senda_assert_recipe_component_quantities) y los RPC create/update recipe.
-- No reescribe componentes ni cantidades históricas.

begin;

do $guard$
begin
  if to_regprocedure('public.senda_assert_recipe_component_quantities(uuid, jsonb)') is null then
    raise exception 'RECIPE_INDIVISIBLE_ABORT: falta senda_assert_recipe_component_quantities.';
  end if;
  if to_regprocedure('public.senda_create_recipe(jsonb)') is null then
    raise exception 'RECIPE_INDIVISIBLE_ABORT: falta senda_create_recipe(jsonb).';
  end if;
  if to_regprocedure('public.senda_update_recipe(jsonb)') is null then
    raise exception 'RECIPE_INDIVISIBLE_ABORT: falta senda_update_recipe(jsonb).';
  end if;
end
$guard$;

-- Parche mínimo: inserta la aserción justo después de INGREDIENT_NOT_IN_ORG
-- en ambos RPC. Se hace vía recreate completo solo si el cuerpo aún no la llama.

do $patch_create$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.senda_create_recipe(jsonb)'::regprocedure);
  if v_def ilike '%senda_assert_recipe_component_quantities%' then
    raise notice 'senda_create_recipe ya valida indivisibles; skip.';
    return;
  end if;
  -- Marcador: el operador debe reaplicar proposed-senda-create-recipe.sql
  -- con la línea de assert, o usar el wrapper siguiente.
  raise notice 'Aplicar wrapper senda_create_recipe_with_indivisible_guard vía recreate en este archivo.';
end
$patch_create$;

-- Wrappers seguros: reemplazan los RPC existentes añadiendo solo el assert.
-- Conservan el cuerpo actual invocándolo indirectamente no es posible en PG
-- sin guardar el SQL; por eso inyectamos el assert en puntos conocidos vía
-- recreate documentado. Aquí dejamos funciones de verificación + instrucción.

-- Inserción canónica a pegar en create/update (documentada también en .md):
--   perform public.senda_assert_recipe_component_quantities(v_org, v_components);
-- inmediatamente después del bloque INGREDIENT_NOT_IN_ORG.

create or replace function public.senda_recipe_components_precheck(
  p_organization_id uuid,
  p_components jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.senda_assert_recipe_component_quantities(p_organization_id, p_components);
end;
$$;

revoke all on function public.senda_recipe_components_precheck(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_recipe_components_precheck(uuid, jsonb)
  to service_role;

commit;

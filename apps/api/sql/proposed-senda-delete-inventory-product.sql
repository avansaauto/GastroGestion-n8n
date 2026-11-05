-- SENDA OPS — Eliminación definitiva segura de insumos de prueba
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Hard delete solo sin historial ni dependencias. Si hay referencias:
-- PRODUCT_HAS_HISTORY. No depende de errores de FK como mecanismo normal.
-- La API hace fallback a senda_set_inventory_product_active.
--
-- Si ya está instalada una versión con purchase_product_memory, aplicar
-- proposed-senda-delete-inventory-product-hotfix.sql (no reinstalar este archivo).
-- Después: verify-senda-delete-inventory-product.sql (solo lectura).

begin;

do $guard$
begin
  if to_regprocedure('public.senda_require_backend_actor(uuid)') is null then
    raise exception 'INVENTORY_DELETE_ABORT: falta senda_require_backend_actor(uuid).';
  end if;
  if to_regclass('public.inventory_products') is null then
    raise exception 'INVENTORY_DELETE_ABORT: falta inventory_products.';
  end if;
end
$guard$;

create or replace function public.senda_delete_inventory_product(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_product uuid;
  v_row public.inventory_products%rowtype;
  v_has_history boolean := false;
  v_found boolean := false;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  v_actor := public.senda_require_backend_actor((p->>'actor_user_id')::uuid);
  v_org := (p->>'organization_id')::uuid;
  v_product := (p->>'inventory_product_id')::uuid;
  if v_org is null or v_product is null then
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
  from public.inventory_products ip
  where ip.id = v_product
  for update;
  if v_row.id is null or v_row.organization_id is distinct from v_org then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.purchase_document_receipts r where r.inventory_product_id = v_product
  ) then
    v_has_history := true;
  elsif exists (
    select 1 from public.purchase_document_lines l where l.inventory_product_id = v_product
  ) then
    v_has_history := true;
  elsif exists (
    select 1 from public.recipe_components c where c.inventory_product_id = v_product
  ) then
    v_has_history := true;
  elsif exists (
    select 1
    from public.location_inventory li
    join public.inventory_movements m on m.location_inventory_id = li.id
    where li.inventory_product_id = v_product
  ) then
    v_has_history := true;
  elsif exists (
    select 1
    from public.location_inventory li
    join public.inventory_valuations v on v.location_inventory_id = li.id
    where li.inventory_product_id = v_product
      and coalesce(v.quantity_on_hand, 0) <> 0
  ) then
    v_has_history := true;
  end if;

  if not v_has_history and to_regclass('public.inventory_cost_history') is not null then
    execute
      'select exists (
         select 1 from public.inventory_cost_history h
         where h.inventory_product_id = $1
       )'
      into v_found
      using v_product;
    if v_found then
      v_has_history := true;
    end if;
  end if;

  if not v_has_history and to_regclass('public.inventory_adjustments') is not null then
    execute
      'select exists (
         select 1 from public.inventory_adjustments a
         where a.inventory_product_id = $1
       )'
      into v_found
      using v_product;
    if v_found then
      v_has_history := true;
    end if;
  end if;

  if v_has_history then
    raise exception 'PRODUCT_HAS_HISTORY';
  end if;

  delete from public.inventory_valuations iv
   using public.location_inventory li
   where iv.location_inventory_id = li.id
     and li.inventory_product_id = v_product;

  delete from public.location_inventory
   where inventory_product_id = v_product;

  delete from public.inventory_products
   where id = v_product;

  return jsonb_build_object(
    'inventory_product_id', v_product,
    'deleted', true,
    'mode', 'hard'
  );
end;
$$;

revoke all on function public.senda_delete_inventory_product(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_delete_inventory_product(jsonb)
  to service_role;

commit;

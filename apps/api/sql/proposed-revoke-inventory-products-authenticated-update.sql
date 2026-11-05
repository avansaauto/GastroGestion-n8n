-- SENDA OPS — Revoco mínimo UPDATE/DELETE de authenticated sobre inventory_products
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Contexto: verify no_authenticated_update_grant falla por GRANT preexistente.
-- proposed-senda-set-inventory-product-active.sql NO concedió ese privilegio.
-- El frontend/API escribe active/nombre/mínimo vía RPC service_role; authenticated
-- solo necesita SELECT (+ INSERT para alta de insumos con política RLS).
--
-- Tras aplicar (cuando se autorice): re-correr
--   verify-senda-set-inventory-product-active.sql
-- y el inspect de solo lectura.

begin;

do $guard$
begin
  if to_regclass('public.inventory_products') is null then
    raise exception 'REVOKE_ABORT: falta public.inventory_products.';
  end if;
end
$guard$;

-- Solo table-level. No toca SELECT ni INSERT. No toca service_role ni anon.
revoke update, delete on table public.inventory_products from authenticated;

-- Por si el privilegio llegó vía PUBLIC (común en tablas creadas tempr).
revoke update, delete on table public.inventory_products from public;

commit;

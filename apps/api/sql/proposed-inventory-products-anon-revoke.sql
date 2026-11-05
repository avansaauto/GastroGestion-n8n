-- SENDA OPS — Paso 318
-- ENDURECIMIENTO DE anon. NO EJECUTAR con la política INSERT.
-- NO APLICAR automáticamente. Requiere autorización explícita aparte.
--
-- Inspección: anon tiene GRANT INSERT sobre inventory_products.
-- Sin política RLS para anon, el INSERT de anon sigue denegado por RLS.
-- El GRANT sobra y conviene revocarlo para defensa en profundidad.
--
-- No toca authenticated. No toca SELECT/UPDATE/DELETE. No toca compras.

revoke insert on table public.inventory_products from anon, public;

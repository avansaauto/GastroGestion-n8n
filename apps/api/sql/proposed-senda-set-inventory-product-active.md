# senda_set_inventory_product_active — contrato

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

Baja lógica de un insumo. No es vaciar existencias.

Hasta aplicarlo, la UI de Inventario **no ofrece** retirar ni eliminar
productos. No hay botón que aparente borrar.

Tras aplicar: `apps/api/sql/verify-senda-set-inventory-product-active.sql`.

## Qué hace

- Cambia `inventory_products.active`.
- Conserva `recipe_components`, movimientos, valuaciones y costos.
- Reintento: si `active` ya es el pedido, `replay: true`.
- Bloquea desactivar si recetas **activas** lo usan (`PRODUCT_IN_USE`).

## Qué no hace

- No `DELETE` del insumo.
- No escribe `quantity_on_hand`.
- No inserta `inventory_movements`.
- No toca facturas, Fudo ni n8n.
- No REPLACE `senda_receive_purchase_document_line`.

## Recepción tras baja

Un producto `active = false` **no** puede recibir stock desde una factura
previamente vinculada. La recepción debe fallar con `PRODUCT_INACTIVE`
hasta reactivar con este RPC (`active = true`, `expected_active = false`).

Ese guard se aplica con el parche independiente
`proposed-senda-receive-require-active-product.sql` (no reinstala
`migrate-inventory-reception`). También queda incluido en
`proposed-senda-receive-purchase-cost.sql` si se aplica la etapa de costo.

## Seguridad

- SECURITY DEFINER, `search_path = pg_catalog, public`.
- EXECUTE solo `service_role`.
- Actor: `senda_require_backend_actor`.
- Membresía: admin/operator activo de la organización.
- Aislamiento: el insumo debe pertenecer a `organization_id`.
- Concurrencia: `expected_active` + `FOR UPDATE`.

Vaciar existencias es otra operación:
`proposed-senda-adjust-inventory-quantity.sql`.

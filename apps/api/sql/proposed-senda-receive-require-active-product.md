# senda_receive — PRODUCT_INACTIVE (parche independiente)

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

Actualiza la función de recepción **ya instalada** para que un producto
`active = false` no reciba stock desde facturas mapeadas.

## Qué hace

- Parchea solo `senda_receive_purchase_document_line`.
- Inserta `PRODUCT_INACTIVE` tras la validación de organización del producto.
- Idempotente: si el guard ya existe, no modifica el cuerpo.

## Qué no hace

- No reejecuta `migrate-inventory-reception.sql`.
- No recrea tablas, triggers ni políticas de recepción.
- No aplica el SQL de costo (`proposed-senda-receive-purchase-cost.sql`).
- No toca Fudo, ventas, recetas ni GastroGest.

## Orden

Aplicar **antes** de `proposed-senda-set-inventory-product-active.sql`
(o junto con el paquete de Inventario Paso 3).

Si más adelante se aplica `proposed-senda-receive-purchase-cost.sql`, ese
archivo ya incluye el mismo guard.

Tras aplicar: `verify-senda-receive-require-active-product.sql`.

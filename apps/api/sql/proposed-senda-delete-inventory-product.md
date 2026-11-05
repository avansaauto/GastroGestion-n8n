# senda_delete_inventory_product — contrato

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

Eliminación definitiva **solo** si el insumo no tiene historial ni dependencias.

## Hard delete (seguro)

Antes del `DELETE`, el RPC enumera referencias reales. Si alguna existe,
levanta `PRODUCT_HAS_HISTORY` (no espera un error de foreign key).

Bloquea si hay:

- `purchase_document_receipts`
- `purchase_document_lines` (línea mapeada al insumo)
- `recipe_components`
- `inventory_movements` (vía `location_inventory`)
- `inventory_valuations` con `quantity_on_hand <> 0`
- `inventory_cost_history` (si existe; consulta vía `EXECUTE`)
- `inventory_adjustments` (si existe; consulta vía `EXECUTE`)

No referencia `purchase_product_memory` (no existe en SENDA; provoca 42P01).

Si la función instalada aún la menciona, aplicar
`proposed-senda-delete-inventory-product-hotfix.sql`.

Solo entonces borra valuaciones/local vacíos y el producto.

## Soft delete (fallback)

Si hay historial, la API HTTP llama `senda_set_inventory_product_active`
con `active=false`. El producto desaparece del inventario activo y conserva
movimientos, recepciones, costos y recetas.

## Qué no hace

- No borra movimientos, recepciones, valuaciones con stock ni componentes.
- No pone stock en cero.
- No usa violaciones de FK como mecanismo normal de control.

Archivo: `proposed-senda-delete-inventory-product.sql`.
Requiere `proposed-senda-set-inventory-product-active.sql` para la baja lógica.

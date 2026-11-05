# senda_update_inventory_product — contrato

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

Edita metadatos del insumo y el stock mínimo del local activo.
No escribe `quantity_on_hand` (eso es `senda_adjust_inventory_quantity`).
No escribe costos (vienen de facturas).

## Qué hace

1. Actualiza `inventory_products.name` (y `category` si la columna existe).
2. Actualiza `location_inventory.minimum_stock` del local indicado.
3. Conserva movimientos, recepciones, valuaciones y recetas.

## Qué no hace

- No escribe `quantity_on_hand` ni costos.
- No reactiva un producto ni un `location_inventory` previamente
  desactivado: al crear el registro de local hereda
  `inventory_products.active`; en conflicto solo actualiza
  `minimum_stock`.

## Seguridad

- SECURITY DEFINER, EXECUTE solo `service_role`.
- Actor + membresía de compra del local.
- Aislamiento por organización.

Archivo: `proposed-senda-update-inventory-product.sql`.

# senda_adjust_inventory_quantity — contrato

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

Ajuste trazable de existencias. No es retirar el insumo.

Hasta aplicarlo, la UI **no ofrece** vaciar existencias ni poner stock en
cero. No hay botón que aparente borrar cantidad.

Tras aplicar: `apps/api/sql/verify-senda-adjust-inventory-quantity.sql`.

## Vaciar existencias

No se hace `UPDATE inventory_valuations SET quantity_on_hand = 0`.

Se llama este RPC con:

- `quantity` = `-quantity_on_hand` actual
- `reason` no vacío (≥ 3 caracteres)
- `idempotency_key`

El RPC inserta `inventory_movements.movement_type = 'adjustment'` con
**cantidad firmada** (positiva = entrada, negativa = salida) y recién
después actualiza el saldo. No usa `abs()`: un descuento queda como salida.

## Qué no hace

- No desactiva `inventory_products`.
- No borra movimientos anteriores.
- No escribe costos (`average_unit_cost`, `last_purchase_unit_cost`).
- No toca facturas.

Si el saldo resultante sería negativo: `ADJUSTMENT_EXCEEDS_ON_HAND`.

Reintento con la misma clave y la misma cantidad: `replay: true`.
Clave reutilizada con otra cantidad: `IDEMPOTENCY_CONFLICT`.

## Seguridad

- SECURITY DEFINER.
- EXECUTE solo `service_role`.
- Membresía de compra del local (`senda_actor_is_purchase_member`).
- Aislamiento org/local/insumo.

## Trazabilidad

- Inserta `inventory_movements` (`movement_type = 'adjustment'`, quantity
  firmada) antes de actualizar el saldo.
- Persiste fila en `inventory_adjustments` (qty firmada, saldo previo/siguiente,
  motivo, actor, `idempotency_key`, `inventory_movement_id`).
- Al crear `location_inventory` hereda `inventory_products.active` (no fuerza
  `active = true`).

## movement_type

No reemplaza el CHECK por solo `('purchase', 'adjustment')`. Si falta
`adjustment`, amplía la lista conservando los tipos ya admitidos (y los
presentes en datos). Si no hay CHECK, no inventa uno restrictivo.

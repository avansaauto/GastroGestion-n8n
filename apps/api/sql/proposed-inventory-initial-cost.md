# Costo inicial de mercadería preexistente — NO requiere migración nueva

## Decisión

Reutilizar `senda_set_inventory_purchase_cost` (`source = 'manual'`), ya definido en
`proposed-senda-cpp.sql` / Etapa A.

No hay RPC nuevo ni columnas nuevas.

## Por qué alcanza

| Caso | Comportamiento existente |
|---|---|
| Stock con `average_unit_cost IS NULL` | Manual **permitido** (semilla / apertura) |
| Stock con CPP válido | `MANUAL_COST_WITH_ON_HAND` — no sobrescribe |
| Factura posterior | Sigue ponderando CPP (`source=invoice`) |
| Historial | `inventory_cost_history.source = 'manual'` (≠ factura) |
| Cantidad | El RPC **no** cambia `quantity_on_hand` |

## Flujo UI

1. Crear insumo → ajuste «Stock inicial» (si hay cantidad).
2. Si el usuario informó costo → `POST .../purchase-cost` con cantidad base y importe.
3. Edición: misma llamada solo si aún no hay valuación (sin sumar stock).

Vacío ≠ $0: no se llama al RPC si el campo está vacío.

## Ejemplo Coca-Cola

10 u × 330 ml, $900/u → stock 3.300 ml, `purchase_cost=9000`,
`average_unit_cost = 900/330`. Receta de 1 u (330 ml) = $900.

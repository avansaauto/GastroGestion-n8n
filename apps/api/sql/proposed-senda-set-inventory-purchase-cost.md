# senda_set_inventory_purchase_cost — contrato (Paso 447)

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

Adapta el SQL 446. Crea:

1. Tabla `inventory_cost_history` (append-only).
2. RPC `senda_set_inventory_purchase_cost`.

Si la tabla o el RPC ya existen, aborta (`INVENTORY_COST_HISTORY_EXISTS` /
`INVENTORY_COST_RPC_EXISTS`). No hay `CREATE OR REPLACE`.

No reutiliza ni reemplaza `senda_create_recipe`, `senda_update_recipe`,
`senda_set_recipe_active`, `senda_save_fudo_recipe`,
`senda_set_location_recipe_price` ni `senda_receive_purchase_document_line`.

Hasta aplicarlo, el POST HTTP de costo de compra responde 503
`INVENTORY_COST_RPC_PENDING` y **no llama** ningún RPC.

Tras aplicar: `apps/api/sql/verify-senda-set-inventory-purchase-cost.sql`.

## Criterio

**Último costo de compra.** El stock anterior no interviene.

- `last_purchase_unit_cost`: último costo unitario conocido.
- `average_unit_cost`: columna de compatibilidad que las recetas ya leen.
  En esta etapa **se escribe el mismo valor**. No es un promedio ponderado.
  No se presenta como promedio en la interfaz ni en este contrato.

No se renombran ni se eliminan columnas.

Cálculo: `round(purchase_cost / purchase_quantity, 8)`.

Ejemplo: 100000 ml a $180000 → $1,80 / ml. Receta de 500 ml → $900.
Segunda compra 100000 ml a $200000 → $2,00 / ml. Receta → $1000.

## Firma HTTP

La API inyecta `actor_user_id` con `getUser`, `organization_id`,
`location_id`, `inventory_product_id` y `source = 'manual'`. No se copian
del body del browser. El body solo trae `purchaseQuantity` (unidad base)
y `purchaseCost`.

## Qué guarda el RPC

El costo por unidad base del insumo en ese local.

| Campo | Semántica |
|---|---|
| Existencias | `quantity_on_hand`. **No se modifica.** |
| Contenido de la compra | Denominador. No es stock. |
| Costo de compra | Numerador. $0 es válido (bonificación, costo conocido). |
| Último costo | `last_purchase_unit_cost` y `average_unit_cost`, iguales. |
| Historial | Una fila en `inventory_cost_history` si el unitario cambió. |

Si no hay `location_inventory`, se crea la identidad (`minimum_stock = 0`,
`active = true`) **sin movimiento de stock**. Si no hay valuación, se
inserta con `quantity_on_hand = 0` y el costo. Si ya existe, solo se
actualizan los costos.

Reintento: si ambos costos ya son el pedido, `replay: true` sin escribir
ni historiar.

## Historial

`inventory_cost_history`: organización, local, insumo, costo anterior,
costo nuevo, origen (`manual` / `invoice`), `source_ref`, `effective_at`,
`recorded_at`, actor, cantidad y precio de la compra.

RLS: SELECT para miembro activo de la organización
(`senda_is_org_active_member`). Sin políticas de INSERT/UPDATE/DELETE.
`authenticated` no escribe. `service_role` INSERT, no DELETE.
Append-only.

## Seguridad y aislamiento

- SECURITY DEFINER, `search_path = pg_catalog, public`.
- EXECUTE solo `service_role`.
- Actor: `senda_require_backend_actor`.
- Escritura: `senda_actor_is_purchase_member(location_id, actor)`.
- El local debe ser de la organización. El insumo debe ser de la org.
- Concurrencia: `FOR UPDATE` de `location_inventory` y
  `inventory_valuations` antes de escribir.
- El frontend **no** escribe `inventory_valuations` ni el historial.

## Recetas

No cambian. Siguen leyendo `inventory_valuations.average_unit_cost` del
local. `null` = desconocido. `0` = costo conocido igual a cero. Al
persistir el último costo, el próximo GET de recetas recalcula costo,
ganancia y margen.

## Qué no cambia (Etapa A)

- `quantity_on_hand`
- `inventory_movements`
- facturas, recepciones, `purchase_documents`
- recetas, mappings Fudo, ventas
- `senda_receive_purchase_document_line` (sigue sin inventar costos)

## Etapa B — no implementar ahora

La recepción deberá llamar **este mismo RPC** (no un segundo escritor)
después de identificar org/local/insumo, cantidad base e importe neto:

- `source = 'invoice'`
- `source_ref` = id del recibo
- `effective_at` = fecha de la compra
- Misma transacción que el alta de stock, conservando la idempotencia
  actual de `senda_receive_purchase_document_line`

El RPC ya rechaza una factura más vieja (`effective_at` <
`last_purchase_at`) cuando `source = 'invoice'` (`skipped_stale`).
Una carga manual (`source = 'manual'`) siempre reemplaza, serializada
por `FOR UPDATE`.

No modificar el receive hasta autorizar la Etapa B.

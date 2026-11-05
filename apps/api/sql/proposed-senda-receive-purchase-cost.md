# senda_receive_purchase_document_line — Etapa B (costo automático)

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

No vuelve a crear `senda_set_inventory_purchase_cost` ni `inventory_cost_history`.
El usuario ya verificó 10/10 en el SQL de costo de compra. Este archivo solo
**REPLACE** el cuerpo de `senda_receive_purchase_document_line`.

Antes de aplicar: `apps/api/sql/verify-senda-receive-purchase-cost-preflight.sql`
(solo lectura). Después: `apps/api/sql/verify-senda-receive-purchase-cost.sql`.

## Qué cambia

Al confirmar una línea, en la **misma transacción**:

1. Identifica el insumo (`inventory_product_id` de la línea mapeada).
2. Incrementa stock con `p_quantity` (unidad base de la recepción, parcial o total).
3. Toma el importe neto `coalesce(reviewed_amount, original_amount)`.
4. **No prorratea** ese neto para el costo. Pasa al RPC instalado:
   - `purchase_cost` = neto de la línea
   - `purchase_quantity` = `inventory_physical_quantity` (cantidad facturada)
   El RPC hace `round(round(cost, 2) / qty, 8)`. Una recepción de 3 kg y otra
   de 10 kg de la misma línea quedan en el mismo unitario.
5. Incrementa `quantity_on_hand` exactamente una vez (lógica actual).
6. Llama `senda_set_inventory_purchase_cost` con `source = 'invoice'` y
   `source_ref = receipt_id`. Ese RPC escribe `last_purchase_unit_cost` y
   `average_unit_cost` (mismo valor) e historial.

No hay un segundo escritor de costos. No hay HTTP desde SQL.

## Ejemplo

10 kg de carne facturados a $200.000, unidad base gramos:

- `inventory_physical_quantity = 10000`
- `reviewed_amount = 200000`
- recepción de 3333 g o de 10000 g → unitario `$20 / g` = `$20.000 / kg`
- receta de 200 g lee `average_unit_cost` → `$4.000`

En ese ejemplo el unitario ya es exacto (20 × 3333 g = $66.660). El redondeo
intermedio sí pierde plata cuando el neto no es múltiplo exacto: 3 u a $10,
recibir 1 u → `round(10/3, 2) = 3,33` en vez de `3,33333333`. Pasar el neto
completo con la cantidad **parcial** al RPC también está prohibido:
$200.000 / 3333 g ≈ $60,006 / g.

## Orden temporal (RPC 447, sin modificarlo)

- `effective_at` = `document_date` a medianoche, o `clock_timestamp()` si no hay fecha.
- Factura más vieja que `last_purchase_at`: `skipped_stale`. El stock igual suma.
- Dos facturas con la **misma** fecha: `effective_at` iguales, el `<` no salta,
  gana la última recepción (last-write-wins).
- Costo **manual** posterior: `effective_at = now`. Una factura del mismo día
  (medianoche) queda stale y no pisa el manual.

Segunda compra más cara: último costo gana, salvo factura más vieja
(`skipped_stale` en el RPC de costo; el stock de esa recepción sí se suma).

El historial de un parcial guarda el neto y la cantidad **facturada** de la
línea (economía de la factura), no un importe prorrateado. `source_ref` sigue
siendo el `receipt_id`. Si el unitario no cambió, el RPC 447 hace replay y no
duplica historial; el stock del segundo parcial igual suma.

## Idempotencia y fallos

- Misma `idempotency_key` + mismos datos: replay **antes** de stock y costo.
  No hay segundo incremento ni segundo historial.
- Clave repetida con otros datos: `IDEMPOTENCY_CONFLICT`.
- Producto `active = false`: `PRODUCT_INACTIVE` (no suma stock; requiere
  reactivación explícita con `senda_set_inventory_product_active`).
- Neto nulo: `VALUATION_AMOUNT_REQUIRED`. Revierte stock y recibo.
- Neto negativo: `INVALID_PURCHASE_COST`. Igual, todo o nada.
- Neto 0: válido (bonificación). Unitario 0.
- Si el RPC de costo falla, PostgreSQL aborta la función de recepción.

## Qué no cambia

- Firma HTTP de recepción.
- Mapeo a inventario (no a Fudo).
- Ventas, n8n, GastroGest.
- `senda_create_recipe` / `senda_save_fudo_recipe`.
- SQL 447. No reejecutar.

## Rastro (solo lectura, no ejecutar acá)

`apps/api/sql/verify-senda-receive-trace.sql` une documento → línea → recibo →
movimiento → insumo × local. Si hay recibo, no se asume pérdida. Una línea
sale de Pendientes cuando `remaining <= 0`; Inventario lista insumos de la
organización y muestra existencias del **local seleccionado** en unidad base
(g/ml), mientras Pendientes muestra kg/L.

## HTTP posterior (no en este paso)

Cuando se autorice aplicar este SQL, `invoiceReceive.ts` debería mapear
`VALUATION_AMOUNT_REQUIRED` e `INVALID_PURCHASE_COST` a 422 en español.
Hasta entonces el fallo de valuación llega como `RECEIVE_FAILED`.

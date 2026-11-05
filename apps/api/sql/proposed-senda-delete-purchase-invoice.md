# senda_delete_purchase_invoice — eliminación lógica + reversión de stock

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

SQL (instalación completa): `proposed-senda-delete-purchase-invoice.sql`  
Hotfix (RPC ya instalada, bug 42703): `hotfix-senda-delete-purchase-invoice.sql`  
Verificación (solo lectura): `verify-senda-delete-purchase-invoice.sql`

## Relación factura → stock → costos

1. `purchase_documents` + `purchase_document_lines`.
2. Cada recepción: `purchase_document_receipts` (cantidad **recibida**).
3. Movimiento `purchase` (`source_id = receipt_id`) + suma en `inventory_valuations.quantity_on_hand`.
4. Etapa B de costos (si instalada): `inventory_cost_history` con `source = 'invoice'` y `source_ref = receipt_id`.

La reversión usa solo cantidades de recibos.

## Qué hace el RPC

Operación atómica `service_role` + actor `getUser`.

| Caso | Efecto |
|---|---|
| Sin / con recepciones | Marca `deleted_at` / `deleted_by` en el documento. **No** borra filas. Conserva líneas, recibos, audit y movimientos de compra. (No marca líneas: el trigger de líneas solo permite UPDATE en `reviewed`.) |
| Reversión | Por cada recibo: `senda_adjust_inventory_quantity` con `idempotency_key = receipt_id` y `quantity = -recibida`. No inserta `inventory_movements` a mano. |
| Valuación ausente con inventario | Materializa valuación desde movimientos o 0 y exige stock suficiente; no omite en silencio. |
| Producto eliminado o sin `location_inventory` | Registra `missing_inventory` en el log y permite la eliminación lógica (no crea inventario). |
| `location_inventory_id` inconsistente | Si el ID existe pero no coincide con el local/producto del recibo → `REVERSAL_INVENTORY_REF_MISMATCH` (abort). No descuenta otro LI. Si el ID ya no existe → `missing_inventory` (sin fallback). |
| Producto + inventario existen | Reversión **obligatoria** (también si el producto está inactivo). Fallos de vinculación/permisos/datos → `REVERSAL_ABORTED` y rollback completo (no marca `deleted_at`). |
| Stock insuficiente | Aborta todo: `REVERSAL_INSUFFICIENT_STOCK`. No permite stock negativo. |

### Compatibilidad con `senda_adjust_inventory_quantity`

Inspección del SQL propuesto de adjust: **no bloquea productos inactivos**. Solo exige que el producto exista en la org; hereda `active` al crear LI y permite `quantity` negativa si el saldo no queda bajo 0. Por tanto, la eliminación de facturas **no requiere cambiar** `senda_adjust_inventory_quantity` para revertir recepciones históricas de insumos inactivos.

Si una versión instalada distinta rechazara inactivos, habría que informar antes de tocar adjust (p. ej. flag interno `allow_inactive_reversal` solo vía delete).
| Costos | Recalcula `last_purchase_unit_cost` / `average_unit_cost` desde el historial **válido restante** (manual u invoice de factura no eliminada), **excluyendo** la factura actual. Si no hay anterior válido → ambos costos quedan `NULL` (`cleared`), no `0`. No usa `previous_unit_cost` de la fila excluida a ciegas. No borra `inventory_cost_history`. |
| Auditoría | `purchase_invoice_deletion_log` (quién, cuándo, recibos, compensaciones, costos). |
| Idempotencia | Índice único compensación por recibo; reintento con `deleted_at` ya set → `replay`. |

**No desactiva** triggers ni auditoría.  
**No modifica** CHECKs de `movement_type`, `quantity` ni `inventory_cost_history.source` (requiere `senda_adjust_inventory_quantity` ya instalado).  
**No reescribe** receive / confirm-intake / cancel / set-cost.

## Visibilidad

Las consultas normales de la API filtran `deleted_at is null`.

## Errores

- `NOT_A_MEMBER`, `DOCUMENT_NOT_FOUND`, `INVALID_PAYLOAD`
- `REVERSAL_INSUFFICIENT_STOCK:<nombre>:<necesario>:<disponible>`

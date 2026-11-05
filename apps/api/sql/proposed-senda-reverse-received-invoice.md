# Anulación de facturas ya recibidas — propuesta técnica

**NO IMPLEMENTAR. NO EJECUTAR SQL. NO CABLEAR HTTP.**

Estado actual (ya aplicado):

- `senda_cancel_purchase_invoice` solo pasa `reviewed → cancelled`.
- El trigger `purchase_documents_block_cancel_with_receipts` aborta con
  `CANCEL_HAS_RECEIPTS` si hay filas en `purchase_document_receipts`.
- El trigger de estado aborta `received → cancelled` con
  `STATUS_TRANSITION_FORBIDDEN`.
- Recibir mercadería inserta `inventory_movements.movement_type = 'purchase'`
  y suma `inventory_valuations.quantity_on_hand`.
- El costo de última compra (Paso 447, si se aplica) puede haber quedado
  escrito por esta factura u otra posterior.

Por eso **no basta con ocultar** una factura `received`. Tampoco sirve un
`DELETE` ni reutilizar `senda_cancel_purchase_invoice`.

## Qué tendría que hacer una reversión segura

Operación nueva, atómica, `service_role`, con `FOR UPDATE` de documento,
líneas, recepciones, `location_inventory` y valuaciones.

1. Verificar membresía, organización y local.
2. Bloquear si el documento no está `received` (o `reviewed` con recepciones).
3. **No borrar** `purchase_document_receipts`, `inventory_movements` ni
   `purchase_document_audit`.
4. Insertar movimientos de compensación (`adjustment` o `purchase_reversal`)
   por cada recepción de **esta** factura, cantidad = recepción original.
5. Restar de `quantity_on_hand` solo esas cantidades.
6. Abortar si el saldo quedaría negativo (`REVERSAL_WOULD_GO_NEGATIVE`):
   hubo consumos posteriores que ya usaron esa mercadería.
7. Costos: no sobrescribir `last_purchase_unit_cost` /
   `average_unit_cost` si existe una compra **posterior** del mismo insumo.
   Si esta factura es todavía el último costo conocido, volver al costo
   anterior del historial o dejarlo nulo. Nunca reescribir un costo más
   nuevo.
8. Marcar el documento `cancelled` (o un estado `voided` nuevo) **después**
   de compensar stock. Eso exige cambiar los triggers de transición y de
   `CANCEL_HAS_RECEIPTS`.
9. Auditoría append-only: `invoice_voided` con ids de movimientos de
   compensación. Reintento por idempotencia: si ya está anulada, `replay`.

## Por qué no se implementa ahora

- Hay que ampliar `inventory_movements.movement_type`.
- Hay que relajar o reemplazar dos triggers de facturas.
- El costo posterior y el stock negativo son casos reales de locales con
  recetas activas.
- Un RPC a medias dejaría facturas ocultas con stock inconsistente.

La UI **bloquea** anular facturas `received` o con recepciones y muestra el
motivo. No hay botón efectivo sobre esos registros.

Archivo SQL asociado: `proposed-senda-reverse-received-invoice.sql`.
Es un aborto explícito, no una migración aplicable.

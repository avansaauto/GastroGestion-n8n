# Trazabilidad Fudo → n8n → receta → consumo → stock

Actualizado: 2026-11-03. Cierre de circuito para piloto. Sin aplicar migraciones en SENDA real ni activar n8n en producción.

## 1. Estado del circuito

| Pieza | Estado |
|---|---|
| `register_sale_consumption` (línea) | Instalado / en uso por n8n |
| `senda_register_sale_consumption_event` | **Propuesto, no aplicado** |
| Pantalla Ventas y consumos | Lista; enriquece si existe la tabla de eventos |
| Workflow n8n | Activo con RPC de línea; **falta JSON export** para cablear el envoltorio |
| Cancelaciones / devoluciones | Skip en n8n («¿Item cancelado?»); **sin reverso automático** |

## 2. Qué es `source_id` (comprobado)

En SENDA:

- `source_type = 'fudo'`
- `source_id` ≈ 6 dígitos (`143751`…`144759`)
- Distinto de `external_product_id` de mappings
- Hoy 1 `source_id` → 1 movimiento `sale`

Es el id de **evento de consumo** que construye «Preparar Movimientos Multi», no el producto.

Para el piloto: **reutilizar el mismo `source_id`** al llamar el envoltorio; enriquecer venta/ítem/producto/receta en campos aparte. Sin el JSON de n8n no se publica una fórmula nueva de composición.

## 3. Workflow n8n (copia sanitizada)

Fuente: `~/Downloads/SENDA - Fudo Inventario copy.json`.

Copia lista para importar (inactive, sin secretos):

- `apps/api/n8n/SENDA-Fudo-Inventario-sale-event.sanitized.json`
- `apps/api/n8n/SENDA-Fudo-Inventario-sale-event.README.md`
- Rebuild: `node apps/api/n8n/build-fudo-sale-event-workflow.mjs`

Hallazgo clave: `source_id = item_id` Fudo. `venta_id` viaja como `external_sale_id`.

## 4. Flujo objetivo (cuando se autorice)

```
Fudo venta
  → n8n (omitir ítem cancelado)
  → mapping + componentes de receta
  → Calcular Consumo Multi
  → Preparar Movimientos Multi  (mismo source_id + lines[] + metadatos)
  → senda_register_sale_consumption_event
       → sale_consumption_events (+ lines)
       → register_sale_consumption por línea
       → complete | partial | failed | duplicate
  → UI Ventas y consumos
```

## 5. Archivos

- `apps/api/sql/proposed-senda-sale-consumption-event.sql` — NO aplicar sin autorización
- `apps/api/sql/verify-senda-sale-consumption-event.sql`
- `apps/api/sql/proposed-senda-sale-consumption-event.md`
- `apps/api/sql/test-senda-sale-consumption-event.sql`
- `apps/api/sql/run-test-senda-sale-consumption-event.mjs` — `npm run sale-event:test`

## 6. Procedimiento reproducible (aislado)

```bash
cd apps/api
npm run sale-event:test
```

Cubre: recepción (factura) → stock → venta multi-insumo complete → replay sin re-descuento → `SALE_EXCEEDS_ON_HAND` persistido → partial → reintento solo failed → complete.

## 7. Procedimiento piloto (cuando haya JSON + autorización)

1. Aplicar `proposed-senda-sale-consumption-event.sql` en SENDA.
2. Correr `verify-senda-sale-consumption-event.sql`.
3. En copia del workflow (no prod): cambiar nodo RPC al envoltorio; mapear body según contrato md.
4. Dry-run en sucursal de prueba con 1 venta mapeada.
5. Activar solo tras verificar complete/partial/failed en UI.
6. No reprocesar históricas.

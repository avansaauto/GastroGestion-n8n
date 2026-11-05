# SENDA — Fudo Inventario (sale-event piloto)

Importable en n8n. **active=false**. Sin secretos. RPC y pendientes **deshabilitados**.

Sucursal piloto: **OGHAM Barrio Chino** (`d8d78b7d-eec5-4e90-8f2d-98268a875d00`).

## Parámetros (nodo Config Piloto)

| Clave | Default | Notas |
|---|---|---|
| `LOCATION_ID` | `d8d78b7d-eec5-4e90-8f2d-98268a875d00` | Única sucursal del flujo |
| `LOCATION_NAME` | OGHAM Barrio Chino | Solo documentación |
| `PILOT_START_ISO` | _(vacío)_ | **Obligatorio** si `PILOT_SINGLE_ITEM=false`. No inventar. ISO-8601 UTC |
| `PILOT_DATE_FIELD` | `createdAt` | Política piloto: corte por creación, no por cierre |
| `PILOT_ALLOWED_SALE_STATES` | `CLOSED` | Lista CSV; filtro **local**. Confirmar valores reales con probe |
| `PILOT_SINGLE_ITEM` | `true` | GET `/sales/{id}` + un solo `item_id` |
| `PILOT_EXTERNAL_SALE_ID` | _(vacío)_ | Requerido en single |
| `PILOT_EXTERNAL_ITEM_ID` | _(vacío)_ | Requerido en single (`source_id`) |
| `FUDO_API_CREATED_AT_FILTER` | `false` | Activar solo tras `probe-fudo-sales-filters.mjs` OK |
| `FUDO_API_SALE_STATE_FILTER` | `false` | Idem |

## Política de fecha (importante)

El piloto corta por **`createdAt >= PILOT_START_ISO`**.

Una venta **creada antes** del piloto y **cerrada después** **no** se procesa. Es deliberado: evita históricas. Si más adelante se elige `closedAt`, documentar el riesgo de tickets abiertos pre-piloto.

Filtro API `filter[createdAt]=gte…` / `filter[saleState]=in.(…)`: opt-in. El corte efectivo siempre está en **Separar Ventas** (local, fail-closed).

## Qué cambió (seguridad)

| Pieza | Cambio |
|---|---|
| Config Piloto | Una sola fuente de `LOCATION_ID` / flags |
| Eliminado | Hardcodes de SENDA - Pruebas (reemplazados por Config Piloto) |
| Separar Ventas / Items | Fecha + estado + single-item |
| canceled | Boolean en Preparar Item / Preparar Venta / IF |
| RPC | Deshabilitado; camino activo → Dry-run → Loop |
| Pendientes upsert/resolve | Deshabilitados |
| Idempotencia | `source_id = item_id` intacta |
| Cursor / Schedule | No activados |

## Probe de filtros Fudo (solo lectura)

```bash
cd apps/api
FUDO_API_KEY=… FUDO_API_SECRET=… node n8n/probe-fudo-sales-filters.mjs
```

No escribe en SENDA ni en Fudo. Si el probe confirma sintaxis, setear `FUDO_API_*_FILTER=true` en Config.

## Verificación previa a habilitar escrituras

1. Importar JSON (workflow nuevo, inactive).
2. Credenciales n8n: Fudo + Supabase Custom Auth (service_role). Sin pegar secretos en nodos.
3. Completar Config: `PILOT_EXTERNAL_SALE_ID` / `PILOT_EXTERNAL_ITEM_ID` (venta **nueva** post-piloto, nunca histórica).
4. Mapping activo en Barrio Chino para el producto del ítem; stock suficiente.
5. Ejecutar Manual Trigger con RPC **sigue disabled**.
6. Inspeccionar payload en **Dry-run Evento Consumo** (`location_id`, `source_id`, `lines`).
7. Confirmar que no hubo writes (stock / `sale_consumption_events` / pendientes).
8. Solo entonces: habilitar RPC, cablear Dry-run → RPC → Loop, un ítem, verificar `complete` / `duplicate`.

## Mapa Fudo → RPC

| Campo | RPC |
|---|---|
| `item_id` | `source_id` + `external_item_id` |
| `venta_id` | `external_sale_id` |
| `producto_id` | `external_product_id` |
| `cantidad` | `sold_quantity` |
| LI + qty negativa | `lines[]` |
| Config | `location_id`, `source_type=fudo` |

## Rebuild

```bash
node apps/api/n8n/build-fudo-sale-event-workflow.mjs
```

# Contrato — `senda_register_sale_consumption_event`

## Propósito

Conservar el contexto de una venta Fudo y registrar cada descuento de stock sin cambiar la firma de `register_sale_consumption`.

## Identidad estable (`source_id`)

Evidencia en SENDA (lectura 2026-11-02 / 2026-11-03):

- `source_type = 'fudo'`
- `source_id` es un string de ~6 dígitos (`143751`…`144759`)
- **No** coincide con `external_product_id` de mappings (valores cortos)
- Hoy: 1 `source_id` → 1 movimiento `sale` (recetas 1:1 o una línea por llamada)

Conclusión (JSON n8n 2026-11-03): en «Preparar Movimientos Multi» / «Preparar Evento Consumo»,
`source_id = String(item_id)` de Fudo. No es el producto ni el `venta_id`.

Regla para el piloto:

1. Conservar `source_id = item_id` exactamente.
2. Todas las líneas de ingredientes del mismo ítem comparten ese `source_id`.
3. Metadatos: `external_sale_id = venta_id`, `external_item_id = item_id`, producto y receta aparte.
4. No reprocesar ventas históricas.

## Entrada (`jsonb`)

```json
{
  "location_id": "uuid",
  "source_type": "fudo",
  "source_id": "144696",
  "external_sale_id": "144696",
  "external_item_id": null,
  "external_product_id": "183",
  "external_product_name": "Coca Cola Zero",
  "recipe_id": "uuid-o-null",
  "recipe_name": "Coca Cola Zero",
  "sold_quantity": 1,
  "sold_unit": "unit",
  "lines": [
    { "location_inventory_id": "uuid", "quantity": -1 }
  ]
}
```

## Salida

```json
{
  "event_id": "uuid",
  "status": "complete|partial|failed|duplicate|reversed",
  "replay": false,
  "lines": [
    {
      "location_inventory_id": "uuid",
      "quantity": -1,
      "status": "registered|failed|duplicate",
      "movement_id": "uuid-o-null",
      "error_code": null
    }
  ]
}
```

| status | Significado |
|---|---|
| `complete` | Todas las líneas registradas (o ya cubiertas) |
| `partial` | Al menos una registered y al menos una failed |
| `failed` | Ninguna línea registrada; p. ej. solo `SALE_EXCEEDS_ON_HAND` |
| `duplicate` | Mismo origen + mismo digest ya completo |
| `reversed` | Reservado; este RPC **no** inventa reversos |

## Idempotencia y reintentos

- Misma clave `(location_id, source_type, source_id)` + mismo digest de líneas →
  - si `complete` / `duplicate` / `reversed` → replay sin nuevo descuento
  - si `partial` / `failed` → **reintenta solo líneas `failed`**; no toca `registered`
- Misma clave + digest distinto → `SALE_EVENT_IDEMPOTENCY_CONFLICT`
- Cada línea delega en `register_sale_consumption` (idempotencia por movimiento intacta)

## Errores

| Código | Cuándo |
|---|---|
| `INVALID_INPUT` | Faltan campos o cantidades inválidas |
| `LOCATION_MISSING` | Sucursal inexistente |
| `SALE_EVENT_IDEMPOTENCY_CONFLICT` | Mismo origen, otro payload |
| Por línea: `SALE_EXCEEDS_ON_HAND`, … | Guardados en `sale_consumption_event_lines` |

`SALE_EXCEEDS_ON_HAND` **no desaparece**: queda `status=failed` + `error_code`.

## Cancelaciones / devoluciones Fudo

El workflow tiene «¿Item cancelado?» que **omite** el ítem antes del RPC. No hay contrato instalado de `sale_reversal` desde n8n en este circuito. Este envoltorio **no inventa** reversos. Si Fudo envía cancelación/devolución, hasta definir contrato explícito se deja fuera.

## Qué no hace

- No altera CPP, facturas ni recetas.
- No reescribe `inventory_movements` históricos.
- No reemplaza `register_sale_consumption` (n8n puede seguir llamándolo; entonces no habrá contexto enriquecido).

## Cambio n8n (cuando exista el JSON)

1. Nodo final: de `POST …/rpc/register_sale_consumption` → `POST …/rpc/senda_register_sale_consumption_event`.
2. «Preparar Movimientos Multi»: un ítem → un payload con `lines[]` (cantidades negativas) + metadatos de producto/receta.
3. Conservar el mismo `source_id` que hoy usa el RPC de línea.
4. No activar en producción hasta migración SQL aplicada y dry-run en sucursal de prueba.

# senda_set_recipe_active — contrato (Paso 437)

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

No reutiliza `senda_create_recipe`, `senda_update_recipe` ni
`senda_save_fudo_recipe`. Si el RPC ya existe, el SQL aborta
(`RECIPE_STATUS_RPC_EXISTS`).

Hasta aplicarlo, el PATCH HTTP de estado responde 503
`RECIPE_STATUS_RPC_PENDING` y **no llama** ningún RPC, salvo reintento
idempotente (ya está en el estado pedido).

Tras aplicar: `apps/api/sql/verify-senda-set-recipe-active.sql`.

La API inyecta `actor_user_id` con `getUser`, `organization_id` y `recipe_id`
desde la ruta. No se copian del body del browser.

## Firma

`public.senda_set_recipe_active(p jsonb) → jsonb`

SECURITY DEFINER, `search_path = pg_catalog, public`. EXECUTE solo `service_role`.

## Qué cambia

En **una transacción**: `UPDATE recipes SET active = …` de esa receta.

Reintento: si ya está en el estado pedido, devuelve `replay: true` sin
escribir. `expected_active` se exige solo cuando hay que cambiar el estado.

## Qué no cambia

- `recipe_components`
- mappings Fudo (`sales_product_mappings`)
- Product IDs externos
- pendientes
- nombre, categoría, rendimiento
- stock, valuaciones, ventas, facturas

## Concurrencia

`SELECT … FOR UPDATE` + `expected_active` (boolean de la precarga).
Si no coincide → `CONCURRENT_UPDATE`.
`serialization_failure` / deadlock → `CONCURRENT_UPDATE`.

## Dependencias

Desactivar se bloquea si otra receta **activa** de la misma org la usa como
subreceta (`recipe_components.component_recipe_id`) → `RECIPE_IN_USE`.

Reactivar no exige esa comprobación.

Mappings Fudo activos no bloquean. No se desactivan.

## Parámetros (`p`)

| Campo | Obligatorio | Notas |
|---|---|---|
| `actor_user_id` | sí | uuid, solo backend |
| `organization_id` | sí | uuid de la ruta |
| `recipe_id` | sí | uuid de la ruta |
| `active` | sí | boolean destino |
| `expected_active` | sí | boolean de la precarga |

## Respuesta

```json
{
  "recipe_id": "…",
  "active": false,
  "replay": false,
  "used_by": [],
  "active_mapping_count": 2
}
```

## Códigos

| Código | HTTP previsto |
|---|---|
| `NOT_A_MEMBER` | 403 |
| `ORGANIZATION_NOT_FOUND` / `RECIPE_NOT_IN_ORG` | 404 |
| `RECIPE_IN_USE` / `CONCURRENT_UPDATE` | 409 |
| `EXPECTED_REQUIRED` / `INVALID_PAYLOAD` | 400 |
| `RECIPE_STATUS_RPC_PENDING` | 503 |

# senda_update_recipe — contrato (Paso 435)

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

No reutiliza `senda_create_recipe` ni `senda_save_fudo_recipe` para editar.
Si el RPC de update ya existe, el SQL aborta (`RECIPE_UPDATE_RPC_EXISTS`).

Hasta aplicarlo, el PATCH HTTP responde 503 `RECIPE_UPDATE_RPC_PENDING` y **no
llama** ningún RPC. No hay escritura parcial.

Tras aplicar: `apps/api/sql/verify-senda-update-recipe.sql`.

La API inyecta `actor_user_id` con `getUser`, `organization_id` y `recipe_id`
desde la ruta. No se copian del body del browser.

## Firma

`public.senda_update_recipe(p jsonb) → jsonb`

SECURITY DEFINER, `search_path = pg_catalog, public`. EXECUTE solo `service_role`.

## Qué cambia

En **una transacción**:

- `UPDATE recipes` (nombre, rendimiento, unidad, `category_id`)
- resuelve o crea categoría como `senda_create_recipe`
- reemplaza `recipe_components` (DELETE + INSERT)

Si una validación falla, no queda receta a medias.

## Qué no cambia

- mappings Fudo (`sales_product_mappings`)
- Product IDs externos
- pendientes
- stock, valuaciones, ventas, facturas
- `recipe_type`, `active`, `organization_id`

## Concurrencia

El esquema actual **no** tiene `recipes.updated_at` ni `version`. No se agrega
columna en este SQL.

Mecanismo instalable sin migración:

1. `SELECT … FOR UPDATE` de la receta.
2. Huella `expected` (name, yield, category_id, BOM) tomada al precargar.
3. Si no coincide → `CONCURRENT_UPDATE`.
4. `serialization_failure` / deadlock → `CONCURRENT_UPDATE`.

Propuesta futura, sin aplicar: `recipes.updated_at timestamptz` con trigger.
No es necesaria para este RPC.

## Parámetros (`p`)

| Campo | Obligatorio | Notas |
|---|---|---|
| `actor_user_id` | sí | uuid, solo backend |
| `organization_id` | sí | uuid de la ruta |
| `recipe_id` | sí | uuid de la ruta |
| `name` | sí | único por org, excluye la receta actual |
| `yield_quantity` | sí | `> 0` |
| `yield_unit` | sí | `unit` \| `g` \| `ml` |
| `components` | no | BOM completo de reemplazo |
| `category_id` / `category_name` | no | misma resolución que el alta |
| `expected` | sí | snapshot del GET de precarga |

Receta inactiva → `RECIPE_INACTIVE`.
Receta de otra org → `RECIPE_NOT_IN_ORG`.
Subrecetas en el BOM actual o nuevo → `INVALID_BOM`.
Huella `expected` distinta de la fila bloqueada → `CONCURRENT_UPDATE`.

## Respuesta

```json
{
  "recipe_id": "…",
  "name": "…",
  "yield_quantity": 1,
  "yield_unit": "unit",
  "component_count": 0,
  "category_id": "…",
  "category_name": "…",
  "shared_location_count": 2
}
```

`shared_location_count` es de solo lectura (mappings activos). No modifica mappings.

## Códigos

| Código | HTTP previsto |
|---|---|
| `NOT_A_MEMBER` | 403 |
| `ORGANIZATION_NOT_FOUND` / `RECIPE_NOT_IN_ORG` | 404 |
| `RECIPE_INACTIVE` | 409 |
| `DUPLICATE_RECIPE_NAME` / `CONCURRENT_UPDATE` | 409 |
| `CATEGORY_NOT_IN_ORG` / `CATEGORY_CONFLICT` / BOM | 422 |
| `EXPECTED_REQUIRED` / `INVALID_PAYLOAD` | 400 |

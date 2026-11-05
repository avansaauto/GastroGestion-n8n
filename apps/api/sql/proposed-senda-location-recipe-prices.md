# location_recipe_prices — contrato (Paso 442)

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

Crea `public.location_recipe_prices` y el RPC `senda_set_location_recipe_price`.
Si la tabla o el RPC ya existen, el SQL aborta (`RECIPE_PRICE_TABLE_EXISTS` /
`RECIPE_PRICE_RPC_EXISTS`). No hay `CREATE OR REPLACE`.

No reutiliza ni reemplaza `senda_create_recipe`, `senda_update_recipe`,
`senda_set_recipe_active` ni `senda_save_fudo_recipe`.

Hasta aplicarlo, **no hay** GET ni PATCH HTTP de precios. Esos endpoints
quedan para un paso posterior; cuando existan y el RPC falte, deberán
responder 503 `RECIPE_PRICE_RPC_PENDING` y no llamar ningún RPC.

Tras aplicar: `apps/api/sql/verify-senda-location-recipe-prices.sql`.

La API inyectará `actor_user_id` con `getUser`, `organization_id`,
`location_id` y `recipe_id` desde la ruta. No se copian del body del browser.

## Qué guarda

Una fila por **local × receta**: el precio de lista **manual** de esa receta
en ese local, por la unidad vendible (`recipes.yield_quantity` +
`recipes.yield_unit`).

| Estado | Representación |
|---|---|
| Precio no configurado | **No hay fila.** La API leerá `null`. UI: `—`. |
| Precio manual | Fila con `sale_price > 0`. |
| Actualización | `UPDATE` de esa fila: nuevo `sale_price`, `version + 1`, `updated_at`. |
| Receta inactiva | La fila **se conserva**. El RPC rechaza cambios (`RECIPE_INACTIVE`). |
| Otro local | Otra fila. El UNIQUE es `(location_id, recipe_id)`. |

`0` no es un precio válido. `numeric` de PostgreSQL no admite NaN ni
Infinity; el RPC exige JSON number, redondea a 2 decimales **antes** de
asignar a `numeric(12,2)` y rechaza `<= 0` o `> 9999999999.99`.
`0.004` redondea a `0.00` → `INVALID_SALE_PRICE`, no se inserta un cero.

Dos INSERT concurrentes: `SELECT FOR UPDATE` sobre cero filas no cierra el
hueco UNIQUE; el segundo cae en `unique_violation`. Mismo precio →
`replay`. Precio distinto → `CONCURRENT_UPDATE`. El `UPDATE` usa
`IF NOT FOUND` (no `v_row.id is null` tras `RETURNING INTO`).

Este paso **no** guarda precios observados de Fudo, impuestos, promociones
ni listas. LINK/CREATE Fudo no leen ni escriben esta tabla.

## Por qué `organization_id`

`sales_product_mappings` no lo denormaliza: el RLS entra por `locations`.
`recipe_categories` sí, para FK compuesta `(id, organization_id)`.

Acá hace falta el mismo truco: el precio referencia **local y receta**,
que deben ser de la **misma** organización. Sin `organization_id` en la
fila, PostgreSQL no puede imponerlo con FK.

- `UNIQUE (locations.id, locations.organization_id)` — destino de FK.
- `UNIQUE (recipes.id, recipes.organization_id)` — destino de FK.
- `FK (location_id, organization_id) → locations`
- `FK (recipe_id, organization_id) → recipes`

Un local de la org A no puede apuntar a una receta de la org B. El UNIQUE
de negocio sigue siendo `(location_id, recipe_id)`: un precio no pisa otro
local.

No se agrega columna de precio a `recipes`.

## Firma

`public.senda_set_location_recipe_price(p jsonb) → jsonb`

SECURITY DEFINER, `search_path = pg_catalog, public`. EXECUTE solo `service_role`.

## Qué cambia

En **una transacción**: `INSERT` o `UPDATE` de **una** fila de
`location_recipe_prices` para ese `location_id` + `recipe_id`.

Reintento: si el precio ya es el pedido, `replay: true` sin escribir.

## Qué no cambia

- `recipes` (ni `active`, ni BOM, ni categoría)
- `recipe_components`
- mappings Fudo (`sales_product_mappings`)
- pendientes
- stock, valuaciones, ventas, facturas
- precios en Fudo

## Concurrencia

No hay `recipes.updated_at`. `updated_at` en esta tabla es auditoría;
la carrera se resuelve con **`version` entero** (más estable que un
timestamptz al redondear en JSON).

| Caso | `expected_version` | Efecto |
|---|---|---|
| Primer precio (no hay fila) | JSON `null` | `INSERT`, `version = 1` |
| Cliente creía que había fila | entero, y no hay fila | `CONCURRENT_UPDATE` |
| Mismo precio ya persistido | el que sea (incluso `null`) | `replay: true` |
| Cambio de precio | entero = `version` actual | `UPDATE`, `version + 1` |
| Cambio con versión vieja o `null` | no coincide | `CONCURRENT_UPDATE` |
| Dos INSERT simultáneos | `null` + UNIQUE | el segundo: replay si el precio coincide; si no, `CONCURRENT_UPDATE` |

Bloqueos: `locations` `FOR SHARE` → `recipes` `FOR UPDATE` → fila de
precio `FOR UPDATE`. `serialization_failure` / deadlock →
`CONCURRENT_UPDATE`.

`senda_set_recipe_active` solo bloquea `recipes`. LINK bloquea pending →
mapping → recipe. Este RPC no toca mappings.

## Parámetros (`p`)

| Campo | Obligatorio | Notas |
|---|---|---|
| `actor_user_id` | sí | uuid, solo backend |
| `organization_id` | sí | uuid de la ruta |
| `location_id` | sí | uuid de la ruta; debe ser de esa org |
| `recipe_id` | sí | uuid de la ruta; debe ser de esa org |
| `sale_price` | sí | JSON number, finito, `> 0`, 2 decimales |
| `expected_version` | sí | JSON `null` (alta) o entero `> 0` (update) |

## Respuesta

```json
{
  "location_id": "…",
  "recipe_id": "…",
  "sale_price": 4500.00,
  "version": 1,
  "updated_at": "…",
  "replay": false
}
```

## Códigos

| Código | HTTP previsto |
|---|---|
| `NOT_A_MEMBER` | 403 |
| `ORGANIZATION_NOT_FOUND` / `LOCATION_NOT_IN_ORG` / `RECIPE_NOT_IN_ORG` | 404 |
| `RECIPE_INACTIVE` / `RECIPE_NOT_SALE_PRODUCT` / `CONCURRENT_UPDATE` | 409 |
| `EXPECTED_REQUIRED` / `INVALID_SALE_PRICE` / `INVALID_PAYLOAD` | 400 |
| `RECIPE_PRICE_RPC_PENDING` | 503 (solo HTTP futuro, si falta el RPC) |

## Seguridad

- RLS activo. Política: solo `SELECT` para `authenticated`,
  `senda_is_org_active_member(organization_id)`.
- Sin políticas INSERT/UPDATE/DELETE.
- `authenticated`: solo `SELECT`. `anon`: nada.
- `service_role`: `SELECT/INSERT/UPDATE` de tabla. Sin `DELETE` (no hay
  borrar precio en este paso).
- Escritura de negocio: RPC DEFINER + actor `getUser` + admin/operator
  activo de **esa** organización. El local y la receta se vuelven a
  validar dentro de la transacción.
- No hay GRANT de escritura al frontend.

## Fuera de este paso

- GET de precios y columnas en `/recetas`
- PATCH HTTP
- Precios observados Fudo
- Borrar o anular un precio (volver a “pendiente”)
- Editar precio de receta inactiva

# senda_create_recipe — contrato (Pasos 428 y 429)

No ejecutar. No aplicar. El RPC y `recipe_categories` todavía no existen en
Supabase: el POST HTTP responde 503 `CREATE_RECIPE_RPC_MISSING` hasta que se
autorice este SQL.

Tras aplicar: `apps/api/sql/verify-senda-create-recipe.sql`. Ese archivo aborta
si falta el RPC, la tabla, la FK, el UNIQUE case-insensitive o si authenticated
puede escribir categorías.

La API inyecta `actor_user_id` con `getUser` y `organization_id` desde la ruta.
No se copian del body del browser.

## Firma

`public.senda_create_recipe(p jsonb) → jsonb`

SECURITY DEFINER, dueño `postgres`, `search_path = pg_catalog, public`. EXECUTE solo `service_role`.

Operación independiente de `senda_save_fudo_recipe`. No exige pendiente Fudo.
La vinculación Fudo queda para un RPC posterior.

El mismo archivo crea `recipe_categories`, agrega `recipes.category_id` y el RPC.
Una transacción. Receta y categoría nueva se persisten juntas; si falla el alta
de la receta no queda categoría huérfana.

## Parámetros (`p`)

| Campo | Obligatorio | Notas |
|---|---|---|
| `actor_user_id` | sí | uuid, solo backend |
| `organization_id` | sí | uuid de la ruta |
| `name` | sí | único por organización (`UNIQUE (organization_id, name)`) |
| `yield_quantity` | sí | numérico `> 0` |
| `yield_unit` | sí | `unit` \| `g` \| `ml` |
| `components` | no | `[{ inventory_product_id, quantity }]`, 0..N. Ausente = sin consumo |
| `category_id` | no | uuid de una categoría de la misma organización |
| `category_name` | no | nombre nuevo o existente; `btrim`; unicidad case-insensitive |

`recipe_type` queda siempre `sale_product`. `active = true`. Sin subrecetas.
Cantidad de cada insumo en unidad base. Sin ingredientes duplicados.
Insumos reales, activos y de la misma organización.

Categoría:

- Ausente: receta sin categoría (compatibilidad con el POST 428 y recetas viejas).
- Solo `category_id`: debe existir en la organización. Ajena → `CATEGORY_NOT_IN_ORG`.
- Solo `category_name`: reutiliza el id si `lower(btrim(name))` coincide; si no, inserta.
- Ambos: el id debe ser de la org y el nombre debe coincidir ignorando mayúsculas; si no → `CATEGORY_CONFLICT`.
- No hay categorías predefinidas.

No hay `location_id`, `source`, `external_product_id`, `intent` ni `existing_recipe_id`.

## Respuesta

```json
{
  "recipe_id": "…",
  "name": "…",
  "yield_quantity": 1,
  "yield_unit": "unit",
  "component_count": 0,
  "category_id": "…",
  "category_name": "…"
}
```

`category_id` / `category_name` son `null` si no se envió categoría.
No incluye mapping ni pendiente. No hay `replay`: un nombre duplicado es conflicto.

## Códigos (`RAISE EXCEPTION 'CODE'`)

| Código | Cuándo |
|---|---|
| `BACKEND_ROLE_REQUIRED` / `ACTOR_REQUIRED` | JWT no es service_role o falta actor |
| `ORGANIZATION_REQUIRED` / `ORGANIZATION_NOT_FOUND` | organización ausente |
| `NOT_A_MEMBER` | no es admin/operator activo de la organización |
| `NAME_REQUIRED` | nombre vacío |
| `DUPLICATE_RECIPE_NAME` | UNIQUE `(organization_id, name)` |
| `INVALID_YIELD` / `INVALID_YIELD_UNIT` | rinde |
| `INVALID_QUANTITY` / `INVALID_BOM` / `DUPLICATE_INGREDIENT` | componentes |
| `INGREDIENT_NOT_IN_ORG` | insumo inactivo, inexistente o de otra org |
| `CATEGORY_NOT_IN_ORG` | categoría inexistente o de otra org |
| `CATEGORY_CONFLICT` | `category_id` y `category_name` no coinciden |
| `CONCURRENT_UPDATE` | deadlock / serialization |
| `INVALID_PAYLOAD` | JSON o uuid ilegible |

La API no debe reenviar el texto interno de PostgreSQL.

## Lectura HTTP

- `GET /api/organizations/:organizationId/recipe-categories` — categorías reales de la org.
- `GET /api/organizations/:organizationId/recipes` — cada receta incluye `category` (`{ id, name }` o `null`).

Si el esquema todavía no existe, las lecturas no inventan categorías: listado vacío o `category: null`.

## Qué no hace

- No lee ni escribe `pending_product_mappings`.
- No lee ni escribe `sales_product_mappings`.
- No llama `resolve_pending_product_mappings` ni `register_sale_consumption`.
- No escribe `inventory_movements` ni `location_inventory`.
- No GRANT INSERT autenticado sobre `recipes` / `recipe_components` / `recipe_categories`.
- No crea un POST de categorías independiente: la categoría nueva solo nace al guardar la receta.

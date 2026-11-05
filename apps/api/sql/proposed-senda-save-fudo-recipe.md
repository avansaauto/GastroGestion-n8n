# senda_save_fudo_recipe — contrato (Paso 418)

No ejecutar. No es un endpoint. La API inyecta `actor_user_id` con `getUser`; no se copia del body del browser.

## Firma

`public.senda_save_fudo_recipe(p jsonb) → jsonb`

SECURITY DEFINER, dueño `postgres`, `search_path = pg_catalog, public`. EXECUTE solo `service_role`.

## Parámetros (`p`)

| Campo | CREATE | LINK |
|---|---|---|
| `actor_user_id` | uuid, backend | igual |
| `location_id` | uuid | igual |
| `intent` | `create` | `link` |
| `source` | texto, de la fila pendiente | igual |
| `external_product_id` | texto, de la fila pendiente | igual |
| `name` | obligatorio | ignorado |
| `yield_quantity` | default 1, `> 0` | ignorado |
| `yield_unit` | `unit` \| `g` \| `ml`, default `unit` | ignorado |
| `components` | `[{ inventory_product_id, quantity }]` (0..N) | vacío o ausente |
| `existing_recipe_id` | prohibido | uuid de la org |

La organización sale del local. `recipe_type` queda siempre `sale_product`. Sin subrecetas.

## Respuesta

```json
{ "recipe_id": "…", "mapping_id": "…", "pending_id": "…", "replay": false }
```

`replay: true` = no se insertó receta nueva; se reutilizó el vínculo ya persistido.

## Códigos (`RAISE EXCEPTION 'CODE'`)

| Código | Cuándo |
|---|---|
| `BACKEND_ROLE_REQUIRED` / `ACTOR_REQUIRED` | JWT no es service_role o falta actor |
| `NOT_A_MEMBER` | no es admin/operator del local |
| `LOCATION_REQUIRED` / `LOCATION_NOT_FOUND` | local ausente |
| `INVALID_INTENT` | ni create ni link, o `existing_recipe_id` en create |
| `SOURCE_REQUIRED` / `EXTERNAL_PRODUCT_ID_REQUIRED` | terna incompleta |
| `PENDING_NOT_FOUND` | no hay fila pendiente de esa terna |
| `MAPPING_INACTIVE` | hay mapping con `active = false` o `NULL`. No se reactiva, no se toca `recipe_id`/BOM ni el pendiente |
| `ALREADY_LINKED` | mapping **activo** a **otra** receta, o CREATE cuyo BOM/nombre no coincide |
| `DUPLICATE_RECIPE_NAME` | UNIQUE `(organization_id, name)` |
| `RECIPE_NOT_IN_ORG` | LINK a receta ajena o inexistente |
| `NAME_REQUIRED` / `EXISTING_RECIPE_REQUIRED` | faltan campos de intent |
| `INVALID_YIELD` / `INVALID_YIELD_UNIT` | rinde |
| `INVALID_QUANTITY` / `INVALID_BOM` / `DUPLICATE_INGREDIENT` | componentes |
| `INGREDIENT_NOT_IN_ORG` | insumo inactivo o de otra org |
| `LINK_DOES_NOT_EDIT_BOM` | LINK con componentes |
| `CONCURRENT_UPDATE` | deadlock / serialization |
| `INVALID_PAYLOAD` | JSON o uuid ilegible |

La API no debe reenviar el texto interno de PostgreSQL.

## Idempotencia

- **LINK:** replay si el mapping **activo** de la terna ya apunta a `existing_recipe_id`. Si apunta a otra receta → `ALREADY_LINKED`.
- **CREATE:** la terna sola no identifica un reintento. Replay solo si hay mapping **activo** y la receta mapeada tiene el mismo `name`, rinde y BOM (mismas cantidades, sin subrecetas). Cualquier otro mapping activo → `ALREADY_LINKED`.
- Mapping `active = false` o `NULL` (CREATE y LINK): `MAPPING_INACTIVE`. No reactivar. No cambiar `recipe_id`. No tocar BOM. No marcar el pendiente `resolved`.
- Alta nueva: `active = true`.
- Ambas: `SELECT pending … FOR UPDATE` antes de insertar. Un fallo revierte receta, componentes y mapping juntos.

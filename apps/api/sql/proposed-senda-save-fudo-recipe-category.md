# senda_save_fudo_recipe + categoría (Paso 432)

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

## Auditoría

El archivo de Paso 431 era un aborto (`RECIPE_SAVE_CATEGORY_NOT_AUTHORIZED`) y no podía instalarse. El RPC actualmente instalado es `public.senda_save_fudo_recipe(p jsonb)` sin categoría.

Esta propuesta **REPLACE** el cuerpo del RPC instalado. No es un segundo RPC. Conserva:

- `SECURITY DEFINER`, `search_path = pg_catalog, public`
- actor `senda_require_backend_actor` + membresía `senda_actor_is_purchase_member`
- EXECUTE solo `service_role`; `anon` / `authenticated` sin EXECUTE
- identidad Fudo `location_id + source + external_product_id`
- intent `create` / `link`
- `PENDING_NOT_FOUND`, `MAPPING_INACTIVE`, `ALREADY_LINKED`, `DUPLICATE_RECIPE_NAME`, `RECIPE_NOT_IN_ORG`, `LINK_DOES_NOT_EDIT_BOM`
- replay CREATE por huella (name + yield + BOM + categoría)
- replay LINK por `recipe_id`
- `pending_product_mappings.status = resolved` si el vínculo sale bien
- locks `FOR UPDATE` sobre pendiente y mapping
- sin stock, ventas, n8n ni `update public.recipes`

## CREATE con categoría

Misma resolución que `senda_create_recipe`:

| Campo | CREATE |
|---|---|
| ausente | receta Fudo sin categoría |
| `category_id` | debe ser de la org → si no, `CATEGORY_NOT_IN_ORG` |
| `category_name` | reutiliza `lower(btrim(name))`; si no existe, inserta |
| ambos | el nombre debe coincidir → si no, `CATEGORY_CONFLICT` |

Categoría nueva, receta y mapping van en la **misma transacción**. Si falla el INSERT de receta o mapping, no queda categoría huérfana.

## LINK

No lee `category_id` / `category_name`.
No hace `UPDATE` de `recipes`.
No cambia BOM ni categoría de una receta existente.

## Reintentos

Si el mapping activo ya apunta a una receta con el mismo name, yield, BOM y `category_id`, el CREATE es replay.
Si la huella no coincide → `ALREADY_LINKED`. No se duplica receta.

## Mientras no se aplique

El frontend sigue usando `senda_create_recipe` + LINK.
La API **no** envía categoría a `senda_save_fudo_recipe` CREATE: el RPC instalado la ignoraría.

Tras aplicar: `apps/api/sql/verify-senda-save-fudo-recipe-category.sql`.

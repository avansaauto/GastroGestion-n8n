# senda_save_fudo_recipe + LINK activo (Paso 438)

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.

El RPC instalado (Paso 433) ya persiste categoría en CREATE, pero **LINK no
mira `recipes.active`**. Un cliente que envíe `existing_recipe_id` de una
receta inactiva puede crear un mapping nuevo.

Esta propuesta **REPLACE** el cuerpo instalado. El único cambio de negocio
es exigir receta activa en un LINK **nuevo**. No es un segundo RPC.

No REPLACE `senda_create_recipe`, `senda_update_recipe` ni
`senda_set_recipe_active`. `RECIPE_STATUS_RPC_ENABLED` sigue en `false`.

Tras aplicar: `apps/api/sql/verify-senda-save-fudo-recipe-link-active.sql`.

## Conserva

- `SECURITY DEFINER`, `search_path = pg_catalog, public`
- actor `senda_require_backend_actor` + membresía `senda_actor_is_purchase_member`
- EXECUTE solo `service_role`
- identidad `(location_id, source, external_product_id)`
- Product ID externo exacto
- categorías en CREATE
- `PENDING_NOT_FOUND`, `MAPPING_INACTIVE`, `ALREADY_LINKED`,
  `DUPLICATE_RECIPE_NAME`, `RECIPE_NOT_IN_ORG`, `LINK_DOES_NOT_EDIT_BOM`
- replay CREATE por huella (name + yield + BOM + categoría)
- replay LINK por `recipe_id`
- `pending_product_mappings.status = resolved` si el vínculo sale bien
- mappings históricos
- sin stock, ventas, n8n ni `UPDATE public.recipes`
- LINK no lee ni escribe categoría ni BOM

## LINK nuevo

Tras `SELECT recipes … FOR UPDATE` de la receta de la organización:

| Situación | Resultado |
|---|---|
| Receta ajena / inexistente | `RECIPE_NOT_IN_ORG` |
| Mapping activo a **otra** receta | `ALREADY_LINKED` |
| Mapping activo a **la misma** receta (replay) | `replay: true`, aunque ahora esté inactiva |
| Sin mapping y receta inactiva | `RECIPE_INACTIVE` |
| Sin mapping y receta activa | INSERT mapping |

El replay no crea otro mapping ni toca el historial. No desactiva mappings.

## Concurrencia con `senda_set_recipe_active`

Orden de locks en LINK (no invertir):

1. `pending_product_mappings` `FOR UPDATE`
2. `sales_product_mappings` `FOR UPDATE`
3. `recipes` `FOR UPDATE`
4. chequeo `active` **después** del lock
5. INSERT mapping si corresponde

`senda_set_recipe_active` solo hace `FOR UPDATE` de `recipes`. No debe
bloquear mappings: si un día lockeara mapping **después** de recipe,
cruzaría el orden de LINK (mapping → recipe) y podría deadlock.

Con este orden:

- Si LINK toma la receta activa, inserta el mapping y commitea, la
  desactivación posterior deja un mapping **histórico** a una receta que
  estaba activa al vincular. Eso es válido.
- Si la desactivación commitea primero, LINK ve `active is not true` y
  aborta `RECIPE_INACTIVE`. No queda un vínculo nuevo a una receta ya
  inactiva.
- `serialization_failure` / deadlock → `CONCURRENT_UPDATE`.

## CREATE

Sin cambios. Sigue insertando recetas `active = true` y resolviendo
categoría en la misma transacción.

## Mientras no se aplique

LINK HTTP sigue llamando el RPC instalado. El formulario no ofrece
inactivas, pero un ID forzado todavía puede vincular. Este SQL cierra
ese hueco. No se deshabilita el guardado Fudo.

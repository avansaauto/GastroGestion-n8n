# Persistencia presentación + proveedor habitual — NO APLICAR

SQL: `proposed-inventory-product-presentation-supplier.sql`  
Verify (solo lectura): `verify-inventory-product-presentation-supplier.sql`

## Qué resuelve

1. **Contenido por unidad** — reutiliza el modelo de `conversionFactor` de mapping memory de facturas.
2. **Proveedor habitual** — reutiliza `public.suppliers` (ya existía; las facturas hoy dejan `supplier_id` null y solo `issuer_name`).
3. **Divisible** — persistido y recuperado en `senda_update_inventory_product`.
4. **Cambio controlado** — `senda_set_inventory_product_presentation` (confirm + reason); no reinterpreta stock.
5. **Recetas** — `senda_assert_recipe_component_quantities` + create/update recipe.
6. **Proveedores concurrentes** — índices únicos + retry en `unique_violation`.

## Columnas en `inventory_products`

| Columna | Semántica |
|---|---|
| `presentation_unit` | Unidad comercial (`u`) |
| `conversion_factor` | Unidades base por 1 presentación (Fernet: 750 ml/u) |
| `preferred_supplier_id` | FK → `suppliers.id` |
| `divisible` | `null`/`true`: recetas admiten g/ml; `false`: solo u enteras |

Stock sigue en `base_unit` (g/ml/unit). No se reescriben movimientos ni CPP.

## Reglas clave del update RPC

- `location_id.organization_id` debe coincidir con `organization_id` (`ORG_LOCATION_MISMATCH`).
- Producto debe pertenecer a la misma org (`PRODUCT_NOT_FOUND`).
- Coherencia: presentación + factor juntos; solo `u`; base `g|ml`; `divisible` solo con presentación.
- Con historial (stock ≠ 0, movimientos, receipts, recipe_components): cambiar factor/unidad → `PRESENTATION_LOCKED` (usar RPC controlado).
- Preserva validaciones originales: nombre, duplicado, mínimo, no reactiva `active`.

## Flujo Fernet

1. Alta: 20 u × 750 ml → stock inicial **15.000 ml** + `conversion_factor=750`.
2. Mínimo 5 u → **3.750 ml**.
3. Entrada posterior 10 u → ajuste **+7.500 ml** → **22.500 ml**.
4. Receta 60 ml → descuenta **60 ml** en base (sin tocar presentación) si `divisible` ≠ false.
5. Si `divisible = false`, la BOM exige múltiplos de 750 ml.

## Compatibilidad

Sin migración aplicada: el alta degrada (crea sin columnas nuevas). Con migración: persiste y se recupera en list/edit.

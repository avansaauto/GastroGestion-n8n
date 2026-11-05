# Crear Insumo universal — compatibilidad (NO APLICAR)

Documento de diseño. **No ejecuta SQL.** No modifica datos existentes.

## Qué reutiliza

| Pieza | Uso |
|---|---|
| `inventory_products.base_unit` CHECK (`g` \| `ml` \| `unit`) | Sin cambio de esquema |
| `createInventoryProduct` + JWT/RLS | Alta de catálogo |
| `senda_update_inventory_product` | Stock mínimo por local |
| `senda_adjust_inventory_quantity` | Stock inicial como ajuste trazable (`reason = Stock inicial`) |
| `recipeUnits` / `convertQuantityToBase` | Recetas y CPP siguen en unidad base |
| Proveedores vía `purchase_documents.issuer_name` | Selector de proveedores ya vistos en facturas |

## Conversión (capa app)

UI acepta `u | g | kg | ml | L`. Persistencia:

- `g` / `kg` → `base_unit = g` (kg × 1000)
- `ml` / `L` → `base_unit = ml` (L × 1000)
- `u` sin contenido → `base_unit = unit`
- `u` + contenido (g|kg|ml|L) → `base_unit = g|ml` y stock = unidades × contenido

Ejemplos: Fernet 20 u × 750 ml = 15 000 ml; Huevos 60 u sin contenido = 60 unit.

No se mezclan masa y volumen. No se reescriben movimientos ni costos históricos.

## Persistencia (propuesta siguiente)

Ver `proposed-inventory-product-presentation-supplier.sql`:

- `presentation_unit` + `conversion_factor` en `inventory_products`
- `preferred_supplier_id` → `suppliers`
- RPC `senda_ensure_supplier_from_issuer`

## Contenido por unidad

La equivalencia se materializa en `base_unit` g/ml al alta y, con la migración
propuesta, también queda el factor comercial (`conversion_factor`) para entradas
posteriores en u.

## Compatibilidad

- Facturas / presentaciones comerciales: sin cambio.
- Recetas: consumen la `base_unit` resultante (parcial si g/ml; entero si unit).
- CPP / movimientos: siguen en unidad física base.
- Reactivación: conserva id e historial; stock inicial opcional vía ajuste.

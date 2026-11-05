# Inventario Paso 3 — orden de instalación (NO EJECUTAR)

Aplicar en Supabase SENDA (no GastroGest), de a uno, con su verificador
de solo lectura después de cada paso.

1. `proposed-senda-receive-require-active-product.sql`  
   → `verify-senda-receive-require-active-product.sql`  
   Parche independiente de recepción (`PRODUCT_INACTIVE`).  
   **No** reejecutar `migrate-inventory-reception.sql`.

2. `proposed-senda-set-inventory-product-active.sql`  
   → `verify-senda-set-inventory-product-active.sql`

3. `proposed-senda-adjust-inventory-quantity.sql`  
   → `verify-senda-adjust-inventory-quantity.sql`

4. `proposed-senda-update-inventory-product.sql`  
   → `verify-senda-update-inventory-product.sql`

5. `proposed-senda-delete-inventory-product.sql`  
   → `verify-senda-delete-inventory-product.sql`

Opcional / etapa costo (aparte, cuando se autorice):

- `proposed-senda-receive-purchase-cost.sql`  
  → `verify-senda-receive-purchase-cost.sql`  
  Ya incluye `PRODUCT_INACTIVE`; no hace falta reaplicar el parche (1).

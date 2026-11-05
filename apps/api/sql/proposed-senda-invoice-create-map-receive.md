# Propuesta: confirmación atómica de factura (documento + líneas)

**NO EJECUTAR. NO APLICAR** hasta autorización expresa.  
Sustituye el borrador anterior de RPC por línea.

**Implementación lista para revisión:**  
`proposed-senda-confirm-purchase-invoice-intake.sql` + `verify-senda-confirm-purchase-invoice-intake.sql`.

Inspección de contratos reales en el repo (fuentes):

| RPC / vía | Firma | Fuente |
|-----------|--------|--------|
| `senda_save_purchase_invoice` | `(jsonb) → uuid` | `migrate-invoice-persistence.sql` |
| `senda_map_purchase_document_line` | `(uuid, uuid, numeric, uuid) → void` | `migrate-invoice-persistence.sql` |
| `senda_receive_purchase_document_line` | `(uuid, uuid, numeric, uuid, uuid) → jsonb` | `migrate-inventory-reception.sql` + parches costo / `PRODUCT_INACTIVE` |
| `senda_set_inventory_product_active` | `(jsonb) → jsonb` | `proposed-senda-set-inventory-product-active.sql` |
| Alta de insumo | **no hay RPC** — `INSERT` JWT+RLS en `operationsRepository.createInventoryProduct` | API |

Todos los RPC de escritura son `SECURITY DEFINER`, `EXECUTE` solo `service_role`, actor vía `senda_require_backend_actor`.

---

## 1. Contrato propuesto

### Nombre

`senda_confirm_purchase_invoice_intake(p jsonb) → jsonb`

Operación **posterior** al guardado. No reemplaza `senda_save_purchase_invoice`.

### Separación de operaciones

| Operación | RPC | Efecto |
|-----------|-----|--------|
| Guardar revisión (sin stock) | `senda_save_purchase_invoice` (actual) | Documento `reviewed`, líneas `unmapped`, **sin** movimientos |
| Confirmar intake | **este RPC** | Create/reactivate/map/receive atómico por el conjunto de líneas |
| Recepción parcial posterior | `senda_receive_purchase_document_line` (actual) | Sin cambios de contrato |

### Payload de entrada (`p`)

```json
{
  "actor_user_id": "uuid",
  "organization_id": "uuid",
  "location_id": "uuid",
  "purchase_document_id": "uuid",
  "confirm_idempotency_key": "uuid",
  "lines": [
    {
      "purchase_document_line_id": "uuid",
      "action": "link_existing | create | reactivate | pending",
      "inventory_product_id": "uuid|null",
      "create": {
        "name": "string",
        "base_unit": "g|ml|unit",
        "category": "string|null",
        "minimum_stock": "number|null"
      },
      "inventory_physical_quantity": "number|null",
      "conversion_factor": "number|null",
      "receive_quantity": "number|null",
      "receive_idempotency_key": "uuid|null"
    }
  ]
}
```

Reglas por `action`:

| `action` | Requerido | Prohibido / efecto |
|----------|-----------|-------------------|
| `link_existing` | `inventory_product_id`, `inventory_physical_quantity > 0` | No create |
| `create` | `create.*`, `inventory_physical_quantity > 0` | `inventory_product_id` null; falla si activo duplicado o inactivo homónimo |
| `reactivate` | `inventory_product_id`, `inventory_physical_quantity > 0` | Llama activación explícita; opcional `create.category` / `minimum_stock` vía update existente si se decide |
| `pending` | solo id de línea | Solo si la línea está `unmapped` y sin receipts; si ya está vinculada/recibida → `PENDING_NOT_ALLOWED` |

`receive_quantity`:

- `null` o `0` → map only (si no `pending`).
- `> 0` → requiere `receive_idempotency_key` y `action ≠ pending`.
- Debe ser `≤ inventory_physical_quantity` (tope de factura en unidad base).

`conversion_factor`: la API (`invoiceUnits`) resuelve el factor SI o exige factor de empaque y envía siempre el factor efectivo + `inventory_physical_quantity`. El RPC **revalida** contra unidad/cantidad de la línea y `base_unit` del producto (o `create.base_unit`): factor SI incorrecto → `INVALID_CONVERSION`; empaque sin factor → `EQUIVALENCE_REQUIRED`; `physical ≠ qty×factor` → `INVALID_CONVERSION`.

`confirm_idempotency_key`: única por **intento** (tabla `purchase_document_confirm_attempts`). Replay de la misma clave + mismo digest → éxito idempotente. Misma clave + digest distinto → `CONFIRM_IDEMPOTENCY_CONFLICT`. Una factura puede tener varios intentos sucesivos para completar líneas que quedaron `pending` sin reprocesar las ya recibidas.

### Validaciones de cabecera (orden)

1. `senda_require_backend_actor(actor_user_id)`.
2. Documento `FOR UPDATE`; existe; `location_id` y `organization_id` coinciden con payload y con `locations`.
3. `senda_actor_is_purchase_member(location_id, actor)`.
4. `status ∈ {reviewed, received}` (mismo criterio que receive).
5. Cada `purchase_document_line_id` pertenece al documento; inventariable (`senda_purchase_line_is_inventoriable`); sin receipts si se remapea a otro producto (respeta trigger `purchase_document_lines_block_receipted_remap`).
6. El array `lines` debe cubrir **todas** las líneas elegibles inventariables del documento (o decidir explícitamente “subset allowed” — ver decisiones pendientes).

### Semántica transaccional

Una sola transacción PG (función plpgsql):

1. Lock documento.
2. Replay: si existe intento en `purchase_document_confirm_attempts` con la misma `confirm_idempotency_key` y mismo digest → devolver `result` (`idempotent: true`). Digest distinto → conflicto.
3. Por cada línea, en orden estable (`source_index` / id):
   - `pending` → no-op stock solo si `unmapped` y sin receipts.
   - `create` → helper interno (sin GRANT externo); si falla → rollback total.
   - `reactivate` → `senda_set_inventory_product_active` con `active: true`, `expected_active: false`.
   - `link_existing` / post-create / post-reactivate → map si hace falta; si ya está mapeada al mismo producto/cantidad, no re-map.
   - si `receive_quantity > 0` → `senda_receive_purchase_document_line(...)` (tope = autorizado − ya recibido; costo instalado).
4. Cualquier `raise` → rollback de **todas** las líneas (productos nuevos, maps, receipts, movimientos, costos).
5. Persistencia del intento + audit `invoice_intake_confirmed`.
6. Estado documento: lo decide receive (`senda_purchase_document_is_fully_received`). Con `pending` el documento **permanece `reviewed`**.

### Respuesta (`jsonb`)

```json
{
  "purchase_document_id": "uuid",
  "document_status": "reviewed|received",
  "idempotent": false,
  "unmapped_line_count": 0,
  "lines": [
    {
      "purchase_document_line_id": "uuid",
      "action": "link_existing|create|reactivate|pending",
      "inventory_product_id": "uuid|null",
      "created": false,
      "reactivated": false,
      "mapped": true,
      "inventory_physical_quantity": 16000,
      "receive": null
    }
  ]
}
```

`receive` reutiliza el shape de `senda_receive_purchase_document_line` cuando hubo recepción.

### Errores (códigos estables, alineados a existentes)

`NOT_A_MEMBER`, `DOCUMENT_NOT_FOUND`, `LINE_NOT_FOUND`, `CONFIRM_REQUIRES_REVIEWED`, `INVALID_PAYLOAD`, `DUPLICATE_PRODUCT`, `INACTIVE_PRODUCT_EXISTS`, `PRODUCT_INACTIVE`, `PRODUCT_ORG_MISMATCH`, `MAP_REQUIRES_ELIGIBLE`, `LINE_HAS_RECEIPTS`, `RECEIPT_EXCEEDS_INVOICED`, `IDEMPOTENCY_CONFLICT`, `CONFIRM_IDEMPOTENCY_CONFLICT`, `VALUATION_AMOUNT_REQUIRED`, `INVALID_QUANTITY`, `CONCURRENT_UPDATE`.

### Grants

Igual que el resto: `REVOKE` public/anon/authenticated; `GRANT EXECUTE` solo `service_role`. Owner alineado a map/receive.

---

## 2. Dependencias existentes reutilizables

### Invocables **dentro** de la función (misma transacción)

| Dependencia | Reutilizable | Notas |
|-------------|--------------|-------|
| `senda_require_backend_actor` | Sí | Cabecera |
| `senda_actor_is_purchase_member` | Sí | Cabecera |
| `senda_purchase_line_is_inventoriable` | Sí | Filtro de líneas |
| `senda_purchase_document_is_fully_received` | Sí | Indirecto vía receive |
| `senda_map_purchase_document_line` | Sí | Firma estable; no toca stock; acepta cantidad física ya calculada |
| `senda_receive_purchase_document_line` | Sí | Conserva idempotencia por `(document_id, idempotency_key)`, tope, movimiento, valuación y **costo** si el parche de costo está instalado; `PRODUCT_INACTIVE` si el parche activo está instalado |
| `senda_set_inventory_product_active` | Sí | Reactivar con `expected_active: false`; replay si ya activo |

Anidamiento DEFINER → DEFINER en PG comparte la transacción: un `raise` en receive revierte map/create previos del mismo call.

### No reutilizables tal cual (adaptación necesaria)

| Pieza | Estado | Adaptación |
|-------|--------|------------|
| Alta de insumo | Solo HTTP `INSERT` + dedupe por nombre normalizado en Node | Nuevo helper SQL `senda_ensure_inventory_product(jsonb)` **o** INSERT inline en el confirm DEFINER (misma semántica `DUPLICATE_PRODUCT` / `INACTIVE_PRODUCT_EXISTS`). **No** llamar la API HTTP desde SQL. |
| `senda_save_purchase_invoice` | Guarda documento; no intake | **No invocar** desde confirm. Sigue siendo operación separada. |
| `senda_update_inventory_product` | Edición nombre/categoría/mínimo | Opcional tras reactivate; no obligatorio en v1 |
| Conversión SI/empaque | Hoy en Express (`invoiceUnits.resolveConversionFactor`) | Validar en API antes del RPC; pasar `inventory_physical_quantity`. No portar Decimal.js a SQL en v1. |
| Idempotencia de confirmación | Tabla `purchase_document_confirm_attempts` (clave, digest, result, status) | Varios intentos por documento; replay por clave |

### Fuera de alcance (no tocar)

Anulación de recibidas, Fudo, recetas (salvo el check `PRODUCT_IN_USE` ya existente al desactivar — no aplica al reactivar).

---

## 3. Riesgos concretos y decisiones pendientes

### Riesgos

1. **Alta sin RPC**: sin helper DEFINER, no hay create atómico seguro; el INSERT authenticated no corre bajo service_role del confirm.
2. **Doble `FOR UPDATE` del documento**: map y receive ya bloquéan el documento; anidarlos es correcto pero el orden de líneas debe ser determinista para evitar deadlocks entre confirms concurrentes.
3. **Confirm parcial vs fully_received**: líneas `pending` dejan el doc en `reviewed`; correcto. Un segundo confirm debe poder completar pending sin re-recibir líneas ya recibidas (`LINE_HAS_RECEIPTS` / skip receive).
4. **Replay de create**: si el primer confirm hizo commit y el cliente reintenta con otra `confirm_idempotency_key` pero mismos `create.name`, cae en `DUPLICATE_PRODUCT`. La clave de confirmación debe ser estable en el cliente.
5. **Costo vigente**: depende de que el cuerpo instalado de receive sea el de `proposed-senda-receive-purchase-cost` (+ active). El confirm **no** debe reinstalar receive; solo llamarlo. Verificar preflight en el entorno.
6. **Subset de líneas**: si el payload omite una elegible, hoy el intake HTTP la trata como pending implícito. El RPC debe fijar si omitir = error o = pending.
7. **Remap con receipts**: el trigger bloquea cambio de producto; el confirm debe fallar claro, no silenciar.
8. **Huérfanos tras éxito**: si create+map+receive OK y el HTTP timeout, el retry con la misma `confirm_idempotency_key` debe ser no-op seguro (por eso la clave de documento es obligatoria además de las de receive).

### Decisiones pendientes

1. ¿`lines` debe listar **todas** las elegibles o se permiten omisiones (= pending)?
2. ¿Helper nuevo `senda_ensure_inventory_product` vs INSERT inline solo en el confirm?
3. ¿Persistir `confirm_idempotency_key` en columna dedicada o solo audit?
4. ¿Tras `create`, aplicar `minimum_stock` vía `location_inventory` en el mismo confirm (hoy el create HTTP a veces lo hace en otro paso)?
5. ¿Permitir `receive_quantity` parcial en el confirm o exigir recepción total de lo mapeado en esta operación?
6. ¿El digest de replay exige igualdad exacta del array `lines` o solo de claves de recepción?

---

## 4. Plan mínimo de implementación

1. **Preflight solo lectura**: verificar firmas instaladas de map/receive/active y que receive contenga costo + `PRODUCT_INACTIVE`.
2. **SQL propuesto (sin aplicar)**:
   - helper create/ensure (si se elige separado),
   - `senda_confirm_purchase_invoice_intake(jsonb)`,
   - storage de `confirm_idempotency_key`,
   - grants/owner/verify.
3. **API**: nuevo endpoint `POST /api/invoices/:id/confirm-intake` que:
   - valida conversiones y arma `inventory_physical_quantity`,
   - genera/reusa claves de idempotencia,
   - llama **una** vez al RPC admin,
   - deja `senda_save_purchase_invoice` como está (guardar sin stock).
4. **Web**: reemplazar el encadenado `saveThenApplyIntake` (map/receive HTTP por línea) por save → confirm-intake cuando el RPC esté instalado; feature-detect o flag.
5. **Tests**: unitarios de contrato SQL (policy tests como los actuales), HTTP mock del RPC, caso rollback (create ok + receive fail ⇒ sin producto), replay idempotente, pending sin movimiento.
6. **No** en este plan: anulación de recibidas, Fudo, recetas, portar conversión SI a SQL.

### Criterio de “operativo”

Solo después de: migración aplicada en el entorno, verify SQL en verde, prueba manual con factura real (p. ej. MAYORISTANET) save + confirm con al menos una línea create, una link, una pending y un empaque con factor.

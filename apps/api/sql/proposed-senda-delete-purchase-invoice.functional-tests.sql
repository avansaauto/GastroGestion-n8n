-- SENDA OPS — Pruebas funcionales TRANSACCIONALES del borrado de facturas.
-- NO EJECUTAR contra datos reales sin autorización expresa.
--
-- Requisitos: proposed-senda-delete-purchase-invoice.sql y
-- senda_adjust_inventory_quantity ya instalados en un entorno de prueba.
--
-- Cada bloque hace BEGIN … ROLLBACK. No deja datos.
-- Sustituí los UUID/placeholders antes de correr en un sandbox.

-- =============================================================================
-- Plantilla: reemplazar estos placeholders con IDs de un entorno de prueba.
-- =============================================================================
-- :actor          uuid  — usuario miembro del local
-- :org            uuid
-- :location       uuid
-- :product_a      uuid  — activo
-- :product_b      uuid  — inactivo (active=false), con LI y stock
-- :product_gone   uuid  — no existe en inventory_products (solo en recibo viejo)

begin;
-- Sanity: RPC presente
do $$
begin
  if to_regprocedure('public.senda_delete_purchase_invoice(jsonb)') is null then
    raise exception 'FUNCTIONAL_TEST_SKIP: falta senda_delete_purchase_invoice';
  end if;
  if to_regprocedure('public.senda_adjust_inventory_quantity(jsonb)') is null then
    raise exception 'FUNCTIONAL_TEST_SKIP: falta senda_adjust_inventory_quantity';
  end if;
end $$;
rollback;

-- -----------------------------------------------------------------------------
-- 1) Factura recibida + stock suficiente → deleted_at + adjust negativo
-- -----------------------------------------------------------------------------
-- Pseudocódigo a materializar en sandbox:
--   insert document reviewed/received
--   insert line + receipt (qty Q) + purchase movement + valuation on_hand >= Q
--   call senda_delete_purchase_invoice({actor, document})
--   assert document.deleted_at is not null
--   assert inventory_adjustments.idempotency_key = receipt_id and quantity = -Q
--   assert valuation.on_hand = previous - Q
--   rollback
--
-- Esperado: OK, replay=false, cost_rollbacks según historial.

-- -----------------------------------------------------------------------------
-- 2) Producto inactivo + LI con stock → igual debe revertir
-- -----------------------------------------------------------------------------
--   product.active = false, location_inventory existe, on_hand >= Q
--   call delete
--   assert adjust creado (senda_adjust no bloquea inactive en el SQL propuesto)
--   rollback

-- -----------------------------------------------------------------------------
-- 3) Referencia de inventario inconsistente → abort, sin deleted_at
-- -----------------------------------------------------------------------------
--   receipt.location_inventory_id = LI de OTRO producto o de OTRO local
--   call delete
--   assert exception REVERSAL_INVENTORY_REF_MISMATCH
--   assert document.deleted_at is null
--   assert no inventory_adjustments nuevos
--   rollback

-- -----------------------------------------------------------------------------
-- 4) Stock insuficiente → REVERSAL_INSUFFICIENT_STOCK
-- -----------------------------------------------------------------------------
--   on_hand < receipt.quantity
--   call delete
--   assert exception REVERSAL_INSUFFICIENT_STOCK
--   assert deleted_at is null
--   rollback

-- -----------------------------------------------------------------------------
-- 5) Varias líneas / recibos del mismo insumo
-- -----------------------------------------------------------------------------
--   2 receipts same product, qty Q1+Q2, on_hand >= Q1+Q2
--   call delete
--   assert 2 adjustments with distinct receipt_id keys
--   assert on_hand decreased by Q1+Q2
--   rollback

-- -----------------------------------------------------------------------------
-- 6) Restauración del costo anterior válido
-- -----------------------------------------------------------------------------
--   history: invoice A (older) cost CA, invoice B (current) cost CB
--   delete B
--   assert valuation last/avg = CA (B excluded via deleted_at / id distinct)
--   assert inventory_cost_history rows of B still exist (no hard delete)
--   rollback

-- -----------------------------------------------------------------------------
-- 6b) Sin costo anterior válido (previous_unit_cost NULL en la única fila)
-- -----------------------------------------------------------------------------
-- Caso real tipo 694d59af-… / source_ref 17b7aed2-…:
--   unica fila inventory_cost_history source=invoice, previous_unit_cost NULL
--   delete
--   assert average_unit_cost IS NULL and last_purchase_unit_cost IS NULL
--   assert cost_rollbacks action = 'cleared'
--   assert history row still present
--   rollback
-- Nota: NO restaurar h.previous_unit_cost a ciegas; recalcular desde historial
-- válido restante (manual u otras invoices no eliminadas).

-- -----------------------------------------------------------------------------
-- 7) Eliminación repetida (idempotencia)
-- -----------------------------------------------------------------------------
--   delete once → deleted_at set, adjust created
--   delete again → replay true, no second adjustment row for same receipt_id
--   rollback

-- -----------------------------------------------------------------------------
-- 8) Error a mitad → toda la transacción revierte (sin deleted_at)
-- -----------------------------------------------------------------------------
--   on_hand insuficiente en la 2ª recepción
--   call delete → REVERSAL_INSUFFICIENT_STOCK
--   assert deleted_at is null, sin adjustments nuevos
--   rollback

-- -----------------------------------------------------------------------------
-- 9) Factura sin recepciones
-- -----------------------------------------------------------------------------
--   document reviewed, 0 receipts
--   call delete → deleted_at set, cost_rollbacks vacío
--   rollback

-- Ejemplo ejecutable mínimo (comentado): descomentar solo en sandbox con vars.
/*
do $demo$
declare
  v_doc uuid := '00000000-0000-4000-8000-000000000001'; -- placeholder
  v_actor uuid := '00000000-0000-4000-8000-000000000099';
  v_result jsonb;
begin
  begin
    v_result := public.senda_delete_purchase_invoice(jsonb_build_object(
      'actor_user_id', v_actor,
      'purchase_document_id', v_doc
    ));
    raise notice 'result=%', v_result;
  exception
    when others then
      raise notice 'expected_or_setup_error: %', sqlerrm;
  end;
end
$demo$;
*/

select 'proposed-senda-delete-purchase-invoice.functional-tests.sql: plantilla lista (NO EJECUTAR sin autorización)' as status;

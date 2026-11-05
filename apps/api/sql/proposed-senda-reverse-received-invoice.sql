-- SENDA OPS — Propuesta de reversión de facturas recibidas.
-- NO EJECUTAR. NO APLICAR.
-- Este archivo no crea RPC ni altera triggers. Aborta a propósito.
-- Contrato: apps/api/sql/proposed-senda-reverse-received-invoice.md

begin;

do $guard$
begin
  raise exception 'REVERSE_RECEIVED_NOT_AUTHORIZED: propuesta pendiente. No aplicar. No reescribir senda_cancel_purchase_invoice. No DELETE de facturas, recepciones, movimientos ni auditoría.';
end
$guard$;

commit;

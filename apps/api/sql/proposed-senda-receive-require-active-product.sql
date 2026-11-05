-- SENDA OPS — Parche independiente: recepción bloquea producto inactivo
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción.
-- Después: apps/api/sql/verify-senda-receive-require-active-product.sql (solo lectura).
--
-- Qué hace:
--   Actualiza SOLO el cuerpo instalado de senda_receive_purchase_document_line
--   para rechazar productos active = false con PRODUCT_INACTIVE.
--
-- Qué NO hace:
--   No reejecuta migrate-inventory-reception.sql.
--   No recrea purchase_document_receipts, triggers ni políticas.
--   No aplica proposed-senda-receive-purchase-cost.sql (costo).
--   No toca Fudo, ventas ni GastroGest.
--
-- Idempotente: si PRODUCT_INACTIVE ya está en el cuerpo, no modifica nada.

begin;

do $patch$
declare
  v_reg regprocedure;
  v_def text;
  v_new text;
  v_already boolean := false;
begin
  if to_regprocedure(
    'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'
  ) is null then
    raise exception
      'RECEIVE_ACTIVE_ABORT: falta senda_receive_purchase_document_line. '
      'No reejecutar migrate-inventory-reception desde este archivo.';
  end if;

  v_reg := 'public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid)'::regprocedure;
  v_def := pg_get_functiondef(v_reg);

  if v_def ilike '%PRODUCT_INACTIVE%' then
    v_already := true;
  end if;

  if v_already then
    raise notice 'RECEIVE_ACTIVE_SKIP: PRODUCT_INACTIVE ya presente en la recepción instalada.';
  else
    if v_def not ilike '%RECEIPT_EXCEEDS_INVOICED%'
       or v_def not ilike '%LINE_NOT_MAPPED%'
       or v_def not ilike '%PRODUCT_ORG_MISMATCH%'
       or v_def not ilike '%insert into public.inventory_movements%' then
      raise exception
        'RECEIVE_ACTIVE_ABORT: cuerpo de recepción inesperado; no se parchea a ciegas. '
        'Comprobar efectos antes de reinstalar migraciones anteriores.';
    end if;

    if v_def ilike '%create table public.purchase_document_receipts%'
       or v_def ilike '%migrate-inventory-reception%' then
      raise exception 'RECEIVE_ACTIVE_ABORT: definición inesperada (parece una migración completa).';
    end if;

    v_new := v_def;

    if v_new !~* 'v_product_active\s+boolean' then
      if v_new !~* 'v_product_org\s+uuid\s*;' then
        raise exception 'RECEIVE_ACTIVE_ABORT: no se encontró v_product_org uuid en DECLARE.';
      end if;
      v_new := regexp_replace(
        v_new,
        'v_product_org\s+uuid\s*;',
        E'v_product_org uuid;\n  v_product_active boolean;',
        'i'
      );
    end if;

    if v_new !~* 'into\s+v_product_org\s*,\s*v_product_active' then
      v_new := regexp_replace(
        v_new,
        'select\s+p\.organization_id\s+into\s+v_product_org\s+'
          || 'from\s+public\.inventory_products\s+p\s+'
          || 'where\s+p\.id\s*=\s*v_line\.inventory_product_id\s*;',
        $r$select p.organization_id, p.active
    into v_product_org, v_product_active
  from public.inventory_products p
  where p.id = v_line.inventory_product_id;$r$,
        'i'
      );
    end if;

    if v_new !~* 'into\s+v_product_org\s*,\s*v_product_active' then
      raise exception
        'RECEIVE_ACTIVE_ABORT: no se pudo transformar el SELECT del producto. '
        'Abortar; no reinstalar migrate-inventory-reception sin revisión.';
    end if;

    if v_new not ilike '%PRODUCT_INACTIVE%' then
      v_new := regexp_replace(
        v_new,
        'raise exception ''PRODUCT_ORG_MISMATCH''\s*;\s*end if\s*;',
        $r$raise exception 'PRODUCT_ORG_MISMATCH';
  end if;
  if v_product_active is not true then
    raise exception 'PRODUCT_INACTIVE';
  end if;$r$,
        'i'
      );
    end if;

    if v_new not ilike '%PRODUCT_INACTIVE%' then
      raise exception 'RECEIVE_ACTIVE_ABORT: no se pudo insertar PRODUCT_INACTIVE.';
    end if;

    if v_new ilike '%create table %'
       or v_new ilike '%drop table %'
       or v_new ilike '%truncate %' then
      raise exception 'RECEIVE_ACTIVE_ABORT: el parche transformado no debe DDL de tablas.';
    end if;

    execute v_new;

    revoke all on function public.senda_receive_purchase_document_line(
      uuid, uuid, numeric, uuid, uuid
    ) from public, anon, authenticated;
    grant execute on function public.senda_receive_purchase_document_line(
      uuid, uuid, numeric, uuid, uuid
    ) to service_role;
  end if;

  -- Verificación in-transaction
  v_def := pg_get_functiondef(v_reg);
  if v_def not ilike '%PRODUCT_INACTIVE%' then
    raise exception 'RECEIVE_ACTIVE_ABORT: tras el parche falta PRODUCT_INACTIVE.';
  end if;
  if v_def ilike '%create table public.purchase_document_receipts%' then
    raise exception 'RECEIVE_ACTIVE_ABORT: el parche no debe incluir DDL de receipts.';
  end if;
end
$patch$;

comment on function public.senda_receive_purchase_document_line(uuid, uuid, numeric, uuid, uuid) is
  'Recepción de línea de compra. Rechaza productos inactivos (PRODUCT_INACTIVE). Solo service_role.';

commit;

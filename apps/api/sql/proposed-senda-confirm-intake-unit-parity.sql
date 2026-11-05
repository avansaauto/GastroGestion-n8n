-- SENDA OPS — Paridad de unidades en la confirmación de factura
-- Reemplaza solo:
--   public.senda_confirm_intake_canonical_unit(text)
--   public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)
-- NO EJECUTAR. NO APLICAR sin autorización.
--
-- Dónde, cuando se autorice: Supabase Dashboard → proyecto SENDA (no GastroGest)
-- → SQL Editor. Pegar el archivo entero. Una transacción.
-- Después, solo lectura: apps/api/sql/verify-senda-confirm-intake-unit-parity.sql
--
-- No altera tablas. No reemplaza senda_confirm_purchase_invoice_intake,
-- senda_save_purchase_invoice, senda_receive_purchase_document_line ni
-- senda_map_purchase_document_line. No crea insumos ni movimientos de stock.
-- Los helpers siguen sin GRANT: solo los invoca el RPC ya instalado.
-- Idempotente: create or replace de la misma firma. Si faltan los helpers, aborta.

begin;

do $guard$
begin
  if to_regprocedure('public.senda_confirm_intake_canonical_unit(text)') is null
     or to_regprocedure('public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)') is null then
    raise exception 'CONFIRM_INTAKE_UNIT_PARITY_ABORT: faltan los helpers de conversión. No crearlos desde este archivo.';
  end if;
end
$guard$;

create or replace function public.senda_confirm_intake_canonical_unit(p_unit text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v text;
  v_token text;
  i int;
begin
  v := lower(btrim(coalesce(p_unit, '')));
  v := translate(v, 'áéíóúàèìòùäëïöüñ', 'aeiouaeiouaeiouun');
  v := regexp_replace(v, '\([^)]*\)', ' ', 'g');
  v := regexp_replace(v, '\s+', ' ', 'g');
  v := btrim(v);
  if v = '' then return null; end if;

  v_token := v;
  for i in 1..2 loop
    if v_token in ('m3', 'm³', 'm^3') then return 'm3'; end if;
    if v_token in ('l', 'lt', 'lts', 'litro', 'litros') then return 'l'; end if;
    if v_token in ('ml', 'mililitro', 'mililitros') then return 'ml'; end if;
    if v_token in ('cl', 'centilitro', 'centilitros') then return 'cl'; end if;
    if v_token in ('kg', 'kilo', 'kilos', 'kilogramo', 'kilogramos') then return 'kg'; end if;
    if v_token in ('g', 'gr', 'grs', 'gramo', 'gramos') then return 'g'; end if;
    if v_token in ('mg', 'miligramo', 'miligramos') then return 'mg'; end if;
    if v_token in ('docena', 'docenas') then return 'docena'; end if;
    if v_token in ('unit', 'u', 'un', 'uni', 'und', 'unid', 'unidad', 'unidades') then return 'unit'; end if;
    if v_token in (
      'caja', 'cajas', 'pack', 'packs', 'bulto', 'bultos', 'barril', 'barriles',
      'bidon', 'bidones', 'maple', 'cajon', 'cajones', 'pallet', 'palet',
      'pieza', 'piezas', 'lata', 'latas', 'bolsa', 'bolsas',
      'botella', 'botellas', 'plancha', 'planchas', 'barra', 'barras',
      'horma', 'hormas', 'bloque', 'bloques'
    ) then
      return v_token;
    end if;
    exit when i = 2 or position(' ' in v_token) = 0;
    v_token := split_part(v_token, ' ', 1);
  end loop;

  if v_token = '' then return null; end if;
  return v_token;
end;
$$;

create or replace function public.senda_confirm_intake_assert_physical(
  p_invoice_unit text,
  p_base_unit text,
  p_invoice_qty numeric,
  p_conversion_factor numeric,
  p_physical numeric
)
returns numeric
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_from text;
  v_to text;
  v_packaging boolean;
  v_from_family text;
  v_to_family text;
  v_from_to_base numeric;
  v_to_to_base numeric;
  v_known numeric;
  v_factor numeric;
  v_expected numeric;
begin
  if p_invoice_qty is null or p_invoice_qty <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;
  if p_physical is null or p_physical <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  v_from := public.senda_confirm_intake_canonical_unit(p_invoice_unit);
  v_to := public.senda_confirm_intake_canonical_unit(p_base_unit);
  if v_to is null then
    raise exception 'INCOMPATIBLE_UNITS';
  end if;

  -- Sin unidad de factura: equivalencia explícita solo hacia g, ml o unit.
  if v_from is null then
    if v_to in ('g', 'ml', 'unit') then
      if p_conversion_factor is null or p_conversion_factor <= 0 then
        raise exception 'EQUIVALENCE_REQUIRED';
      end if;
      v_factor := round(p_conversion_factor, 6);
    else
      raise exception 'INCOMPATIBLE_UNITS';
    end if;
  else
    v_packaging := v_from in (
      'caja', 'cajas', 'pack', 'packs', 'bulto', 'bultos', 'barril', 'barriles',
      'bidon', 'bidones', 'maple', 'cajon', 'cajones', 'pallet', 'palet',
      'pieza', 'piezas', 'lata', 'latas', 'bolsa', 'bolsas',
      'botella', 'botellas', 'plancha', 'planchas', 'barra', 'barras',
      'horma', 'hormas', 'bloque', 'bloques'
    ) or v_to in (
      'caja', 'cajas', 'pack', 'packs', 'bulto', 'bultos', 'barril', 'barriles',
      'bidon', 'bidones', 'maple', 'cajon', 'cajones', 'pallet', 'palet',
      'pieza', 'piezas', 'lata', 'latas', 'bolsa', 'bolsas',
      'botella', 'botellas', 'plancha', 'planchas', 'barra', 'barras',
      'horma', 'hormas', 'bloque', 'bloques'
    );

    if v_packaging then
      if p_conversion_factor is null or p_conversion_factor <= 0 then
        raise exception 'EQUIVALENCE_REQUIRED';
      end if;
      v_factor := round(p_conversion_factor, 6);
    elsif v_from = v_to then
      v_known := 1;
      if p_conversion_factor is not null then
        if round(p_conversion_factor, 6) is distinct from round(v_known, 6) then
          raise exception 'INVALID_CONVERSION';
        end if;
        v_factor := round(p_conversion_factor, 6);
      else
        v_factor := v_known;
      end if;
    else
      v_from_family := case
        when v_from in ('l', 'cl', 'ml', 'm3') then 'volume'
        when v_from in ('kg', 'g', 'mg') then 'mass'
        when v_from in ('unit', 'docena') then 'count'
        else null
      end;
      v_to_family := case
        when v_to in ('l', 'cl', 'ml', 'm3') then 'volume'
        when v_to in ('kg', 'g', 'mg') then 'mass'
        when v_to in ('unit', 'docena') then 'count'
        else null
      end;
      if v_from_family is null or v_to_family is null or v_from_family is distinct from v_to_family then
        -- unit ↔ otra dimensión: factor explícito. docena no hereda esa excepción.
        if v_from = 'unit' or v_to = 'unit' then
          if p_conversion_factor is null or p_conversion_factor <= 0 then
            raise exception 'EQUIVALENCE_REQUIRED';
          end if;
          v_factor := round(p_conversion_factor, 6);
        else
          raise exception 'INCOMPATIBLE_UNITS';
        end if;
      else
        v_from_to_base := case v_from
          when 'l' then 1000
          when 'cl' then 10
          when 'ml' then 1
          when 'm3' then 1000000
          when 'kg' then 1000
          when 'g' then 1
          when 'mg' then 0.001
          when 'unit' then 1
          when 'docena' then 12
        end;
        v_to_to_base := case v_to
          when 'l' then 1000
          when 'cl' then 10
          when 'ml' then 1
          when 'm3' then 1000000
          when 'kg' then 1000
          when 'g' then 1
          when 'mg' then 0.001
          when 'unit' then 1
          when 'docena' then 12
        end;
        v_known := round(v_from_to_base / v_to_to_base, 6);
        if v_known is null or v_known <= 0 then
          raise exception 'INCOMPATIBLE_UNITS';
        end if;
        if p_conversion_factor is not null then
          if round(p_conversion_factor, 6) is distinct from v_known then
            raise exception 'INVALID_CONVERSION';
          end if;
          v_factor := round(p_conversion_factor, 6);
        else
          v_factor := v_known;
        end if;
      end if;
    end if;
  end if;

  v_expected := round(p_invoice_qty * v_factor, 6);
  if round(p_physical, 6) is distinct from v_expected then
    raise exception 'INVALID_CONVERSION';
  end if;

  return v_factor;
end;
$$;

revoke all on function public.senda_confirm_intake_canonical_unit(text)
  from public, anon, authenticated, service_role;
revoke all on function public.senda_confirm_intake_assert_physical(text, text, numeric, numeric, numeric)
  from public, anon, authenticated, service_role;
commit;

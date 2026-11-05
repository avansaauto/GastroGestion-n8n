-- SENDA OPS. Propuesta. NO EJECUTAR hasta autorización explícita.
-- Proyecto SENDA, no GastroGest.
--
-- Hoy purchase_document_confirm_attempts solo guarda intentos succeeded.
-- Un fallo hace rollback y no deja la clave ni el contenido.
--
-- Esta tabla guarda el intento exacto para repetirlo desde el comprobante.
-- No modifica senda_confirm_purchase_invoice_intake
-- ni el cuerpo de senda_save_purchase_invoice.
-- No crea insumos, vínculos ni movimientos.
--
-- senda_save_purchase_invoice confirma su propia transacción al volver.
-- Esta función lo llama y después inserta el intento, en la misma transacción.
-- Si confirm_intent falta o es inválido, rechaza antes de crear el comprobante.
-- El API no tiene otro alta: si esta función no está, no guarda la factura.

create table public.purchase_document_confirm_intents (
  id uuid primary key default gen_random_uuid(),
  purchase_document_id uuid not null references public.purchase_documents (id) on delete cascade,
  organization_id uuid not null,
  location_id uuid not null,
  actor_user_id uuid not null,
  confirm_idempotency_key uuid not null,
  lines jsonb not null,
  payload_digest text not null,
  created_at timestamptz not null default now(),
  constraint purchase_document_confirm_intents_document_uniq unique (purchase_document_id),
  constraint purchase_document_confirm_intents_key_uniq unique (confirm_idempotency_key)
);

comment on table public.purchase_document_confirm_intents is
  'Intento de confirmación pendiente, guardado antes del RPC. Permite repetir la misma clave y el mismo contenido después de cerrar la pantalla. No reemplaza los intentos ya exitosos.';

alter table public.purchase_document_confirm_intents enable row level security;

create policy purchase_document_confirm_intents_member_select
  on public.purchase_document_confirm_intents
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.purchase_documents d
      where d.id = purchase_document_id
        and public.senda_is_org_active_member(d.organization_id)
    )
  );

revoke all on table public.purchase_document_confirm_intents
  from public, anon, authenticated;
grant select on table public.purchase_document_confirm_intents to authenticated;
grant insert on table public.purchase_document_confirm_intents to service_role;
revoke update, delete on table public.purchase_document_confirm_intents from service_role;

-- Misma transacción que el alta del comprobante. No reemplaza la función existente.
-- El digest repite confirmIntentCanonical: campos separados por tab, líneas por salto,
-- ordenadas por purchaseDocumentLineId. md5 en hex.
create or replace function public.senda_save_purchase_invoice_with_confirm_intent(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_intent jsonb;
  v_line jsonb;
  v_line_id uuid;
  v_mapped jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_actor uuid;
  v_org uuid;
  v_location uuid;
  v_digest text;
begin
  v_intent := p->'confirm_intent';
  if v_intent is null or jsonb_typeof(v_intent) is distinct from 'object' then
    raise exception 'CONFIRM_INTENT_REQUIRED';
  end if;
  if jsonb_typeof(v_intent->'lines') is distinct from 'array'
     or jsonb_array_length(v_intent->'lines') < 1
     or nullif(v_intent->>'confirm_idempotency_key', '') is null then
    raise exception 'CONFIRM_INTENT_REQUIRED';
  end if;

  v_id := public.senda_save_purchase_invoice(p - 'confirm_intent');
  v_actor := (p->>'actor_user_id')::uuid;

  for v_line in
    select t.line from jsonb_array_elements(v_intent->'lines') as t(line)
  loop
    select l.id into v_line_id
    from public.purchase_document_lines l
    where l.purchase_document_id = v_id
      and l.source_line_id = v_line->>'source_line_id';
    if v_line_id is null then
      raise exception 'CONFIRM_INTENT_LINE_MISMATCH';
    end if;
    v_mapped := jsonb_strip_nulls(jsonb_build_object(
      'purchaseDocumentLineId', v_line_id,
      'action', v_line->>'action',
      'inventoryProductId', v_line->>'inventoryProductId',
      'create', v_line->'create',
      'conversionFactor', v_line->'conversionFactor',
      'receiveQuantity', v_line->'receiveQuantity',
      'receiveIdempotencyKey', v_line->>'receiveIdempotencyKey'
    ));
    v_lines := v_lines || jsonb_build_array(v_mapped);
  end loop;

  select md5(string_agg(
    concat_ws(
      E'\t',
      coalesce(line->>'purchaseDocumentLineId', ''),
      coalesce(line->>'action', ''),
      coalesce(line->>'inventoryProductId', ''),
      coalesce(line->>'conversionFactor', ''),
      coalesce(line->>'receiveQuantity', ''),
      coalesce(line->>'receiveIdempotencyKey', ''),
      coalesce(line->'create'->>'name', ''),
      coalesce(line->'create'->>'baseUnit', ''),
      coalesce(line->'create'->>'category', ''),
      coalesce(line->'create'->>'minimumStock', '')
    ),
    E'\n' order by line->>'purchaseDocumentLineId'
  ))
  into v_digest
  from jsonb_array_elements(v_lines) as line;

  select d.organization_id, d.location_id
    into v_org, v_location
  from public.purchase_documents d
  where d.id = v_id;

  insert into public.purchase_document_confirm_intents (
    purchase_document_id,
    organization_id,
    location_id,
    actor_user_id,
    confirm_idempotency_key,
    lines,
    payload_digest
  ) values (
    v_id,
    v_org,
    v_location,
    v_actor,
    (v_intent->>'confirm_idempotency_key')::uuid,
    v_lines,
    v_digest
  );

  return v_id;
end;
$$;

revoke all on function public.senda_save_purchase_invoice_with_confirm_intent(jsonb)
  from public, anon, authenticated;
grant execute on function public.senda_save_purchase_invoice_with_confirm_intent(jsonb)
  to service_role;

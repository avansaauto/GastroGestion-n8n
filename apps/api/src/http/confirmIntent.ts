import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { InvoiceQueryError } from './invoiceQueryError.js'

type IntentLine = {
  purchaseDocumentLineId: string
  action: string
  inventoryProductId?: string | null
  create?: {
    name: string
    baseUnit: string
    category?: string | null
    minimumStock?: number | null
  } | null
  conversionFactor?: number | null
  receiveQuantity?: number | null
  receiveIdempotencyKey?: string | null
}

const INTENT_TABLE = 'purchase_document_confirm_intents'

export type StoredConfirmIntent = {
  purchaseDocumentId: string
  organizationId: string
  locationId: string
  actorUserId: string
  confirmIdempotencyKey: string
  lines: IntentLine[]
  payloadDigest: string
}

export type ConfirmRecoveryStatus = 'completed' | 'recoverable' | 'unavailable' | 'forbidden'

function canonicalPart(value: string | number | null | undefined) {
  return value == null ? '' : String(value)
}

/**
 * Texto estable del intento. El SQL propuesto usa los mismos campos y el mismo
 * separador para el digest. No depende del orden de las claves JSON.
 */
export function confirmIntentCanonical(lines: IntentLine[]): string {
  return [...lines]
    .sort((left, right) => left.purchaseDocumentLineId.localeCompare(right.purchaseDocumentLineId))
    .map((line) => [
      canonicalPart(line.purchaseDocumentLineId),
      canonicalPart(line.action),
      canonicalPart(line.inventoryProductId),
      canonicalPart(line.conversionFactor),
      canonicalPart(line.receiveQuantity),
      canonicalPart(line.receiveIdempotencyKey),
      canonicalPart(line.create?.name),
      canonicalPart(line.create?.baseUnit),
      canonicalPart(line.create?.category),
      canonicalPart(line.create?.minimumStock),
    ].join('\t'))
    .join('\n')
}

export function confirmIntentDigest(lines: IntentLine[]): string {
  return createHash('md5').update(confirmIntentCanonical(lines)).digest('hex')
}

export type SaveConfirmIntentLine = {
  sourceLineId: string
  action: string
  inventoryProductId?: string | null
  create?: IntentLine['create']
  conversionFactor?: number | null
  receiveQuantity?: number | null
  receiveIdempotencyKey?: string | null
}

export function mapConfirmIntentSourceLines(
  lines: SaveConfirmIntentLine[],
  storedLines: Array<{ id: string; sourceLineId: string }>,
): IntentLine[] {
  const bySource = new Map(storedLines.map((row) => [row.sourceLineId, row.id]))
  return lines.map((line) => {
    const purchaseDocumentLineId = bySource.get(line.sourceLineId)
    if (!purchaseDocumentLineId) {
      throw new InvoiceQueryError(
        'No hay una línea guardada para el intento de confirmación.',
        'LINES_MISMATCH',
        422,
      )
    }
    return {
      purchaseDocumentLineId,
      action: line.action,
      inventoryProductId: line.inventoryProductId ?? null,
      create: line.create ?? null,
      conversionFactor: line.conversionFactor ?? null,
      receiveQuantity: line.receiveQuantity ?? null,
      receiveIdempotencyKey: line.receiveIdempotencyKey ?? null,
    }
  })
}

export function decideConfirmRecovery(input: {
  documentOrganizationId: string
  documentLocationId: string
  requestedOrganizationId: string
  requestedLocationId: string
  succeeded: boolean
  intent: Pick<StoredConfirmIntent, 'organizationId' | 'locationId' | 'confirmIdempotencyKey'> | null
}): { status: ConfirmRecoveryStatus } {
  if (
    input.requestedOrganizationId !== input.documentOrganizationId
    || input.requestedLocationId !== input.documentLocationId
  ) {
    return { status: 'forbidden' }
  }
  if (
    input.intent
    && (
      input.intent.organizationId !== input.documentOrganizationId
      || input.intent.locationId !== input.documentLocationId
    )
  ) {
    return { status: 'forbidden' }
  }
  if (input.succeeded) return { status: 'completed' }
  if (input.intent) return { status: 'recoverable' }
  return { status: 'unavailable' }
}

export function shouldOfferCompleteSave(status: ConfirmRecoveryStatus | null | undefined) {
  return status === 'recoverable'
}

type IntentRow = {
  purchase_document_id?: string
  organization_id?: string
  location_id?: string
  actor_user_id?: string
  confirm_idempotency_key?: string
  lines?: unknown
  payload_digest?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isMissingIntentTable(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false
  const blob = `${error.code ?? ''} ${error.message ?? ''}`
  return error.code === '42P01'
    || error.code === 'PGRST205'
    || (/purchase_document_confirm_intents/i.test(blob) && /does not exist|schema cache|could not find/i.test(blob))
}

function mapIntent(row: IntentRow): StoredConfirmIntent | null {
  if (!row.purchase_document_id || !row.confirm_idempotency_key || !Array.isArray(row.lines)) return null
  return {
    purchaseDocumentId: String(row.purchase_document_id),
    organizationId: String(row.organization_id ?? ''),
    locationId: String(row.location_id ?? ''),
    actorUserId: String(row.actor_user_id ?? ''),
    confirmIdempotencyKey: String(row.confirm_idempotency_key),
    lines: row.lines as IntentLine[],
    payloadDigest: String(row.payload_digest ?? ''),
  }
}

export type PreparedConfirmIntent = {
  lines: IntentLine[]
  confirmIdempotencyKey: string
  persist: () => Promise<void>
}

export function createSupabaseConfirmIntentStore(adminClient: SupabaseClient) {
  return {
    async prepare(input: {
      purchaseDocumentId: string
      organizationId: string
      locationId: string
      actorUserId: string
      confirmIdempotencyKey: string
      lines: IntentLine[]
    }): Promise<PreparedConfirmIntent> {
      const existing = await readIntent(adminClient, input.purchaseDocumentId)
      if (existing === 'missing_table') {
        return {
          lines: input.lines,
          confirmIdempotencyKey: input.confirmIdempotencyKey,
          persist: async () => undefined,
        }
      }
      if (existing) {
        if (
          existing.confirmIdempotencyKey !== input.confirmIdempotencyKey
          || confirmIntentDigest(existing.lines) !== confirmIntentDigest(input.lines)
        ) {
          throw new InvoiceQueryError(
            'Ya hay un intento de guardado para esta factura. No se reemplaza.',
            'CONFIRM_INTENT_CONFLICT',
            409,
          )
        }
        return {
          lines: existing.lines,
          confirmIdempotencyKey: existing.confirmIdempotencyKey,
          persist: async () => undefined,
        }
      }
      return {
        lines: input.lines,
        confirmIdempotencyKey: input.confirmIdempotencyKey,
        persist: () => insertIntent(adminClient, input),
      }
    },
    load(purchaseDocumentId: string) {
      return readIntent(adminClient, purchaseDocumentId)
    },
    hasSucceededAttempt(purchaseDocumentId: string) {
      return readSucceededAttempt(adminClient, purchaseDocumentId)
    },
  }
}

export type ConfirmIntentStore = ReturnType<typeof createSupabaseConfirmIntentStore>

async function readIntent(
  adminClient: SupabaseClient,
  purchaseDocumentId: string,
): Promise<StoredConfirmIntent | null | 'missing_table'> {
  const { data, error } = await adminClient
    .from(INTENT_TABLE)
    .select('purchase_document_id, organization_id, location_id, actor_user_id, confirm_idempotency_key, lines, payload_digest')
    .eq('purchase_document_id', purchaseDocumentId)
    .maybeSingle()
  if (error) {
    if (isMissingIntentTable(error)) return 'missing_table'
    throw new InvoiceQueryError('No se pudo consultar el intento de guardado.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data)) return null
  return mapIntent(data)
}

async function readSucceededAttempt(adminClient: SupabaseClient, purchaseDocumentId: string) {
  const { data, error } = await adminClient
    .from('purchase_document_confirm_attempts')
    .select('id, status')
    .eq('purchase_document_id', purchaseDocumentId)
    .eq('status', 'succeeded')
    .limit(1)
  if (error) {
    throw new InvoiceQueryError('No se pudo consultar la confirmación.', 'LOOKUP_FAILED', 500)
  }
  return Array.isArray(data) && data.length > 0
}

async function insertIntent(
  adminClient: SupabaseClient,
  input: {
    purchaseDocumentId: string
    organizationId: string
    locationId: string
    actorUserId: string
    confirmIdempotencyKey: string
    lines: IntentLine[]
  },
) {
  const { error } = await adminClient.from(INTENT_TABLE).insert({
    purchase_document_id: input.purchaseDocumentId,
    organization_id: input.organizationId,
    location_id: input.locationId,
    actor_user_id: input.actorUserId,
    confirm_idempotency_key: input.confirmIdempotencyKey,
    lines: input.lines,
    payload_digest: confirmIntentDigest(input.lines),
  })
  if (!error) return
  if (isMissingIntentTable(error)) return
  if (error.code === '23505') {
    const existing = await readIntent(adminClient, input.purchaseDocumentId)
    if (
      existing
      && existing !== 'missing_table'
      && existing.confirmIdempotencyKey === input.confirmIdempotencyKey
      && confirmIntentDigest(existing.lines) === confirmIntentDigest(input.lines)
    ) return
    throw new InvoiceQueryError(
      'Ya hay un intento de guardado para esta factura. No se reemplaza.',
      'CONFIRM_INTENT_CONFLICT',
      409,
    )
  }
  throw new InvoiceQueryError('No se pudo conservar el intento de guardado.', 'INTENT_NOT_STORED', 500)
}

export async function documentHasConfirmIntent(
  adminClient: SupabaseClient,
  purchaseDocumentId: string,
): Promise<boolean> {
  const from = (adminClient as SupabaseClient & { from?: unknown }).from
  if (typeof from !== 'function') return false
  const loaded = await createSupabaseConfirmIntentStore(adminClient).load(purchaseDocumentId)
  return loaded !== 'missing_table' && loaded != null
}

/**
 * Guarda el intento una sola vez, con la organización y la sucursal del comprobante.
 * Si ya existe, no lo actualiza. Otro contenido, otra clave u otra sucursal se rechaza.
 */
export async function persistConfirmIntentForNewDocument(
  adminClient: SupabaseClient,
  input: {
    purchaseDocumentId: string
    organizationId: string
    locationId: string
    actorUserId: string
    confirmIdempotencyKey: string
    lines: IntentLine[]
  },
): Promise<'stored' | 'missing_table'> {
  const store = createSupabaseConfirmIntentStore(adminClient)
  const existing = await store.load(input.purchaseDocumentId)
  if (existing === 'missing_table') return 'missing_table'
  if (existing) {
    const sameIntent = existing.confirmIdempotencyKey === input.confirmIdempotencyKey
      && existing.organizationId === input.organizationId
      && existing.locationId === input.locationId
      && confirmIntentDigest(existing.lines) === confirmIntentDigest(input.lines)
    if (!sameIntent) {
      throw new InvoiceQueryError(
        'Ya hay un intento de guardado para esta factura. No se reemplaza.',
        'CONFIRM_INTENT_CONFLICT',
        409,
      )
    }
    return 'stored'
  }
  const prepared = await store.prepare(input)
  await prepared.persist()
  return 'stored'
}

export async function inspectConfirmRecovery(input: {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  documentId: string
  organizationId: string
  locationId: string
}) {
  const { data, error } = await input.userClient
    .from('purchase_documents')
    .select('id, organization_id, location_id')
    .eq('id', input.documentId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) {
    throw new InvoiceQueryError('No se pudieron consultar las facturas.', 'LOOKUP_FAILED', 500)
  }
  if (!isRecord(data) || !data.id) {
    throw new InvoiceQueryError('No se encontró la factura.', 'NOT_FOUND', 404)
  }
  const documentOrganizationId = String(data.organization_id ?? '')
  const documentLocationId = String(data.location_id ?? '')
  const store = createSupabaseConfirmIntentStore(input.adminClient)
  const intent = await store.load(input.documentId)
  const storedIntent = intent === 'missing_table' ? null : intent
  const succeeded = intent === 'missing_table'
    ? false
    : await store.hasSucceededAttempt(input.documentId)
  const decision = decideConfirmRecovery({
    documentOrganizationId,
    documentLocationId,
    requestedOrganizationId: input.organizationId,
    requestedLocationId: input.locationId,
    succeeded,
    intent: storedIntent,
  })
  if (decision.status === 'forbidden') {
    throw new InvoiceQueryError(
      'La factura no pertenece a esa organización o sucursal.',
      'OUT_OF_SCOPE',
      422,
    )
  }
  return {
    status: decision.status,
    confirmIdempotencyKey: decision.status === 'recoverable' && storedIntent
      ? storedIntent.confirmIdempotencyKey
      : null,
  }
}

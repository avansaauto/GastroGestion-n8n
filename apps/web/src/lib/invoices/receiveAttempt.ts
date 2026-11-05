export type ReceiveAttemptRecord = {
  idempotencyKey: string
  invoiceId: string
  lineId: string
  quantity: number
  status: 'pending' | 'resolved'
}

export type AttemptStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const PREFIX = 'senda-receive-attempt:'
const memory = new Map<string, string>()

export function receiveAttemptKey(invoiceId: string, lineId: string) {
  return `${PREFIX}${invoiceId}:${lineId}`
}

export function defaultAttemptStore(): AttemptStore {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage
  } catch {
    // jsdom o modo privado
  }
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value)
    },
    removeItem: (key) => {
      memory.delete(key)
    },
  }
}

export function createMemoryAttemptStore(initial: Record<string, string> = {}): AttemptStore {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

function parseRecord(raw: string | null): ReceiveAttemptRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ReceiveAttemptRecord>
    if (
      typeof value.idempotencyKey !== 'string'
      || typeof value.invoiceId !== 'string'
      || typeof value.lineId !== 'string'
      || typeof value.quantity !== 'number'
      || (value.status !== 'pending' && value.status !== 'resolved')
    ) {
      return null
    }
    return {
      idempotencyKey: value.idempotencyKey,
      invoiceId: value.invoiceId,
      lineId: value.lineId,
      quantity: value.quantity,
      status: value.status,
    }
  } catch {
    return null
  }
}

export function readReceiveAttempt(
  invoiceId: string,
  lineId: string,
  store: AttemptStore = defaultAttemptStore(),
): ReceiveAttemptRecord | null {
  const record = parseRecord(store.getItem(receiveAttemptKey(invoiceId, lineId)))
  if (!record) return null
  if (record.invoiceId !== invoiceId || record.lineId !== lineId) return null
  return record
}

export function writeReceiveAttempt(record: ReceiveAttemptRecord, store: AttemptStore = defaultAttemptStore()) {
  store.setItem(receiveAttemptKey(record.invoiceId, record.lineId), JSON.stringify(record))
}

export function clearReceiveAttempt(
  invoiceId: string,
  lineId: string,
  store: AttemptStore = defaultAttemptStore(),
) {
  store.removeItem(receiveAttemptKey(invoiceId, lineId))
}

export function prepareReceiveAttempt(input: {
  invoiceId: string
  lineId: string
  quantity: number
  createKey?: () => string
  store?: AttemptStore
}):
  | { ok: true; attempt: ReceiveAttemptRecord; reused: boolean }
  | { ok: false; reason: 'pending_different_quantity'; attempt: ReceiveAttemptRecord } {
  const store = input.store ?? defaultAttemptStore()
  const existing = readReceiveAttempt(input.invoiceId, input.lineId, store)
  if (existing?.status === 'pending') {
    if (existing.quantity === input.quantity) {
      return { ok: true, attempt: existing, reused: true }
    }
    return { ok: false, reason: 'pending_different_quantity', attempt: existing }
  }
  const attempt: ReceiveAttemptRecord = {
    idempotencyKey: input.createKey?.() ?? globalThis.crypto.randomUUID(),
    invoiceId: input.invoiceId,
    lineId: input.lineId,
    quantity: input.quantity,
    status: 'pending',
  }
  writeReceiveAttempt(attempt, store)
  return { ok: true, attempt, reused: false }
}

export function markReceiveAttemptResolved(
  invoiceId: string,
  lineId: string,
  store: AttemptStore = defaultAttemptStore(),
) {
  const existing = readReceiveAttempt(invoiceId, lineId, store)
  if (!existing) return
  writeReceiveAttempt({ ...existing, status: 'resolved' }, store)
}

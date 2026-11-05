export type InventoryWriteKind =
  | 'denied'
  | 'duplicate'
  | 'invalid'
  | 'empty_representation'
  | 'failed'

export type InventoryWriteDiagnosis = {
  kind: InventoryWriteKind
  postgresCode: string | null
  message: string | null
  details: string | null
  hint: string | null
}

export function redactInventoryDiagnostic(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b(service_role|apikey|anon key)\b/gi, '[redacted]')
}

function missingInsertedRow(data: unknown): boolean {
  if (data == null) return true
  if (Array.isArray(data)) {
    const row = data[0]
    return !row || typeof row !== 'object' || !('id' in row) || !(row as { id?: unknown }).id
  }
  return typeof data !== 'object' || !(data as { id?: unknown }).id
}

export function classifyInventoryWriteError(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
  data: unknown,
): InventoryWriteDiagnosis {
  const postgresCode = error?.code ?? null
  const blob = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`
  const diagnosis: InventoryWriteDiagnosis = {
    kind: 'failed',
    postgresCode,
    message: redactInventoryDiagnostic(error?.message),
    details: redactInventoryDiagnostic(error?.details),
    hint: redactInventoryDiagnostic(error?.hint),
  }

  if (/42501|permission denied|row-level security|rls|violates row-level security/i.test(blob)) {
    return { ...diagnosis, kind: 'denied' }
  }
  if (postgresCode === '23505' || /duplicate key|unique constraint/i.test(blob)) {
    return { ...diagnosis, kind: 'duplicate' }
  }
  if (
    postgresCode === '23514'
    || postgresCode === '23502'
    || postgresCode === '22P02'
    || postgresCode === '23503'
    || /check constraint|not-null|invalid input/i.test(blob)
  ) {
    return { ...diagnosis, kind: 'invalid' }
  }
  if (
    postgresCode === 'PGRST116'
    || /contains 0 rows|cannot coerce/i.test(blob)
    || (!error && missingInsertedRow(data))
  ) {
    return { ...diagnosis, kind: 'empty_representation' }
  }
  return diagnosis
}

export function logInventoryWriteFailure(input: {
  operation?: string
  organizationId: string
  baseUnit: string
  hasRow: boolean
  recovered: boolean
  diagnosis: InventoryWriteDiagnosis
}) {
  console.error(JSON.stringify({
    operation: input.operation ?? 'inventory_products.insert',
    organizationId: input.organizationId,
    baseUnit: input.baseUnit,
    hasRow: input.hasRow,
    recovered: input.recovered,
    kind: input.diagnosis.kind,
    postgresCode: input.diagnosis.postgresCode,
    message: input.diagnosis.message,
    details: input.diagnosis.details,
    hint: input.diagnosis.hint,
  }))
}

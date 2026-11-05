export class InventoryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'InventoryError'
  }
}

export function isInventoryInsertDenied(error: { code?: string; message?: string } | null): boolean {
  const blob = `${error?.code ?? ''} ${error?.message ?? ''}`
  return /42501|permission denied|row-level security|rls|violates row-level security/i.test(blob)
}

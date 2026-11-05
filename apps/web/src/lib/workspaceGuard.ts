export type WorkspaceGuardKind = 'idle' | 'blocked' | 'dirty'

export type WorkspaceGuardReport = {
  kind: WorkspaceGuardKind
  message: string
}

export const IDLE_WORKSPACE_GUARD: WorkspaceGuardReport = {
  kind: 'idle',
  message: '',
}

export function resolveWorkspaceGuards(reports: WorkspaceGuardReport[]): WorkspaceGuardReport {
  const blocked = reports.find((report) => report.kind === 'blocked')
  if (blocked) return blocked
  const dirty = reports.find((report) => report.kind === 'dirty')
  if (dirty) return dirty
  return IDLE_WORKSPACE_GUARD
}

export function invoiceHasActiveOperation(input: {
  hasFile: boolean
  status: string
  saveStatus: string
}) {
  return Boolean(input.hasFile)
    || input.status === 'analyzing'
    || input.status === 'review'
    || input.status === 'failed'
    || input.saveStatus === 'saving'
    || input.saveStatus === 'failed'
    || input.saveStatus === 'saved'
}

export function invoiceSaveLocationId(
  pinnedLocationId: string,
  globalLocationId: string,
  hasActiveOperation: boolean,
) {
  if (hasActiveOperation && pinnedLocationId.trim()) return pinnedLocationId
  return globalLocationId
}

export function invoiceWorkspaceGuard(input: {
  hasFile: boolean
  status: string
  saveStatus: string
}): WorkspaceGuardReport {
  if (input.status === 'analyzing') {
    return {
      kind: 'blocked',
      message: 'SENDA está analizando el documento. Esperá a que termine antes de cambiar de local.',
    }
  }
  if (input.saveStatus === 'saving') {
    return {
      kind: 'blocked',
      message: 'La factura se está guardando. Esperá a que termine antes de cambiar de local.',
    }
  }
  if (invoiceHasActiveOperation(input)) {
    return {
      kind: 'dirty',
      message: 'Hay una factura en curso. Si cambiás de local, se descarta el archivo y la revisión de este local.',
    }
  }
  return IDLE_WORKSPACE_GUARD
}

export function pendingReceptionsWorkspaceGuard(input: {
  sending: boolean
  receivingOpen: boolean
}): WorkspaceGuardReport {
  if (input.sending) {
    return {
      kind: 'blocked',
      message: 'Hay una recepción en curso. Esperá a que termine antes de cambiar de local.',
    }
  }
  if (input.receivingOpen) {
    return {
      kind: 'dirty',
      message: 'Hay un formulario de recepción abierto. Si cambiás de local, se cierra sin confirmar.',
    }
  }
  return IDLE_WORKSPACE_GUARD
}

export function inventoryWorkspaceGuard(input: {
  creating: boolean
  open: boolean
  name: string
  costing?: boolean
  costOpen?: boolean
}): WorkspaceGuardReport {
  if (input.creating || input.costing) {
    return {
      kind: 'blocked',
      message: input.costing
        ? 'Hay un costo de compra guardándose. Esperá a que termine antes de cambiar de local.'
        : 'Hay un insumo creándose. Esperá a que termine antes de cambiar de local.',
    }
  }
  if (input.open) {
    return {
      kind: 'dirty',
      message: input.name.trim()
        ? 'Hay un formulario de insumo sin guardar. Si cambiás de local, se descarta.'
        : 'Hay un formulario de insumo abierto. Si cambiás de local, se cierra.',
    }
  }
  if (input.costOpen) {
    return {
      kind: 'dirty',
      message: 'Hay un costo de compra sin guardar. Si cambiás de local, se descarta.',
    }
  }
  return IDLE_WORKSPACE_GUARD
}

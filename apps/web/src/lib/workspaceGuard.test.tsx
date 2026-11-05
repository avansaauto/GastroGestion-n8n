import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkspaceSwitchPrompt } from '@/components/layout/Header'
import {
  IDLE_WORKSPACE_GUARD,
  invoiceHasActiveOperation,
  invoiceSaveLocationId,
  invoiceWorkspaceGuard,
  inventoryWorkspaceGuard,
  pendingReceptionsWorkspaceGuard,
  resolveWorkspaceGuards,
} from './workspaceGuard'

describe('protección de operaciones al cambiar de local', () => {
  it('permite cambiar de local antes de comenzar una factura', () => {
    expect(invoiceWorkspaceGuard({
      hasFile: false,
      status: 'idle',
      saveStatus: 'idle',
    })).toEqual(IDLE_WORKSPACE_GUARD)
    expect(invoiceSaveLocationId('', 'loc-b', false)).toBe('loc-b')
  })

  it('fija el local activo al comenzar y no reasigna el guardado', () => {
    expect(invoiceHasActiveOperation({
      hasFile: true,
      status: 'idle',
      saveStatus: 'idle',
    })).toBe(true)
    expect(invoiceSaveLocationId('loc-a', 'loc-b', true)).toBe('loc-a')
    expect(invoiceSaveLocationId('loc-a', 'loc-b', false)).toBe('loc-b')
  })

  it('bloquea el cambio durante un análisis', () => {
    const report = invoiceWorkspaceGuard({
      hasFile: true,
      status: 'analyzing',
      saveStatus: 'idle',
    })
    expect(report.kind).toBe('blocked')
    expect(report.message).toMatch(/analizando/)
  })

  it('pide confirmación si hay una revisión sin guardar', () => {
    const report = invoiceWorkspaceGuard({
      hasFile: true,
      status: 'review',
      saveStatus: 'idle',
    })
    expect(report.kind).toBe('dirty')
    expect(report.message).toMatch(/descarta/)
  })

  it('bloquea el cambio durante un guardado', () => {
    expect(invoiceWorkspaceGuard({
      hasFile: true,
      status: 'review',
      saveStatus: 'saving',
    }).kind).toBe('blocked')
  })

  it('bloquea una recepción en curso y confirma un formulario abierto', () => {
    expect(pendingReceptionsWorkspaceGuard({ sending: true, receivingOpen: true }).kind).toBe('blocked')
    expect(pendingReceptionsWorkspaceGuard({ sending: false, receivingOpen: true }).kind).toBe('dirty')
    expect(pendingReceptionsWorkspaceGuard({ sending: false, receivingOpen: false })).toEqual(IDLE_WORKSPACE_GUARD)
  })

  it('prioriza el bloqueo sobre cambios sin guardar', () => {
    const report = resolveWorkspaceGuards([
      invoiceWorkspaceGuard({ hasFile: true, status: 'review', saveStatus: 'idle' }),
      pendingReceptionsWorkspaceGuard({ sending: true, receivingOpen: true }),
    ])
    expect(report.kind).toBe('blocked')
    expect(report.message).toMatch(/recepción en curso/)
  })

  it('protege el alta de insumo abierta o en envío', () => {
    expect(inventoryWorkspaceGuard({ creating: true, open: true, name: 'Tomate' }).kind).toBe('blocked')
    expect(inventoryWorkspaceGuard({ creating: false, open: true, name: 'Tomate' }).kind).toBe('dirty')
    expect(inventoryWorkspaceGuard({ creating: false, open: false, name: '', costing: true }).kind).toBe('blocked')
    expect(inventoryWorkspaceGuard({ creating: false, open: false, name: '', costOpen: true }).kind).toBe('dirty')
    expect(inventoryWorkspaceGuard({ creating: false, open: false, name: '' })).toEqual(IDLE_WORKSPACE_GUARD)
  })

  it('muestra bloqueo sin confirmar y dirty con cancelar o descartar', () => {
    const blocked = renderToString(
      <WorkspaceSwitchPrompt
        prompt={{
          kind: 'blocked',
          title: 'No se puede cambiar ahora',
          message: 'SENDA está analizando el documento. Esperá a que termine antes de cambiar de local.',
          next: null,
        }}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(blocked).toContain('No se puede cambiar ahora')
    expect(blocked).toContain('Entendido')
    expect(blocked).not.toContain('Descartar y cambiar')

    const dirty = renderToString(
      <WorkspaceSwitchPrompt
        prompt={{
          kind: 'dirty',
          title: '¿Cambiar de local?',
          message: 'Hay una factura en curso. Si cambiás de local, se descarta el archivo y la revisión de este local.',
          next: { type: 'location', id: 'loc-b' },
        }}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(dirty).toContain('¿Cambiar de local?')
    expect(dirty).toContain('Cancelar')
    expect(dirty).toContain('Descartar y cambiar')

    const orgChange = renderToString(
      <WorkspaceSwitchPrompt
        prompt={{
          kind: 'dirty',
          title: '¿Cambiar de organización?',
          message: 'Hay una factura en curso. Si cambiás de local, se descarta el archivo y la revisión de este local.',
          next: { type: 'org', href: '/entrar?cambiar=organizacion' },
        }}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(orgChange).toContain('¿Cambiar de organización?')
    expect(orgChange).toContain('Cancelar')
  })
})

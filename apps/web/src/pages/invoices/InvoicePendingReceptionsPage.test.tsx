import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/lib/auth'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import type { Location } from '@/lib/api'
import type { PendingReceptionLine } from '@/lib/invoices/types'
import {
  InvoicePendingReceivePanel,
  InvoicePendingReceptionsPage,
  InvoicePendingReceptionsView,
} from './InvoicePendingReceptionsPage'

const LOCATIONS: Location[] = [
  { id: 'loc-a', organization_id: 'org-1', name: 'Casa Central' },
  { id: 'loc-b', organization_id: 'org-1', name: 'Sucursal Norte' },
]

function pendingLine(overrides: Partial<PendingReceptionLine> = {}): PendingReceptionLine {
  return {
    invoiceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    lineId: '11111111-1111-4111-8111-111111111111',
    supplierName: 'LUPULO SRL',
    documentNumber: '0001-00006046',
    documentDate: '2026-10-01',
    locationId: 'loc-a',
    ingredientId: 'prod-1',
    ingredientName: 'Cerveza Pilsen',
    baseUnit: 'ml',
    invoicedQuantity: 100000,
    receivedQuantity: 50000,
    remainingQuantity: 50000,
    ...overrides,
  }
}

function renderView(overrides: Partial<Parameters<typeof InvoicePendingReceptionsView>[0]> = {}) {
  return renderToString(
    <MemoryRouter>
      <InvoicePendingReceptionsView
        error=""
        items={[]}
        loading={false}
        loadingMore={false}
        locationId="loc-a"
        locations={LOCATIONS}
        nextCursor={null}
        selectedLocationLabel="Casa Central"
        onLoadMore={() => undefined}
        onRetry={() => undefined}
        {...overrides}
      />
    </MemoryRouter>,
  )
}

describe('Recepciones pendientes', () => {
  it('muestra cantidades comerciales L, kg y u sin alterar los valores físicos', () => {
    const html = renderView({
      items: [
        pendingLine(),
        pendingLine({
          lineId: '22222222-2222-4222-8222-222222222222',
          ingredientName: 'Harina 000',
          baseUnit: 'g',
          invoicedQuantity: 50000,
          receivedQuantity: 20000,
          remainingQuantity: 30000,
        }),
        pendingLine({
          lineId: '33333333-3333-4333-8333-333333333333',
          ingredientName: 'Huevos',
          baseUnit: 'unit',
          invoicedQuantity: 12,
          receivedQuantity: 4,
          remainingQuantity: 8,
        }),
      ],
    })
    expect(html).toContain('100 L')
    expect(html).toContain('50 L')
    expect(html).toContain('50 kg')
    expect(html).toContain('20 kg')
    expect(html).toContain('30 kg')
    expect(html).toContain('12 u')
    expect(html).toContain('4 u')
    expect(html).toContain('8 u')
    expect(html).not.toContain('100000')
    expect(html).not.toContain('50000')
    expect(html).toContain('Recibir')
    expect(html).toContain('Ver factura')
    expect(html).not.toContain('IVA')
    expect(html).not.toContain('Ajuste')
  })

  it('filtra por local accesible y muestra el local seleccionado', () => {
    const html = renderView({
      items: [pendingLine()],
    })
    expect(html).toContain('Casa Central')
    expect(html).toContain('Consultando pendientes de Casa Central.')
    expect(html).not.toContain('Sucursal Norte')
    expect(html).not.toContain('>Organización<')
    expect(html).not.toContain('value="loc-a"')
    expect(html).toContain('Cerveza Pilsen')
    expect(html).not.toContain('Harina sucursal')
  })

  it('navega a la factura desde Ver factura', () => {
    const html = renderView({
      items: [pendingLine({ invoiceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })],
    })
    expect(html).toContain('/facturas/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(html).toContain('Ver factura')
    expect(html).not.toContain('/facturas/recepciones-pendientes/')
  })

  it('permite cargar más cuando hay nextCursor', () => {
    const html = renderView({
      items: [pendingLine()],
      nextCursor: '11111111-1111-4111-8111-111111111111',
    })
    expect(html).toContain('Cargar más')
  })

  it('no trata una página parcial como final si existe nextCursor', () => {
    const html = renderView({
      items: [
        pendingLine({ lineId: 'line-1' }),
        pendingLine({ lineId: 'line-2', ingredientName: 'Golden Ale' }),
      ],
      nextCursor: 'line-2',
    })
    expect(html).toContain('Cerveza Pilsen')
    expect(html).toContain('Golden Ale')
    expect(html).toContain('Cargar más')
  })

  it('muestra el vacío del local seleccionado', () => {
    const html = renderView({ items: [], nextCursor: null })
    expect(html).toContain('No hay mercadería pendiente de recibir en este local.')
    expect(html).not.toContain('Cargar más')
    expect(html).not.toContain('Cerveza Pilsen')
  })

  it('muestra error y reintento', () => {
    const html = renderView({
      error: 'No se pudieron consultar las recepciones pendientes.',
      items: [],
    })
    expect(html).toContain('No se pudieron consultar las recepciones pendientes.')
    expect(html).toContain('Reintentar')
    expect(html).not.toContain('No hay mercadería pendiente de recibir en este local.')
  })

  it('pide seleccionar un local antes de consultar', () => {
    const html = renderView({
      locationId: '',
      selectedLocationLabel: '',
      items: [pendingLine()],
    })
    expect(html).toContain('No hay un local activo para consultar recepciones pendientes.')
    expect(html).toContain('No hay un local activo.')
    expect(html).not.toContain('Cerveza Pilsen')
    expect(html).not.toContain('Cargar más')
  })

  it('aísla los datos al cambiar de local', () => {
    const locA = renderView({
      locationId: 'loc-a',
      selectedLocationLabel: 'Casa Central',
      items: [pendingLine({ ingredientName: 'Pilsen Casa Central', locationId: 'loc-a' })],
    })
    const locB = renderView({
      locationId: 'loc-b',
      selectedLocationLabel: 'Sucursal Norte',
      items: [pendingLine({
        lineId: 'line-b',
        ingredientName: 'Harina Sucursal Norte',
        locationId: 'loc-b',
      })],
    })
    expect(locA).toContain('Consultando pendientes de Casa Central.')
    expect(locA).toContain('Pilsen Casa Central')
    expect(locA).not.toContain('Harina Sucursal Norte')
    expect(locB).toContain('Consultando pendientes de Sucursal Norte.')
    expect(locB).toContain('Harina Sucursal Norte')
    expect(locB).not.toContain('Pilsen Casa Central')
  })

  it('muestra carga y no adelanta un botón de recepción', () => {
    const html = renderView({ loading: true, items: [] })
    expect(html).toContain('Cargando recepciones pendientes…')
    expect(html).not.toContain('Recibir')
    expect(html).not.toContain('Confirmar recepción')
  })

  it('en vista previa no consulta recepciones', () => {
    const html = renderView({
      previewMode: true,
      locationId: '',
      selectedLocationLabel: '',
      items: [],
    })
    expect(html).toContain('vista previa no se consultan recepciones pendientes')
    expect(html).not.toContain('Cerveza Pilsen')
    expect(html).not.toContain('Confirmar recepción')
  })

  it('no adelanta un botón de recepción en la pantalla conectada', () => {
    const html = renderToString(
      <MemoryRouter>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <InvoicePendingReceptionsPage />
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('Recepciones pendientes')
    expect(html).not.toContain('Confirmar recepción')
    expect(html).not.toContain('>Recibir<')
  })

  it('abre Recibir con el formulario existente y conserva Ver factura', () => {
    const html = renderView({
      items: [pendingLine()],
      receivingRow: pendingLine(),
    })
    expect(html).toContain('Recibir')
    expect(html).toContain('Ver factura')
    expect(html).toContain('/facturas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Recibir mercadería')
    expect(html).toContain('Proveedor')
    expect(html).toContain('LUPULO SRL')
    expect(html).toContain('0001-00006046')
    expect(html).toContain('Cerveza Pilsen')
    expect(html).toContain('Local de destino')
    expect(html).toContain('Casa Central')
    expect(html).toContain('Cantidad a recibir')
    expect(html).toContain('Confirmar recepción')
    expect(html).toContain('Actualizar cantidades')
    expect(html).toContain('100 L')
    expect(html).toContain('50 L')
    expect(html).not.toContain('100000')
  })

  it('usa el local de la factura como destino, no el local activo de la UI', () => {
    const html = renderView({
      items: [pendingLine({ locationId: 'loc-a' })],
      receivingRow: pendingLine({ locationId: 'loc-a' }),
      locationId: 'loc-b',
      selectedLocationLabel: 'Sucursal Norte',
    })
    expect(html).toContain('Consultando pendientes de Sucursal Norte.')
    expect(html).toContain('Local de destino')
    expect(html).toContain('Casa Central')
    expect(html).toContain('El local del encabezado no cambia el destino de una factura ya guardada.')
  })

  it('muestra kg y bloquea el envío mientras está en curso', () => {
    const kg = pendingLine({
      ingredientName: 'Harina 000',
      baseUnit: 'g',
      invoicedQuantity: 50000,
      receivedQuantity: 0,
      remainingQuantity: 50000,
    })
    const panel = renderToString(
      <MemoryRouter>
        <InvoicePendingReceivePanel
          destinationLabel="Casa Central"
          row={kg}
          sending
          onReceived={() => undefined}
          onRefresh={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(panel).toContain('50 kg')
    expect(panel).toContain('Harina 000')
    expect(panel).toContain('Enviando…')
    expect(panel).toContain('disabled=""')
    expect(panel).not.toContain('Confirmar recepción')
    expect(panel).not.toContain('50000')
  })
})

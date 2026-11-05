import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/lib/auth'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import { InvoiceNewPage } from './InvoiceNewPage'
import { InvoiceDeleteConfirm, InvoiceListView, INVOICE_REGISTERED_BANNER, InvoicesPage } from './InvoicesPage'
import {
  INVOICE_BULK_DELETE_LABEL,
  INVOICE_DELETE_CONFIRM,
  INVOICE_SELECT_ALL_VISIBLE_HINT,
} from '@/lib/invoices/invoiceDeleteState'
import { InvoiceMappingForm } from './InvoiceMappingSection'
import { InvoiceReceiveForm } from './InvoiceReceiveSection'
import { InvoiceMappingPicker } from './InvoiceMappingPicker'
import { InvoiceDuplicateNotice } from './InvoiceDuplicateNotice'
import { InvoiceReview } from './InvoiceReview'
import { baseInvoiceResult, bonusInvoiceResult, confirmedBonusInvoiceResult, savedInvoiceResult, serviceInvoiceConsistentResult, serviceInvoiceResult } from '@/lib/invoices/fixtures'
import { createMemoryAttemptStore, prepareReceiveAttempt } from '@/lib/invoices/receiveAttempt'
import { applyInvoiceReceiveResult } from '@/lib/invoices/invoiceReceiveState'
import { LINE_ASSOCIATION_MISSING } from '@/lib/invoices/mapping'
import type { ReviewMappingDraft } from '@/lib/invoices/reviewMapping'
import type { InvoiceAnalysisLine, InvoiceDetail, InvoiceListItem, InvoiceStoredLine } from '@/lib/invoices/types'

function reviewDraft(inventoryProductId: string): ReviewMappingDraft {
  return { inventoryProductId, approximateAccepted: false } as ReviewMappingDraft
}

describe('pantallas de facturas', () => {
  it('muestra el vacío real sin historial simulado', () => {
    const html = renderToString(
      <MemoryRouter>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <InvoicesPage />
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('Facturas')
    expect(html).toContain('Nueva factura')
    expect(html).not.toContain('Recepciones pendientes')
    expect(html).not.toContain('/facturas/recepciones-pendientes')
    expect(html).toContain('Podés eliminar facturas; si ya ingresaron stock')
    expect(html.includes('Todavía no hay facturas registradas') || html.includes('Cargando facturas')).toBe(true)
    expect(html).not.toContain(INVOICE_REGISTERED_BANNER)
    expect(html).not.toContain('MetroGAS')
    expect(html).not.toContain('Actualizar stock')
    expect(html).not.toContain('>Organización<')
    expect(html).not.toContain('>Local<')
    expect(html).toContain('/facturas/nueva')
  })

  it('confirma el alta al volver al listado', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={[{ pathname: '/facturas', state: { invoiceRegistered: true } }]}>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <InvoicesPage />
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain(INVOICE_REGISTERED_BANNER)
    expect(html).toContain('/facturas/nueva')
  })

  it('muestra filtros, badges de workflow y conserva la navegación al detalle', () => {
    const invoices: InvoiceListItem[] = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        supplierName: 'LUPULO SRL',
        documentDate: '2026-10-01',
        documentNumber: '0001-00006046',
        documentType: 'invoice',
        status: 'reviewed',
        currency: 'ARS',
        total: 1500.5,
        locationId: 'loc-1',
        organizationId: 'org-1',
        pendingConfiguration: true,
        pendingReceive: true,
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        supplierName: 'CARNES DEL SUR',
        documentDate: '2026-10-02',
        documentNumber: '0001-00006047',
        documentType: 'invoice',
        status: 'received',
        currency: 'ARS',
        total: 800,
        locationId: 'loc-1',
        organizationId: 'org-1',
        pendingConfiguration: false,
        pendingReceive: false,
      },
    ]
    const html = renderToString(
      <MemoryRouter>
        <InvoiceListView
          filter="all"
          invoices={invoices}
          search=""
          onFilter={() => undefined}
          onSearch={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('Todas (2)')
    expect(html).toContain('Por vincular (1)')
    expect(html).toContain('Por recibir (1)')
    expect(html).toContain('Recibidas (1)')
    expect(html).toContain('Revisada')
    expect(html).toContain('Recibida')
    expect(html).toContain('Pendiente de configuración')
    expect(html).toContain('Pendiente de recibir')
    expect(html).toContain('bg-orange-50')
    expect(html).toContain('bg-emerald-50')
    expect(html).toContain('/facturas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(html).toContain('Ver detalle')
    expect(html).toContain('LUPULO SRL')
    expect(html).toContain('Proveedor')
    expect(html).toContain('aria-label="Seleccionar todas las facturas visibles"')
    expect(html).toContain('aria-label="Eliminar LUPULO SRL"')
    expect(html).not.toContain(INVOICE_BULK_DELETE_LABEL)
    expect(html).not.toContain(INVOICE_SELECT_ALL_VISIBLE_HINT)
    expect(html).not.toContain('Actualizar stock')

    const withSelection = renderToString(
      <MemoryRouter>
        <InvoiceListView
          filter="all"
          invoices={invoices}
          search=""
          selectedIds={['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']}
          onFilter={() => undefined}
          onSearch={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(withSelection).toContain(INVOICE_SELECT_ALL_VISIBLE_HINT)
    expect(withSelection).toContain(INVOICE_BULK_DELETE_LABEL)

    const filtered = renderToString(
      <MemoryRouter>
        <InvoiceListView
          filter="to_map"
          invoices={invoices}
          search=""
          onFilter={() => undefined}
          onSearch={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(filtered).toContain('LUPULO SRL')
    expect(filtered).not.toContain('CARNES DEL SUR')
  })

  it('confirma eliminación de revisadas y recibidas (con reversión de stock)', () => {
    const lupulo: InvoiceListItem = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      supplierName: 'LUPULO SRL',
      documentDate: '2026-10-01',
      documentNumber: '0001-00006046',
      documentType: 'invoice',
      status: 'reviewed',
      currency: 'ARS',
      total: 1500.5,
      locationId: 'loc-1',
      organizationId: 'org-1',
      pendingConfiguration: true,
      pendingReceive: true,
      hasReceipts: false,
    }
    const carnes: InvoiceListItem = {
      ...lupulo,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      supplierName: 'CARNES DEL SUR',
      documentNumber: '0001-00006047',
      status: 'received',
      pendingConfiguration: false,
      pendingReceive: false,
      hasReceipts: true,
    }
    const selected = renderToString(
      <MemoryRouter>
        <InvoiceListView
          filter="all"
          invoices={[lupulo, carnes]}
          search=""
          selectedIds={[lupulo.id, carnes.id]}
          onFilter={() => undefined}
          onSearch={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(selected).toContain('2 facturas visibles seleccionadas')
    expect(selected).toContain(INVOICE_BULK_DELETE_LABEL)

    const confirm = renderToString(
      <InvoiceDeleteConfirm
        dialog={{
          items: [lupulo, carnes],
          classifications: [
            { id: lupulo.id, label: 'LUPULO SRL', canDelete: true, reason: null },
            { id: carnes.id, label: 'CARNES DEL SUR', canDelete: true, reason: null },
          ],
          submitting: false,
          error: '',
          outcomes: null,
        }}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(confirm).toContain('LUPULO SRL')
    expect(confirm).toContain('CARNES DEL SUR')
    expect(confirm).toContain('¿Eliminar 2 facturas?')
    expect(confirm).toContain('revertirá el stock')
    expect(confirm).toContain('Cancelar')
    expect(INVOICE_DELETE_CONFIRM).toMatch(/¿Eliminar esta factura\?/)

    const deleted = renderToString(
      <InvoiceDeleteConfirm
        dialog={{
          items: [lupulo, carnes],
          classifications: [
            { id: lupulo.id, label: 'LUPULO SRL', canDelete: true, reason: null },
            { id: carnes.id, label: 'CARNES DEL SUR', canDelete: true, reason: null },
          ],
          submitting: false,
          error: '',
          outcomes: [
            { id: lupulo.id, label: 'LUPULO SRL', result: 'deleted' },
            { id: carnes.id, label: 'CARNES DEL SUR', result: 'deleted' },
          ],
        }}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(deleted).toContain('2 eliminadas, 0 sin cambios')
    expect(deleted).toContain('Cerrar')
  })

  it('ofrece la carga de un comprobante', () => {
    const html = renderToString(
      <MemoryRouter>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <InvoiceNewPage />
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('Analizar factura')
    expect(html).toContain('Arrastrá un comprobante')
    expect(html).toContain('máximo 10 MB')
    expect(html).not.toContain('El selector no autoriza por sí solo')
    expect(html).not.toContain('>Organización<')
    expect(html).not.toContain('label="Local"')
    expect(html).not.toContain('Comprobando factura…')
    expect(html).not.toContain('Factura ya registrada')
  })

  it('muestra el aviso de duplicado dentro de la carga, sin modal', () => {
    const checking = renderToString(
      <MemoryRouter>
        <InvoiceDuplicateNotice duplicate={{
          status: 'checking',
          match: null,
          warning: null,
          source: null,
          contextKey: 'loc::file',
        }} />
      </MemoryRouter>,
    )
    expect(checking).toContain('Comprobando factura…')
    expect(checking).not.toContain('role="dialog"')

    const matched = renderToString(
      <MemoryRouter>
        <InvoiceDuplicateNotice duplicate={{
          status: 'matched',
          match: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            supplierName: 'LUPULO SRL',
            documentNumber: '00007-00006046',
            documentDate: '2026-10-01',
            status: 'reviewed',
            locationId: 'loc-1',
          },
          warning: null,
          source: 'hash',
          contextKey: 'loc::file',
        }} />
      </MemoryRouter>,
    )
    expect(matched).toContain('Factura ya registrada')
    expect(matched).toContain('LUPULO SRL')
    expect(matched).toContain('00007-00006046')
    expect(matched).toContain('01/10/2026')
    expect(matched).toContain('/facturas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(matched).toContain('Abrir factura registrada')
    expect(matched).not.toContain('role="dialog"')

    const failed = renderToString(
      <InvoiceDuplicateNotice duplicate={{
        status: 'failed',
        match: null,
        warning: 'No se pudo comprobar si esta factura ya existe',
        source: null,
        contextKey: 'loc::file',
      }} />,
    )
    expect(failed).toContain('No se pudo comprobar si esta factura ya existe')
  })

  it('renderiza mercadería y bonificación pendiente', () => {
    const html = renderToString(
      <InvoiceReview
        localDecisions={{}}
        result={bonusInvoiceResult}
        onDecide={() => undefined}
        save={{
          canSave: false,
          saving: false,
          saved: null,
          error: null,
          blockedReason: 'Confirmá o rechazá la bonificación de PILSEN antes de guardar.',
          acceptFiscalInconsistency: false,
          onAcceptFiscal: () => undefined,
          onSave: () => undefined,
        }}
      />,
    )
    expect(html).toContain('PILSEN')
    expect(html).toContain('50 L facturados')
    expect(html).toContain('bonificación del 100%')
    expect(html).toContain('Importe bruto')
    expect(html).toContain('Neto comercial')
    expect(html).toContain('Confirmar')
    expect(html).toContain('Guardar')
    expect(html).toContain('Cancelar')
    expect(html).toContain('Confirmá o rechazá la bonificación de PILSEN antes de guardar.')
    expect(html).toContain('Ajustes comerciales')
    expect(html).not.toContain('recibiste')
    expect(html).not.toContain('temporal')
    expect(html).not.toContain('value="50"')
  })

  it('muestra recibido e insumo de Pilsen al confirmar la bonificación', () => {
    const html = renderToString(
      <InvoiceReview
        localDecisions={{ 'relation-line-bonus': 'confirm' }}
        result={confirmedBonusInvoiceResult}
        onDecide={() => undefined}
        onReceivedChange={() => undefined}
      />,
    )
    expect(html).toContain('Recibido')
    expect(html).toContain('value="50"')
    expect(html).toContain('inputMode="decimal"')
    expect(html).toContain('confirmada')
    expect(html).toContain('82.500,00')
    expect(html).toContain('Neto comercial')
  })

  it('muestra Recibido inicial, pendiente y errores sin tocar impuestos', () => {
    const result = {
      ...confirmedBonusInvoiceResult,
      document: {
        ...confirmedBonusInvoiceResult.document,
        lines: [
          {
            ...confirmedBonusInvoiceResult.document.lines[0]!,
            quantity: 2,
            amount: 3300,
            inventoryPhysicalQuantity: 2,
            inventoryEligibility: 'eligible' as const,
          },
          confirmedBonusInvoiceResult.document.lines[1]!,
          {
            id: 'line-iva',
            sourceIndex: 2,
            originalDescription: 'IVA 21%',
            name: 'IVA 21%',
            supplierSku: null,
            quantity: null,
            unit: null,
            unitPrice: null,
            amount: 693,
            classification: 'fiscal' as const,
            inventoryEligibility: 'ineligible' as const,
            quantityKind: 'none' as const,
            inventoryPhysicalQuantity: 0,
            missingFields: [],
            ambiguities: [],
          },
        ],
      },
    }
    const initial = renderToString(
      <InvoiceReview
        localDecisions={{}}
        receivedDrafts={{ 'line-pilsen': '2' }}
        result={result}
        onDecide={() => undefined}
        onReceivedChange={() => undefined}
      />,
    )
    expect(initial).toContain('Recibido')
    expect(initial).toContain('value="2"')
    expect(initial).not.toContain('Pendiente')
    expect(initial).toContain('IVA 21%')

    const partial = renderToString(
      <InvoiceReview
        localDecisions={{}}
        receivedDrafts={{ 'line-pilsen': '0,8' }}
        result={result}
        onDecide={() => undefined}
        onReceivedChange={() => undefined}
      />,
    )
    expect(partial).toContain('value="0,8"')
    expect(partial).toContain('Pendiente: 1,2 L')
    expect(partial).toContain('1.650,00')
    expect(partial).toContain('3.300,00')

    const none = renderToString(
      <InvoiceReview
        localDecisions={{}}
        receivedDrafts={{ 'line-pilsen': '0' }}
        result={result}
        onDecide={() => undefined}
        onReceivedChange={() => undefined}
      />,
    )
    expect(none).toContain('value="0"')
    expect(none).toContain('Pendiente: 2 L')

    const invalid = renderToString(
      <InvoiceReview
        localDecisions={{}}
        receivedDrafts={{ 'line-pilsen': '3' }}
        result={result}
        onDecide={() => undefined}
        onReceivedChange={() => undefined}
      />,
    )
    expect(invalid).toContain('La cantidad supera lo facturado.')
  })

  it('muestra el selector de insumo antes de guardar, con conversión y pendientes', () => {
    const liquid = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: 'PRUEBA SENDA — Líquido',
      baseUnit: 'ml' as const,
    }
    const flour = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      name: 'Harina 000',
      baseUnit: 'g' as const,
    }
    const catalog = { products: [liquid, flour], loading: false, error: '' }
    const twoLitres = {
      ...baseInvoiceResult(),
      document: {
        ...baseInvoiceResult().document,
        lines: [
          {
            ...baseInvoiceResult().document.lines[0]!,
            id: 'line-liquid',
            originalDescription: 'PRUEBA SENDA — Líquido',
            name: 'PRUEBA SENDA — Líquido',
            quantity: 2,
            unit: 'L',
            unitPrice: 10,
            amount: 20,
            inventoryPhysicalQuantity: 2,
            inventoryEligibility: 'eligible' as const,
          },
        ],
      },
    }

    const exact = renderToString(
      <MemoryRouter>
        <InvoiceReview
          localDecisions={{}}
          mappingCatalog={catalog}
          mappingDrafts={{ 'line-liquid': reviewDraft(liquid.id) }}
          mappingSuggestions={{
            'line-liquid': {
              kind: 'exact',
              inventoryProductId: liquid.id,
              inventoryProduct: liquid,
              conversionFactor: 1000,
              source: 'confirmed_mapping',
            },
          }}
          result={twoLitres}
          onAcceptMappingSuggestion={() => undefined}
          onDecide={() => undefined}
          onMappingProductChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(exact).toContain('Insumo')
    expect(exact).not.toContain('Seleccionar insumo')
    expect(exact).toContain('Propuesta por vinculación anterior')
    expect(exact).toContain('Quitar propuesta')
    expect(exact).toContain('2 L')
    expect(exact).not.toContain('2.000 ml')
    expect(exact).not.toContain('Factor de conversión')
    expect(exact).toContain('PRUEBA SENDA — Líquido')
    expect(exact).not.toContain('Harina 000')
    expect(exact).not.toContain('Buscar insumo')
    expect(exact).not.toContain('Confirmar sugerencia')
    expect(exact).not.toContain('Cantidad facturada')
    expect(exact).not.toContain('Cantidad física')

    const approximate = renderToString(
      <MemoryRouter>
        <InvoiceReview
          localDecisions={{}}
          mappingCatalog={catalog}
          mappingDrafts={{ 'line-liquid': reviewDraft('') }}
          mappingSuggestions={{
            'line-liquid': {
              kind: 'approximate',
              inventoryProductId: liquid.id,
              inventoryProduct: liquid,
              conversionFactor: 1000,
              source: 'confirmed_mapping',
            },
          }}
          result={twoLitres}
          onAcceptMappingSuggestion={() => undefined}
          onDecide={() => undefined}
          onMappingProductChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(approximate).toContain('Sugerencia aproximada')
    expect(approximate).toContain('Confirmar sugerencia')
    expect(approximate).toContain('Seleccionar insumo')
    expect(approximate).not.toContain('Propuesta por vinculación anterior')
    expect(approximate).not.toContain('Harina 000')

    const none = renderToString(
      <MemoryRouter>
        <InvoiceReview
          localDecisions={{}}
          mappingCatalog={catalog}
          mappingDrafts={{ 'line-liquid': reviewDraft('') }}
          mappingSuggestions={{ 'line-liquid': null }}
          result={twoLitres}
          onAcceptMappingSuggestion={() => undefined}
          onDecide={() => undefined}
          onMappingProductChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(none).toContain('Sin insumo. Quedará pendiente de vinculación después de guardar.')
    expect(none).toContain('Seleccionar insumo')
    expect(none).toContain('PRUEBA SENDA — Líquido')
    expect(none).not.toContain('Harina 000')
    expect(none).not.toContain('Propuesta por vinculación anterior')
    expect(none).not.toContain('Sugerencia aproximada')
    expect(none).not.toContain('Buscar insumo')

    const incompatible = renderToString(
      <MemoryRouter>
        <InvoiceReview
          localDecisions={{}}
          mappingCatalog={catalog}
          mappingDrafts={{ 'line-liquid': reviewDraft(flour.id) }}
          mappingSuggestions={{ 'line-liquid': null }}
          result={twoLitres}
          onAcceptMappingSuggestion={() => undefined}
          onDecide={() => undefined}
          onMappingProductChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(incompatible).toContain('No se puede convertir esa unidad de la factura a la unidad del inventario.')

    const boxed = renderToString(
      <MemoryRouter>
        <InvoiceReview
          localDecisions={{}}
          mappingCatalog={{ products: [flour], loading: false, error: '' }}
          mappingDrafts={{
            'line-liquid': reviewDraft(flour.id),
          }}
          mappingSuggestions={{ 'line-liquid': null }}
          result={{
            ...twoLitres,
            document: {
              ...twoLitres.document,
              lines: [{ ...twoLitres.document.lines[0]!, unit: 'caja' }],
            },
          }}
          onAcceptMappingSuggestion={() => undefined}
          onDecide={() => undefined}
          onMappingProductChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(boxed).toContain('¿Cuántos kg trae cada caja?')
    expect(boxed).toContain('caja')
    expect(boxed).not.toContain('Factor de conversión')
    expect(boxed).not.toContain('2.000 ml')

    const manyLines = Array.from({ length: 8 }, (_, index) => ({
      ...twoLitres.document.lines[0]!,
      id: `line-liquid-${index}`,
    }))
    const crowded = renderToString(
      <MemoryRouter>
        <InvoiceReview
          localDecisions={{}}
          mappingCatalog={catalog}
          mappingDrafts={Object.fromEntries(manyLines.map((line) => [line.id, reviewDraft('')]))}
          mappingSuggestions={Object.fromEntries(manyLines.map((line) => [line.id, null]))}
          result={{
            ...twoLitres,
            document: { ...twoLitres.document, lines: manyLines },
          }}
          onAcceptMappingSuggestion={() => undefined}
          onDecide={() => undefined}
          onMappingProductChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(crowded.match(/Seleccionar insumo/g)?.length).toBe(8)
    expect(crowded).not.toContain('Harina 000')
    expect(crowded).not.toContain('data-mapping-menu')
  })

  it('no muestra el selector de insumo en una factura ya guardada', () => {
    const html = renderToString(
      <MemoryRouter>
        <InvoiceReview
          documentStatus="Revisada"
          localDecisions={{}}
          mappingCatalog={{ products: [{ id: 'p1', name: 'Cerveza', baseUnit: 'ml' }], loading: false, error: '' }}
          mappingDrafts={{ 'line-pilsen': reviewDraft('p1') }}
          mode="saved"
          result={bonusInvoiceResult}
        />
      </MemoryRouter>,
    )
    expect(html).not.toContain('Buscar y seleccionar insumo')
    expect(html).not.toContain('Seleccionar insumo')
    expect(html).not.toContain('Propuesta por vinculación anterior')
    expect(html).toContain('Consulta de solo lectura')
  })

  it('abre el desplegable flotante con búsqueda y no deja la lista en el flujo de la fila', () => {
    const catalog = {
      products: [
        { id: 'p-liquid', name: 'PRUEBA SENDA — Líquido', baseUnit: 'ml' as const },
        { id: 'p-flour', name: 'Harina 000', baseUnit: 'g' as const },
      ],
      loading: false,
      error: '',
    }
    const closed = renderToString(
      <MemoryRouter>
        <InvoiceMappingPicker
          approximateAccepted={false}
          catalog={catalog}
          compact
          productId=""
          quantity={2}
          suggestion={null}
          unit="L"
          onAcceptApproximate={() => undefined}
          onProductIdChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(closed).toContain('Seleccionar insumo')
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).not.toContain('Harina 000')
    expect(closed).not.toContain('data-mapping-menu')

    const opened = renderToString(
      <MemoryRouter>
        <InvoiceMappingPicker
          approximateAccepted={false}
          catalog={catalog}
          compact
          defaultOpen
          productId=""
          quantity={2}
          suggestion={null}
          unit="L"
          onAcceptApproximate={() => undefined}
          onProductIdChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(opened).toContain('aria-expanded="true"')
    expect(opened).toContain('data-mapping-menu')
    expect(opened).toContain('Buscar insumo')
    expect(opened).toContain('Buscar y seleccionar insumo')
    expect(opened).toContain('Harina 000')
    expect(opened).toContain('PRUEBA SENDA — Líquido')
    expect(opened).toContain('max-h-52')
    expect(opened).toContain('overflow-y-auto')
  })

  it('muestra el alta preparada y el botón de crear solo si la línea sigue sin insumo', () => {
    const catalog = { products: [], loading: false, error: '' }
    const prepared = renderToString(
      <MemoryRouter>
        <InvoiceMappingPicker
          allowCreate
          approximateAccepted={false}
          catalog={{
            ...catalog,
            products: [{ id: 'create:aurora', name: 'Queso Mozzarella Doña Aurora Plancha', baseUnit: 'g' }],
          }}
          compact
          lineAmount={72972.75}
          productId="create:aurora"
          quantity={1}
          suggestion={null}
          unit="plancha"
          onAcceptApproximate={() => undefined}
          onCreateNew={() => undefined}
          onProductIdChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(prepared).toContain('Se creará al guardar')
    expect(prepared).toContain('Queso Mozzarella Doña Aurora Plancha')
    expect(prepared).not.toContain('Crear insumo nuevo')

    const undecided = renderToString(
      <MemoryRouter>
        <InvoiceMappingPicker
          allowCreate
          approximateAccepted={false}
          catalog={catalog}
          compact
          productId=""
          quantity={1}
          suggestion={null}
          unit="plancha"
          onAcceptApproximate={() => undefined}
          onCreateNew={() => undefined}
          onProductIdChange={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(undecided).toContain('Crear insumo nuevo')
    expect(undecided).not.toContain('Se creará al guardar')
  })

  it('renderiza MetroGAS con diferencia fiscal de $2 como revisión, no como consistente', () => {
    const html = renderToString(
      <InvoiceReview localDecisions={{}} result={serviceInvoiceResult} onDecide={() => undefined} />,
    )
    expect(html).toContain('MetroGAS')
    expect(html).toContain('08/2026')
    expect(html).toContain('m³')
    expect(html).toContain('Conceptos de servicio')
    expect(html).toContain('Impuestos, tasas y percepciones')
    expect(html).toContain('El IVA y los otros impuestos están en los totales del comprobante.')
    expect(html).not.toContain('No se identificaron líneas fiscales de detalle')
    expect(html).toContain('Subtotales y totales')
    expect(html).toContain('Documento de servicios')
    expect(html).toContain('importes originales')
    expect(html).toMatch(/Fiscal[\s\S]{0,280}?Requiere revisión/)
    expect(html).not.toContain('Recibir mercadería')
    expect(html).not.toContain('Guardar factura')
    expect(html).not.toContain('Recibido')
  })

  it('renderiza MetroGAS conciliado como fiscal consistente y sin advertencia de $2', () => {
    const html = renderToString(
      <InvoiceReview localDecisions={{}} result={serviceInvoiceConsistentResult} onDecide={() => undefined} />,
    )
    expect(html).toContain('MetroGAS')
    expect(html).not.toContain('>Consistente<')
    expect(html).not.toContain('>Matemática<')
    expect(html).not.toContain('>Fiscal<')
    expect(html).not.toContain('>Comercial<')
    expect(html).toContain('El IVA y los otros impuestos están en los totales del comprobante.')
    expect(html).not.toContain('No se identificaron líneas fiscales de detalle')
    expect(html).not.toContain('valor original')
    expect(html).not.toContain('Requiere revisión')
    expect(html).not.toContain('Recibir mercadería')
    expect(html).not.toContain('Guardar factura')
    expect(html).not.toContain('Recibido')
  })

  it('muestra progreso, error de duplicado y éxito con id sin adelantar confirmación', () => {
    const saving = renderToString(
      <InvoiceReview
        localDecisions={{}}
        result={bonusInvoiceResult}
        onDecide={() => undefined}
        save={{
          canSave: false,
          saving: true,
          saved: null,
          error: null,
          blockedReason: null,
          acceptFiscalInconsistency: false,
          onAcceptFiscal: () => undefined,
          onSave: () => undefined,
        }}
      />,
    )
    expect(saving).toContain('Procesando…')
    expect(saving).not.toContain('Factura guardada. ID:')

    const duplicate = renderToString(
      <InvoiceReview
        localDecisions={{ 'relation-line-bonus': 'confirm' }}
        result={bonusInvoiceResult}
        onDecide={() => undefined}
        save={{
          canSave: true,
          saving: false,
          saved: null,
          error: { message: 'Este comprobante ya está registrado.', code: 'DUPLICATE_DOCUMENT' },
          blockedReason: null,
          acceptFiscalInconsistency: false,
          onAcceptFiscal: () => undefined,
          onSave: () => undefined,
        }}
      />,
    )
    expect(duplicate).toContain('Este comprobante ya está registrado.')
    expect(duplicate).toContain('PILSEN')
    expect(duplicate).toContain('confirmada')
    expect(duplicate).not.toContain('Factura guardada. ID:')

    const success = renderToString(
      <InvoiceReview
        localDecisions={{}}
        result={bonusInvoiceResult}
        onDecide={() => undefined}
        save={{
          canSave: false,
          saving: false,
          saved: savedInvoiceResult(),
          error: null,
          blockedReason: null,
          acceptFiscalInconsistency: false,
          onAcceptFiscal: () => undefined,
          onSave: () => undefined,
        }}
      />,
    )
    expect(success).toContain('Operación incompleta')
    expect(success).toContain('doc-saved-1')
    expect(success).not.toContain('Factura guardada y stock actualizado')
    expect(success).toContain('Abrir detalle de la factura')
    expect(success).not.toContain('Factura ya registrada')

    const replay = renderToString(
      <InvoiceReview
        localDecisions={{}}
        result={bonusInvoiceResult}
        onDecide={() => undefined}
        save={{
          canSave: false,
          saving: false,
          saved: savedInvoiceResult({ idempotent: true }),
          error: null,
          blockedReason: null,
          intakeLines: [
            {
              sourceLineId: 'line-pilsen',
              label: 'Golden Ale',
              status: 'received',
              message: 'Recepción completa registrada.',
              retryable: false,
            },
          ],
          acceptFiscalInconsistency: false,
          onAcceptFiscal: () => undefined,
          onSave: () => undefined,
        }}
      />,
    )
    expect(replay).toContain('Factura ya registrada')
    expect(replay).toContain('Esta factura ya estaba registrada en SENDA. No se modificó el inventario durante este intento.')
    expect(replay).toContain('Abrir detalle de la factura')
    expect(replay).toContain('/facturas/doc-saved-1')
    expect(replay).not.toContain('Factura guardada y recepción completa')
    expect(replay).not.toContain('Recepción completa registrada')
    expect(replay).not.toContain('Golden Ale')

    const intake = renderToString(
      <InvoiceReview
        localDecisions={{}}
        result={bonusInvoiceResult}
        onDecide={() => undefined}
        save={{
          canSave: false,
          canRetry: true,
          saving: false,
          saved: savedInvoiceResult(),
          error: null,
          blockedReason: null,
          intakeLines: [
            {
              sourceLineId: 'line-pilsen',
              label: 'PILSEN',
              status: 'receive_uncertain',
              message: 'No se pudo conectar con el servidor. Conservamos la clave de idempotencia para reintentar sin duplicar stock.',
              retryable: true,
            },
          ],
          acceptFiscalInconsistency: false,
          onAcceptFiscal: () => undefined,
          onSave: () => undefined,
        }}
      />,
    )
    expect(intake).toContain('Operación incompleta')
    expect(intake).toContain('>Reintentar<')
    expect(intake).toContain('PILSEN')
    expect(intake).toContain('sin duplicar stock')
    expect(intake).not.toContain('Factura guardada y recepción completa')

    const storage = renderToString(
      <InvoiceReview
        localDecisions={{}}
        result={bonusInvoiceResult}
        onDecide={() => undefined}
        save={{
          canSave: true,
          saving: false,
          saved: null,
          error: {
            message: 'El almacenamiento de facturas no está configurado.',
            code: 'INVOICE_STORAGE_NOT_CONFIGURED',
          },
          blockedReason: null,
          acceptFiscalInconsistency: false,
          onAcceptFiscal: () => undefined,
          onSave: () => undefined,
        }}
      />,
    )
    expect(storage).toContain('El almacenamiento de facturas no está configurado.')
    expect(storage).toContain('PILSEN')
    expect(storage).not.toContain('Factura guardada. ID:')
  })

  it('reutiliza la revisión en solo lectura para una factura guardada', () => {
    const html = renderToString(
      <InvoiceReview
        documentStatus="Revisada"
        localDecisions={{ 'relation-line-bonus': 'confirm' }}
        mode="saved"
        originalResult={bonusInvoiceResult}
        result={confirmedBonusInvoiceResult}
      />,
    )
    expect(html).toContain('Consulta de solo lectura')
    expect(html).toContain('Datos originales')
    expect(html).toContain('Datos revisados')
    expect(html).toContain('PILSEN')
    expect(html).toContain('confirmada')
    expect(html).toContain('Subtotales y totales')
    expect(html).toContain('IVA')
    expect(html).not.toContain('>Consistente<')
    expect(html).not.toContain('Recepción al guardar')
    expect(html).not.toContain('efectivamente recibido')
    expect(html).not.toContain('Guardar factura')
    expect(html).not.toContain('Confirmar')
    expect(html).not.toContain('Actualizar stock')
    expect(html).not.toContain('Recibir mercadería')
    expect(html).not.toContain('inputMode="decimal"')
  })

  const PRODUCT = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Cerveza Pilsen', baseUnit: 'ml' as const }

  function fiscalLine(): InvoiceAnalysisLine {
    return {
      id: 'line-iva',
      sourceIndex: 2,
      originalDescription: 'IVA 21%',
      name: 'IVA 21%',
      supplierSku: null,
      quantity: null,
      unit: null,
      unitPrice: null,
      amount: 105,
      classification: 'fiscal',
      inventoryEligibility: 'ineligible',
      quantityKind: 'none',
      inventoryPhysicalQuantity: 0,
      missingFields: [],
      ambiguities: [],
    }
  }

  function reviewResult() {
    return {
      ...confirmedBonusInvoiceResult,
      document: {
        ...confirmedBonusInvoiceResult.document,
        lines: [...confirmedBonusInvoiceResult.document.lines, fiscalLine()],
      },
    }
  }

  function opsLine(overrides: Partial<InvoiceStoredLine> = {}): InvoiceStoredLine {
    return {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sourceLineId: 'line-pilsen',
      sourceIndex: 0,
      original: { description: 'PILSEN', quantity: 50, unit: 'L', unitPrice: 1650, amount: 82500 },
      reviewed: { description: 'PILSEN', quantity: 50, unit: 'L', unitPrice: 1650, amount: 82500 },
      classification: 'stock',
      inventoryEligibility: 'eligible',
      mappingStatus: 'unmapped',
      quantityKind: 'inventory',
      inventoryPhysicalQuantity: 0,
      inventoryProductId: null,
      inventoryProduct: null,
      mappingSuggestion: null,
      ...overrides,
    }
  }

  function renderConcepts(line: InvoiceStoredLine, status = 'reviewed', readOnly = false) {
    return renderToString(
      <InvoiceReview
        documentStatus="Revisada"
        lineOperations={{
          invoiceId: 'fe8b3702-dea1-4e89-b86c-76ae42d700fc',
          lines: [line],
          status,
          catalog: { products: [PRODUCT], loading: false, error: '' },
          onMapped: () => undefined,
          onReceived: () => undefined,
        }}
        localDecisions={{}}
        mode="saved"
        readOnly={readOnly}
        result={reviewResult()}
      />,
    )
  }

  it('una factura recibida muestra el vínculo sin edición', () => {
    const html = renderConcepts(opsLine({
      mappingStatus: 'mapped',
      inventoryProductId: PRODUCT.id,
      inventoryProduct: PRODUCT,
      inventoryPhysicalQuantity: 50000,
      receivedQuantity: 50000,
      remainingQuantity: 0,
    }), 'received', true)
    expect(html).toContain(PRODUCT.name)
    expect(html).not.toContain('recibido 50000')
    expect(html).not.toContain('Habilitada')
    expect(html).not.toContain('Vinculado')
    expect(html).not.toContain('>Recibido<')
    expect(html).not.toContain('Recepción al guardar')
    expect(html).not.toContain('efectivamente recibido')
    expect(html).not.toContain('Vincular')
    expect(html).not.toContain('Editar vínculo')
    expect(html).not.toContain('No se puede editar el vínculo')
  })

  it('muestra Vincular en mercadería sin vincular y excluye fiscales', () => {
    const html = renderConcepts(opsLine())
    expect(html).toContain('Mercadería')
    expect(html).toContain('PILSEN')
    expect(html).toContain('Ajustes comerciales')
    expect(html).toContain('Vincular')
    expect(html).toContain('IVA 21%')
    expect(html).toContain('Impuestos, tasas y percepciones')
    expect(html.match(/Vincular/g)?.length).toBe(1)
    expect(html).not.toContain('Recibir')
    expect(html).not.toContain('Vinculación de productos')
    expect(html).not.toContain('Recepción de mercadería')
    expect(html).not.toContain('Actualizar stock')
  })

  it('muestra Recibir en una línea vinculada pendiente', () => {
    const html = renderConcepts(opsLine({
      mappingStatus: 'mapped',
      inventoryPhysicalQuantity: 50000,
      inventoryProductId: PRODUCT.id,
      inventoryProduct: PRODUCT,
      invoicedQuantity: 50000,
      receivedQuantity: 0,
      remainingQuantity: 50000,
    }))
    expect(html).not.toContain('Habilitada')
    expect(html).not.toContain('Vinculado')
    expect(html).toContain('Sin recibir')
    expect(html).toContain('Editar vínculo')
    expect(html).not.toMatch(/>Recibir</)
    expect(html).not.toContain('Recibido parcial')
  })

  it('no ofrece Recibir en el detalle si la línea sigue en revisión comercial', () => {
    const base = reviewResult()
    const html = renderToString(
      <InvoiceReview
        documentStatus="Revisada"
        lineOperations={{
          invoiceId: 'fe8b3702-dea1-4e89-b86c-76ae42d700fc',
          lines: [opsLine({
            mappingStatus: 'mapped',
            inventoryPhysicalQuantity: 50000,
            inventoryProductId: PRODUCT.id,
            inventoryProduct: PRODUCT,
            invoicedQuantity: 50000,
            receivedQuantity: 0,
            remainingQuantity: 50000,
          })],
          status: 'reviewed',
          catalog: { products: [PRODUCT], loading: false, error: '' },
          onMapped: () => undefined,
          onReceived: () => undefined,
        }}
        localDecisions={{}}
        mode="saved"
        result={{
          ...base,
          interpretation: {
            ...base.interpretation,
            lines: [{ lineId: 'line-pilsen', operation: 'inbound', status: 'requires_review' }],
          },
        }}
      />,
    )
    expect(html).toContain('Revisión comercial')
    expect(html).toContain('discrepancia comercial')
    expect(html).not.toMatch(/>Recibir</)
  })

  it('no ofrece una confirmación de recepción aparte en la factura ya guardada', () => {
    const html = renderToString(
      <InvoiceReview
        documentStatus="Revisada"
        localDecisions={{}}
        mode="saved"
        result={confirmedBonusInvoiceResult}
      />,
    )
    expect(html).not.toContain('Recepción pendiente')
    expect(html).not.toContain('Confirmar recepción pendiente')
    expect(html).not.toContain('Solo guardar sin recibir stock')
    expect(html).not.toContain('Guardar factura')
  })

  it('muestra Recibido parcial y bloquea editar el vínculo', () => {
    const html = renderConcepts(opsLine({
      mappingStatus: 'mapped',
      inventoryPhysicalQuantity: 100000,
      inventoryProductId: PRODUCT.id,
      inventoryProduct: PRODUCT,
      invoicedQuantity: 100000,
      receivedQuantity: 40000,
      remainingQuantity: 60000,
    }))
    expect(html).toContain('Recibido parcial')
    expect(html).not.toMatch(/>Recibir</)
    expect(html).toContain('No se puede editar el vínculo: ya hay recepciones.')
    expect(html).not.toContain('Editar vínculo')
    const readable = renderConcepts(opsLine({
      mappingStatus: 'mapped',
      inventoryPhysicalQuantity: 100000,
      inventoryProductId: PRODUCT.id,
      inventoryProduct: PRODUCT,
      invoicedQuantity: 100000,
      receivedQuantity: 40000,
      remainingQuantity: 60000,
    }), 'received', true)
    expect(readable).toContain('Recibido 40 L')
    expect(readable).not.toContain('recibido 40000')
    expect(readable).not.toContain('recibido 100000')
  })

  it('muestra Recibido completo sin registrar nuevas entradas', () => {
    const html = renderConcepts(opsLine({
      mappingStatus: 'mapped',
      inventoryPhysicalQuantity: 100000,
      inventoryProductId: PRODUCT.id,
      inventoryProduct: PRODUCT,
      invoicedQuantity: 100000,
      receivedQuantity: 100000,
      remainingQuantity: 0,
    }), 'received')
    expect(html).not.toContain('>Recibido<')
    expect(html).not.toContain('Habilitada')
    expect(html).not.toContain('recibido 100000')
    expect(html).not.toContain('>Recibir<')
    expect(html).toContain('No se puede editar el vínculo: ya hay recepciones.')
  })

  it('bloquea Vincular si el sourceLineId no coincide aunque el índice sea el mismo', () => {
    const html = renderConcepts(opsLine({ sourceLineId: 'line-otra', sourceIndex: 0 }))
    expect(html).toContain('PILSEN')
    expect(html).toContain('50')
    expect(html).toContain(LINE_ASSOCIATION_MISSING)
    expect(html).not.toContain('Vincular')
    expect(html).not.toContain('Recibir')
  })

  it('no asigna las acciones de un concepto homónimo al UUID de otro', () => {
    const oilA: InvoiceAnalysisLine = {
      id: 'line-oil-a',
      sourceIndex: 0,
      originalDescription: 'Aceite',
      name: 'Aceite',
      supplierSku: null,
      quantity: 4,
      unit: 'L',
      unitPrice: 200,
      amount: 800,
      classification: 'stock',
      inventoryEligibility: 'eligible',
      quantityKind: 'inventory',
      inventoryPhysicalQuantity: 4,
      missingFields: [],
      ambiguities: [],
    }
    const oilB: InvoiceAnalysisLine = { ...oilA, id: 'line-oil-b', sourceIndex: 1 }
    const storedB = opsLine({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sourceLineId: 'line-oil-b',
      sourceIndex: 0,
      original: { description: 'Aceite', quantity: 4, unit: 'L', unitPrice: 200, amount: 800 },
      reviewed: { description: 'Aceite', quantity: 4, unit: 'L', unitPrice: 200, amount: 800 },
    })
    const html = renderToString(
      <InvoiceReview
        documentStatus="Revisada"
        lineOperations={{
          invoiceId: 'fe8b3702-dea1-4e89-b86c-76ae42d700fc',
          lines: [storedB],
          status: 'reviewed',
          catalog: { products: [PRODUCT], loading: false, error: '' },
          onMapped: () => undefined,
          onReceived: () => undefined,
        }}
        localDecisions={{}}
        mode="saved"
        result={{
          ...bonusInvoiceResult,
          document: {
            ...bonusInvoiceResult.document,
            lines: [oilB, oilA, fiscalLine()],
          },
        }}
      />,
    )
    expect(html).toContain('Aceite')
    expect(html).toContain(LINE_ASSOCIATION_MISSING)
    expect(html.match(/Vincular/g)?.length).toBe(1)
    expect(html).toContain('IVA 21%')
    expect(html).toContain('Impuestos, tasas y percepciones')
  })

  it('conserva la conversión automática en el formulario de vinculación', () => {
    const html = renderToString(
      <MemoryRouter>
        <InvoiceMappingForm
          catalog={{ products: [PRODUCT], loading: false, error: '' }}
          invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
          line={opsLine({
            mappingSuggestion: {
              kind: 'exact',
              inventoryProductId: PRODUCT.id,
              inventoryProduct: PRODUCT,
              conversionFactor: 1,
              source: 'confirmed_mapping',
            },
          })}
          onMapped={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('Cerveza Pilsen')
    expect(html).not.toContain('Seleccionar insumo')
    expect(html).toContain('50 L')
    expect(html).not.toContain('50.000 ml')
    expect(html).toContain('Propuesta por vinculación anterior')
    expect(html).not.toContain('Buscar insumo')
    expect(html).not.toContain('Cantidad facturada')
    expect(html).not.toContain('Cantidad física')
    expect(html).not.toContain('Buscar producto')
    expect(html).not.toContain('Producto de inventario')
    expect(html).not.toContain('Factor de conversión')
  })

  it('convierte 2 l (litros) de Gemini a 2.000 ml al elegir el insumo', () => {
    const html = renderToString(
      <MemoryRouter>
        <InvoiceMappingForm
          catalog={{ products: [PRODUCT], loading: false, error: '' }}
          invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
          line={opsLine({
            original: { description: 'PRUEBA SENDA — Líquido', quantity: 2, unit: 'l (litros)', unitPrice: 1, amount: 2 },
            reviewed: { description: 'PRUEBA SENDA — Líquido', quantity: 2, unit: 'l (litros)', unitPrice: 1, amount: 2 },
            mappingSuggestion: {
              kind: 'exact',
              inventoryProductId: PRODUCT.id,
              inventoryProduct: PRODUCT,
              conversionFactor: 1,
              source: 'confirmed_mapping',
            },
          })}
          onMapped={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('2 L')
    expect(html).not.toContain('2.000 ml')
    expect(html).not.toContain('Factor de conversión')
    expect(html).not.toContain('No se puede convertir esa unidad')
  })

  it('pide factor de conversión para empaques y no convierte litros a gramos', () => {
    const boxes = renderToString(
      <MemoryRouter>
        <InvoiceMappingForm
          catalog={{
            products: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Tomate', baseUnit: 'g' }],
            loading: false,
            error: '',
          }}
          invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
          line={opsLine({
            original: { description: 'CAJA TOMATE', quantity: 2, unit: 'caja', unitPrice: 10, amount: 20 },
            reviewed: { description: 'CAJA TOMATE', quantity: 2, unit: 'caja', unitPrice: 10, amount: 20 },
            mappingSuggestion: {
              kind: 'exact',
              inventoryProductId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              inventoryProduct: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Tomate', baseUnit: 'g' },
              conversionFactor: 8000,
              source: 'confirmed_mapping',
            },
          })}
          onMapped={() => undefined}
        />
      </MemoryRouter>,
    )
    // Factor viene de la memoria de vinculación (8000 g/caja); no pedir input manual.
    expect(boxes).toContain('16 kg')
    expect(boxes).not.toContain('Factor de conversión')
    expect(boxes).not.toContain('8000')
    expect(boxes).not.toContain('No se puede convertir esa unidad')
    expect(boxes).not.toContain('Ir a Inventario')

    const incompatible = renderToString(
      <MemoryRouter>
        <InvoiceMappingForm
          catalog={{ products: [{ ...PRODUCT, baseUnit: 'g' }], loading: false, error: '' }}
          invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
          line={opsLine({
            original: { description: 'PRUEBA SENDA — Líquido', quantity: 2, unit: 'L', unitPrice: 1, amount: 2 },
            reviewed: { description: 'PRUEBA SENDA — Líquido', quantity: 2, unit: 'L', unitPrice: 1, amount: 2 },
            mappingSuggestion: {
              kind: 'exact',
              inventoryProductId: PRODUCT.id,
              inventoryProduct: { ...PRODUCT, baseUnit: 'g' },
              conversionFactor: null,
              source: 'confirmed_mapping',
            },
          })}
          onMapped={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(incompatible).toContain('No se puede convertir esa unidad')
  })

  it('distingue catálogo vacío, error de carga, crear insumo y propuesta exacta reversible', () => {
    const empty = renderToString(
      <MemoryRouter>
        <InvoiceMappingForm
          catalog={{ products: [], loading: false, error: '' }}
          invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
          line={opsLine()}
          organizationId="org-1"
          onMapped={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(empty).toContain('Crear insumo nuevo')

    const failed = renderToString(
      <MemoryRouter>
        <InvoiceMappingForm
          catalog={{ products: [], loading: false, error: 'No se pudieron consultar los productos.' }}
          invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
          line={opsLine()}
          onMapped={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(failed).toContain('No se pudieron consultar los productos.')

    const exact = renderToString(
      <MemoryRouter>
        <InvoiceMappingForm
          catalog={{ products: [{ ...PRODUCT, baseUnit: 'l' }], loading: false, error: '' }}
          invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
          line={opsLine({
            mappingSuggestion: {
              kind: 'exact',
              inventoryProductId: PRODUCT.id,
              inventoryProduct: { ...PRODUCT, baseUnit: 'l' },
              conversionFactor: 1,
              source: 'confirmed_mapping',
            },
          })}
          onMapped={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(exact).toContain('Propuesta por vinculación anterior')
    expect(exact).toContain('Quitar propuesta')
  })

  it('muestra cantidades de recepción y no permite recibir sin vincular', () => {
    const partial = renderToString(
      <InvoiceReceiveForm
        invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
        line={opsLine({
          mappingStatus: 'mapped',
          inventoryPhysicalQuantity: 100000,
          inventoryProductId: PRODUCT.id,
          inventoryProduct: PRODUCT,
          invoicedQuantity: 100000,
          receivedQuantity: 40000,
          remainingQuantity: 60000,
        })}
        onReceived={() => undefined}
      />,
    )
    expect(partial).toContain('Cerveza Pilsen')
    expect(partial).toContain('100 L')
    expect(partial).toContain('40 L')
    expect(partial).toContain('60 L')
    expect(partial).toContain('Cantidad a recibir')
    expect(partial).toContain('type="text"')
    expect(partial).toContain('inputMode="decimal"')
    expect(partial).not.toContain('type="number"')
    expect(partial).not.toContain('100000')

    const sending = renderToString(
      <InvoiceReceiveForm
        invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
        line={opsLine({
          mappingStatus: 'mapped',
          inventoryPhysicalQuantity: 2000,
          inventoryProductId: PRODUCT.id,
          inventoryProduct: PRODUCT,
          invoicedQuantity: 2000,
          receivedQuantity: 0,
          remainingQuantity: 2000,
        })}
        sending
        onReceived={() => undefined}
      />,
    )
    expect(sending).toContain('Enviando…')
    expect(sending).toContain('disabled=""')
    expect(sending).not.toContain('Confirmar recepción')

    const unmapped = renderToString(
      <InvoiceReceiveForm
        invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
        line={opsLine({ configurationStatus: 'pending_configuration' })}
        onReceived={() => undefined}
      />,
    )
    expect(unmapped).toContain('Primero vinculá esta línea a un insumo')
    expect(unmapped).not.toContain('Cantidad a recibir')
    expect(unmapped).not.toContain('Confirmar recepción')
  })

  it('consulta una recepción completa sin formulario de carga', () => {
    const html = renderToString(
      <InvoiceReceiveForm
        invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
        line={opsLine({
          mappingStatus: 'mapped',
          inventoryPhysicalQuantity: 100000,
          inventoryProductId: PRODUCT.id,
          inventoryProduct: PRODUCT,
          invoicedQuantity: 100000,
          receivedQuantity: 100000,
          remainingQuantity: 0,
        })}
        onReceived={() => undefined}
      />,
    )
    expect(html).toContain('100 L')
    expect(html).toContain('ya está recibida')
    expect(html).not.toContain('Cantidad a recibir')
    expect(html).not.toContain('Confirmar recepción')
  })

  it('actualiza cantidades y estado tras una recepción', () => {
    const detail: InvoiceDetail = {
      id: 'inv-1',
      status: 'reviewed',
      locationId: 'loc-1',
      organizationId: 'org-1',
      supplierName: 'LUPULO SRL',
      issuerTaxId: null,
      documentDate: '2026-10-01',
      documentNumber: '0001-00000001',
      documentType: 'invoice',
      classification: 'gastronomic_merchandise',
      currency: 'ARS',
      eligibleLineCount: 1,
      unmappedLineCount: 0,
      fiscalDifferenceAccepted: false,
      originalAnalysis: null,
      reviewedAnalysis: null,
      corrections: {},
      commercialDecisions: [],
      file: null,
      lines: [opsLine({
        mappingStatus: 'mapped',
        inventoryPhysicalQuantity: 100000,
        inventoryProductId: PRODUCT.id,
        inventoryProduct: PRODUCT,
        invoicedQuantity: 100000,
        receivedQuantity: 0,
        remainingQuantity: 100000,
      })],
    }
    const next = applyInvoiceReceiveResult(detail, {
      id: 'receipt-1',
      purchaseDocumentId: 'inv-1',
      purchaseDocumentLineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      quantity: 40000,
      invoicedQuantity: 100000,
      receivedQuantity: 40000,
      remainingQuantity: 60000,
      documentStatus: 'reviewed',
      inventoryMovementId: 'mov-1',
      idempotent: false,
    })
    expect(next.lines[0]?.receivedQuantity).toBe(40000)
    expect(next.lines[0]?.remainingQuantity).toBe(60000)
    expect(next.status).toBe('reviewed')
    const html = renderConcepts(next.lines[0] as InvoiceStoredLine)
    expect(html).toContain('Recibido parcial')
    expect(html).not.toMatch(/>Recibir</)
  })

  it('conserva el intento idempotente si la recepción falla', () => {
    const store = createMemoryAttemptStore()
    prepareReceiveAttempt({
      invoiceId: 'fe8b3702-dea1-4e89-b86c-76ae42d700fc',
      lineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      quantity: 40000,
      store,
      createKey: () => 'key-retry',
    })
    const html = renderToString(
      <InvoiceReceiveForm
        invoiceId="fe8b3702-dea1-4e89-b86c-76ae42d700fc"
        line={opsLine({
          mappingStatus: 'mapped',
          inventoryPhysicalQuantity: 100000,
          inventoryProductId: PRODUCT.id,
          inventoryProduct: PRODUCT,
          invoicedQuantity: 100000,
          receivedQuantity: 0,
          remainingQuantity: 100000,
        })}
        store={store}
        onReceived={() => undefined}
      />,
    )
    expect(html).toContain('intento sin confirmar')
    expect(html).toContain('reintentá de forma segura')
  })
})


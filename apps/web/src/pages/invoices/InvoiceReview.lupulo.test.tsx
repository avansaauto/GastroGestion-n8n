import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import {
  beginAnalyze,
  canSaveInvoice,
  initialInvoiceFlow,
  saveBlockedReason,
  selectInvoiceFile,
  setLocalDecision,
  setReviewReceivedDisplay,
  succeedAnalyze,
  type InvoiceFlowState,
} from '@/lib/invoices/flow'
import { bonusInvoiceResult, signedInvoiceResult } from '@/lib/invoices/fixtures'
import { isInventoriableAnalysisLine } from '@/lib/invoices/mapping'
import { InvoiceReview } from './InvoiceReview'

const LOCATION_ID = 'loc-1'
const PILSEN_CATALOG = {
  products: [{
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    name: 'Cerveza Pilsen',
    baseUnit: 'ml' as const,
  }],
  loading: false,
  error: '',
}

function fakeFile() {
  const blob = new Blob([new Uint8Array(2048)], { type: 'application/pdf' })
  return Object.assign(blob, { name: 'lupulo.pdf', lastModified: Date.now() }) as File
}

function lupuloReview(): InvoiceFlowState {
  const selected = selectInvoiceFile(initialInvoiceFlow, fakeFile())
  return succeedAnalyze(beginAnalyze(selected)!, signedInvoiceResult({
    ...bonusInvoiceResult,
    metadata: signedInvoiceResult().metadata,
  }))
}

function renderReview(state: InvoiceFlowState, onSave: () => void = () => undefined) {
  return renderToString(
    <MemoryRouter>
      <InvoiceReview
        localDecisions={state.localDecisions}
        mappingCatalog={PILSEN_CATALOG}
        mappingDrafts={state.mappingDrafts}
        mappingSuggestions={state.mappingSuggestions}
        receivedDrafts={state.receivedDrafts}
        result={state.result!}
        originalResult={state.originalSnapshot}
        onDecide={() => undefined}
        onMappingProductChange={() => undefined}
        onReceivedChange={() => undefined}
        save={{
          canSave: canSaveInvoice(state, LOCATION_ID),
          saving: false,
          saved: null,
          error: null,
          blockedReason: saveBlockedReason(state, LOCATION_ID, false),
          acceptFiscalInconsistency: false,
          onAcceptFiscal: () => undefined,
          onSave,
        }}
      />
    </MemoryRouter>,
  )
}

function sectionAfter(html: string, heading: string, nextHeading: string) {
  const start = html.indexOf(heading)
  expect(start).toBeGreaterThan(-1)
  const from = html.slice(start)
  const end = from.indexOf(nextHeading)
  return end === -1 ? from : from.slice(0, end)
}

describe('validación visual Lúpulo sobre InvoiceReview', () => {
  it('muestra la bonificación propuesta, el ajuste negativo y Guardar bloqueado', () => {
    const pending = lupuloReview()
    const html = renderReview(pending)
    const merchandise = sectionAfter(html, '>Mercadería<', '>Ajustes comerciales<')
    const adjustments = sectionAfter(html, '>Ajustes comerciales<', '>Impuestos, tasas y percepciones<')

    expect(pending.result?.interpretation.relations[0]).toMatchObject({
      status: 'proposed',
      grossAmount: 82500,
      bonusAmount: 82500,
      netAcquisitionAmount: 0,
    })
    expect(pending.result?.document.lines[0]).toMatchObject({
      name: 'PILSEN',
      quantity: 50,
      inventoryEligibility: 'pending_review',
    })
    expect(isInventoriableAnalysisLine(pending.result!.document.lines[0]!)).toBe(false)

    expect(html).toContain('Estado actual:')
    expect(html).toContain('pendiente')
    expect(html).toContain('PILSEN figura con 50 L facturados y una bonificación del 100%')
    expect(html).toContain('Importe bruto')
    expect(html).toContain('82.500,00')
    expect(html).toContain('Neto comercial')
    expect(html).toContain('0,00')
    expect(html).toContain('Cantidad facturada: ')
    expect(html).toContain('No es la cantidad recibida.')
    expect(html).not.toContain('recibiste')

    expect(merchandise).toContain('PILSEN LTS 50')
    expect(merchandise).toContain('Revisión comercial')
    expect(merchandise).not.toContain('Habilitada')
    expect(merchandise).not.toContain('inputMode="decimal"')
    expect(merchandise).not.toContain('Seleccionar insumo')
    expect(merchandise).not.toContain('-$')
    expect(html).toContain('Revisión comercial pendiente')
    expect(html).toContain('Confirmala o rechazala para habilitar la recepción.')
    expect(html).not.toContain('SENDA registrará lo efectivamente recibido')
    expect(html).not.toContain('La recepción no está disponible todavía')
    expect(html).not.toContain('Líneas pendientes de revisión:')

    expect(adjustments).toContain('PILSEN bonificación')
    expect(adjustments).toContain('Ajuste (sin stock)')
    expect(adjustments).toContain('-$')
    expect(adjustments).toContain('82.500,00')
    expect(adjustments).not.toContain('inputMode="decimal"')
    expect(adjustments).not.toContain('Seleccionar insumo')
    expect(adjustments).toContain('No representan mercadería física ni mueven stock')

    expect(canSaveInvoice(pending, LOCATION_ID)).toBe(false)
    expect(saveBlockedReason(pending, LOCATION_ID, false)).toBe(
      'Confirmá o rechazá la bonificación de PILSEN antes de guardar.',
    )
    expect(html).toContain('Confirmá o rechazá la bonificación de PILSEN antes de guardar.')
    expect(html).toMatch(/disabled=""[^>]*>Guardar</)
  })

  it('al confirmar habilita Pilsen para vinculación, recepción y los importes comerciales', () => {
    const confirmed = setLocalDecision(lupuloReview(), 'relation-line-bonus', 'confirm')
    const pilsen = confirmed.result!.document.lines[0]!
    const adjustment = confirmed.result!.document.lines[1]!
    const html = renderReview(confirmed)
    const merchandise = sectionAfter(html, '>Mercadería<', '>Ajustes comerciales<')
    const adjustments = sectionAfter(html, '>Ajustes comerciales<', '>Impuestos, tasas y percepciones<')

    expect(confirmed.originalSnapshot?.document.lines[0]?.inventoryEligibility).toBe('pending_review')
    expect(pilsen).toMatchObject({
      inventoryEligibility: 'eligible',
      quantity: 50,
      unitPrice: 1650,
      amount: 82500,
    })
    expect(adjustment).toMatchObject({
      inventoryEligibility: 'ineligible',
      amount: -82500,
    })
    expect(isInventoriableAnalysisLine(pilsen)).toBe(true)
    expect(isInventoriableAnalysisLine(adjustment)).toBe(false)
    expect(confirmed.result?.interpretation.relations[0]?.status).toBe('confirmed')

    expect(html).toContain('confirmada')
    expect(html).not.toContain('Estado actual: <!-- -->pendiente')
    expect(merchandise).toContain('Recibido')
    expect(merchandise).toContain('Facturado')
    expect(merchandise).toContain('value="50"')
    expect(merchandise).toContain('Sin insumo')
    expect(merchandise).not.toContain('Revisión comercial')
    expect(merchandise).toContain('Seleccionar insumo')
    expect(merchandise).toContain('inputMode="decimal"')
    expect(merchandise).toContain('1.650,00')
    expect(merchandise).toContain('82.500,00')
    expect(adjustments).toContain('Ajuste (sin stock)')
    expect(adjustments).not.toContain('value="50"')
    expect(adjustments).not.toContain('Seleccionar insumo')
    expect(html).toContain('SENDA registrará lo efectivamente recibido al guardar.')
    expect(html).toContain('1 línea requiere vinculación a un insumo.')
    expect(html).not.toContain('La recepción no está disponible todavía')

    expect(html).toContain('Importe bruto')
    expect(html).toContain('Bonificación')
    expect(html).toContain('Neto comercial')
    expect(html).toMatch(/Importe bruto[\s\S]*82\.500,00/)
    expect(html).toMatch(/Bonificación[\s\S]*82\.500,00/)
    expect(html).toMatch(/Neto comercial[\s\S]*\$\s*0,00/)
  })

  it('al rechazar cierra la relación y trata Pilsen como compra normal', () => {
    const rejected = setLocalDecision(lupuloReview(), 'relation-line-bonus', 'reject')
    const html = renderReview(rejected)
    const merchandise = sectionAfter(html, '>Mercadería<', '>Ajustes comerciales<')
    const adjustments = sectionAfter(html, '>Ajustes comerciales<', '>Impuestos, tasas y percepciones<')

    expect(rejected.result?.interpretation.relations[0]?.status).toBe('rejected')
    expect(rejected.result?.document.lines[0]?.inventoryEligibility).toBe('eligible')
    expect(rejected.result?.document.lines[1]?.inventoryEligibility).toBe('ineligible')
    expect(html).toContain('rechazada')
    expect(html).toContain('Relación cerrada. El ajuste negativo no ingresa al inventario.')
    expect(merchandise).toContain('Recibido')
    expect(merchandise).toContain('Seleccionar insumo')
    expect(merchandise).toContain('value="50"')
    expect(adjustments).toContain('Ajuste (sin stock)')
    expect(adjustments).not.toContain('Seleccionar insumo')
    expect(canSaveInvoice(rejected, LOCATION_ID)).toBe(true)
    expect(saveBlockedReason(rejected, LOCATION_ID, false)).toBeNull()
    expect(html).not.toContain('Confirmá o rechazá la bonificación de PILSEN antes de guardar.')
  })

  it('muestra 30 L pendientes si se reciben 20 L de 50 L facturados, sin tocar precio ni importe', () => {
    const confirmed = setLocalDecision(lupuloReview(), 'relation-line-bonus', 'confirm')
    const partial = setReviewReceivedDisplay(confirmed, 'line-pilsen', '20')
    const html = renderReview(partial)
    const pilsen = partial.result!.document.lines[0]!

    expect(partial.receivedDrafts['line-pilsen']).toBe('20')
    expect(pilsen.quantity).toBe(50)
    expect(pilsen.unitPrice).toBe(1650)
    expect(pilsen.amount).toBe(82500)
    expect(partial.originalSnapshot?.document.lines[0]?.quantity).toBe(50)
    expect(partial.originalSnapshot?.document.lines[0]?.amount).toBe(82500)
    expect(html).toContain('value="20"')
    expect(html).toContain('Pendiente: 30 L')
    expect(html).toContain('Recepción parcial: 1')
    expect(html).toContain('1.650,00')
    expect(html).toContain('82.500,00')
    expect(html).not.toContain('Pendiente: 50 L')
  })

  it('no dispara Guardar desde la revisión de Lúpulo pendiente', () => {
    const saves: string[] = []
    const html = renderReview(lupuloReview(), () => saves.push('saved'))
    expect(html).toMatch(/disabled=""[^>]*>Guardar</)
    expect(saves).toEqual([])
  })
})

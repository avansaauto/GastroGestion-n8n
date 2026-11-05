import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SaleConsumptionGroup } from '@/lib/api'
import { formatInventoryStock } from '@/lib/inventoryCatalog'
import { formatQuantity } from '@/lib/invoices/review'
import { filterSaleConsumptionGroups, isTestSource, SalesConsumptionBoard } from './SalesConsumptionsPage'

const harina = formatInventoryStock(-200, 'g', formatQuantity)
const mozzarella = formatInventoryStock(-80, 'g', formatQuantity)

const legacyGroup: SaleConsumptionGroup = {
  sourceType: 'fudo',
  sourceId: '884211',
  occurredAt: '2026-10-31T18:00:00.000Z',
  status: 'registered',
  soldProductName: null,
  soldProductId: null,
  recipeName: null,
  recipeId: null,
  soldQuantity: null,
  soldUnit: null,
  errorCode: null,
  lines: [
    {
      id: 'line-harina',
      occurredAt: '2026-10-31T18:00:00.000Z',
      productId: 'p1',
      productName: 'Harina',
      baseUnit: 'g',
      quantity: -200,
      status: 'registered',
      errorCode: null,
    },
    {
      id: 'line-mozz',
      occurredAt: '2026-10-31T18:00:00.000Z',
      productId: 'p2',
      productName: 'Mozzarella',
      baseUnit: 'g',
      quantity: -80,
      status: 'registered',
      errorCode: null,
    },
  ],
}

const enrichedGroup: SaleConsumptionGroup = {
  sourceType: 'fudo',
  sourceId: '144382',
  occurredAt: '2026-10-11T13:57:00.000Z',
  status: 'complete',
  soldProductName: 'Coca Cola Zero',
  soldProductId: '183',
  recipeName: 'Coca Cola Zero',
  recipeId: 'recipe-1',
  soldQuantity: 1,
  soldUnit: 'unit',
  errorCode: null,
  lines: [{
    id: 'line-coca',
    occurredAt: '2026-10-11T13:57:00.000Z',
    productId: 'p3',
    productName: 'Coca Cola Zero',
    baseUnit: 'unit',
    quantity: -1,
    status: 'registered',
    errorCode: null,
  }],
}

describe('ventas y consumos', () => {
  it('conserva No consta cuando el movimiento no trae producto ni receta', () => {
    const html = renderToString(
      <SalesConsumptionBoard
        error=""
        groups={[legacyGroup]}
        loading={false}
        onSelect={() => undefined}
        selectedKey="fudo:884211"
      />,
    )
    expect(html).toContain('884211')
    expect(html).toContain('Fudo')
    expect(html).toContain('Harina')
    expect(html).toContain('Mozzarella')
    expect(html).toContain(harina)
    expect(html).toContain(mozzarella)
    expect(html).toContain('Registrado')
    expect(html).toContain('No consta')
    expect(html).toContain('Detalle · 884211')
    expect(html).not.toContain('Pizza')
  })

  it('muestra producto, receta y estado completo cuando el evento existe', () => {
    const html = renderToString(
      <SalesConsumptionBoard
        error=""
        groups={[enrichedGroup]}
        loading={false}
        onSelect={() => undefined}
        selectedKey="fudo:144382"
      />,
    )
    expect(html).toContain('Coca Cola Zero')
    expect(html).toContain('Completo')
    expect(html).toContain('Detalle · 144382')
    expect(html).toContain('Producto')
    expect(html).toContain('Receta')
    expect(html).not.toMatch(/>No consta</)
  })

  it('muestra un rechazo de stock sin tratarlo como venta completa', () => {
    const html = renderToString(
      <SalesConsumptionBoard
        error=""
        groups={[{
          sourceType: 'fudo',
          sourceId: '999001',
          occurredAt: '2026-11-02T12:00:00.000Z',
          status: 'failed',
          soldProductName: 'Coca Cola Zero',
          soldProductId: '183',
          recipeName: null,
          recipeId: null,
          soldQuantity: 1,
          soldUnit: 'unit',
          errorCode: 'SALE_EVENT_FAILED',
          lines: [{
            id: 'fail',
            occurredAt: '2026-11-02T12:00:00.000Z',
            productId: 'p3',
            productName: 'Coca Cola Zero',
            baseUnit: 'unit',
            quantity: -1,
            status: 'failed',
            errorCode: 'SALE_EXCEEDS_ON_HAND',
          }],
        }]}
        loading={false}
        onSelect={() => undefined}
        selectedKey="fudo:999001"
      />,
    )
    expect(html).toContain('Fallido')
    expect(html).toContain('SALE_EXCEEDS_ON_HAND')
    expect(html).not.toContain('>Completo</span>')
  })

  it('oculta eventos de prueba por defecto', () => {
    expect(isTestSource('senda_test')).toBe(true)
    const visible = filterSaleConsumptionGroups(
      [
        enrichedGroup,
        { ...enrichedGroup, sourceType: 'senda_test', sourceId: 't-1' },
      ],
      { query: '', status: 'all', source: 'all', date: '', includeTests: false },
    )
    expect(visible.map((row) => row.sourceId)).toEqual(['144382'])
  })

  it('separa carga, vacío y error', () => {
    const loading = renderToString(
      <SalesConsumptionBoard error="" groups={[]} loading onSelect={() => undefined} selectedKey="" />,
    )
    expect(loading).toContain('Cargando consumos…')

    const empty = renderToString(
      <SalesConsumptionBoard error="" groups={[]} loading={false} onSelect={() => undefined} selectedKey="" />,
    )
    expect(empty).toContain('Sin consumos registrados')

    const failed = renderToString(
      <SalesConsumptionBoard
        error="No se pudieron leer los consumos de esta sucursal."
        groups={[]}
        loading={false}
        onSelect={() => undefined}
        selectedKey=""
      />,
    )
    expect(failed).toContain('No se pudieron leer los consumos de esta sucursal.')
  })
})

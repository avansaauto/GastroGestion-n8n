import { describe, expect, it, vi } from 'vitest'
import { InvoiceApiError } from './api'
import {
  applyPendingReceptionResult,
  applyPendingReceptionsPage,
  mergePendingReceptions,
  pendingLineFromInvoiceDetail,
  pendingLineToStoredLine,
  pendingReceptionsPath,
  reconcilePendingAfterReceive,
} from './pendingReceptions'
import { formatDisplayQuantity } from './receptionUnits'
import { createMemoryAttemptStore } from './receiveAttempt'
import { submitReceiveLine } from './receiveSubmit'
import type { InvoiceReceiveResult, InvoiceStoredLine, PendingReceptionLine } from './types'

function line(overrides: Partial<PendingReceptionLine> = {}): PendingReceptionLine {
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

describe('paginación de recepciones pendientes', () => {
  it('arma la ruta con locationId y cursor, sin organizationId', () => {
    expect(pendingReceptionsPath('loc-a')).toBe('/api/invoices/pending-receptions?locationId=loc-a')
    expect(pendingReceptionsPath('loc-a', { cursor: 'line-9', limit: 20 })).toBe(
      '/api/invoices/pending-receptions?locationId=loc-a&cursor=line-9&limit=20',
    )
    expect(pendingReceptionsPath('loc-a', { cursor: null })).not.toContain('cursor=')
    expect(pendingReceptionsPath('loc-a')).not.toContain('organizationId')
  })

  it('evita duplicados al concatenar páginas', () => {
    const first = line({ lineId: 'line-1', ingredientName: 'Pilsen' })
    const duplicate = line({ lineId: 'line-1', ingredientName: 'Pilsen repetida' })
    const second = line({ lineId: 'line-2', ingredientName: 'Harina' })
    const merged = mergePendingReceptions([first], [duplicate, second])
    expect(merged.map((row) => row.lineId)).toEqual(['line-1', 'line-2'])
    expect(merged[0]?.ingredientName).toBe('Pilsen')
  })

  it('conserva nextCursor aunque la página sea parcial', () => {
    const current = [line({ lineId: 'line-1' })]
    const partial = [
      line({ lineId: 'line-2' }),
      line({ lineId: 'line-3' }),
    ]
    const appended = applyPendingReceptionsPage(current, partial, 'append')
    expect(appended).toHaveLength(3)
    expect(partial).toHaveLength(2)
  })

  it('aísla los datos al cambiar de local', () => {
    const locA = [line({ lineId: 'line-a', locationId: 'loc-a', ingredientName: 'Pilsen' })]
    const locB = [line({ lineId: 'line-b', locationId: 'loc-b', ingredientName: 'Harina' })]
    const replaced = applyPendingReceptionsPage(locA, locB, 'replace')
    expect(replaced.map((row) => row.lineId)).toEqual(['line-b'])
    expect(replaced[0]?.ingredientName).toBe('Harina')
    expect(replaced.some((row) => row.locationId === 'loc-a')).toBe(false)
  })
})

function receipt(overrides: Partial<InvoiceReceiveResult> = {}): InvoiceReceiveResult {
  return {
    id: 'receipt-1',
    purchaseDocumentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    purchaseDocumentLineId: '11111111-1111-4111-8111-111111111111',
    quantity: 20000,
    invoicedQuantity: 50000,
    receivedQuantity: 20000,
    remainingQuantity: 30000,
    documentStatus: 'reviewed',
    inventoryMovementId: 'mov-1',
    idempotent: false,
    ...overrides,
  }
}

describe('recepción desde pendientes', () => {
  it('recibe 20 L de 50 L pendientes y deja 30 L', () => {
    const items = [line({ invoicedQuantity: 50000, receivedQuantity: 0, remainingQuantity: 50000 })]
    const next = applyPendingReceptionResult(items, receipt())
    expect(next).toHaveLength(1)
    expect(next[0]?.receivedQuantity).toBe(20000)
    expect(next[0]?.remainingQuantity).toBe(30000)
    expect(next[0]?.invoicedQuantity).toBe(50000)
    expect(next[0]?.locationId).toBe('loc-a')
  })

  it('retira la línea cuando la recepción completa deja pendiente en cero', () => {
    const items = [
      line({ invoicedQuantity: 50000, receivedQuantity: 0, remainingQuantity: 50000 }),
      line({ lineId: 'line-other', ingredientName: 'Harina' }),
    ]
    const next = applyPendingReceptionResult(items, receipt({
      quantity: 50000,
      receivedQuantity: 50000,
      remainingQuantity: 0,
    }))
    expect(next.map((row) => row.lineId)).toEqual(['line-other'])
  })

  it('aplica dos recepciones sucesivas sin duplicar la línea', () => {
    const items = [line({ invoicedQuantity: 50000, receivedQuantity: 0, remainingQuantity: 50000 })]
    const afterFirst = applyPendingReceptionResult(items, receipt())
    const afterSecond = applyPendingReceptionResult(afterFirst, receipt({
      id: 'receipt-2',
      quantity: 30000,
      receivedQuantity: 50000,
      remainingQuantity: 0,
    }))
    expect(afterFirst).toHaveLength(1)
    expect(afterSecond).toHaveLength(0)
  })

  it('mapea la línea pendiente al formulario con el local de la factura', () => {
    const stored = pendingLineToStoredLine(line({ locationId: 'loc-factura' }))
    expect(stored.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(stored.mappingStatus).toBe('mapped')
    expect(stored.inventoryProduct?.baseUnit).toBe('ml')
    expect(stored.remainingQuantity).toBe(50000)
    expect(JSON.stringify(stored)).not.toContain('loc-ui')
  })

  it('actualiza el pendiente desde el detalle del servidor y no desde el local de la UI', () => {
    const current = line({ locationId: 'loc-factura', remainingQuantity: 50000, receivedQuantity: 0 })
    const stored: InvoiceStoredLine = pendingLineToStoredLine({
      ...current,
      receivedQuantity: 20000,
      remainingQuantity: 30000,
    })
    const next = pendingLineFromInvoiceDetail(current, {
      locationId: 'loc-factura',
      lines: [stored],
    })
    expect(next?.locationId).toBe('loc-factura')
    expect(next?.remainingQuantity).toBe(30000)
    expect(next?.locationId).not.toBe('loc-ui')
  })

  it('retira la línea si otra sesión ya cubrió el pendiente', () => {
    const current = line({ remainingQuantity: 50000 })
    const stored = pendingLineToStoredLine({ ...current, receivedQuantity: 50000, remainingQuantity: 0 })
    expect(pendingLineFromInvoiceDetail(current, {
      locationId: 'loc-a',
      lines: [stored],
    })).toBeNull()
    const reconciled = reconcilePendingAfterReceive(
      [current],
      receipt({ remainingQuantity: 0, receivedQuantity: 50000, quantity: 50000 }),
      { locationId: 'loc-a', lines: [stored] },
    )
    expect(reconciled).toHaveLength(0)
  })

  it('convierte 20 L a 20.000 ml y 2 kg a 2.000 g en el envío existente', async () => {
    const receiveLine = vi.fn(async (_invoice, _line, input) => receipt({
      quantity: input.quantity,
      receivedQuantity: input.quantity,
      remainingQuantity: 50000 - input.quantity,
      invoicedQuantity: 50000,
    }))
    const litres = await submitReceiveLine({
      invoiceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      lineId: '11111111-1111-4111-8111-111111111111',
      remaining: 50000,
      unit: 'ml',
      displayValue: '20',
      store: createMemoryAttemptStore(),
      receiveLine,
      createKey: () => 'key-l',
    })
    expect(litres.kind).toBe('success')
    expect(receiveLine).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      { quantity: 20000, idempotencyKey: 'key-l' },
    )

    const kilos = await submitReceiveLine({
      invoiceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      lineId: '22222222-2222-4222-8222-222222222222',
      remaining: 50000,
      unit: 'g',
      displayValue: '2',
      store: createMemoryAttemptStore(),
      receiveLine,
      createKey: () => 'key-kg',
    })
    expect(kilos.kind).toBe('success')
    expect(receiveLine).toHaveBeenLastCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      { quantity: 2000, idempotencyKey: 'key-kg' },
    )
  })

  it('reutiliza la clave ante un error de red y no duplica el envío en un doble clic', async () => {
    const store = createMemoryAttemptStore()
    const receiveLine = vi.fn()
      .mockRejectedValueOnce(new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK'))
      .mockResolvedValueOnce(receipt())
    const first = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 50000,
      unit: 'ml',
      displayValue: '20',
      store,
      receiveLine,
      createKey: () => 'key-retry',
    })
    expect(first.kind).toBe('uncertain')

    const retry = await submitReceiveLine({
      invoiceId: 'inv-1',
      lineId: 'line-1',
      remaining: 50000,
      unit: 'ml',
      displayValue: '20',
      store,
      receiveLine,
      createKey: () => 'key-other',
    })
    expect(retry.kind).toBe('success')
    expect(receiveLine).toHaveBeenNthCalledWith(1, 'inv-1', 'line-1', { quantity: 20000, idempotencyKey: 'key-retry' })
    expect(receiveLine).toHaveBeenNthCalledWith(2, 'inv-1', 'line-1', { quantity: 20000, idempotencyKey: 'key-retry' })

    let release: () => void = () => undefined
    const pending = new Promise<InvoiceReceiveResult>((resolve) => {
      release = () => resolve(receipt())
    })
    let started: () => void = () => undefined
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const slow = vi.fn(async () => {
      started()
      return pending
    })
    const inFlight = submitReceiveLine({
      invoiceId: 'inv-2',
      lineId: 'line-2',
      remaining: 50000,
      unit: 'ml',
      displayValue: '20',
      store: createMemoryAttemptStore(),
      receiveLine: slow,
      createKey: () => 'key-dbl',
    })
    await startedPromise
    const ignored = await submitReceiveLine({
      invoiceId: 'inv-2',
      lineId: 'line-2',
      remaining: 50000,
      unit: 'ml',
      displayValue: '20',
      store: createMemoryAttemptStore(),
      receiveLine: slow,
      createKey: () => 'key-dbl',
    })
    expect(ignored.kind).toBe('ignored')
    expect(slow).toHaveBeenCalledTimes(1)
    release()
    expect((await inFlight).kind).toBe('success')
  })

  it('conserva la autoridad del servidor si el pendiente cambió en otra sesión', async () => {
    const items = [line({ remainingQuantity: 50000, receivedQuantity: 0, invoicedQuantity: 50000 })]
    const receiveLine = vi.fn(async () => {
      throw new InvoiceApiError('La cantidad supera lo pendiente de esta línea.', 422, 'RECEIPT_EXCEEDS_INVOICED')
    })
    const outcome = await submitReceiveLine({
      invoiceId: items[0]!.invoiceId,
      lineId: items[0]!.lineId,
      remaining: 50000,
      unit: 'ml',
      displayValue: '40',
      store: createMemoryAttemptStore(),
      receiveLine,
      createKey: () => 'key-stale',
    })
    expect(outcome.kind).toBe('error')
    expect(outcome.kind === 'error' && outcome.message).toBe('La cantidad supera lo pendiente de esta línea.')
    expect(items[0]?.remainingQuantity).toBe(50000)

    const synced = pendingLineFromInvoiceDetail(items[0]!, {
      locationId: 'loc-a',
      lines: [pendingLineToStoredLine({ ...items[0]!, receivedQuantity: 30000, remainingQuantity: 20000 })],
    })
    expect(synced?.remainingQuantity).toBe(20000)
    const retry = await submitReceiveLine({
      invoiceId: items[0]!.invoiceId,
      lineId: items[0]!.lineId,
      remaining: synced!.remainingQuantity,
      unit: 'ml',
      displayValue: '40',
      store: createMemoryAttemptStore(),
      receiveLine: vi.fn(),
      createKey: () => 'key-after-refresh',
    })
    expect(retry).toEqual({ kind: 'validation', message: 'La cantidad supera lo pendiente de esta línea.' })
  })
})

describe('por qué un pendiente puede desaparecer sin verse en Inventario', () => {
  it('sale de la pantalla cuando remaining llega a 0, aunque el insumo ya existiera', () => {
    const items = [line({
      ingredientName: 'Ojo de bife',
      invoicedQuantity: 10000,
      receivedQuantity: 0,
      remainingQuantity: 10000,
    })]
    const next = applyPendingReceptionResult(items, receipt({
      quantity: 10000,
      receivedQuantity: 10000,
      remainingQuantity: 0,
    }))
    expect(next).toEqual([])
  })

  it('Inventario busca por nombre de insumo, no por descripción de factura', () => {
    const catalog = [{ name: 'Ojo de bife' }, { name: 'Vacío' }]
    const invoiceDescription = 'CARNE VACUNA CONG'
    const term = invoiceDescription.toLocaleLowerCase('es')
    const hits = catalog.filter((product) => product.name.toLocaleLowerCase('es').includes(term))
    expect(hits).toEqual([])
    expect(catalog.some((product) => product.name === 'Ojo de bife')).toBe(true)
  })

  it('Pendientes muestra kg y Inventario muestra g del mismo stock', () => {
    expect(formatDisplayQuantity(10000, 'g', (value) => String(value))).toBe('10 kg')
    expect(formatDisplayQuantity(10000, 'g', (value) => String(value))).not.toContain('10000')
  })
})

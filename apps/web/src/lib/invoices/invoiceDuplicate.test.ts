import { createHash, webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { InvoiceApiError } from './api'
import { sha256Hex, sha256HexOfFile } from './fileHash'
import {
  beginAnalyze,
  beginDuplicateCheck,
  beginSave,
  canAnalyze,
  canSaveInvoice,
  applyDuplicateLookup,
  applyDuplicateOutcome,
  failDuplicateLookup,
  initialInvoiceFlow,
  prepareDuplicateContext,
  saveBlockedReason,
  selectInvoiceFile,
  succeedAnalyze,
} from './flow'
import {
  analyzeWithDuplicateGuard,
  buildDuplicateLookupPath,
  duplicateContextKey,
  fiscalIdentityFromAnalysis,
  hashAndLookupDuplicate,
  invoiceFileKey,
  lookupFiscalDuplicate,
  lookupHashDuplicate,
  shouldShowInvoiceReview,
} from './invoiceDuplicate'
import { isCompleteVoucherIdentity } from './invoiceVoucher'
import { ALREADY_REGISTERED_MESSAGE, intakeOutcomeSummary, saveThenApplyIntake } from './reviewIntake'
import { savedInvoiceResult, signedInvoiceResult } from './fixtures'
import type { InvoiceDuplicateMatch } from './types'

const LOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FILE_HASH = 'ab'.repeat(32)
const MATCH: InvoiceDuplicateMatch = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  supplierName: 'LUPULO SRL',
  documentNumber: '00007-00006046',
  documentDate: '2026-10-01',
  status: 'reviewed',
  locationId: LOC_ID,
}

function fakeFile(name: string, type: string, contents = 'pdf-bytes') {
  const blob = new Blob([contents], { type })
  return Object.assign(blob, { name, lastModified: 1_700_000_000_000 }) as File
}

function selectedState() {
  return selectInvoiceFile(initialInvoiceFlow, fakeFile('factura.pdf', 'application/pdf'))
}

function matchedState(source: 'hash' | 'fiscal' = 'hash') {
  const contextKey = duplicateContextKey(LOC_ID, invoiceFileKey(selectedState().file!.file))
  const checking = beginDuplicateCheck(selectedState(), contextKey)
  return applyDuplicateLookup(checking, { contextKey, match: MATCH, source })
}

describe('hash SHA-256 local', () => {
  it('calcula el SHA-256 de los bytes originales con Web Crypto', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const bytes = new TextEncoder().encode('abc')
    const hex = await sha256Hex(bytes)
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hex).toBe(createHash('sha256').update(bytes).digest('hex'))
    const file = fakeFile('factura.pdf', 'application/pdf', 'abc')
    expect(await sha256HexOfFile(file)).toBe(hex)
  })
})

describe('detección temprana de duplicados', () => {
  it('no inicia Gemini si el hash ya coincide', async () => {
    const analyze = vi.fn()
    const matched = matchedState('hash')
    expect(canAnalyze(matched)).toBe(false)
    expect(beginAnalyze(matched)).toBeNull()
    expect(analyze).not.toHaveBeenCalled()
    expect(shouldShowInvoiceReview(matched.result, matched.duplicate)).toBe(false)
  })

  it('permite el análisis habitual si no hay coincidencia', async () => {
    const result = signedInvoiceResult()
    const analyze = vi.fn(async () => result)
    const lookup = vi.fn(async () => null)
    const outcome = await analyzeWithDuplicateGuard({
      locationId: LOC_ID,
      isCurrent: () => true,
      analyze,
      lookupFiscal: lookup,
    })
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ kind: 'analyzed', duplicate: { kind: 'clear' } })
    const contextKey = 'loc::file'
    const reviewed = succeedAnalyze(beginAnalyze(selectedState())!, result)
    const cleared = applyDuplicateOutcome(beginDuplicateCheck(reviewed, contextKey), contextKey, { kind: 'clear' }, 'hash')
    expect(canAnalyze(cleared)).toBe(true)
    expect(shouldShowInvoiceReview(cleared.result, cleared.duplicate)).toBe(true)
  })

  it('bloquea el guardado si hay coincidencia fiscal después de Gemini', async () => {
    const result = signedInvoiceResult()
    const lookup = vi.fn(async () => MATCH)
    const outcome = await analyzeWithDuplicateGuard({
      locationId: LOC_ID,
      isCurrent: () => true,
      analyze: async () => result,
      lookupFiscal: lookup,
    })
    expect(outcome.kind).toBe('analyzed')
    if (outcome.kind !== 'analyzed') return
    expect(outcome.duplicate).toEqual({ kind: 'matched', match: MATCH })
    const contextKey = 'loc::file'
    const reviewed = applyDuplicateOutcome(
      beginDuplicateCheck(succeedAnalyze(beginAnalyze(selectedState())!, result), contextKey),
      contextKey,
      outcome.duplicate,
      'fiscal',
    )
    expect(canSaveInvoice(reviewed, LOC_ID)).toBe(false)
    expect(beginSave(reviewed, LOC_ID)).toBeNull()
    expect(saveBlockedReason(reviewed, LOC_ID, false)).toBe('Esta factura ya está registrada.')
    expect(shouldShowInvoiceReview(reviewed.result, reviewed.duplicate)).toBe(false)
  })

  it('no asume duplicado si la identidad fiscal está incompleta', async () => {
    const result = signedInvoiceResult({
      document: {
        ...signedInvoiceResult().document,
        supplier: { name: 'LUPULO SRL', taxId: '30' },
        header: {
          ...signedInvoiceResult().document.header,
          number: '00007',
        },
      },
    })
    expect(isCompleteVoucherIdentity(fiscalIdentityFromAnalysis(result))).toBe(false)
    const lookup = vi.fn()
    const fiscal = await lookupFiscalDuplicate({
      locationId: LOC_ID,
      result,
      isCurrent: () => true,
      lookup,
    })
    expect(fiscal).toEqual({ kind: 'skipped' })
    expect(lookup).not.toHaveBeenCalled()
    const analyzed = await analyzeWithDuplicateGuard({
      locationId: LOC_ID,
      isCurrent: () => true,
      analyze: async () => result,
      lookupFiscal: lookup,
    })
    expect(analyzed).toMatchObject({ kind: 'analyzed', duplicate: { kind: 'skipped' } })
  })

  it('advierte si falla la red y no asume que el documento no existe', async () => {
    const lookup = vi.fn(async () => {
      throw new InvoiceApiError('No se pudo conectar con el servidor.', 0, 'NETWORK')
    })
    const hashOutcome = await lookupHashDuplicate({
      locationId: LOC_ID,
      fileSha256: FILE_HASH,
      isCurrent: () => true,
      lookup,
    })
    expect(hashOutcome).toEqual({ kind: 'failed' })
    const contextKey = duplicateContextKey(LOC_ID, 'file')
    const failed = failDuplicateLookup(beginDuplicateCheck(selectedState(), contextKey), contextKey)
    expect(failed.duplicate.warning).toBe('No se pudo comprobar si esta factura ya existe')
    expect(failed.duplicate.match).toBeNull()
    expect(canAnalyze(failed)).toBe(true)
    expect(canSaveInvoice(succeedAnalyze(beginAnalyze(failed)!, signedInvoiceResult()), LOC_ID)).toBe(true)

    const fiscal = await lookupFiscalDuplicate({
      locationId: LOC_ID,
      result: signedInvoiceResult(),
      isCurrent: () => true,
      lookup,
    })
    expect(fiscal).toEqual({ kind: 'failed' })
  })

  it('una factura eliminada no bloquea el análisis ni el guardado', () => {
    const contextKey = duplicateContextKey(LOC_ID, 'file')
    const noted = applyDuplicateLookup(beginDuplicateCheck(selectedState(), contextKey), {
      contextKey,
      match: { ...MATCH, disposition: 'deleted' },
      source: 'hash',
    })
    expect(noted.duplicate.status).toBe('noted')
    expect(canAnalyze(noted)).toBe(true)
    expect(canSaveInvoice(succeedAnalyze(beginAnalyze(noted)!, signedInvoiceResult()), LOC_ID)).toBe(true)
    expect(shouldShowInvoiceReview(signedInvoiceResult(), noted.duplicate)).toBe(true)
    const active = applyDuplicateLookup(beginDuplicateCheck(selectedState(), contextKey), {
      contextKey,
      match: MATCH,
      source: 'fiscal',
    })
    expect(active.duplicate.status).toBe('matched')
    expect(canAnalyze(active)).toBe(false)
  })

  it('invalida la búsqueda al cambiar archivo o local', async () => {
    const firstKey = duplicateContextKey('loc-1', 'uno.pdf:1:1')
    const secondKey = duplicateContextKey('loc-2', 'dos.pdf:2:2')
    const checking = beginDuplicateCheck(selectedState(), firstKey)
    const stale = applyDuplicateLookup(beginDuplicateCheck(checking, secondKey), {
      contextKey: firstKey,
      match: MATCH,
      source: 'hash',
    })
    expect(stale.duplicate.status).toBe('checking')
    expect(stale.duplicate.contextKey).toBe(secondKey)
    expect(stale.duplicate.match).toBeNull()
    const analyzing = beginAnalyze(selectedState())!
    const prepared = prepareDuplicateContext(analyzing, secondKey)
    expect(prepared.status).toBe('idle')
    expect(prepared.result).toBeNull()
    expect(prepared.duplicate.status).toBe('checking')
  })

  it('ignora una respuesta tardía', async () => {
    let current = true
    const lookup = vi.fn(async () => MATCH)
    const lateHash = await hashAndLookupDuplicate({
      file: fakeFile('factura.pdf', 'application/pdf'),
      locationId: LOC_ID,
      isCurrent: () => current,
      hashFile: async () => {
        current = false
        return FILE_HASH
      },
      lookup,
    })
    expect(lateHash).toEqual({ kind: 'stale' })
    expect(lookup).not.toHaveBeenCalled()

    current = true
    const lateLookup = await lookupHashDuplicate({
      locationId: LOC_ID,
      fileSha256: FILE_HASH,
      isCurrent: () => current,
      lookup: async () => {
        current = false
        return MATCH
      },
    })
    expect(lateLookup).toEqual({ kind: 'stale' })
  })

  it('descarta Gemini si el archivo o el local cambian durante el análisis', async () => {
    const lookup = vi.fn()
    let current = true
    const outcome = await analyzeWithDuplicateGuard({
      locationId: LOC_ID,
      isCurrent: () => current,
      analyze: async () => {
        current = false
        return signedInvoiceResult()
      },
      lookupFiscal: lookup,
    })
    expect(outcome).toEqual({ kind: 'stale' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('idempotent: true continúa sin intake', async () => {
    const getInvoiceFn = vi.fn()
    const receiveFn = vi.fn()
    const outcome = await saveThenApplyIntake({
      savedDocument: savedInvoiceResult({ idempotent: true }),
      planned: [],
      saveInvoice: async () => savedInvoiceResult({ id: 'doc-should-not-save' }),
      ports: {
        getInvoice: getInvoiceFn,
        mapInvoiceLine: vi.fn(),
        receiveInvoiceLine: receiveFn,
      },
    })
    expect(getInvoiceFn).not.toHaveBeenCalled()
    expect(receiveFn).not.toHaveBeenCalled()
    expect(outcome.summary.kind).toBe('already_registered')
    expect(intakeOutcomeSummary({
      saved: savedInvoiceResult({ idempotent: true }),
      intakeLines: [],
    })?.body).toBe(ALREADY_REGISTERED_MESSAGE)
  })

  it('no registra stock durante ninguna comprobación', async () => {
    const receive = vi.fn()
    const save = vi.fn()
    const lookup = vi.fn(async (query) => {
      expect(query).not.toHaveProperty('organizationId')
      return null
    })
    await hashAndLookupDuplicate({
      file: fakeFile('factura.pdf', 'application/pdf'),
      locationId: LOC_ID,
      isCurrent: () => true,
      hashFile: async () => FILE_HASH,
      lookup,
    })
    await lookupFiscalDuplicate({
      locationId: LOC_ID,
      result: signedInvoiceResult(),
      isCurrent: () => true,
      lookup,
    })
    expect(receive).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(buildDuplicateLookupPath({ locationId: LOC_ID, fileSha256: FILE_HASH })).not.toContain('organizationId')
    expect(buildDuplicateLookupPath({
      locationId: LOC_ID,
      issuerTaxId: '30714329401',
      voucherType: 'A',
      pointOfSale: '00007',
      voucherNumber: '00006046',
    })).toBe(
      `/api/invoices/duplicates?locationId=${LOC_ID}&issuerTaxId=30714329401&voucherType=A&pointOfSale=00007&voucherNumber=00006046`,
    )
  })
})

import { describe, expect, it } from 'vitest'
import { sha256Hex } from './fileHash.js'
import {
  hashAnalysisSnapshot,
  issueInvoiceIntegrityToken,
  InvoiceIntegrityError,
  verifyInvoiceIntegrity,
  type InvoiceIntegritySnapshot,
} from './invoiceIntegrity.js'

const SECRET = 'test-integrity-secret-not-for-production'
const OTHER = 'another-secret'
const PDF = Buffer.from('%PDF-1.4\nfixture')
const OTHER_PDF = Buffer.from('%PDF-1.4\nother')

function snapshot(overrides: Partial<InvoiceIntegritySnapshot> = {}): InvoiceIntegritySnapshot {
  return {
    document: {
      supplier: { name: 'Alimentos Demo SA', taxId: '30-12345678-1' },
      amounts: { total: 1210 },
      lines: [{ id: 'line-harina', amount: 1000 }],
    },
    interpretation: { relations: [], consistency: 'consistent' },
    validation: { status: 'ready' },
    inventory: { eligibleLines: 1, shouldOfferFutureReceipt: true },
    metadata: {
      provider: 'fake-ai',
      model: 'fixture',
      promptVersion: 'senda-invoice-v2-service',
      processingTimeMs: 12,
      fileSha256: sha256Hex(PDF),
    },
    ...overrides,
  }
}

describe('token HMAC de integridad del análisis', () => {
  it('acepta un token válido para el mismo usuario, archivo y snapshot', () => {
    const data = snapshot()
    const issued = issueInvoiceIntegrityToken({
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
      now: new Date('2026-10-14T14:00:00.000Z'),
    })
    const verified = verifyInvoiceIntegrity({
      token: issued.token,
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: { ...data, metadata: { ...data.metadata, integrityToken: issued.token } },
      secret: SECRET,
      now: new Date('2026-10-14T14:30:00.000Z'),
    })
    expect(verified.sub).toBe('user-1')
    expect(verified.fileSha256).toBe(sha256Hex(PDF))
    expect(verified.snapshotSha256).toBe(hashAnalysisSnapshot(data))
    expect(issued.token).not.toContain(SECRET)
  })

  it('rechaza un token modificado', () => {
    const data = snapshot()
    const issued = issueInvoiceIntegrityToken({
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
    })
    const tampered = `${issued.token.slice(0, -4)}aaaa`
    expect(() => verifyInvoiceIntegrity({
      token: tampered,
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
    })).toThrow(InvoiceIntegrityError)
    try {
      verifyInvoiceIntegrity({
        token: tampered,
        userId: 'user-1',
        fileSha256: sha256Hex(PDF),
        snapshot: data,
        secret: SECRET,
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'TOKEN_INVALID' })
    }
    expect(() => verifyInvoiceIntegrity({
      token: issued.token,
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: OTHER,
    })).toThrow(InvoiceIntegrityError)
  })

  it('rechaza un archivo diferente aunque el cliente copie el hash', () => {
    const data = snapshot()
    const issued = issueInvoiceIntegrityToken({
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
    })
    expect(() => verifyInvoiceIntegrity({
      token: issued.token,
      userId: 'user-1',
      fileSha256: sha256Hex(OTHER_PDF),
      snapshot: {
        ...data,
        metadata: { ...data.metadata, fileSha256: sha256Hex(PDF) },
      },
      secret: SECRET,
    })).toThrow(/archivo no coincide/)
  })

  it('rechaza un snapshot con importes o clasificación alterados', () => {
    const data = snapshot()
    const issued = issueInvoiceIntegrityToken({
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
    })
    const altered = snapshot({
      document: {
        supplier: { name: 'Alimentos Demo SA', taxId: '30-12345678-1' },
        amounts: { total: 1 },
        lines: [{ id: 'line-harina', amount: 1 }],
      },
    })
    expect(() => verifyInvoiceIntegrity({
      token: issued.token,
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: altered,
      secret: SECRET,
    })).toThrow(/modificado/)
  })

  it('rechaza un usuario diferente', () => {
    const data = snapshot()
    const issued = issueInvoiceIntegrityToken({
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
    })
    expect(() => verifyInvoiceIntegrity({
      token: issued.token,
      userId: 'user-2',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
    })).toThrow(/otro usuario/)
  })

  it('rechaza un token expirado', () => {
    const data = snapshot()
    const issued = issueInvoiceIntegrityToken({
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
      ttlSeconds: 60,
      now: new Date('2026-10-14T14:00:00.000Z'),
    })
    expect(() => verifyInvoiceIntegrity({
      token: issued.token,
      userId: 'user-1',
      fileSha256: sha256Hex(PDF),
      snapshot: data,
      secret: SECRET,
      now: new Date('2026-10-14T14:05:00.000Z'),
    })).toThrow(/expiró/)
  })
})

import { describe, expect, it } from 'vitest'
import {
  classifyInventoryWriteError,
  redactInventoryDiagnostic,
} from './inventoryWriteError.js'

describe('diagnóstico de alta de insumos', () => {
  it('no registra JWT ni claves', () => {
    expect(redactInventoryDiagnostic('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb')).toBe('Bearer [redacted]')
    expect(redactInventoryDiagnostic('apikey service_role leaked')).toBe('[redacted] [redacted] leaked')
  })

  it('separa permiso, duplicado, validación y representación vacía', () => {
    expect(classifyInventoryWriteError({
      code: '42501',
      message: 'new row violates row-level security policy',
    }, null).kind).toBe('denied')
    expect(classifyInventoryWriteError({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    }, null).kind).toBe('duplicate')
    expect(classifyInventoryWriteError({
      code: '23514',
      message: 'new row violates check constraint',
    }, null).kind).toBe('invalid')
    expect(classifyInventoryWriteError({
      code: 'PGRST116',
      message: 'The result contains 0 rows',
    }, null).kind).toBe('empty_representation')
    expect(classifyInventoryWriteError(null, null).kind).toBe('empty_representation')
    expect(classifyInventoryWriteError(null, []).kind).toBe('empty_representation')
  })
})

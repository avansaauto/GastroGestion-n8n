import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'

export class ProviderSecretCipherError extends Error {
  constructor(public readonly code: 'KEY_MISSING' | 'KEY_INVALID' | 'CIPHER_INVALID') {
    super(code)
    this.name = 'ProviderSecretCipherError'
  }
}

/** Clave AES-256 distinta del pepper de los tokens snd_. */
export function decodeProviderCredentialsKey(raw: string | undefined): Buffer {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) throw new ProviderSecretCipherError('KEY_MISSING')
  const key = Buffer.from(trimmed, 'base64')
  if (key.length !== 32) throw new ProviderSecretCipherError('KEY_INVALID')
  return key
}

export function encryptProviderSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION}:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`
}

export function decryptProviderSecret(payload: string, key: Buffer): string {
  if (!payload.startsWith(`${VERSION}:`)) throw new ProviderSecretCipherError('CIPHER_INVALID')
  const packed = Buffer.from(payload.slice(VERSION.length + 1), 'base64')
  if (packed.length < 29) throw new ProviderSecretCipherError('CIPHER_INVALID')
  const iv = packed.subarray(0, 12)
  const tag = packed.subarray(12, 28)
  const ciphertext = packed.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new ProviderSecretCipherError('CIPHER_INVALID')
  }
}

import { createHash } from 'node:crypto'

/** SHA-256 hex lowercase de los bytes recibidos. No usar un hash enviado por el cliente. */
export function sha256Hex(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(data: BufferSource): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('WEB_CRYPTO_UNAVAILABLE')
  }
  const digest = await subtle.digest('SHA-256', data)
  return toHex(new Uint8Array(digest))
}

export async function sha256HexOfFile(file: Blob): Promise<string> {
  return sha256Hex(await file.arrayBuffer())
}

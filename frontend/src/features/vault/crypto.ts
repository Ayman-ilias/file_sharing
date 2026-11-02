// My storage encryption, all in the browser (WebCrypto). The server only ever stores the output.
//
// Formats (all versioned so the KDF or cipher can change later):
//   wrapped key  = 0x01 ‖ iv(12) ‖ AES-GCM(raw data key)            (base64)
//   meta         = 0x01 ‖ iv(12) ‖ AES-GCM(JSON), AAD "fsv1:meta"   (base64)
//   blob         = "FSV1" ‖ uint32 segment size ‖ nonce prefix(8) ‖ segments
//   segment i    = AES-GCM(plain ≤ segment), IV = prefix ‖ uint32 i, AAD "fsv1:blob:<i>:<end|more>"
import type { VaultMeta } from './api'

export const ITERATIONS = 600_000
export const SEGMENT = 4 * 1024 * 1024
const HEADER = 16
const TAG = 16
const VERSION = 1
const MAGIC = 'FSV1'
const enc = new TextEncoder()
const dec = new TextDecoder()

export class WrongPassword extends Error {
  constructor() {
    super('wrong storage password')
    this.name = 'WrongPassword'
  }
}

export class Corrupt extends Error {
  constructor(what = 'data') {
    super(`this ${what} can't be decrypted`)
    this.name = 'Corrupt'
  }
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  } catch {
    throw new Corrupt()
  }
}

export const newSalt = () => toB64(random(16))

/** Storage password → key-encryption key (PBKDF2-SHA-256, at least 600 000 rounds). */
export async function deriveKek(password: string, salt: string, iterations: number): Promise<CryptoKey> {
  if (!Number.isInteger(iterations) || iterations < ITERATIONS) throw new Error('too few KDF iterations')
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'],
  )
}

/** A fresh data key. Extractable only so it can be wrapped once; re-unwrap before keeping it. */
export const newDataKey = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])

export async function wrapDataKey(key: CryptoKey, kek: CryptoKey): Promise<string> {
  const iv = random(12)
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', key, kek, { name: 'AES-GCM', iv }))
  return toB64(concat([Uint8Array.of(VERSION), iv, wrapped]))
}

export async function unwrapDataKey(wrapped: string, kek: CryptoKey, { extractable = false } = {}): Promise<CryptoKey> {
  const raw = fromB64(wrapped)
  if (raw[0] !== VERSION || raw.length < 1 + 12 + TAG) throw new Corrupt('key')
  try {
    return await crypto.subtle.unwrapKey('raw', raw.subarray(13), kek, { name: 'AES-GCM', iv: raw.subarray(1, 13) },
      { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt'])
  } catch {
    throw new WrongPassword()
  }
}

export async function encryptMeta(meta: VaultMeta, key: CryptoKey): Promise<string> {
  const iv = random(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('fsv1:meta') },
    key, enc.encode(JSON.stringify(meta)))
  return toB64(concat([Uint8Array.of(VERSION), iv, new Uint8Array(ct)]))
}

export async function decryptMeta(ct: string, key: CryptoKey): Promise<VaultMeta> {
  const raw = fromB64(ct)
  if (raw[0] !== VERSION || raw.length < 1 + 12 + TAG) throw new Corrupt('item')
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(1, 13), additionalData: enc.encode('fsv1:meta') }, key, raw.subarray(13))
    return JSON.parse(dec.decode(plain)) as VaultMeta
  } catch {
    throw new Corrupt('item')
  }
}

/** Exact ciphertext size, so the quota can be checked before spending time encrypting. */
export function cipherSize(plainSize: number, segment = SEGMENT): number {
  return HEADER + Math.max(1, Math.ceil(plainSize / segment)) * TAG + plainSize
}

function segmentIv(prefix: Uint8Array, i: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12)
  iv.set(prefix)
  new DataView(iv.buffer).setUint32(8, i)
  return iv
}

const segmentAad = (i: number, last: boolean) => enc.encode(`fsv1:blob:${i}:${last ? 'end' : 'more'}`)

/** Encrypt a file one segment at a time (the plaintext is never in memory twice). */
export async function encryptBlob(
  file: Blob, key: CryptoKey, { segment = SEGMENT, onProgress }: { segment?: number; onProgress?: (done: number) => void } = {},
): Promise<{ blob: Blob; prefix: string }> {
  const prefix = random(8)
  const header = new Uint8Array(HEADER)
  header.set(enc.encode(MAGIC))
  new DataView(header.buffer).setUint32(4, segment)
  header.set(prefix, 8)
  const parts: BlobPart[] = [header]
  const count = Math.max(1, Math.ceil(file.size / segment))
  for (let i = 0; i < count; i++) {
    const plain = await file.slice(i * segment, (i + 1) * segment).arrayBuffer()
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: segmentIv(prefix, i), additionalData: segmentAad(i, i === count - 1) }, key, plain)
    parts.push(new Uint8Array(ct))
    onProgress?.(Math.min(file.size, (i + 1) * segment))
  }
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), prefix: toB64(prefix) }
}

/** Decrypt segment by segment. Truncated, reordered, extended or foreign blobs → Corrupt. */
export async function decryptBlob(blob: Blob, key: CryptoKey, mime: string, expectedPrefix?: string): Promise<Blob> {
  if (blob.size < HEADER + TAG) throw new Corrupt('file')
  const header = new Uint8Array(await blob.slice(0, HEADER).arrayBuffer())
  if (dec.decode(header.subarray(0, 4)) !== MAGIC) throw new Corrupt('file')
  const segment = new DataView(header.buffer).getUint32(4)
  const prefix = header.slice(8, 16)
  if (segment < 1 || (expectedPrefix !== undefined && toB64(prefix) !== expectedPrefix)) throw new Corrupt('file')
  const parts: BlobPart[] = []
  let at = HEADER
  for (let i = 0; at < blob.size; i++) {
    const end = Math.min(blob.size, at + segment + TAG)
    const last = end === blob.size
    try {
      parts.push(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: segmentIv(prefix, i), additionalData: segmentAad(i, last) },
        key, await blob.slice(at, end).arrayBuffer()))
    } catch {
      throw new Corrupt('file')
    }
    at = end
  }
  return new Blob(parts, { type: mime })
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

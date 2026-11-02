// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Corrupt, ITERATIONS, WrongPassword, cipherSize, decryptBlob, decryptMeta, deriveKek, encryptBlob,
  encryptMeta, newDataKey, newSalt, unwrapDataKey, wrapDataKey,
} from './crypto'
import type { VaultMeta } from './api'

// PBKDF2 with 600 000 rounds is slow on purpose; a busy machine needs more than the 5 s default
vi.setConfig({ testTimeout: 20_000 })

afterEach(() => vi.restoreAllMocks())

const note: VaultMeta = { kind: 'note', title: 'Meeting notes, 28 Oct', text: 'Uttara rollout moves to 12 Nov. ✓ ক' }
const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 7) % 251))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

async function opened() {
  const salt = newSalt()
  const kek = await deriveKek('correct horse battery', salt, ITERATIONS)
  const key = await newDataKey()
  const wrapped = await wrapDataKey(key, kek)
  return { salt, kek, wrapped, key: await unwrapDataKey(wrapped, kek) }
}

describe('keys', () => {
  it('wrap → unwrap with the right password works; the held key is not extractable', async () => {
    const { key, wrapped } = await opened()
    expect(unb64(wrapped)[0]).toBe(1) // version byte
    expect(key.extractable).toBe(false)
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt'])
  })

  it('the wrong password throws WrongPassword', async () => {
    const { salt, wrapped } = await opened()
    const other = await deriveKek('wrong horse battery', salt, ITERATIONS)
    await expect(unwrapDataKey(wrapped, other)).rejects.toBeInstanceOf(WrongPassword)
  })

  it('an extractable unwrap is possible on purpose (only for changing the password)', async () => {
    const { kek, wrapped } = await opened()
    const k = await unwrapDataKey(wrapped, kek, { extractable: true })
    expect(k.extractable).toBe(true)
  })

  it('uses PBKDF2-SHA-256 with 600 000 iterations and refuses fewer', async () => {
    const spy = vi.spyOn(crypto.subtle, 'deriveKey')
    await deriveKek('pw-pw-pw-pw', newSalt(), ITERATIONS)
    expect(spy.mock.calls[0][0]).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 })
    await expect(deriveKek('pw-pw-pw-pw', newSalt(), 100_000)).rejects.toThrow()
  })

  it('normalises the password (NFC), so the same word typed differently opens the vault', async () => {
    const salt = newSalt()
    const composed = await deriveKek('café-password', salt, ITERATIONS)
    const decomposed = await deriveKek('café-password', salt, ITERATIONS)
    const key = await newDataKey()
    const wrapped = await wrapDataKey(key, composed)
    await expect(unwrapDataKey(wrapped, decomposed)).resolves.toBeDefined()
  })

  it('salts are 16 random bytes', () => {
    expect(unb64(newSalt())).toHaveLength(16)
    expect(newSalt()).not.toBe(newSalt())
  })
})

describe('meta', () => {
  it('round-trips', async () => {
    const { key } = await opened()
    expect(await decryptMeta(await encryptMeta(note, key), key)).toEqual(note)
  })

  it('two encryptions differ (fresh IV) and start with version 1', async () => {
    const { key } = await opened()
    const [a, b] = [await encryptMeta(note, key), await encryptMeta(note, key)]
    expect(a).not.toBe(b)
    expect(unb64(a)[0]).toBe(1)
  })

  it('a flipped byte → Corrupt', async () => {
    const { key } = await opened()
    const raw = unb64(await encryptMeta(note, key))
    raw[raw.length - 3] ^= 1
    await expect(decryptMeta(b64(raw), key)).rejects.toBeInstanceOf(Corrupt)
  })

  it('garbage or another version → Corrupt', async () => {
    const { key } = await opened()
    await expect(decryptMeta('bm90IGNpcGhlcg==', key)).rejects.toBeInstanceOf(Corrupt)
    const raw = unb64(await encryptMeta(note, key))
    raw[0] = 2
    await expect(decryptMeta(b64(raw), key)).rejects.toBeInstanceOf(Corrupt)
  })
})

describe('blobs', () => {
  const SEG = 1024

  async function sealed(n: number) {
    const { key } = await opened()
    const plain = bytes(n)
    const out = await encryptBlob(new Blob([plain]), key, { segment: SEG })
    return { key, plain, ...out }
  }

  it('round-trips across 3 segments with the right type and size', async () => {
    const { key, plain, blob, prefix } = await sealed(2500)
    expect(blob.size).toBe(cipherSize(2500, SEG))
    const back = await decryptBlob(blob, key, 'image/png', prefix)
    expect(back.type).toBe('image/png')
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(plain)
  })

  it('an empty file round-trips (one final segment)', async () => {
    const { key, blob, prefix } = await sealed(0)
    expect(blob.size).toBe(16 + 16)
    expect((await decryptBlob(blob, key, 'text/plain', prefix)).size).toBe(0)
  })

  it('the segment size is in the header', async () => {
    const { blob } = await sealed(10)
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
    expect(String.fromCharCode(...head.slice(0, 4))).toBe('FSV1')
    expect(new DataView(head.buffer).getUint32(4)).toBe(SEG)
  })

  it('a truncated blob → Corrupt', async () => {
    const { key, blob, prefix } = await sealed(2500)
    await expect(decryptBlob(blob.slice(0, blob.size - 5), key, 'x/y', prefix)).rejects.toBeInstanceOf(Corrupt)
  })

  it('a dropped last segment → Corrupt (the "end" AAD)', async () => {
    const { key, blob, prefix } = await sealed(2048) // exactly 2 full segments
    await expect(decryptBlob(blob.slice(0, 16 + (SEG + 16)), key, 'x/y', prefix)).rejects.toBeInstanceOf(Corrupt)
  })

  it('swapped segments → Corrupt', async () => {
    const { key, blob, prefix } = await sealed(2500)
    const head = blob.slice(0, 16)
    const s0 = blob.slice(16, 16 + SEG + 16)
    const s1 = blob.slice(16 + SEG + 16, 16 + 2 * (SEG + 16))
    const rest = blob.slice(16 + 2 * (SEG + 16))
    await expect(decryptBlob(new Blob([head, s1, s0, rest]), key, 'x/y', prefix)).rejects.toBeInstanceOf(Corrupt)
  })

  it('bytes after the end segment → Corrupt', async () => {
    const { key, blob, prefix } = await sealed(100)
    await expect(decryptBlob(new Blob([blob, new Uint8Array(20)]), key, 'x/y', prefix)).rejects.toBeInstanceOf(Corrupt)
  })

  it('a header-only blob or wrong magic → Corrupt', async () => {
    const { key, blob, prefix } = await sealed(100)
    await expect(decryptBlob(blob.slice(0, 16), key, 'x/y', prefix)).rejects.toBeInstanceOf(Corrupt)
    await expect(decryptBlob(new Blob(['XXXX', blob.slice(4)]), key, 'x/y', prefix)).rejects.toBeInstanceOf(Corrupt)
  })

  it('a blob from another item (different nonce prefix) → Corrupt', async () => {
    const a = await sealed(100)
    const b = await encryptBlob(new Blob([bytes(100)]), a.key, { segment: SEG })
    await expect(decryptBlob(b.blob, a.key, 'x/y', a.prefix)).rejects.toBeInstanceOf(Corrupt)
  })

  it('cipherSize matches the real ciphertext for the default segment', async () => {
    const { key } = await opened()
    const { blob } = await encryptBlob(new Blob([bytes(5000)]), key)
    expect(blob.size).toBe(cipherSize(5000))
  })
})

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeServer, memoryStorage } from '../uploads/fakeServer'
import { Uploader } from '../uploads/Uploader'
import type { FileMeta } from './api'
import { Corrupt } from './crypto'
import { fakeVault } from './fakeVault'
import { VaultStore } from './store'
import { addVaultFiles, markUnfinished, takeUnfinished } from './vaultFiles'

vi.setConfig({ testTimeout: 20_000 })

async function until(cond: () => boolean, ms = 6000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 2))
  }
}

let ctx: Awaited<ReturnType<typeof world>>

async function world() {
  const vault = fakeVault()
  const uploads = fakeServer({ chunkSize: 1024, delay: 2 })
  const env = new EventTarget()
  const store = new VaultStore({ api: vault.api as never, env, channel: null })
  const up = new Uploader({ api: uploads.api, env, storage: memoryStorage(), session: memoryStorage(), online: () => true })
  env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: 1 } }))
  await store.load()
  await store.setup('storage-pass-123')
  return { vault, uploads, store, up, env }
}

beforeEach(async () => { ctx = await world() })
afterEach(() => vi.restoreAllMocks())

const pdf = (name = 'cv.pdf', n = 3000) => new File([new Uint8Array(n).fill(3)], name, { type: 'application/pdf' })

describe('adding photos and files', () => {
  it('Photo refuses a PDF', async () => {
    const out = await addVaultFiles([pdf()], 'photo', ctx.store, ctx.up)
    expect(out.error).toBe('Only PNG, JPEG, GIF or WebP photos. Add it as a File instead.')
    expect(ctx.up.jobs()).toEqual([])
  })

  it('a selection over the free space is refused before anything is encrypted or sent', async () => {
    ctx.store.forcePatchForTest({ usedBytes: 209715200 - 100_000 })
    const enc = vi.spyOn(ctx.store, 'encryptFile')
    const out = await addVaultFiles([pdf('a.pdf', 30_000), pdf('b.pdf', 30_000)], 'file', ctx.store, ctx.up)
    expect(out.error).toMatch(/^Not enough space in My storage \(needs .+, 97\.7 KB free\)\.$/)
    expect(enc).not.toHaveBeenCalled()
    expect(ctx.up.jobs()).toEqual([])
  })

  it('encrypts one file at a time, each just before its own upload, and saves the items', async () => {
    const order: string[] = []
    const realEnc = ctx.store.encryptFile.bind(ctx.store)
    vi.spyOn(ctx.store, 'encryptFile').mockImplementation(async (f: Blob) => {
      order.push(`enc:${(f as File).name}:${ctx.up.jobs().filter((j) => j.state === 'done').length}`)
      return realEnc(f)
    })
    await addVaultFiles([pdf('a.pdf'), pdf('b.pdf')], 'file', ctx.store, ctx.up)
    await until(() => ctx.store.snapshot().items.length === 2)
    expect(order).toEqual(['enc:a.pdf:0', 'enc:b.pdf:1'])
    expect(ctx.store.snapshot().items.map((i) => (i.meta as FileMeta).name).sort()).toEqual(['a.pdf', 'b.pdf'])
  })

  it('the upload rows carry the file name but the server gets "blob"', async () => {
    const bodies: Record<string, unknown>[] = []
    ctx.uploads.hooks.before = ({ method, path, body }) => { if (method === 'POST' && path === '/api/uploads') bodies.push(body as Record<string, unknown>) }
    await addVaultFiles([pdf('salary.pdf')], 'file', ctx.store, ctx.up)
    await until(() => ctx.up.jobs()[0]?.state === 'done')
    expect(ctx.up.jobs()[0]).toMatchObject({ name: 'salary.pdf', vault: true })
    expect(JSON.stringify(bodies)).not.toContain('salary')
  })

  it('a lock during the upload still saves the item (its meta was encrypted first)', async () => {
    ctx.uploads.hooks.before = ({ method }) => { if (method === 'PUT') ctx.store.lock() }
    await addVaultFiles([pdf('cv.pdf')], 'file', ctx.store, ctx.up)
    await until(() => ctx.vault.items.size === 1)
    await ctx.store.unlock('storage-pass-123')
    expect((ctx.store.snapshot().items[0].meta as FileMeta).name).toBe('cv.pdf')
  })

  it('running uploads count as activity', async () => {
    const touch = vi.spyOn(ctx.store, 'touch')
    await addVaultFiles([pdf('cv.pdf', 5000)], 'file', ctx.store, ctx.up)
    await until(() => ctx.up.jobs()[0]?.state === 'done')
    expect(touch).toHaveBeenCalled()
  })
})

describe('reading them back', () => {
  it("another item's blob (a different nonce prefix) is Corrupt, never shown", async () => {
    const mine = await ctx.store.encryptFile(pdf('mine.pdf', 2000))
    const other = await ctx.store.encryptFile(pdf('other.pdf', 2000))
    const meta: FileMeta = { kind: 'file', name: 'mine.pdf', mime: 'application/pdf', size: 2000, prefix: mine.prefix }
    const item = await ctx.store.addEncrypted(await ctx.store.encrypt(meta), 'c'.repeat(32))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(other.blob)) // swapped on the server
    await expect(ctx.store.openBlob(item, 'application/octet-stream')).rejects.toBeInstanceOf(Corrupt)
  })

  it('round-trips through openBlob when the server returns the uploaded ciphertext', async () => {
    const file = pdf('cv.pdf', 4000)
    const { blob, prefix } = await ctx.store.encryptFile(file)
    const meta: FileMeta = { kind: 'file', name: 'cv.pdf', mime: 'application/pdf', size: 4000, prefix }
    const item = await ctx.store.addEncrypted(await ctx.store.encrypt(meta), 'b'.repeat(32))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(blob))
    const out = await ctx.store.openBlob(item, 'application/octet-stream')
    expect(out.type).toBe('application/octet-stream')
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()))
  })
})

describe('telling the user after a reload', () => {
  it('counts unfinished My storage uploads at pagehide, shown once next time', async () => {
    const session = memoryStorage()
    ctx.uploads.hooks.before = ({ method }) => (method === 'PUT' ? new Promise(() => {}) : undefined)
    void addVaultFiles([pdf('cv.pdf')], 'file', ctx.store, ctx.up) // it waits for the upload, which hangs
    await until(() => ctx.up.jobs()[0]?.state === 'sending')
    markUnfinished(ctx.up, session)
    expect(takeUnfinished(session)).toBe(1)
    expect(takeUnfinished(session)).toBe(0)
  })
})

describe('review fixes', () => {
  it('a lock while a file is being encrypted ends with a message, not an unhandled error', async () => {
    const real = ctx.store.encryptFile.bind(ctx.store)
    vi.spyOn(ctx.store, 'encryptFile').mockImplementation(async (f: Blob) => {
      const out = await real(f)
      ctx.store.lock() // another tab's Lock, or idle, while this file was being encrypted
      return out
    })
    const out = await addVaultFiles([pdf('a.pdf')], 'file', ctx.store, ctx.up)
    expect(out.error).toBe('My storage locked — add the rest again after unlocking.')
    expect(ctx.up.jobs()).toEqual([])
  })

  it('a photo with the largest thumbnail still fits the 64 KiB metadata allowance', async () => {
    const { THUMB_MAX } = await import('./vaultFiles')
    const { toB64 } = await import('./crypto')
    const thumb = toB64(new Uint8Array(THUMB_MAX).fill(255))
    const meta: FileMeta = { kind: 'photo', name: 'x'.repeat(200) + '.jpg', mime: 'image/jpeg', size: 9_999_999, prefix: 'AAAAAAAAAAA=', thumb }
    expect((await ctx.store.encrypt(meta)).length).toBeLessThanOrEqual(64 * 1024)
  })
})

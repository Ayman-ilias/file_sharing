// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import type { VaultMeta } from './api'
import { WrongPassword, decryptMeta, deriveKek, encryptMeta, unwrapDataKey } from './crypto'
import { fakeVault } from './fakeVault'
import { Deleted, KeyChanged, Locked, OwnPasswordRequired, StaleVersion, VaultStore } from './store'

const PW = 'storage-pass-123'
const note: VaultMeta = { kind: 'note', title: 'Meeting notes', text: 'Uttara on 12 Nov' }

/** BroadcastChannel between fake tabs (delivers to the others, not the sender). */
function bus() {
  const members = new Set<{ onmessage: ((e: { data: unknown }) => void) | null }>()
  return () => {
    const ch = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(data: unknown) { for (const m of members) if (m !== ch) queueMicrotask(() => m.onmessage?.({ data })) },
      close() { members.delete(ch) },
    }
    members.add(ch)
    return ch
  }
}

function tab(srv = fakeVault(), channel: (() => unknown) | null = null, uid = 1) {
  const env = new EventTarget()
  const store = new VaultStore({ api: srv.api as never, env, channel: channel as never })
  env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: uid } }))
  return { store, env, srv }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

// PBKDF2 with 600 000 rounds is slow on purpose; a busy machine needs more than the 5 s default
vi.setConfig({ testTimeout: 20_000 })

afterEach(() => vi.useRealTimers())

describe('setup and unlock', () => {
  it('setup posts salt, 600000 and a wrapped key, then opens; the held key is not extractable', async () => {
    const { store, srv } = tab()
    await store.load()
    expect(store.snapshot().status).toBe('setup')
    await store.setup(PW)
    const body = srv.api.setup.mock.calls[0][0] as { iterations: number; salt: string; wrapped_key: string }
    expect(body.iterations).toBe(600_000)
    expect(store.snapshot().status).toBe('open')
    expect(store.heldKeyForTest()?.extractable).toBe(false)
    const kek = await deriveKek(PW, body.salt, 600_000)
    await expect(unwrapDataKey(body.wrapped_key, kek)).resolves.toBeDefined()
  })

  it('setup is refused until the user has their own login password', async () => {
    const { store, srv } = tab()
    srv.api.setup.mockRejectedValueOnce(new ApiError(403, 'own_password_required'))
    await store.load()
    await expect(store.setup(PW)).rejects.toBeInstanceOf(OwnPasswordRequired)
    expect(store.snapshot().status).toBe('setup')
  })

  it('setup that finds the vault already made (lost answer, other tab) unlocks with the same password', async () => {
    const srv = fakeVault()
    const first = tab(srv)
    await first.store.load()
    await first.store.setup(PW)
    const second = tab(srv)
    await second.store.load()
    second.store.forceStatusForTest('setup') // it still showed the setup form
    await second.store.setup(PW)
    expect(second.store.snapshot().status).toBe('open')
  })

  it('a wrong password keeps it locked and throws WrongPassword', async () => {
    const srv = fakeVault()
    const a = tab(srv)
    await a.store.load()
    await a.store.setup(PW)
    const b = tab(srv)
    await b.store.load()
    expect(b.store.snapshot().status).toBe('locked') // a new tab opens locked
    await expect(b.store.unlock('nope-nope-nope')).rejects.toBeInstanceOf(WrongPassword)
    expect(b.store.snapshot().status).toBe('locked')
  })

  it('items decrypt after unlock; one that fails to decrypt is marked broken, not thrown', async () => {
    const srv = fakeVault()
    const a = tab(srv)
    await a.store.load()
    await a.store.setup(PW)
    await a.store.add(note)
    srv.items.set('bad', { ...[...srv.items.values()][0], id: 'bad', meta_ct: 'AQIDBAUGBwgJCgsMDQ4PEBESExQ=' })
    const b = tab(srv)
    await b.store.load()
    await b.store.unlock(PW)
    const items = b.store.snapshot().items
    expect(items.find((i) => i.id !== 'bad')?.meta).toEqual(note)
    expect(items.find((i) => i.id === 'bad')).toMatchObject({ meta: null, broken: true })
  })
})

describe('locking', () => {
  async function opened() {
    const t = tab()
    await t.store.load()
    await t.store.setup(PW)
    return t
  }

  it('lock drops the key: after lock, add() throws Locked', async () => {
    const { store } = await opened()
    store.lock()
    expect(store.snapshot()).toMatchObject({ status: 'locked', items: [], lockedBecause: 'manual' })
    await expect(store.add(note)).rejects.toBeInstanceOf(Locked)
  })

  it('auto-locks after 20 min idle with a warning at 19 min; a key press resets it', async () => {
    const { store, env } = await opened()
    vi.useFakeTimers()
    vi.advanceTimersByTime(18 * 60_000)
    env.dispatchEvent(new Event('keydown'))
    vi.advanceTimersByTime(19 * 60_000 + 15_000)
    expect(store.snapshot()).toMatchObject({ status: 'open', lockWarning: true })
    store.touch()
    vi.advanceTimersByTime(15_000)
    expect(store.snapshot().lockWarning).toBe(false)
    vi.advanceTimersByTime(20 * 60_000 + 15_000)
    expect(store.snapshot()).toMatchObject({ status: 'locked', lockedBecause: 'idle' })
  })

  it('waking from a 25 min sleep locks at once (a deadline, not a timer that fires late)', async () => {
    const { store, env } = await opened()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 25 * 60_000) // the clock jumps; no timers ran meanwhile
    env.dispatchEvent(new Event('visibilitychange'))
    expect(store.snapshot().status).toBe('locked')
  })

  it('pagehide locks (a page restored from the back-forward cache must not keep the key)', async () => {
    const { store, env } = await opened()
    env.dispatchEvent(new Event('pagehide'))
    expect(store.snapshot().status).toBe('locked')
  })

  it('signing out locks; another user signing in drops everything', async () => {
    const { store, env } = await opened()
    await store.add(note)
    env.dispatchEvent(new Event('fs:signed-out'))
    expect(store.snapshot().status).toBe('locked')
    env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: 99 } }))
    expect(store.snapshot()).toMatchObject({ items: [] })
    expect(store.snapshot().status).not.toBe('open')
  })
})

describe('tabs', () => {
  it("another tab's unlock opens this tab; its lock locks this one", async () => {
    const srv = fakeVault()
    const channel = bus()
    const a = tab(srv, channel)
    const b = tab(srv, channel)
    await a.store.load()
    await b.store.load()
    await a.store.setup(PW)
    await settle()
    await vi.waitFor(() => expect(b.store.snapshot().status).toBe('open'))
    a.store.lock()
    await settle()
    expect(b.store.snapshot()).toMatchObject({ status: 'locked', lockedBecause: 'other-tab' })
  })

  it('messages for another user are ignored', async () => {
    const srv = fakeVault()
    const channel = bus()
    const a = tab(srv, channel, 1)
    const b = tab(srv, channel, 2)
    await a.store.load()
    await b.store.load()
    await a.store.setup(PW)
    await settle()
    await settle()
    expect(b.store.snapshot().status).not.toBe('open')
  })

  it('activity in tab A keeps tab B open', async () => {
    const srv = fakeVault()
    const channel = bus()
    const a = tab(srv, channel)
    const b = tab(srv, channel)
    await a.store.load()
    await b.store.load()
    await a.store.setup(PW)
    await vi.waitFor(() => expect(b.store.snapshot().status).toBe('open'))
    vi.useFakeTimers()
    for (let m = 0; m < 30; m++) {
      a.env.dispatchEvent(new Event('keydown'))
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(b.store.snapshot().status).toBe('open')
  })

  it('erase in another tab → this tab goes to setup', async () => {
    const srv = fakeVault()
    const channel = bus()
    const a = tab(srv, channel)
    const b = tab(srv, channel)
    await a.store.load()
    await b.store.load()
    await a.store.setup(PW)
    await a.store.erase('login-pass')
    await vi.waitFor(() => expect(b.store.snapshot().status).toBe('setup'))
  })
})

describe('editing', () => {
  async function two() {
    const srv = fakeVault()
    const a = tab(srv)
    await a.store.load()
    await a.store.setup(PW)
    const b = tab(srv)
    await b.store.load()
    await b.store.unlock(PW)
    return { srv, a, b }
  }

  it('a stale save → StaleVersion, and the list holds the server copy', async () => {
    const { a, b } = await two()
    const item = await a.store.add(note)
    await b.store.refresh()
    await a.store.update(item.id, { ...note, text: 'from A' })
    await expect(b.store.update(item.id, { ...note, text: 'from B' })).rejects.toBeInstanceOf(StaleVersion)
    expect(b.store.snapshot().items.find((i) => i.id === item.id)?.meta).toMatchObject({ text: 'from A' })
  })

  it('saving an item deleted in another tab → Deleted, and it leaves the list', async () => {
    const { a, b } = await two()
    const item = await a.store.add(note)
    await b.store.refresh()
    await a.store.remove(item.id)
    await expect(b.store.update(item.id, note)).rejects.toBeInstanceOf(Deleted)
    expect(b.store.snapshot().items).toEqual([])
  })

  it('a write with an old data key → KeyChanged and the tab locks', async () => {
    const { srv, a } = await two()
    const k = srv.peek()!
    k.key_gen = 'replaced-elsewhere'
    await expect(a.store.add(note)).rejects.toBeInstanceOf(KeyChanged)
    expect(a.store.snapshot().status).toBe('locked')
  })

  it('addEncrypted attaches a blob without the key (a lock mid-upload is fine)', async () => {
    const { a } = await two()
    const metaCt = await a.store.encrypt({ kind: 'file', name: 'cv.pdf', mime: 'application/pdf', size: 3, prefix: 'AAAAAAAAAAA=' })
    a.store.lock()
    await a.store.addEncrypted(metaCt, 'b'.repeat(32))
    await a.store.unlock(PW)
    expect(a.store.snapshot().items[0].meta).toMatchObject({ name: 'cv.pdf' })
  })
})

describe('changing the storage password', () => {
  it('re-wraps: the new password unlocks, the old one fails; works while locked and does not unlock', async () => {
    const srv = fakeVault()
    const a = tab(srv)
    await a.store.load()
    await a.store.setup(PW)
    await a.store.add(note)
    a.store.lock()
    await a.store.changePassword(PW, 'brand-new-storage-pw')
    expect(a.store.snapshot().status).toBe('locked')
    await expect(a.store.unlock(PW)).rejects.toBeInstanceOf(WrongPassword)
    await a.store.unlock('brand-new-storage-pw')
    expect(a.store.snapshot().items[0].meta).toEqual(note)
  })

  it('the wrong current password → WrongPassword, nothing changes', async () => {
    const srv = fakeVault()
    const a = tab(srv)
    await a.store.load()
    await a.store.setup(PW)
    const before = srv.peek()!.wrapped_key
    await expect(a.store.changePassword('not-the-password', 'brand-new-storage-pw')).rejects.toBeInstanceOf(WrongPassword)
    expect(srv.peek()!.wrapped_key).toBe(before)
  })
})

it('meta written by the store decrypts with the unwrapped key (format check)', async () => {
  const srv = fakeVault()
  const a = tab(srv)
  await a.store.load()
  await a.store.setup(PW)
  await a.store.add(note)
  const k = srv.peek()!
  const key = await unwrapDataKey(k.wrapped_key, await deriveKek(PW, k.salt, k.iterations))
  expect(await decryptMeta([...srv.items.values()][0].meta_ct, key)).toEqual(note)
  expect(await encryptMeta(note, key)).toMatch(/^[A-Za-z0-9+/]+=*$/)
})

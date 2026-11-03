// @vitest-environment node
// Findings of the plan 3 final review: each test failed before its fix.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeServer, memoryStorage } from './fakeServer'
import { Uploader } from './Uploader'

const PEOPLE = { recipientIds: [5], isGlobal: false }
const GLOBAL = { recipientIds: [], isGlobal: true }

const file = (name: string, size: number, lastModified = 1000) => new File([new Uint8Array(size).fill(7)], name, { lastModified })
function inFolder(path: string, size: number): File {
  const f = file(path.split('/').pop()!, size)
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}
async function until(cond: () => boolean, ms = 4000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 2))
  }
}
const signIn = (env: EventTarget, id: number) => env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id } }))

type Srv = ReturnType<typeof fakeServer>
function tab(srv: Srv, local = memoryStorage(), session = memoryStorage(), opts: Partial<ConstructorParameters<typeof Uploader>[0]> = {}) {
  const env = new EventTarget()
  const up = new Uploader({ api: srv.api, env, storage: local, session, online: () => true, ...opts })
  return { up, env, local, session }
}

afterEach(() => vi.useRealTimers())

describe('review #1: a new user in the same tab never inherits the old user\'s uploads', () => {
  it('signing in as someone else drops the previous user\'s jobs instead of resuming them', async () => {
    const srv = fakeServer({ delay: 20 })
    const { up, env } = tab(srv)
    signIn(env, 1)
    await up.addFiles([file('a-secret.pdf', 400)], PEOPLE)
    await until(() => srv.stats.puts.length > 0)
    env.dispatchEvent(new Event('fs:signed-out'))
    signIn(env, 2)
    expect(up.jobs()).toEqual([])
    const before = srv.log.length
    await new Promise((r) => setTimeout(r, 80))
    expect(srv.log.slice(before).filter((l) => l.startsWith('POST /api/uploads'))).toEqual([])
  })

  it('cancelAll stops and releases everything (used by Log out)', async () => {
    const srv = fakeServer({ delay: 20 })
    const { up, env } = tab(srv)
    signIn(env, 1)
    await up.addFiles([file('a', 400)], PEOPLE)
    await until(() => srv.stats.puts.length > 0)
    await up.cancelAll()
    expect(up.jobs()).toEqual([])
    expect(srv.log.some((l) => l.startsWith('DELETE /api/uploads/'))).toBe(true)
  })

  it('saved jobs come back only for the user who owned them', async () => {
    const srv = fakeServer({ delay: 20 })
    const local = memoryStorage()
    const session = memoryStorage()
    const first = tab(srv, local, session)
    signIn(first.env, 1)
    await first.up.addFiles([file('mine.pdf', 400)], PEOPLE)
    await until(() => srv.stats.puts.length > 0)
    first.up.detach()
    const other = tab(srv, local, session)
    signIn(other.env, 2)
    expect(other.up.jobs()).toEqual([])
    const same = tab(srv, local, session)
    signIn(same.env, 1)
    expect(same.up.jobs().map((j) => j.reason)).toEqual(['interrupted'])
  })
})

describe('review #2: no reservation is left behind', () => {
  it('cancel while the start request is in flight deletes the upload it created', async () => {
    const srv = fakeServer()
    const { up, env } = tab(srv)
    signIn(env, 1)
    let release!: () => void
    srv.hooks.before = ({ method, path }) => {
      if (method === 'POST' && path === '/api/uploads') return new Promise<void>((r) => { release = r }).then(() => undefined)
    }
    await up.addFiles([file('a', 40)], PEOPLE)
    await until(() => !!release)
    await up.cancel(up.jobs()[0].id)
    release()
    await until(() => srv.log.some((l) => l.startsWith('DELETE /api/uploads/')))
    expect([...srv.ups.values()]).toEqual([])
    expect(srv.stats.puts).toEqual([])
  })

  it('a failure that offers no Retry releases the upload', async () => {
    const srv = fakeServer()
    const { up, env } = tab(srv)
    signIn(env, 1)
    const { ApiError } = await import('../../api/client')
    srv.hooks.before = ({ method }) => { if (method === 'PUT') throw new ApiError(507, 'disk_full') }
    await up.addFiles([file('a', 8)], PEOPLE)
    await until(() => up.jobs()[0]?.state === 'failed')
    await until(() => srv.ups.size === 0)
  })

  it('dismissing a failed job releases its upload', async () => {
    vi.useFakeTimers()
    const srv = fakeServer({ delay: 0 })
    const { up, env } = tab(srv)
    signIn(env, 1)
    srv.hooks.before = ({ method }) => { if (method === 'PUT') throw new TypeError('Failed to fetch') }
    await up.addFiles([file('a', 8)], PEOPLE)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(up.jobs()[0].state).toBe('failed')
    up.dismiss(up.jobs()[0].id)
    await vi.advanceTimersByTimeAsync(10)
    expect(srv.ups.size).toBe(0)
  })
})

describe('review #3: a folder bigger than the reservation limit still goes', () => {
  it('registers files a few at a time as earlier ones finish', async () => {
    const srv = fakeServer({ maxReserved: 100 })
    const { up, env } = tab(srv, memoryStorage(), memoryStorage(), { groupBytes: 60 })
    signIn(env, 1)
    up.addFolder([inFolder('big/a', 60), inFolder('big/b', 60), inFolder('big/c', 60)], GLOBAL)
    await until(() => up.jobs()[0].state !== 'sending' && up.jobs()[0].state !== 'queued')
    expect(up.jobs()[0]).toMatchObject({ state: 'done', files: { total: 3, done: 3, failed: [] } })
  })
})

describe('review #4: a replaced batch keeps every file', () => {
  it('files finished in the lost batch are sent again into the new one', async () => {
    const srv = fakeServer()
    const { up, env } = tab(srv, memoryStorage(), memoryStorage(), { groupFiles: 1 })
    signIn(env, 1)
    let registers = 0
    srv.hooks.before = ({ path }) => {
      if (path.endsWith('/files') && ++registers === 2) srv.batches.clear() // the stale sweep removed it
    }
    up.addFolder([inFolder('top/a', 4), inFolder('top/b', 4)], GLOBAL)
    await until(() => up.jobs()[0].state === 'done' || up.jobs()[0].state === 'failed')
    const batchFiles = [...srv.ups.values()].filter((u) => srv.batches.has(u.batchId!)).map((u) => u.path).sort()
    expect(batchFiles).toEqual(['a', 'b'])
    expect(up.jobs()[0].files).toMatchObject({ total: 2, done: 2 })
  })
})

describe('review #5: re-picking after a reload never makes a second item', () => {
  it('a file whose upload already completed ends done with that item, nothing re-sent', async () => {
    const srv = fakeServer({ delay: 20 })
    const local = memoryStorage()
    const session = memoryStorage()
    const a = tab(srv, local, session, { maxChunks: 1 })
    signIn(a.env, 1)
    const f = file('done.pdf', 8)
    await a.up.addFiles([f], PEOPLE)
    await until(() => srv.stats.puts.length > 0)
    a.up.detach()
    const id = [...srv.ups.keys()][0]
    srv.finish(id) // the complete reached the server, the answer never came back
    const puts = srv.stats.puts.length
    const b = tab(srv, local, session)
    signIn(b.env, 1)
    await b.up.addFiles([f], PEOPLE)
    await until(() => b.up.jobs()[0]?.state === 'done')
    expect(b.up.jobs()[0].item?.id).toBe(srv.ups.get(id)!.itemId)
    expect(srv.log.filter((l) => l === 'POST /api/uploads')).toHaveLength(1)
    expect(srv.stats.puts.length).toBe(puts)
  })

  it('a folder whose batch already completed ends done, not sent again', async () => {
    const srv = fakeServer({ delay: 20 })
    const local = memoryStorage()
    const session = memoryStorage()
    const files = [inFolder('site/a', 4), inFolder('site/b', 4)]
    const a = tab(srv, local, session)
    signIn(a.env, 1)
    let stop = false
    srv.hooks.before = ({ path }) => { if (path.endsWith('/complete')) { stop = true; return new Promise(() => {}) } }
    a.up.addFolder(files, GLOBAL)
    await until(() => stop)
    a.up.detach()
    srv.hooks.before = undefined
    const batchId = [...srv.batches.keys()][0]
    await srv.api.send('POST', `/api/batches/${batchId}/complete`) // it did complete on the server
    const b = tab(srv, local, session)
    signIn(b.env, 1)
    b.up.addFolder(files, GLOBAL)
    await until(() => b.up.jobs()[0]?.state === 'done')
    expect(srv.batches.size).toBe(1)
    expect(b.up.jobs()[0].item?.kind).toBe('folder')
  })
})

describe('review #6: tabs keep their own saved jobs', () => {
  it('another tab saving does not erase this tab\'s jobs, and a live tab\'s jobs are not taken over', async () => {
    const srv = fakeServer({ delay: 30 })
    const local = memoryStorage()
    const sessionA = memoryStorage()
    const sessionB = memoryStorage()
    const a = tab(srv, local, sessionA)
    const b = tab(srv, local, sessionB)
    signIn(a.env, 1)
    signIn(b.env, 1)
    await a.up.addFiles([file('from-a.pdf', 400)], PEOPLE)
    await b.up.addFiles([file('from-b.pdf', 400)], PEOPLE)
    await until(() => srv.stats.puts.length > 0)
    a.up.detach() // tab A reloads; tab B keeps running
    const a2 = tab(srv, local, sessionA)
    signIn(a2.env, 1)
    expect(a2.up.jobs().map((j) => j.name)).toEqual(['from-a.pdf'])
    b.up.detach()
  })

  it('jobs of a tab that is gone are offered to the next tab', async () => {
    vi.useFakeTimers()
    const srv = fakeServer({ delay: 1000 })
    const local = memoryStorage()
    const gone = tab(srv, local, memoryStorage())
    signIn(gone.env, 1)
    await gone.up.addFiles([file('orphan.pdf', 400)], PEOPLE)
    await vi.advanceTimersByTimeAsync(10)
    gone.up.detach()
    await vi.advanceTimersByTimeAsync(20_000) // its heartbeat is now old
    const next = tab(srv, local, memoryStorage())
    signIn(next.env, 1)
    expect(next.up.jobs().map((j) => j.name)).toEqual(['orphan.pdf'])
    next.up.detach()
  })
})

describe('review #8: a stalled chunk is retried', () => {
  it('a PUT with no progress for 60 s is aborted and sent again', async () => {
    vi.useFakeTimers()
    const srv = fakeServer({ delay: 0 })
    const { up, env } = tab(srv)
    signIn(env, 1)
    let first = true
    srv.hooks.before = ({ method, signal }) => {
      if (method !== 'PUT' || !first) return
      first = false
      return new Promise((_, fail) => signal?.addEventListener('abort', () => fail(new DOMException('Aborted', 'AbortError'))))
    }
    await up.addFiles([file('a', 4)], PEOPLE)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(up.jobs()[0].state).toBe('sending')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(up.jobs()[0].state).toBe('done')
    expect(srv.stats.puts).toHaveLength(2)
  })
})

describe('review minor: Retry after "upload lost" starts a new upload', () => {
  it('does not keep using the dead upload id', async () => {
    const srv = fakeServer()
    const { up, env } = tab(srv)
    signIn(env, 1)
    const { ApiError } = await import('../../api/client')
    let lose = true
    srv.hooks.before = ({ method }) => {
      if (method === 'PUT' && lose) { srv.ups.clear(); throw new ApiError(404, 'not_found') }
    }
    await up.addFiles([file('a', 4)], PEOPLE)
    await until(() => up.jobs()[0].state === 'failed')
    expect(up.jobs()[0].reason).toBe('not_found')
    lose = false
    up.retry(up.jobs()[0].id)
    await until(() => up.jobs()[0].state === 'done')
  })
})

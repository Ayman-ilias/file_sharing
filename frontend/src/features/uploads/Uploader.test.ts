// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { fakeServer, memoryStorage } from './fakeServer'
import { Uploader, type Job } from './Uploader'

const PEOPLE = { recipientIds: [5], isGlobal: false }
const GLOBAL = { recipientIds: [], isGlobal: true }

function file(name: string, size: number, lastModified = 1000): File {
  return new File([new Uint8Array(size).fill(7)], name, { lastModified })
}

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

function setup(opts: { chunkSize?: number; delay?: number; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const srv = fakeServer({ chunkSize: opts.chunkSize ?? 4, delay: opts.delay ?? 2 })
  const env = new EventTarget()
  const storage = opts.storage ?? memoryStorage()
  const up = new Uploader({ api: srv.api, env, storage, online: () => true })
  return { srv, env, storage, up }
}

const states = (up: Uploader) => up.jobs().map((j: Job) => j.state)

afterEach(() => vi.useRealTimers())

describe('Uploader: files', () => {
  it('never more than 4 chunk PUTs in flight per file and 2 files at once', async () => {
    const { srv, up } = setup()
    await up.addFiles([file('a', 40), file('b', 40), file('c', 40), file('d', 40)], PEOPLE)
    await until(() => states(up).every((s) => s === 'done'))
    expect(srv.stats.maxPerUpload).toBe(4)
    expect(srv.stats.maxUploads).toBe(2)
    expect(srv.stats.puts).toHaveLength(40)
    expect(up.jobs().every((j) => j.item?.kind === 'file' && j.sent === 40)).toBe(true)
  })

  it('sends each chunk as a slice of the file, never read into memory', async () => {
    const { srv, up } = setup()
    const bodies: unknown[] = []
    srv.hooks.before = ({ method, body }) => { if (method === 'PUT') bodies.push(body) }
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer')
    const text = vi.spyOn(Blob.prototype, 'text')
    await up.addFiles([file('a', 10)], PEOPLE)
    await until(() => states(up)[0] === 'done')
    expect(bodies.map((b) => (b as Blob).size)).toEqual([4, 4, 2])
    expect(bodies.every((b) => b instanceof Blob)).toBe(true)
    expect(read).toHaveBeenCalledTimes(2) // only the key's first/last 64 KiB
    expect(text).not.toHaveBeenCalled()
  })

  it('resume skips chunks the server already has', async () => {
    const { srv, up } = setup()
    srv.hooks.before = ({ method, path }) =>
      method === 'POST' && path === '/api/uploads' ? { upload_id: seed(), chunk_size: 4, received: [0, 1] } : undefined
    const seed = () => {
      const id = 'f'.repeat(32)
      srv.ups.set(id, { id, key: 'k', size: 16, received: new Set([0, 1]), done: false })
      return id
    }
    await up.addFiles([file('a', 16)], PEOPLE)
    await until(() => states(up)[0] === 'done')
    expect(srv.stats.puts.sort()).toEqual([`${'f'.repeat(32)}:2`, `${'f'.repeat(32)}:3`])
  })

  it('a failed chunk retries with backoff, then fails with Retry', async () => {
    vi.useFakeTimers()
    const { srv, up } = setup({ delay: 0 })
    const times: number[] = []
    let broken = true
    srv.hooks.before = ({ method }) => {
      if (method !== 'PUT') return
      times.push(Date.now())
      if (broken) throw new TypeError('Failed to fetch')
    }
    await up.addFiles([file('a', 4)], PEOPLE)
    await vi.advanceTimersByTimeAsync(40_000)
    const gaps = times.slice(1).map((t, i) => t - times[i])
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(up.jobs()[0]).toMatchObject({ state: 'failed', reason: 'network', canRetry: true })

    broken = false
    up.retry(up.jobs()[0].id)
    await vi.advanceTimersByTimeAsync(100)
    expect(states(up)).toEqual(['done'])
  })

  it('coming back online skips the rest of the backoff', async () => {
    vi.useFakeTimers()
    const { srv, env, up } = setup({ delay: 0 })
    let fails = 3
    srv.hooks.before = ({ method }) => { if (method === 'PUT' && fails-- > 0) throw new TypeError('Failed to fetch') }
    await up.addFiles([file('a', 4)], PEOPLE)
    await vi.advanceTimersByTimeAsync(3500) // attempts at 0, 1 s, 3 s; now waiting 4 s
    env.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(10)
    expect(states(up)).toEqual(['done'])
  })

  it('complete is retried after a network error and the job ends done once', async () => {
    vi.useFakeTimers()
    const { srv, up } = setup({ delay: 0 })
    let first = true
    srv.hooks.before = ({ path }) => {
      if (path.endsWith('/complete') && first) { first = false; throw new TypeError('Failed to fetch') }
    }
    await up.addFiles([file('a', 8)], PEOPLE)
    await vi.advanceTimersByTimeAsync(2000)
    expect(srv.log.filter((l) => l.endsWith('/complete'))).toHaveLength(2)
    expect(states(up)).toEqual(['done'])
    expect(srv.stats.puts).toHaveLength(2)
  })

  it('missing_chunks on complete re-sends just those chunks', async () => {
    const { srv, up } = setup()
    let once = true
    srv.hooks.before = ({ path }) => {
      if (path.endsWith('/complete') && once) {
        once = false
        const u = [...srv.ups.values()][0]
        u.received.delete(1)
        throw new ApiError(409, 'missing_chunks', { missing: [1] })
      }
    }
    await up.addFiles([file('a', 12)], PEOPLE)
    await until(() => states(up)[0] === 'done')
    expect(srv.stats.puts.map((p) => p.split(':')[1]).sort()).toEqual(['0', '1', '1', '2'])
  })

  it('offline pauses and online continues without re-sending done chunks', async () => {
    let online = true
    const srv = fakeServer({ chunkSize: 4, delay: 2 })
    const env = new EventTarget()
    const up = new Uploader({ api: srv.api, env, storage: memoryStorage(), online: () => online, maxChunks: 1 })
    let dropped = false
    srv.hooks.before = ({ method, n }) => {
      if (method === 'PUT' && n === 2 && !dropped) {
        dropped = true
        online = false
        env.dispatchEvent(new Event('offline'))
        throw new TypeError('Failed to fetch')
      }
    }
    await up.addFiles([file('a', 20)], PEOPLE)
    await until(() => up.jobs()[0].state === 'paused')
    expect(up.jobs()[0].reason).toBe('offline')
    online = true
    env.dispatchEvent(new Event('online'))
    await until(() => states(up)[0] === 'done')
    expect(srv.stats.puts.map((p) => p.split(':')[1])).toEqual(['0', '1', '2', '2', '3', '4'])
  })

  it('signed-out pauses; sign-in continues', async () => {
    const { srv, env, up } = setup()
    let signedIn = true
    srv.hooks.before = ({ method }) => {
      if (method === 'PUT' && !signedIn) throw new ApiError(401, 'not_signed_in')
    }
    signedIn = false
    await up.addFiles([file('a', 8)], PEOPLE)
    await until(() => up.jobs()[0].state === 'paused')
    expect(up.jobs()[0].reason).toBe('signed_out')
    signedIn = true
    env.dispatchEvent(new Event('fs:signed-in'))
    await until(() => states(up)[0] === 'done')
  })

  it.each([
    [413, 'too_large'],
    [507, 'disk_full'],
    [429, 'upload_quota'],
  ])('%i becomes failed with reason %s and nothing is sent', async (status, reason) => {
    const { srv, up } = setup()
    srv.hooks.before = ({ method, path }) => {
      if (method === 'POST' && path === '/api/uploads') throw new ApiError(status, reason)
    }
    await up.addFiles([file('a', 8)], PEOPLE)
    await until(() => up.jobs()[0].state === 'failed')
    expect(up.jobs()[0]).toMatchObject({ reason, canRetry: false })
    expect(srv.stats.puts).toHaveLength(0)
  })

  it('a chunk answered 409 already_complete ends done with the item', async () => {
    const { srv, up } = setup()
    srv.hooks.before = ({ method, path }) => { if (method === 'PUT') srv.finish(path.split('/')[3]) }
    await up.addFiles([file('a', 4)], PEOPLE)
    await until(() => states(up)[0] === 'done')
    const stored = [...srv.ups.values()][0]
    expect(up.jobs()[0].item?.id).toBe(stored.itemId)
    expect(srv.log.filter((l) => l.endsWith('/complete'))).toHaveLength(0)
  })

  it('a 404 starts a fresh upload once, then fails', async () => {
    const { srv, up } = setup()
    srv.hooks.before = ({ method }) => {
      if (method === 'PUT') {
        srv.ups.clear()
        throw new ApiError(404, 'not_found')
      }
    }
    await up.addFiles([file('a', 4)], PEOPLE)
    await until(() => states(up)[0] === 'failed')
    expect(srv.log.filter((l) => l === 'POST /api/uploads')).toHaveLength(2)
    expect(up.jobs()[0].reason).toBe('not_found')
  })

  it('a file that changed or moved fails without retrying', async () => {
    const { srv, up } = setup()
    srv.hooks.before = ({ method }) => {
      if (method === 'PUT') throw new DOMException('gone', 'NotReadableError')
    }
    await up.addFiles([file('a', 4)], PEOPLE)
    await until(() => states(up)[0] === 'failed')
    expect(up.jobs()[0]).toMatchObject({ reason: 'file_changed', canRetry: false })
    expect(srv.stats.puts).toHaveLength(1)
  })

  it('the same file to the same people while it is still sending is refused', async () => {
    const { up } = setup({ delay: 20 })
    const f = file('a', 8)
    const first = await up.addFiles([f], PEOPLE)
    const again = await up.addFiles([f], PEOPLE)
    const other = await up.addFiles([f], GLOBAL)
    expect(first.duplicates).toEqual([])
    expect(again.duplicates).toEqual(['a'])
    expect(other.duplicates).toEqual([])
    expect(up.jobs()).toHaveLength(2)
  })

  it('cancel calls DELETE and drops the job', async () => {
    const { srv, up } = setup({ delay: 30 })
    await up.addFiles([file('a', 400)], PEOPLE)
    await until(() => srv.stats.puts.length > 0)
    const id = up.jobs()[0].id
    await up.cancel(id)
    expect(up.jobs()).toHaveLength(0)
    expect(srv.log.some((l) => /^DELETE \/api\/uploads\/\w+$/.test(l))).toBe(true)
    const sent = srv.stats.puts.length
    await new Promise((r) => setTimeout(r, 80))
    expect(srv.stats.puts.length).toBe(sent) // nothing more after cancel
  })

  it('warns before leaving while something is sending', async () => {
    const { env, up } = setup({ delay: 20 })
    const idle = new Event('beforeunload', { cancelable: true })
    env.dispatchEvent(idle)
    expect(idle.defaultPrevented).toBe(false)
    await up.addFiles([file('a', 40)], PEOPLE)
    const busy = new Event('beforeunload', { cancelable: true })
    env.dispatchEvent(busy)
    expect(busy.defaultPrevented).toBe(true)
  })
})

describe('Uploader: reload', () => {
  it('keeps unfinished jobs; re-picking the file sends only the missing chunks', async () => {
    const storage = memoryStorage()
    const srv = fakeServer({ chunkSize: 4, delay: 2 })
    const env1 = new EventTarget()
    const first = new Uploader({ api: srv.api, env: env1, storage, online: () => true, maxChunks: 1 })
    const f = file('report.pdf', 20)
    let stop = false
    srv.hooks.before = ({ method, n }) => {
      if (method === 'PUT' && n === 2) stop = true
    }
    await first.addFiles([f], PEOPLE)
    await until(() => stop)
    first.detach() // the tab is closed

    srv.hooks.before = undefined
    const sentBefore = srv.stats.puts.length
    const again = new Uploader({ api: srv.api, env: new EventTarget(), storage, online: () => true })
    expect(again.jobs()).toHaveLength(1)
    expect(again.jobs()[0]).toMatchObject({ name: 'report.pdf', state: 'failed', reason: 'interrupted' })

    await again.addFiles([f], PEOPLE)
    await until(() => again.jobs().length === 1 && again.jobs()[0].state === 'done')
    const resent = srv.stats.puts.slice(sentBefore).map((p) => Number(p.split(':')[1]))
    expect(Math.min(...resent)).toBeGreaterThanOrEqual(2)
    expect(storage.getItem('fs.pending')).toBe('[]')
  })
})

describe('Uploader: folders', () => {
  it('registers in groups of 500 and completes the batch', async () => {
    const { srv, up } = setup({ delay: 0 })
    const files = Array.from({ length: 1201 }, (_, i) => inFolder(`photos/day${i % 3}/p${i}.jpg`, 3))
    const sizes: number[] = []
    srv.hooks.before = ({ path, body }) => {
      if (path.endsWith('/files')) sizes.push((body as { files: unknown[] }).files.length)
    }
    up.addFolder(files, PEOPLE)
    await until(() => states(up)[0] === 'done', 15000)
    expect(sizes).toEqual([500, 500, 201])
    expect(srv.log.filter((l) => l === 'POST /api/batches')).toHaveLength(1)
    expect(srv.log.filter((l) => /\/api\/batches\/\w+\/complete$/.test(l))).toHaveLength(1)
    expect(up.jobs()).toHaveLength(1)
    expect(up.jobs()[0]).toMatchObject({ kind: 'folder', name: 'photos', files: { total: 1201, done: 1201, failed: [] } })
    const registered = [...srv.ups.values()].map((u) => u.path)
    expect(registered).toContain('day0/p0.jpg') // the top folder is the item name, not part of the path
  }, 20000)

  it('runs at most 6 small files at once, in one row', async () => {
    const { srv, up } = setup({ delay: 3 })
    const files = Array.from({ length: 60 }, (_, i) => inFolder(`docs/f${i}.txt`, 4))
    up.addFolder(files, GLOBAL)
    await until(() => states(up)[0] === 'done')
    expect(srv.stats.maxUploads).toBeLessThanOrEqual(6)
    expect(srv.stats.maxUploads).toBeGreaterThan(1)
    expect(up.jobs()).toHaveLength(1)
  })

  it('a file that fails mid-way does not stop the others; the row ends Done · N failed', async () => {
    const { srv, up } = setup()
    srv.hooks.before = ({ method, path }) => {
      if (method === 'PUT') {
        const id = path.split('/')[3]
        if (srv.ups.get(id)?.path === 'b.txt') throw new ApiError(507, 'disk_full')
      }
    }
    up.addFolder([inFolder('top/a.txt', 4), inFolder('top/b.txt', 4), inFolder('top/c.txt', 4)], PEOPLE)
    await until(() => states(up)[0] === 'done')
    expect(up.jobs()[0].files).toEqual({ total: 3, done: 2, failed: [{ path: 'b.txt', reason: 'disk_full' }] })
    expect(up.jobs()[0].item?.kind).toBe('folder')
  })

  it('files over 10 GB are marked too large and never registered', async () => {
    const { srv, up } = setup()
    const huge = inFolder('top/huge.iso', 1)
    Object.defineProperty(huge, 'size', { value: 11 * 1024 ** 3 })
    let registered = 0
    srv.hooks.before = ({ path, body }) => {
      if (path.endsWith('/files')) registered += (body as { files: unknown[] }).files.length
    }
    up.addFolder([huge, inFolder('top/ok.txt', 4)], PEOPLE)
    await until(() => states(up)[0] === 'done')
    expect(registered).toBe(1)
    expect(up.jobs()[0].files?.failed).toEqual([{ path: 'huge.iso', reason: 'too_large' }])
  })

  it('a rejected group is registered one by one so only the bad file fails', async () => {
    const { srv, up } = setup()
    srv.hooks.before = ({ path, body }) => {
      if (!path.endsWith('/files')) return
      const paths = (body as { files: { relative_path: string }[] }).files.map((f) => f.relative_path)
      if (paths.includes('CON.txt')) throw new ApiError(400, 'bad_path')
    }
    up.addFolder([inFolder('top/a.txt', 4), inFolder('top/CON.txt', 4)], PEOPLE)
    await until(() => states(up)[0] === 'done')
    expect(up.jobs()[0].files?.failed).toEqual([{ path: 'CON.txt', reason: 'rejected' }])
  })

  it('quota or disk refusals at registration fail the whole folder', async () => {
    const { srv, up } = setup()
    srv.hooks.before = ({ path }) => {
      if (path.endsWith('/files')) throw new ApiError(429, 'upload_quota')
    }
    up.addFolder([inFolder('top/a.txt', 4)], PEOPLE)
    await until(() => states(up)[0] === 'failed')
    expect(up.jobs()[0].reason).toBe('upload_quota')
  })

  it('cancel deletes the unfinished files of the folder', async () => {
    const { srv, up } = setup({ delay: 40 })
    up.addFolder([inFolder('top/a.txt', 400), inFolder('top/b.txt', 400)], PEOPLE)
    await until(() => srv.stats.puts.length > 0)
    await up.cancel(up.jobs()[0].id)
    expect(up.jobs()).toHaveLength(0)
    expect(srv.log.filter((l) => l.startsWith('DELETE /api/uploads/'))).toHaveLength(2)
  })
})

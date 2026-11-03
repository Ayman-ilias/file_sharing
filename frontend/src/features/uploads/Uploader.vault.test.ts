// @vitest-environment node
// My storage uploads through the same engine: ciphertext only, then the item is attached.
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { fakeServer, memoryStorage } from './fakeServer'
import { Uploader } from './Uploader'

async function until(cond: () => boolean, ms = 4000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 2))
  }
}

function setup(delay = 1) {
  const srv = fakeServer({ chunkSize: 4, delay })
  const env = new EventTarget()
  const storage = memoryStorage()
  const up = new Uploader({ api: srv.api, env, storage, session: memoryStorage(), online: () => true })
  env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: 1 } }))
  return { srv, up, storage }
}

const cipher = (n = 10) => new Blob([new Uint8Array(n).fill(9)])

describe('vault uploads', () => {
  it('posts target vault with no name or recipients, then attaches; done only after the attach', async () => {
    const { srv, up } = setup()
    const bodies: Record<string, unknown>[] = []
    srv.hooks.before = ({ method, path, body }) => { if (method === 'POST' && path === '/api/uploads') bodies.push(body as Record<string, unknown>) }
    let release!: () => void
    const finish = vi.fn(() => new Promise<void>((r) => { release = r }))
    const id = up.addVaultFile(cipher(), 'salary-2026.xlsx', 'gen1', finish)
    await until(() => finish.mock.calls.length === 1)
    expect(bodies[0]).toMatchObject({ target: 'vault', name: 'blob', mime: 'application/octet-stream', recipient_ids: [], is_global: false, key_gen: 'gen1' })
    expect(String(bodies[0].client_key)).toMatch(/^vault:/)
    expect(up.jobs().find((j) => j.id === id)).toMatchObject({ state: 'sending', vault: true, name: 'salary-2026.xlsx' })
    release()
    await until(() => up.jobs()[0].state === 'done')
    expect(finish).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{32}$/))
  })

  it('an attach that fails on the network → failed with Retry, which only re-runs the attach', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { srv, up } = setup(0)
    let fail = true
    const finish = vi.fn(async () => { if (fail) throw new TypeError('Failed to fetch') })
    up.addVaultFile(cipher(), 'cv.pdf', 'gen1', finish)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(up.jobs()[0]).toMatchObject({ state: 'failed', reason: 'network', canRetry: true })
    const puts = srv.stats.puts.length
    fail = false
    up.retry(up.jobs()[0].id)
    await vi.advanceTimersByTimeAsync(100)
    expect(up.jobs()[0].state).toBe('done')
    expect(srv.stats.puts.length).toBe(puts) // nothing uploaded again
    vi.useRealTimers()
  })

  it('My storage full at attach → failed "vault_full" and the blob is freed', async () => {
    const { srv, up } = setup()
    const finish = vi.fn(async () => { throw new ApiError(507, 'vault_full') })
    up.addVaultFile(cipher(), 'big.zip', 'gen1', finish)
    await until(() => up.jobs()[0].state === 'failed')
    expect(up.jobs()[0]).toMatchObject({ reason: 'vault_full', canRetry: false })
    await until(() => srv.log.some((l) => /^DELETE \/api\/uploads\/\w+$/.test(l)))
    expect(srv.ups.size).toBe(0)
  })

  it('full at the start → "vault_full" without sending bytes', async () => {
    const { srv, up } = setup()
    srv.hooks.before = ({ method, path }) => {
      if (method === 'POST' && path === '/api/uploads') throw new ApiError(507, 'vault_full')
    }
    up.addVaultFile(cipher(), 'big.zip', 'gen1', vi.fn())
    await until(() => up.jobs()[0].state === 'failed')
    expect(up.jobs()[0].reason).toBe('vault_full')
    expect(srv.stats.puts).toHaveLength(0)
  })

  it('vault jobs are never saved for after a reload', async () => {
    const { up, storage } = setup(20)
    up.addVaultFile(cipher(400), 'secret.pdf', 'gen1', vi.fn(async () => {}))
    await up.addFiles([new File(['abcd'], 'shared.txt', { lastModified: 1 })], { recipientIds: [], isGlobal: true })
    await until(() => storage.keys().some((k) => k.startsWith('fs.pending:')))
    const saved = storage.keys().filter((k) => k.startsWith('fs.pending:')).map((k) => storage.getItem(k)!).join()
    expect(saved).toContain('shared.txt')
    expect(saved).not.toContain('secret.pdf')
  })

  it('cancel after the upload finished but before the attach frees the blob', async () => {
    const { srv, up } = setup()
    const finish = vi.fn(() => new Promise<void>(() => {}))
    const id = up.addVaultFile(cipher(), 'cv.pdf', 'gen1', finish)
    await until(() => finish.mock.calls.length === 1)
    await up.cancel(id)
    await until(() => srv.log.some((l) => l.startsWith('DELETE /api/uploads/')))
    expect(srv.ups.size).toBe(0)
  })
})

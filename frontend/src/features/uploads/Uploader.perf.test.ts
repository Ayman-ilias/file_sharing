// @vitest-environment node
// Remaining review minors: cancel during complete, and per-event work on big folders.
import { describe, expect, it, vi } from 'vitest'
import { fakeServer, memoryStorage } from './fakeServer'
import { Uploader } from './Uploader'

const GLOBAL = { recipientIds: [], isGlobal: true }
async function until(cond: () => boolean, ms = 8000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 2))
  }
}
function inFolder(path: string, size: number): File {
  const f = new File([new Uint8Array(size)], path.split('/').pop()!, { lastModified: 1 })
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}
function setup() {
  const srv = fakeServer({ delay: 0 })
  const env = new EventTarget()
  const storage = memoryStorage()
  const up = new Uploader({ api: srv.api, env, storage, session: memoryStorage(), online: () => true })
  env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: 1 } }))
  return { srv, up, storage }
}

describe('cancel while the upload is completing', () => {
  it('removes the item that the complete created anyway', async () => {
    const { srv, up } = setup()
    let release!: () => void
    srv.hooks.before = async ({ method, path }) => {
      if (path.endsWith('/complete')) await new Promise<void>((r) => { release = r })
      // the cancel's DELETE reaches the server only after the complete finished (the race we fix)
      if (method === 'DELETE' && path.startsWith('/api/uploads/')) await until(() => [...srv.ups.values()].some((u) => u.done))
    }
    await up.addFiles([new File(['abcd'], 'a.txt', { lastModified: 1 })], GLOBAL)
    await until(() => !!release)
    const cancelling = up.cancel(up.jobs()[0].id)
    release()
    await cancelling
    await until(() => srv.log.some((l) => l.startsWith('DELETE /api/items/')))
    expect(up.jobs()).toEqual([])
  })
})

describe('big folders stay cheap', () => {
  it('saved jobs are not rewritten for every finished file', async () => {
    const { up, storage } = setup()
    const writes = vi.spyOn(storage, 'setItem')
    up.addFolder(Array.from({ length: 200 }, (_, i) => inFolder(`docs/f${i}.txt`, 4)), GLOBAL)
    await until(() => up.jobs()[0].state === 'done')
    expect(writes.mock.calls.length).toBeLessThan(20)
  })

  it('progress events do not re-add every file of the folder each time', async () => {
    const { up } = setup()
    const sent = vi.spyOn(Uploader.prototype as unknown as { sent: () => number }, 'sent')
    up.addFolder(Array.from({ length: 300 }, (_, i) => inFolder(`docs/f${i}.txt`, 4)), GLOBAL)
    await until(() => up.jobs()[0].state === 'done')
    expect(sent.mock.calls.length).toBeLessThan(150) // was one full scan per chunk event (600+)
  })
})

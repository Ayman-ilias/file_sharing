// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { fakeServer, memoryStorage } from '../features/uploads/fakeServer'
import { Uploader } from '../features/uploads/Uploader'

const SRC = resolve(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) && !n.endsWith('.test.ts') && !n.endsWith('.test.tsx') ? [p] : []
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('security rules', () => {
  it('never renders HTML from strings', () => {
    const bad = sources(SRC).filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/.test(readFileSync(f, 'utf8')))
    expect(bad).toEqual([])
  })

  it('every write carries X-Requested-With: fs (upload, folder, delete, cancel, logout)', async () => {
    const writes: { method: string; url: string; csrf: string | null }[] = []
    // the real client, with fetch and XMLHttpRequest replaced by recorders
    vi.stubGlobal('window', new EventTarget())
    const srv = fakeServer({ chunkSize: 4, delay: 0 })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET'
      if (method !== 'GET') writes.push({ method, url, csrf: new Headers(init.headers).get('X-Requested-With') })
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      try {
        const out = method === 'GET' ? await srv.api.get(url) : await srv.api.send(method, url, body)
        return new Response(out === undefined ? null : JSON.stringify(out), { status: out === undefined ? 204 : 200 })
      } catch (e) {
        const err = e as { status: number; detail: string }
        return new Response(JSON.stringify({ detail: err.detail }), { status: err.status })
      }
    }))
    class RecordingXHR {
      upload = new EventTarget()
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      status = 0
      responseText = ''
      private method = ''
      private url = ''
      private headers: Record<string, string> = {}
      open(m: string, u: string) { this.method = m; this.url = u }
      setRequestHeader(k: string, v: string) { this.headers[k] = v }
      abort() { this.onabort?.() }
      send(body: Blob) {
        writes.push({ method: this.method, url: this.url, csrf: this.headers['X-Requested-With'] ?? null })
        srv.api.put(this.url, body).then(
          () => { this.status = 204; this.onload?.() },
          (e: { status?: number; detail?: string }) => {
            this.status = e.status ?? 500
            this.responseText = JSON.stringify({ detail: e.detail })
            this.onload?.()
          },
        )
      }
    }
    vi.stubGlobal('XMLHttpRequest', RecordingXHR)

    const up = new Uploader({ api, env: new EventTarget(), storage: memoryStorage(), online: () => true })
    const target = { recipientIds: [], isGlobal: true }
    await up.addFiles([new File(['abcdefghij'], 'a.txt', { lastModified: 1 })], target)
    const folder = ['top/x.txt', 'top/y.txt'].map((p) => {
      const f = new File(['12345'], p.split('/')[1], { lastModified: 2 })
      Object.defineProperty(f, 'webkitRelativePath', { value: p })
      return f
    })
    up.addFolder(folder, target)
    const deadline = Date.now() + 3000
    while (!up.jobs().every((j) => j.state === 'done') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    expect(up.jobs().map((j) => j.state)).toEqual(['done', 'done'])

    await up.addFiles([new File(['z'.repeat(40)], 'c.txt', { lastModified: 3 })], target)
    while (!srv.stats.puts.some((p) => p.endsWith(':0') && writes.at(-1)?.method === 'PUT')) await new Promise((r) => setTimeout(r, 1))
    await up.cancel(up.jobs()[2].id)
    await api.send('DELETE', '/api/items/x').catch(() => {})
    await api.send('POST', '/api/auth/logout').catch(() => {})

    const kinds = new Set(writes.map((w) => `${w.method} ${w.url.replace(/[0-9a-f]{32}/g, ':id').replace(/\/\d+$/, '/:n')}`))
    for (const k of ['POST /api/uploads', 'PUT /api/uploads/:id/chunks/:n', 'POST /api/uploads/:id/complete', 'POST /api/batches',
      'POST /api/batches/:id/files', 'POST /api/batches/:id/complete', 'DELETE /api/uploads/:id', 'DELETE /api/items/x', 'POST /api/auth/logout']) {
      expect(kinds).toContain(k)
    }
    expect(writes.filter((w) => w.csrf !== 'fs')).toEqual([])
  })
})

// A small in-memory copy of the backend upload protocol, for the Uploader tests.
import { ApiError, type PutOptions } from '../../api/client'
import type { Item } from '../../api/types'

type Up = {
  id: string
  key: string
  size: number
  received: Set<number>
  done: boolean
  itemId?: string
  batchId?: string
  path?: string
}

type Hook = (info: { method: string; path: string; body?: unknown; n?: number; signal?: AbortSignal }) => unknown

export function fakeServer({ chunkSize = 4, delay = 2, maxReserved = Infinity } = {}) {
  const ups = new Map<string, Up>()
  const batches = new Map<string, { name: string; done: boolean; item?: Item }>()
  const log: string[] = []
  let seq = 0
  let inflight = 0
  const inflightPer = new Map<string, number>()
  const stats = { maxInflight: 0, maxPerUpload: 0, maxUploads: 0, puts: [] as string[] }
  const hooks: { before?: Hook } = {}

  const nextId = () => (++seq).toString(16).padStart(32, '0')
  const chunks = (size: number) => Math.ceil(size / chunkSize)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const item = (name: string, size: number, kind: Item['kind'] = 'file'): Item => ({
    id: `item-${nextId()}`, kind, name, size, mime: 'application/octet-stream',
    sender: { id: 1, username: 'ayman' }, recipients: [], is_global: true,
    text_body: null, text_truncated: false, line_count: null, file_count: null,
    created_at: new Date().toISOString(), expires_at: new Date().toISOString(),
  })
  const items = new Map<string, Item>()
  /** Bytes promised to unfinished uploads (the server's 20 GiB per-user limit, scaled down). */
  const reserved = () => [...ups.values()].filter((x) => !x.done)
    .reduce((sum, x) => sum + x.size - [...x.received].reduce((a, n) => a + Math.min(chunkSize, x.size - n * chunkSize), 0), 0)

  async function get<T>(path: string): Promise<T> {
    log.push(`GET ${path}`)
    await hooks.before?.({ method: 'GET', path })
    let m = path.match(/^\/api\/uploads\/(\w+)$/)
    if (m) {
      const up = ups.get(m[1])
      if (!up) throw new ApiError(404, 'not_found')
      return { received: [...up.received].sort((a, b) => a - b), size: up.size, chunk_size: chunkSize,
        completed: up.done, item_id: up.itemId ?? null } as T
    }
    m = path.match(/^\/api\/items\/([\w-]+)$/)
    if (m && items.has(m[1])) return items.get(m[1]) as T
    throw new ApiError(404, 'not_found')
  }

  async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
    log.push(`${method} ${path}`)
    const hooked = await hooks.before?.({ method, path, body })
    if (hooked !== undefined) return hooked as T
    const b = body as Record<string, unknown>
    if (method === 'POST' && path === '/api/uploads') {
      const old = [...ups.values()].find((u) => u.key === b.client_key && u.size === b.size && !u.done && !u.batchId)
      if (!old && reserved() + Number(b.size) > maxReserved) throw new ApiError(429, 'upload_quota')
      const up = old ?? { id: nextId(), key: String(b.client_key), size: Number(b.size), received: new Set<number>(), done: false }
      ups.set(up.id, up)
      return { upload_id: up.id, chunk_size: chunkSize, received: [...up.received].sort((x, y) => x - y) } as T
    }
    let m = path.match(/^\/api\/uploads\/(\w+)\/complete$/)
    if (method === 'POST' && m) {
      const up = ups.get(m[1])
      if (!up) throw new ApiError(404, 'not_found')
      if (!up.done) {
        const missing = Array.from({ length: chunks(up.size) }, (_, i) => i).filter((i) => !up.received.has(i))
        if (missing.length) throw new ApiError(409, 'missing_chunks', { missing })
        const it = item('file', up.size)
        items.set(it.id, it)
        up.done = true
        up.itemId = it.id
      }
      return items.get(up.itemId!) as T
    }
    m = path.match(/^\/api\/uploads\/(\w+)$/)
    if (method === 'DELETE' && m) {
      if (ups.get(m[1])?.done) throw new ApiError(409, 'already_complete') // like the real server
      if (!ups.delete(m[1])) throw new ApiError(404, 'not_found')
      return undefined as T
    }
    if (method === 'POST' && path === '/api/batches') {
      const id = nextId()
      batches.set(id, { name: String(b.name), done: false })
      return { batch_id: id } as T
    }
    m = path.match(/^\/api\/batches\/(\w+)\/files$/)
    if (method === 'POST' && m) {
      const batchId = m[1]
      if (!batches.has(batchId)) throw new ApiError(404, 'not_found')
      if (batches.get(batchId)!.done) throw new ApiError(409, 'batch_closed')
      const files = b.files as { relative_path: string; size: number; client_key: string }[]
      const fresh = files.filter((f) => ![...ups.values()].some((u) => u.batchId === batchId && u.path === f.relative_path && u.key === f.client_key))
      if (reserved() + fresh.reduce((sum, f) => sum + f.size, 0) > maxReserved) throw new ApiError(429, 'upload_quota')
      const out = files.map((f) => {
        let up = [...ups.values()].find((u) => u.batchId === batchId && u.path === f.relative_path && u.key === f.client_key)
        if (!up) {
          up = { id: nextId(), key: f.client_key, size: f.size, received: new Set(), done: f.size === 0, batchId, path: f.relative_path }
          ups.set(up.id, up)
        }
        return { relative_path: f.relative_path, upload_id: up.id, chunk_size: chunkSize, received: [...up.received].sort((x, y) => x - y) }
      })
      return { uploads: out } as T
    }
    m = path.match(/^\/api\/batches\/(\w+)\/complete$/)
    if (method === 'POST' && m) {
      const batch = batches.get(m[1])
      if (!batch) throw new ApiError(404, 'not_found')
      const mine = [...ups.values()].filter((u) => u.batchId === m![1])
      const failed = mine.filter((u) => !u.done).map((u) => u.path!).sort()
      if (!batch.item) {
        if (failed.length === mine.length) throw new ApiError(400, 'empty_batch')
        batch.item = item(batch.name, 0, 'folder')
        batch.done = true
        for (const x of mine) if (!x.done) ups.delete(x.id) // the server drops unfinished files
      }
      return { item: batch.item, failed } as T
    }
    throw new ApiError(404, 'not_found')
  }

  async function put(path: string, blob: Blob, opts: PutOptions = {}): Promise<void> {
    const m = path.match(/^\/api\/uploads\/(\w+)\/chunks\/(\d+)$/)!
    const [id, n] = [m[1], Number(m[2])]
    log.push(`PUT ${path}`)
    stats.puts.push(`${id}:${n}`)
    inflight++
    inflightPer.set(id, (inflightPer.get(id) ?? 0) + 1)
    stats.maxInflight = Math.max(stats.maxInflight, inflight)
    stats.maxPerUpload = Math.max(stats.maxPerUpload, inflightPer.get(id)!)
    stats.maxUploads = Math.max(stats.maxUploads, [...inflightPer.values()].filter((v) => v > 0).length)
    try {
      await hooks.before?.({ method: 'PUT', path, n, body: blob, signal: opts.signal })
      await sleep(delay)
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const up = ups.get(id)
      if (!up) throw new ApiError(404, 'not_found')
      if (up.done) throw new ApiError(409, 'already_complete')
      opts.onProgress?.(blob.size)
      up.received.add(n)
      if (up.batchId && up.received.size === chunks(up.size)) up.done = true
    } finally {
      inflight--
      inflightPer.set(id, inflightPer.get(id)! - 1)
    }
  }

  /** Finish an upload on the server side, as if another tab had completed it. */
  function finish(id: string) {
    const up = ups.get(id)!
    if (up.done) return
    const it = item('file', up.size)
    items.set(it.id, it)
    up.done = true
    up.itemId = it.id
  }

  return { api: { get, send, put }, ups, batches, log, stats, hooks, chunkSize, finish }
}

export function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    keys: () => [...data.keys()],
  }
}

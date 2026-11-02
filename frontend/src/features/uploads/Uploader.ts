// The upload engine: chunked, parallel, resumable. Lives outside React so a re-sign-in or a
// re-render never stops a transfer. Protocol: backend/README.md § Upload protocol.
import { ApiError, type PutOptions } from '../../api/client'
import type { BatchFilesOut, Item, UploadStarted, UploadStatus } from '../../api/types'
import { clientKey } from '../../lib/fingerprint'
import { SpeedMeter } from '../../lib/speed'

export type UploadApi = {
  get<T>(path: string): Promise<T>
  send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>
  put(path: string, blob: Blob, opts?: PutOptions): Promise<void>
}

export type Target = { recipientIds: number[]; isGlobal: boolean }
export type JobState = 'queued' | 'sending' | 'paused' | 'failed' | 'done'
export type Reason =
  | 'offline' | 'signed_out' | 'network' | 'too_large' | 'disk_full' | 'upload_quota'
  | 'file_changed' | 'not_found' | 'interrupted' | 'rejected'
export type FailedFile = { path: string; reason: Reason }

export type Job = {
  id: string
  kind: 'file' | 'folder'
  name: string
  size: number
  sent: number
  state: JobState
  reason?: Reason
  canRetry: boolean
  speed: number
  eta: number | null
  item?: Item
  files?: { total: number; done: number; failed: FailedFile[] }
}

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void }

type Options = {
  api: UploadApi
  env?: EventTarget
  storage?: Storage
  online?: () => boolean
  maxFiles?: number
  maxChunks?: number
}

const BACKOFF = [1000, 2000, 4000, 8000, 16000]
const GROUP = 500 // files per registration call (the server's limit)
const SMALL_AT_ONCE = 6
const BIG_AT_ONCE = 2
const MAX_FILE = 10 * 1024 ** 3 // the server's per-file limit ("Any size up to 10 GB")
const PENDING_KEY = 'fs.pending'
const RETRYABLE: Reason[] = ['network', 'not_found']

/** One file on its way: a single upload, or one file of a folder. */
type Task = {
  file: File
  path: string
  key?: string
  uploadId?: string
  chunkSize: number
  received: Set<number>
  doneBytes: number
  loaded: Map<number, number>
  state: 'pending' | 'done' | 'failed'
  reason?: Reason
  restarted: boolean
}

type Rec = {
  id: string
  kind: 'file' | 'folder'
  name: string
  target: Target
  state: JobState
  reason?: Reason
  canRetry: boolean
  item?: Item
  tasks: Task[]
  totalFiles: number
  batchId?: string
  meter: SpeedMeter
  lastSent: number
  abort: AbortController
  interrupted?: Pending
}

type Pending = {
  kind: 'file' | 'folder'
  name: string
  size: number
  target: Target
  key?: string
  uploadId?: string
  batchId?: string
  totalFiles: number
}

class Stop extends Error {
  readonly reason: Reason
  readonly retryable: boolean

  constructor(reason: Reason, retryable = RETRYABLE.includes(reason)) {
    super(reason)
    this.reason = reason
    this.retryable = retryable
  }
}

class Aborted extends Error {}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
const isFileError = (e: unknown) =>
  e instanceof DOMException && (e.name === 'NotReadableError' || e.name === 'NotFoundError')
const numChunks = (size: number, chunk: number) => Math.ceil(size / chunk)
const chunkLen = (size: number, chunk: number, n: number) => Math.min(chunk, size - n * chunk)
const sameTarget = (a: Target, b: Target) =>
  a.isGlobal === b.isGlobal && a.recipientIds.slice().sort((x, y) => x - y).join() === b.recipientIds.slice().sort((x, y) => x - y).join()

function toStop(e: unknown): Stop {
  if (e instanceof Stop) return e
  if (isFileError(e)) return new Stop('file_changed')
  if (e instanceof ApiError) {
    if (e.status === 413) return new Stop('too_large')
    if (e.status === 507) return new Stop('disk_full')
    if (e.status === 429) return new Stop('upload_quota')
    if (e.status === 404) return new Stop('not_found')
    if (e.status < 500) return new Stop('rejected')
  }
  return new Stop('network')
}

/** Run `fn` over `items`, at most `limit` at a time; the first Aborted stops it. */
async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  let stop: unknown = null
  const worker = async () => {
    while (stop === null && next < items.length) {
      const item = items[next++]
      try {
        await fn(item)
      } catch (e) {
        stop ??= e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (stop !== null) throw stop
}

let seq = 0

export class Uploader {
  private api: UploadApi
  private env: EventTarget
  private storage?: Storage
  private online: () => boolean
  private maxFiles: number
  private maxChunks: number
  private recs: Rec[] = []
  private active = new Set<Rec>()
  private paused: 'offline' | 'signed_out' | null = null
  private waiters: (() => void)[] = []
  private sleepers = new Set<() => void>()
  private listeners = new Set<() => void>()
  private snapshot: Job[] = []
  private dirty = true
  private timer: ReturnType<typeof setTimeout> | null = null
  private detached = false
  private handlers: [string, (e: Event) => void][]

  constructor(opts: Options) {
    this.api = opts.api
    this.env = opts.env ?? new EventTarget()
    this.storage = opts.storage
    this.online = opts.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false)
    this.maxFiles = opts.maxFiles ?? 2
    this.maxChunks = opts.maxChunks ?? 4
    this.handlers = [
      ['offline', () => this.pause('offline')],
      ['online', () => { if (this.paused === 'offline') this.resume(); this.wake() }],
      ['fs:signed-out', () => this.pause('signed_out')],
      ['fs:signed-in', () => { if (this.paused === 'signed_out') this.resume(); this.wake() }],
      ['visibilitychange', () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') this.wake() }],
      ['beforeunload', (e) => { if (this.busy()) { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = '' } }],
    ]
    for (const [type, fn] of this.handlers) this.env.addEventListener(type, fn)
    this.restore()
  }

  // ---------- public API ----------

  /** Queue single files. Returns the names refused because the same send is already running. */
  async addFiles(files: File[], target: Target): Promise<{ duplicates: string[] }> {
    const duplicates: string[] = []
    for (const file of files) {
      const key = await clientKey(file, target.recipientIds, target.isGlobal)
      const running = this.recs.find((r) => r.kind === 'file' && !r.interrupted && r.state !== 'done' &&
        r.state !== 'failed' && r.tasks[0].key === key)
      if (running) {
        duplicates.push(file.name)
        continue
      }
      // a re-picked file after a reload: the server resumes it by its key
      this.recs = this.recs.filter((r) => !(r.interrupted?.kind === 'file' && r.interrupted.key === key))
      const rec = this.newRec('file', file.name, target, [this.newTask(file, file.name)], 1)
      rec.tasks[0].key = key
      this.recs.push(rec)
    }
    this.changed()
    this.pump()
    return { duplicates }
  }

  /** Queue a picked folder (files carry webkitRelativePath "top/sub/name"). One row for all of it. */
  addFolder(files: File[], target: Target): void {
    if (!files.length) return
    const top = files[0].webkitRelativePath.split('/')[0] || 'Folder'
    const tasks = files.map((f) => this.newTask(f, f.webkitRelativePath.split('/').slice(1).join('/') || f.name))
    for (const t of tasks) {
      if (t.file.size > MAX_FILE) {
        t.state = 'failed'
        t.reason = 'too_large'
      }
    }
    const rec = this.newRec('folder', top, target, tasks, files.length)
    const old = this.recs.find((r) => r.interrupted?.kind === 'folder' && r.interrupted.name === top &&
      r.interrupted.totalFiles === files.length && sameTarget(r.interrupted.target, target))
    if (old) {
      rec.batchId = old.interrupted!.batchId // the same batch: finished files and chunks are kept
      this.recs = this.recs.filter((r) => r !== old)
    }
    this.recs.push(rec)
    this.changed()
    this.pump()
  }

  retry(id: string): void {
    const rec = this.recs.find((r) => r.id === id)
    if (!rec || rec.interrupted) return
    if (rec.state === 'done' && rec.kind === 'folder') {
      // "Done · N failed": send just those again, as a new folder
      const again = rec.tasks.filter((t) => t.state === 'failed' && t.reason !== 'too_large')
      if (!again.length) return
      const tasks = again.map((t) => this.newTask(t.file, t.path))
      this.recs.push(this.newRec('folder', rec.name, rec.target, tasks, tasks.length))
    } else if (rec.state === 'failed' && rec.canRetry) {
      for (const t of rec.tasks) {
        if (t.state === 'failed' && t.reason && RETRYABLE.includes(t.reason)) {
          t.state = 'pending'
          t.reason = undefined
          t.restarted = false
        }
      }
      rec.state = 'queued'
      rec.reason = undefined
      rec.abort = new AbortController()
    } else {
      return
    }
    this.changed()
    this.pump()
  }

  async cancel(id: string): Promise<void> {
    const rec = this.recs.find((r) => r.id === id)
    if (!rec) return
    rec.abort.abort()
    this.recs = this.recs.filter((r) => r !== rec)
    this.active.delete(rec)
    this.wake()
    this.changed()
    this.pump()
    if (rec.state === 'done') return
    // free the server's reservation now instead of after the stale sweep
    const open = rec.tasks.filter((t) => t.uploadId && t.state !== 'done').map((t) => t.uploadId!)
    if (rec.interrupted?.uploadId) open.push(rec.interrupted.uploadId)
    await pool(open, SMALL_AT_ONCE, async (uploadId) => {
      await this.api.send('DELETE', `/api/uploads/${uploadId}`).catch(() => {})
    })
  }

  /** Remove finished or failed rows from the list. */
  dismiss(id: string): void {
    const rec = this.recs.find((r) => r.id === id)
    if (!rec || (rec.state !== 'done' && rec.state !== 'failed')) return
    if (rec.interrupted) return void this.cancel(id)
    this.recs = this.recs.filter((r) => r !== rec)
    this.changed()
  }

  onChange = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  jobs = (): Job[] => {
    if (this.dirty) {
      this.snapshot = this.recs.map((r) => this.view(r))
      this.dirty = false
    }
    return this.snapshot
  }

  busy(): boolean {
    return this.recs.some((r) => !r.interrupted && (r.state === 'queued' || r.state === 'sending' || r.state === 'paused'))
  }

  /** Stop without touching the server (the tab is going away; used by tests for a "reload"). */
  detach(): void {
    this.detached = true
    for (const [type, fn] of this.handlers) this.env.removeEventListener(type, fn)
    for (const r of this.recs) r.abort.abort()
    this.wake()
  }

  // ---------- scheduling ----------

  private newTask(file: File, path: string): Task {
    return { file, path, chunkSize: 0, received: new Set(), doneBytes: 0, loaded: new Map(), state: 'pending', restarted: false }
  }

  private newRec(kind: Rec['kind'], name: string, target: Target, tasks: Task[], totalFiles: number): Rec {
    return {
      id: `job-${++seq}`, kind, name, target, state: 'queued', canRetry: false, tasks, totalFiles,
      meter: new SpeedMeter(), lastSent: 0, abort: new AbortController(),
    }
  }

  private pump(): void {
    if (this.detached) return
    for (const rec of this.recs) {
      if (this.active.size >= this.maxFiles) break
      if (rec.state === 'queued' && !this.active.has(rec)) {
        this.active.add(rec)
        void this.run(rec)
      }
    }
  }

  private async run(rec: Rec): Promise<void> {
    rec.state = this.paused ? 'paused' : 'sending'
    rec.reason = this.paused ?? undefined
    rec.meter.reset()
    this.changed()
    try {
      if (rec.kind === 'file') await this.runFile(rec)
      else await this.runFolder(rec)
      rec.state = 'done'
      rec.reason = undefined
    } catch (e) {
      if (e instanceof Aborted || rec.abort.signal.aborted) return
      const stop = toStop(e)
      rec.state = 'failed'
      rec.reason = stop.reason
      rec.canRetry = stop.retryable
    } finally {
      this.active.delete(rec)
      if (!this.detached) {
        this.changed()
        this.pump()
      }
    }
  }

  private pause(reason: 'offline' | 'signed_out'): void {
    if (this.paused === 'signed_out' && reason === 'offline') return
    this.paused = reason
    for (const r of this.active) {
      r.state = 'paused'
      r.reason = reason
    }
    this.changed()
  }

  private resume(): void {
    this.paused = null
    for (const r of this.active) {
      r.state = 'sending'
      r.reason = undefined
      r.meter.reset()
    }
    const waiting = this.waiters
    this.waiters = []
    waiting.forEach((w) => w())
    this.changed()
  }

  /** Wait while offline or signed out. Throws Aborted once the job is cancelled. */
  private async gate(rec: Rec): Promise<void> {
    while (true) {
      if (rec.abort.signal.aborted || this.detached) throw new Aborted()
      if (!this.paused) return
      await new Promise<void>((r) => {
        this.waiters.push(r)
        rec.abort.signal.addEventListener('abort', () => r(), { once: true })
      })
    }
  }

  private sleep(ms: number, rec: Rec): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.sleepers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.sleepers.add(done)
      rec.abort.signal.addEventListener('abort', done, { once: true })
    })
  }

  /** Back online or back in view: retry now instead of waiting out the backoff. */
  private wake(): void {
    for (const s of this.sleepers) s() // each removes itself; deleting while iterating a Set is safe
  }

  /** One request with pauses and backoff. Errors the caller must judge are rethrown. */
  private async attempt<T>(rec: Rec, fn: () => Promise<T>): Promise<T> {
    let tries = 0
    while (true) {
      await this.gate(rec)
      try {
        return await fn()
      } catch (e) {
        if (rec.abort.signal.aborted || this.detached || isAbort(e)) throw new Aborted()
        if (e instanceof ApiError) {
          if (e.status === 401) {
            this.pause('signed_out')
            continue
          }
          if (e.status < 500 || e.status === 507) throw e
        } else if (isFileError(e)) {
          throw new Stop('file_changed')
        }
        if (!this.online()) {
          this.pause('offline')
          continue
        }
        if (tries >= BACKOFF.length) throw new Stop('network')
        await this.sleep(BACKOFF[tries++], rec)
      }
    }
  }

  // ---------- one file ----------

  private async startUpload(rec: Rec, task: Task): Promise<void> {
    const started = await this.attempt(rec, () => this.api.send<UploadStarted>('POST', '/api/uploads', {
      client_key: task.key,
      name: task.file.name,
      size: task.file.size,
      mime: task.file.type || 'application/octet-stream',
      recipient_ids: rec.target.isGlobal ? [] : rec.target.recipientIds,
      is_global: rec.target.isGlobal,
    }))
    this.applyStart(task, started.upload_id, started.chunk_size, started.received)
    this.persist()
  }

  private applyStart(task: Task, uploadId: string, chunkSize: number, received: number[]): void {
    task.uploadId = uploadId
    task.chunkSize = chunkSize
    task.received = new Set(received)
    task.doneBytes = received.reduce((sum, n) => sum + chunkLen(task.file.size, chunkSize, n), 0)
  }

  private forget(task: Task): void {
    task.uploadId = undefined
    task.received.clear()
    task.doneBytes = 0
    task.loaded.clear()
  }

  private async runFile(rec: Rec): Promise<void> {
    const task = rec.tasks[0]
    while (true) {
      try {
        if (!task.uploadId) await this.startUpload(rec, task)
        rec.item = await this.sendAndComplete(rec, task)
        task.state = 'done'
        return
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.detail === 'already_complete') {
          rec.item = await this.finishedElsewhere(rec, task)
          task.state = 'done'
          return
        }
        if (e instanceof ApiError && e.status === 404 && !task.restarted) {
          task.restarted = true // the upload expired on the server: start over once
          this.forget(task)
          continue
        }
        throw e
      }
    }
  }

  private async sendAndComplete(rec: Rec, task: Task): Promise<Item> {
    for (let round = 0; ; round++) {
      await this.sendChunks(rec, task)
      try {
        return await this.attempt(rec, () => this.api.send<Item>('POST', `/api/uploads/${task.uploadId}/complete`))
      } catch (e) {
        const missing = e instanceof ApiError && e.detail === 'missing_chunks' ? (e.extra.missing as number[]) : null
        if (!missing || round >= 3) throw e
        for (const n of missing) {
          if (task.received.delete(n)) task.doneBytes -= chunkLen(task.file.size, task.chunkSize, n)
        }
      }
    }
  }

  private async finishedElsewhere(rec: Rec, task: Task): Promise<Item | undefined> {
    const status = await this.attempt(rec, () => this.api.get<UploadStatus>(`/api/uploads/${task.uploadId}`))
    if (!status.item_id) return undefined
    return this.attempt(rec, () => this.api.get<Item>(`/api/items/${status.item_id}`))
  }

  private async sendChunks(rec: Rec, task: Task): Promise<void> {
    const { size } = task.file
    const missing: number[] = []
    for (let n = 0; n < numChunks(size, task.chunkSize); n++) if (!task.received.has(n)) missing.push(n)
    await pool(missing, this.maxChunks, (n) => this.putChunk(rec, task, n))
  }

  private async putChunk(rec: Rec, task: Task, n: number): Promise<void> {
    const start = n * task.chunkSize
    const blob = task.file.slice(start, Math.min(task.file.size, start + task.chunkSize))
    try {
      await this.attempt(rec, () => this.api.put(`/api/uploads/${task.uploadId}/chunks/${n}`, blob, {
        signal: rec.abort.signal,
        onProgress: (loaded) => {
          task.loaded.set(n, loaded)
          this.progress(rec)
        },
      }))
      task.received.add(n)
      task.doneBytes += blob.size
    } finally {
      task.loaded.delete(n)
      this.progress(rec)
    }
  }

  // ---------- folders ----------

  private async runFolder(rec: Rec): Promise<void> {
    const { recipientIds, isGlobal } = rec.target
    const live = () => rec.tasks.filter((t) => t.state !== 'failed' || (t.reason && RETRYABLE.includes(t.reason)))
    if (!live().length) throw new Stop('too_large')
    for (let fresh = 0; ; fresh++) {
      if (!rec.batchId) {
        const out = await this.attempt(rec, () => this.api.send<{ batch_id: string }>('POST', '/api/batches', {
          name: rec.name, file_count: live().length, recipient_ids: isGlobal ? [] : recipientIds, is_global: isGlobal,
        }))
        rec.batchId = out.batch_id
        this.persist()
      }
      const todo = rec.tasks.filter((t) => t.state === 'pending' && !t.uploadId)
      await pool(todo.filter((t) => !t.key), 8, async (t) => { t.key = await clientKey(t.file, recipientIds, isGlobal) })
      try {
        for (let i = 0; i < todo.length; i += GROUP) await this.register(rec, todo.slice(i, i + GROUP))
        break
      } catch (e) {
        // a batch kept from before a reload may be gone or closed: start a new one, once
        const gone = e instanceof ApiError && (e.status === 404 || e.detail === 'batch_closed')
        if (!gone || fresh > 0) throw e
        rec.batchId = undefined
        for (const t of rec.tasks) this.forget(t)
      }
    }
    this.changed()

    const pending = rec.tasks.filter((t) => t.state === 'pending')
    const small = pending.filter((t) => t.file.size <= t.chunkSize)
    const big = pending.filter((t) => t.file.size > t.chunkSize)
    await pool(small, SMALL_AT_ONCE, (t) => this.sendFolderFile(rec, t))
    await pool(big, BIG_AT_ONCE, (t) => this.sendFolderFile(rec, t))

    if (rec.tasks.some((t) => t.state === 'failed' && t.reason && RETRYABLE.includes(t.reason))) {
      throw new Stop('network') // Retry continues the same folder
    }
    const out = await this.attempt(rec, () =>
      this.api.send<{ item: Item; failed: string[] }>('POST', `/api/batches/${rec.batchId}/complete`),
    ).catch((e) => {
      throw e instanceof ApiError && e.detail === 'empty_batch' ? new Stop(rec.tasks[0]?.reason ?? 'rejected', false) : e
    })
    rec.item = out.item
    for (const path of out.failed) {
      const t = rec.tasks.find((x) => x.path === path && x.state === 'done')
      if (t) {
        t.state = 'failed'
        t.reason = 'network'
      }
    }
  }

  /** Register files with the batch; a refused group is retried one by one so only bad files fail. */
  private async register(rec: Rec, group: Task[]): Promise<void> {
    try {
      const out = await this.attempt(rec, () => this.api.send<BatchFilesOut>('POST', `/api/batches/${rec.batchId}/files`, {
        files: group.map((t) => ({
          relative_path: t.path, size: t.file.size, mime: t.file.type || 'application/octet-stream', client_key: t.key,
        })),
      }))
      // the answer is in request order (paths come back cleaned, e.g. NFC)
      out.uploads.forEach((u, i) => {
        const t = group[i]
        this.applyStart(t, u.upload_id, u.chunk_size, u.received)
        if (t.received.size === numChunks(t.file.size, t.chunkSize)) t.state = 'done'
      })
    } catch (e) {
      const perFile = e instanceof ApiError && (e.status === 400 || e.status === 409 || e.status === 413) &&
        e.detail !== 'batch_closed'
      if (!perFile) throw e
      if (group.length > 1) {
        for (const t of group) await this.register(rec, [t])
        return
      }
      group[0].state = 'failed'
      group[0].reason = (e as ApiError).status === 413 ? 'too_large' : 'rejected'
    }
  }

  private async sendFolderFile(rec: Rec, task: Task): Promise<void> {
    try {
      await this.sendChunks(rec, task)
      task.state = 'done'
    } catch (e) {
      if (e instanceof Aborted) throw e
      if (e instanceof ApiError && e.status === 409 && e.detail === 'already_complete') {
        task.state = 'done'
      } else if (e instanceof ApiError && e.status === 404 && !task.restarted) {
        task.restarted = true
        this.forget(task)
        await this.register(rec, [task])
        if (task.state === 'pending') await this.sendFolderFile(rec, task)
      } else {
        const stop = toStop(e)
        task.state = 'failed'
        task.reason = stop.reason
      }
    } finally {
      this.changed()
    }
  }

  // ---------- state for the UI ----------

  private sent(rec: Rec): number {
    let sum = 0
    for (const t of rec.tasks) {
      sum += t.doneBytes
      for (const l of t.loaded.values()) sum += l
    }
    return sum
  }

  private progress(rec: Rec): void {
    const sent = this.sent(rec)
    if (sent > rec.lastSent) rec.meter.add(sent - rec.lastSent)
    rec.lastSent = sent
    this.dirty = true
    // progress events come fast: tell the UI at most every 100 ms
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.emit()
    }, 100)
  }

  private changed(): void {
    this.dirty = true
    this.persist()
    this.emit()
  }

  private emit(): void {
    if (this.detached) return
    this.listeners.forEach((l) => l())
  }

  private view(r: Rec): Job {
    const size = r.interrupted ? r.interrupted.size : r.tasks.reduce((s, t) => s + t.file.size, 0)
    const sent = r.state === 'done' && r.kind === 'file' ? size : this.sent(r)
    const sending = r.state === 'sending'
    const job: Job = {
      id: r.id, kind: r.kind, name: r.name, size, sent, state: r.state, canRetry: r.canRetry,
      speed: sending ? r.meter.bytesPerSec() : 0,
      eta: sending ? r.meter.eta(Math.max(0, size - sent)) : null,
    }
    if (r.reason) job.reason = r.reason
    if (r.item) job.item = r.item
    if (r.kind === 'folder') {
      job.files = {
        total: r.interrupted ? r.interrupted.totalFiles : r.totalFiles,
        done: r.tasks.filter((t) => t.state === 'done').length,
        failed: r.tasks.filter((t) => t.state === 'failed').map((t) => ({ path: t.path, reason: t.reason! })),
      }
    }
    return job
  }

  // ---------- surviving a reload ----------

  private persist(): void {
    if (!this.storage || this.detached) return
    const pending: Pending[] = this.recs
      .filter((r) => r.state !== 'done' && !(r.state === 'failed' && !r.canRetry && !r.interrupted))
      .map((r) => r.interrupted ?? {
        kind: r.kind, name: r.name, target: r.target, totalFiles: r.totalFiles,
        size: r.tasks.reduce((s, t) => s + t.file.size, 0),
        key: r.kind === 'file' ? r.tasks[0].key : undefined,
        uploadId: r.kind === 'file' ? r.tasks[0].uploadId : undefined,
        batchId: r.batchId,
      })
    try {
      this.storage.setItem(PENDING_KEY, JSON.stringify(pending))
    } catch {
      // storage full or blocked: resuming after a reload just won't be offered
    }
  }

  private restore(): void {
    let saved: Pending[] = []
    try {
      saved = JSON.parse(this.storage?.getItem(PENDING_KEY) ?? '[]')
    } catch {
      saved = []
    }
    if (!Array.isArray(saved)) return
    for (const p of saved) {
      if (!p || (p.kind !== 'file' && p.kind !== 'folder') || typeof p.name !== 'string') continue
      const rec = this.newRec(p.kind, p.name, p.target, [], p.totalFiles)
      rec.state = 'failed'
      rec.reason = 'interrupted'
      rec.interrupted = p
      this.recs.push(rec)
    }
  }
}

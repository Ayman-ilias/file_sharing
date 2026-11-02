// One live connection per browser: tabs elect a leader over BroadcastChannel("fs-events"); only
// the leader opens the EventSource and passes events on. Reconnects back off; a lost session stops.
import { api, ApiError } from '../../api/client'
import type { Item } from '../../api/types'

export type LiveEvent =
  | { type: 'created'; item: Item }
  | { type: 'deleted'; id: string; by: string | null }
  | { type: 'reconnect'; first: boolean } // first = the stream just opened for the first time

type SourceLike = {
  addEventListener(type: string, fn: (e: MessageEvent) => void): void
  close(): void
}
type ChannelLike = {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(data: unknown): void
  close(): void
}
type Msg =
  | { t: 'beat'; id: string }
  | { t: 'who' }
  | { t: 'bye'; id: string }
  | { t: 'event'; ev: LiveEvent }
  | { t: 'signed-in' }

type Deps = {
  source?: (url: string) => SourceLike
  channel?: ((name: string) => ChannelLike) | null
  checkSession?: () => Promise<boolean>
  env?: EventTarget
  random?: () => number
}

const BEAT = 1000
const LEADER_GONE = 2500 // no beat for this long → take over (checked every BEAT: within ~3 s)
const STARTUP = 500
const WATCHDOG = 60_000
const MAX_BACKOFF = 30_000

async function sessionAlive(): Promise<boolean> {
  try {
    await api.get('/api/auth/me')
    return true
  } catch (e) {
    return !(e instanceof ApiError && e.status === 401) // a network error: keep retrying
  }
}

export class LiveEvents {
  private readonly id = Math.random().toString(36).slice(2) + Date.now().toString(36)
  private readonly makeSource: ((url: string) => SourceLike) | null
  private readonly makeChannel: ((name: string) => ChannelLike) | null
  private readonly checkSession: () => Promise<boolean>
  private readonly env: EventTarget
  private readonly random: () => number
  private listeners = new Set<(e: LiveEvent) => void>()
  private channel: ChannelLike | null = null
  private leader = false
  private lastBeat = 0
  private es: SourceLike | null = null
  private everOpened = false
  private failures = 0
  private signedOut = false
  private running = false
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private beatTimer: ReturnType<typeof setInterval> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  /** Signed in again in this tab: tell the other tabs too (the leader may be another tab). */
  private onSignedIn = () => {
    this.channel?.postMessage({ t: 'signed-in' })
    this.reopen()
  }

  private reopen(): void {
    if (this.signedOut && this.leader) {
      this.signedOut = false
      this.failures = 0
      this.open()
    }
  }

  constructor(deps: Deps = {}) {
    this.makeSource = deps.source ?? (typeof EventSource === 'function' ? (url) => new EventSource(url) : null)
    this.makeChannel = deps.channel !== undefined ? deps.channel
      : typeof BroadcastChannel === 'function' ? (name) => new BroadcastChannel(name) as unknown as ChannelLike : null
    this.checkSession = deps.checkSession ?? sessionAlive
    this.env = deps.env ?? (typeof window !== 'undefined' ? window : new EventTarget())
    this.random = deps.random ?? Math.random
  }

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  isLeader(): boolean {
    return this.leader
  }

  start(): void {
    if (this.running || !this.makeSource) return // no EventSource here: lists refresh on their own triggers
    this.running = true
    this.env.addEventListener('fs:signed-in', this.onSignedIn)
    this.channel = this.makeChannel?.('fs-events') ?? null
    if (!this.channel) return this.lead()
    this.channel.onmessage = (e) => this.onMessage(e.data as Msg)
    this.channel.postMessage({ t: 'who' })
    this.later(() => { if (!this.leader && Date.now() - this.lastBeat > STARTUP) this.lead() }, STARTUP)
    this.beatTimer = setInterval(() => this.tick(), BEAT)
  }

  stop(): void {
    if (!this.running) return
    if (this.leader) this.channel?.postMessage({ t: 'bye', id: this.id })
    this.halt()
    this.channel?.close()
    this.channel = null
  }

  /** Tests only: behave like a crashed tab (no goodbye, no more beats). */
  freezeForTest(): void {
    this.halt()
  }

  private halt(): void {
    this.running = false
    this.leader = false
    this.closeSource()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    if (this.beatTimer) clearInterval(this.beatTimer)
    this.beatTimer = null
    this.env.removeEventListener('fs:signed-in', this.onSignedIn)
    if (this.channel) this.channel.onmessage = null
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
  }

  // ---------- election ----------

  private tick(): void {
    if (this.leader) this.channel?.postMessage({ t: 'beat', id: this.id })
    else if (Date.now() - this.lastBeat > LEADER_GONE) this.lead()
  }

  private onMessage(msg: Msg): void {
    if (!this.running) return
    if (msg.t === 'beat') {
      this.lastBeat = Date.now()
      if (this.leader && msg.id < this.id) this.stepDown() // two leaders: the smaller id wins
    } else if (msg.t === 'who') {
      if (this.leader) this.channel?.postMessage({ t: 'beat', id: this.id })
    } else if (msg.t === 'bye') {
      this.lastBeat = 0 // the next tick takes over
    } else if (msg.t === 'event') {
      this.emit(msg.ev)
    } else if (msg.t === 'signed-in') {
      this.reopen()
    }
  }

  private lead(): void {
    if (this.leader || !this.running) return
    this.leader = true
    this.channel?.postMessage({ t: 'beat', id: this.id })
    this.open()
  }

  private stepDown(): void {
    this.leader = false
    this.lastBeat = Date.now()
    this.closeSource()
  }

  // ---------- the connection (leader only) ----------

  private open(): void {
    this.closeSource()
    if (!this.leader || !this.running) return
    const es = this.makeSource!('/api/events')
    this.es = es
    es.addEventListener('open', () => {
      if (this.es !== es) return
      this.failures = 0
      // also on the first open: items sent between the list load and now were never streamed
      this.dispatch({ type: 'reconnect', first: !this.everOpened })
      this.everOpened = true
      this.feed()
    })
    es.addEventListener('ping', () => this.feed())
    es.addEventListener('item.created', (e) => {
      this.feed()
      this.dispatch({ type: 'created', item: JSON.parse(e.data).item })
    })
    es.addEventListener('item.deleted', (e) => {
      this.feed()
      const d = JSON.parse(e.data)
      this.dispatch({ type: 'deleted', id: d.id, by: d.by ?? null })
    })
    es.addEventListener('error', () => { if (this.es === es) void this.failed() })
    this.feed()
  }

  private closeSource(): void {
    this.es?.close()
    this.es = null
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
  }

  /** Anything from the server proves the stream is alive; silence for 60 s means it isn't. */
  private feed(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => void this.failed(), WATCHDOG)
  }

  private async failed(): Promise<void> {
    this.closeSource()
    if (!(await this.checkSession())) {
      this.signedOut = true // the sign-in flow takes over; no reconnect loop
      return
    }
    const base = Math.min(MAX_BACKOFF, 1000 * 2 ** this.failures++)
    this.later(() => this.open(), Math.round(base * (0.5 + this.random() / 2)))
  }

  private dispatch(ev: LiveEvent): void {
    this.emit(ev)
    this.channel?.postMessage({ t: 'event', ev })
  }

  private emit(ev: LiveEvent): void {
    this.listeners.forEach((fn) => fn(ev))
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveEvents, type LiveEvent } from './liveEvents'

class FakeSource {
  static all: FakeSource[] = []
  listeners = new Map<string, ((e: MessageEvent) => void)[]>()
  closed = false
  url: string
  constructor(url: string) {
    this.url = url
    FakeSource.all.push(this)
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() { this.closed = true }
  fire(type: string, data?: unknown) {
    const e = new MessageEvent(type, { data: data === undefined ? '' : JSON.stringify(data) })
    for (const fn of this.listeners.get(type) ?? []) fn(e)
  }
}

/** BroadcastChannel between fake tabs: delivers to the others, not to the sender. */
function bus() {
  const members = new Set<FakeChannel>()
  class FakeChannel {
    onmessage: ((e: { data: unknown }) => void) | null = null
    constructor() { members.add(this) }
    postMessage(data: unknown) {
      for (const m of members) if (m !== this) queueMicrotask(() => m.onmessage?.({ data: structuredClone(data) }))
    }
    close() { members.delete(this) }
  }
  return () => new FakeChannel()
}

const open = () => FakeSource.all.filter((s) => !s.closed)

function tab(channel: (() => unknown) | null, checkSession = vi.fn().mockResolvedValue(true)) {
  const env = new EventTarget()
  const live = new LiveEvents({
    source: (url) => new FakeSource(url),
    channel: channel as never,
    checkSession,
    env,
    random: () => 1,
  })
  const seen: LiveEvent[] = []
  live.subscribe((e) => seen.push(e))
  live.start()
  return { live, seen, env, checkSession }
}

beforeEach(() => {
  FakeSource.all = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('LiveEvents', () => {
  it('turns server events into created/deleted', async () => {
    const { seen } = tab(null)
    const es = open()[0]
    expect(es.url).toBe('/api/events')
    es.fire('open')
    es.fire('item.created', { item: { id: 'a' } })
    es.fire('item.deleted', { id: 'a', by: 'rahim' })
    // the first open is announced too: anything sent before the stream opened gets fetched
    expect(seen).toEqual([{ type: 'reconnect', first: true }, { type: 'created', item: { id: 'a' } }, { type: 'deleted', id: 'a', by: 'rahim' }])
  })

  it('one connection for two tabs; the other tab gets the events through the channel', async () => {
    const channel = bus()
    const a = tab(channel)
    await vi.advanceTimersByTimeAsync(600)
    const b = tab(channel)
    await vi.advanceTimersByTimeAsync(2000)
    expect(open()).toHaveLength(1)
    expect(a.live.isLeader()).toBe(true)
    open()[0].fire('item.created', { item: { id: 'x' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(b.seen).toEqual([{ type: 'created', item: { id: 'x' } }])
  })

  it('another tab takes over within 3 s when the leader goes', async () => {
    const channel = bus()
    const a = tab(channel)
    await vi.advanceTimersByTimeAsync(600)
    const b = tab(channel)
    await vi.advanceTimersByTimeAsync(1500)
    a.live.stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(b.live.isLeader()).toBe(true)
    expect(open()).toHaveLength(1)
  })

  it('a leader that silently disappears is replaced within about 3 s', async () => {
    const channel = bus()
    const a = tab(channel)
    await vi.advanceTimersByTimeAsync(600)
    const b = tab(channel)
    await vi.advanceTimersByTimeAsync(1500)
    a.live.freezeForTest() // a crashed tab: no "bye", no more beats
    await vi.advanceTimersByTimeAsync(3500)
    expect(b.live.isLeader()).toBe(true)
  })

  it('after an error it checks the session, backs off, and announces the reconnect', async () => {
    const { seen, checkSession } = tab(null)
    const first = open()[0]
    first.fire('open')
    first.fire('error')
    await vi.advanceTimersByTimeAsync(0)
    expect(checkSession).toHaveBeenCalledTimes(1)
    expect(first.closed).toBe(true)
    expect(open()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    const second = open()[0]
    second.fire('open')
    expect(seen).toEqual([{ type: 'reconnect', first: true }, { type: 'reconnect', first: false }])
  })

  it('backs off 1 s → 30 s', async () => {
    tab(null)
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      open()[0].fire('error')
      const start = Date.now()
      await vi.advanceTimersByTimeAsync(0)
      while (!open().length) await vi.advanceTimersByTimeAsync(100)
      delays.push(Date.now() - start)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  it('stops when signed out (no reconnect loop) and starts again on sign-in', async () => {
    const { env } = tab(null, vi.fn().mockResolvedValue(false))
    open()[0].fire('error')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(open()).toHaveLength(0)
    env.dispatchEvent(new Event('fs:signed-in'))
    expect(open()).toHaveLength(1)
  })

  it('reconnects when nothing, not even a ping, arrives for 60 s', async () => {
    tab(null)
    const es = open()[0]
    es.fire('open')
    await vi.advanceTimersByTimeAsync(50_000)
    es.fire('ping')
    await vi.advanceTimersByTimeAsync(50_000)
    expect(es.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(es.closed).toBe(true)
  })

  it('does nothing where the browser has no EventSource', () => {
    vi.stubGlobal('EventSource', undefined)
    const live = new LiveEvents({ channel: null })
    expect(() => live.start()).not.toThrow()
    expect(live.isLeader()).toBe(false)
    vi.unstubAllGlobals()
  })
})

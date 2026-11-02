import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '../../api/types'
import { ayman, fakeApi, json } from '../../test/http'
import { mkItem } from '../../test/items'
import { LiveEvents } from './liveEvents'
import { Lists } from './Lists'

class FakeSource {
  static last: FakeSource
  listeners = new Map<string, ((e: MessageEvent) => void)[]>()
  closed = false
  constructor() { FakeSource.last = this }
  addEventListener(type: string, fn: (e: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  close() { this.closed = true }
  fire(type: string, data?: unknown) {
    const e = new MessageEvent(type, { data: JSON.stringify(data ?? {}) })
    for (const fn of this.listeners.get(type) ?? []) fn(e)
  }
}

function live() {
  return new LiveEvents({ source: () => new FakeSource(), channel: null, checkSession: async () => true, random: () => 1 })
}

let priv: Item[] = []
let glob: Item[] = []
let calls: string[] = []

function server() {
  calls = []
  return fakeApi({}).mockImplementation(async (input, init) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.startsWith('/api/items?section=private')) return json(200, { items: priv, next: null })
    if (url.startsWith('/api/items?section=global')) return json(200, { items: glob, next: null })
    return json(404, { detail: 'not_found' })
  })
}

beforeEach(() => {
  priv = [mkItem('p1', { name: 'mine.pdf' })]
  glob = [mkItem('g1', { name: 'all.txt', is_global: true, recipients: [] })]
})
afterEach(() => vi.restoreAllMocks())

const pageOne = () => calls.filter((c) => c.startsWith('GET /api/items?section=private')).length

describe('Lists', () => {
  it('opens on Private with counts on the switch', async () => {
    server()
    render(<Lists me={ayman} live={live()} />)
    expect(await screen.findByText('mine.pdf')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Private/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Private/ })).toHaveTextContent('1')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Global/ })).toHaveTextContent('1'))
    expect(screen.getByText('Only you and the people you chose can see these.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /Global/ }))
    expect(screen.getByText('all.txt')).toBeInTheDocument()
    expect(screen.getByText('Everyone at Southern IoT can see these.')).toBeInTheDocument()
  })

  it('a live item for the other section goes there, not here; this section gets it once', async () => {
    server()
    const l = live()
    render(<Lists me={ayman} live={l} />)
    await screen.findByText('mine.pdf')
    act(() => FakeSource.last.fire('item.created', { item: mkItem('g2', { name: 'new-global.txt', is_global: true }) }))
    expect(screen.queryByText('new-global.txt')).toBeNull()
    const fresh = mkItem('p2', { name: 'fresh.pdf' })
    act(() => FakeSource.last.fire('item.created', { item: fresh }))
    act(() => FakeSource.last.fire('item.created', { item: fresh }))
    expect(screen.getAllByText('fresh.pdf')).toHaveLength(1)
    expect(screen.getByText('rahim sent you "fresh.pdf"')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /Global/ }))
    expect(screen.getByText('new-global.txt')).toBeInTheDocument()
  })

  it('no toast for my own new item', async () => {
    server()
    render(<Lists me={ayman} live={live()} />)
    await screen.findByText('mine.pdf')
    act(() => FakeSource.last.fire('item.created', { item: mkItem('p3', { name: 'own.txt', sender: { id: 1, username: 'ayman' } }) }))
    expect(screen.getByText('own.txt')).toBeInTheDocument()
    expect(screen.queryByText(/sent you/)).toBeNull()
  })

  it('item.deleted removes the card and says who deleted it', async () => {
    server()
    render(<Lists me={ayman} live={live()} />)
    await screen.findByText('mine.pdf')
    act(() => FakeSource.last.fire('item.deleted', { id: 'p1', by: 'rahim' }))
    expect(screen.queryByText('mine.pdf')).toBeNull()
    expect(screen.getByText('rahim deleted "mine.pdf"')).toBeInTheDocument()
  })

  it('an expired item disappears without a toast', async () => {
    server()
    render(<Lists me={ayman} live={live()} />)
    await screen.findByText('mine.pdf')
    act(() => FakeSource.last.fire('item.deleted', { id: 'p1', by: null }))
    expect(screen.queryByText('mine.pdf')).toBeNull()
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('after the live connection drops and comes back, page 1 is fetched again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    server()
    render(<Lists me={ayman} live={live()} />)
    await screen.findByText('mine.pdf')
    act(() => FakeSource.last.fire('open'))
    const before = pageOne()
    act(() => FakeSource.last.fire('error'))
    await act(() => vi.advanceTimersByTimeAsync(1100))
    act(() => FakeSource.last.fire('open'))
    await act(() => vi.advanceTimersByTimeAsync(6000))
    expect(pageOne()).toBeGreaterThan(before)
    vi.useRealTimers()
  })

  it('shows the empty states', async () => {
    priv = []
    glob = []
    server()
    render(<Lists me={ayman} live={live()} />)
    expect(await screen.findByText('Nothing private yet')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /Global/ }))
    expect(screen.getByText('Nothing shared with everyone')).toBeInTheDocument()
  })

  it('shows the error card, and Try again reloads', async () => {
    const f = server()
    f.mockImplementation(async () => json(502, {}))
    render(<Lists me={ayman} live={live()} />)
    expect(await screen.findByText("Couldn't load your files")).toBeInTheDocument()
    server()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('mine.pdf')).toBeInTheDocument()
  })

  it('groups by day', async () => {
    const today = new Date()
    const yesterday = new Date(Date.now() - 86_400_000)
    priv = [mkItem('a', { name: 'today.txt', created_at: today.toISOString() }), mkItem('b', { name: 'old.txt', created_at: yesterday.toISOString() })]
    server()
    render(<Lists me={ayman} live={live()} />)
    await screen.findByText('today.txt')
    expect([...document.querySelectorAll('#pane-private .date')].map((d) => d.textContent)).toEqual(['Today', 'Yesterday'])
  })

  it('the global account sees only Global', async () => {
    server()
    render(<Lists me={{ ...ayman, is_global: true }} live={live()} />)
    expect(await screen.findByText('all.txt')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Private/ })).toBeNull()
  })

  it('fetches again as soon as the live stream first opens (catches items sent in between)', async () => {
    server()
    render(<Lists me={ayman} live={live()} />)
    await screen.findByText('mine.pdf')
    const before = pageOne()
    priv = [mkItem('p9', { name: 'sent-meanwhile.pdf' }), ...priv]
    act(() => FakeSource.last.fire('open'))
    expect(await screen.findByText('sent-meanwhile.pdf')).toBeInTheDocument()
    expect(pageOne()).toBe(before + 1)
  })
})

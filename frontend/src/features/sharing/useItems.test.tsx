import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '../../api/types'
import { mkItem } from '../../test/items'
import { fakeApi, json } from '../../test/http'
import { useItems } from './useItems'

afterEach(() => vi.restoreAllMocks())

function pages(first: Item[], next: string | null, second: Item[] = []) {
  return fakeApi({
    'GET /api/items': () => json(200, { items: first, next }),
  }).mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('before=')) return json(200, { items: second, next: null })
    return json(200, { items: first, next })
  })
}

describe('useItems', () => {
  it('loads page 1 of the section, then more', async () => {
    const f = pages([mkItem('a'), mkItem('b')], 'cur1', [mkItem('c')])
    const { result } = renderHook(() => useItems('private'))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(String(f.mock.calls[0][0])).toBe('/api/items?section=private&limit=50')
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())
    expect(String(f.mock.calls[1][0])).toBe('/api/items?section=private&limit=50&before=cur1')
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(result.current.hasMore).toBe(false)
  })

  it('inserts a live item once, even if a refetch brings it too', async () => {
    let first = [mkItem('a')]
    fakeApi({}).mockImplementation(async () => json(200, { items: first, next: null }))
    const { result } = renderHook(() => useItems('private'))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    act(() => result.current.insert(mkItem('n')))
    act(() => result.current.insert(mkItem('n')))
    first = [mkItem('n'), mkItem('a')]
    await act(() => result.current.refetch())
    expect(result.current.items.map((i) => i.id)).toEqual(['n', 'a'])
  })

  it('a deleted id never comes back from a later page', async () => {
    pages([mkItem('a'), mkItem('b')], 'cur1', [mkItem('b2'), mkItem('a')])
    const { result } = renderHook(() => useItems('private'))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    act(() => result.current.remove('a'))
    await act(() => result.current.loadMore())
    expect(result.current.items.map((i) => i.id)).toEqual(['b', 'b2'])
  })

  it('a refetch keeps the older pages already loaded', async () => {
    const f = pages([mkItem('a'), mkItem('b', { created_at: '2026-11-02T09:00:00Z' })], 'cur1',
      [mkItem('c', { created_at: '2026-11-01T09:00:00Z' })])
    const { result } = renderHook(() => useItems('private'))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(() => result.current.loadMore())
    f.mockImplementation(async () => json(200, { items: [mkItem('z'), mkItem('a')], next: 'cur2' }))
    await act(() => result.current.refetch())
    // b is older than page 1's last item and page 1 says there is more: it is on page 2 now
    expect(result.current.items.map((i) => i.id)).toEqual(['z', 'a', 'b', 'c'])
  })

  it('reports an error when the first load fails, and recovers on refetch', async () => {
    const f = fakeApi({}).mockImplementation(async () => json(502, {}))
    const { result } = renderHook(() => useItems('global'))
    await waitFor(() => expect(result.current.state).toBe('error'))
    f.mockImplementation(async () => json(200, { items: [mkItem('a')], next: null }))
    await act(() => result.current.refetch())
    expect(result.current.state).toBe('ready')
  })

  it('refetchSoon runs at most once per 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const f = fakeApi({}).mockImplementation(async () => json(200, { items: [], next: null }))
    const { result } = renderHook(() => useItems('private'))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    const before = f.mock.calls.length
    act(() => { result.current.refetchSoon(); result.current.refetchSoon(); result.current.refetchSoon() })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(f.mock.calls.length - before).toBe(0) // the first load was just now
    await act(() => vi.advanceTimersByTimeAsync(4100))
    expect(f.mock.calls.length - before).toBe(1)
    act(() => result.current.refetchSoon())
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(f.mock.calls.length - before).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(f.mock.calls.length - before).toBe(2)
    vi.useRealTimers()
  })
})

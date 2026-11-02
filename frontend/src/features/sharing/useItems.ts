import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { Item, ItemPage } from '../../api/types'

export type Section = 'private' | 'global'
const PAGE = 50
const REFETCH_GAP = 5000

const newer = (a: Item, b: Item) => a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id)

/** One section's list: pages of 50, live inserts on top, deleted ids never shown again. */
export function useItems(section: Section, enabled = true) {
  const [items, setItems] = useState<Item[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const tombstones = useRef(new Set<string>())
  const loading = useRef(false)
  const lastFetch = useRef(0)
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const url = (before?: string | null) =>
    `/api/items?section=${section}&limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`
  const alive = (list: Item[]) => list.filter((i) => !tombstones.current.has(i.id))

  const refetch = useCallback(async () => {
    if (!enabled) return // e.g. the global account has no private list
    lastFetch.current = Date.now()
    try {
      const page = await api.get<ItemPage>(url())
      const fresh = alive(page.items)
      setItems((old) => {
        const ids = new Set(fresh.map((i) => i.id))
        const first = fresh[0]
        // live items that arrived while this request was out are newer than its page 1: keep them
        const live = old.filter((i) => !ids.has(i.id) && !tombstones.current.has(i.id) && (!first || newer(i, first)))
        if (!page.next) return [...live, ...fresh]
        // keep the older pages already loaded below page 1
        const last = fresh[fresh.length - 1]
        return [...live, ...fresh, ...old.filter((i) => !ids.has(i.id) && (!last || newer(last, i)))]
      })
      setNext((old) => (page.next && itemsRef.current.length > PAGE ? old : page.next))
      setState('ready')
    } catch {
      setState((s) => (s === 'ready' ? 'ready' : 'error'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, enabled])

  const loadMore = useCallback(async () => {
    if (!next || loading.current) return
    loading.current = true
    try {
      const page = await api.get<ItemPage>(url(next))
      setItems((old) => {
        const ids = new Set(old.map((i) => i.id))
        return [...old, ...alive(page.items).filter((i) => !ids.has(i.id))]
      })
      setNext(page.next)
    } catch {
      // the sentinel asks again on the next scroll
    } finally {
      loading.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, section])

  /** For live events and reconnects: page 1 again, at most once per 5 s. */
  const refetchSoon = useCallback(() => {
    if (soon.current) return
    const wait = Math.max(0, lastFetch.current + REFETCH_GAP - Date.now())
    soon.current = setTimeout(() => {
      soon.current = null
      void refetch()
    }, wait)
  }, [refetch])

  const insert = useCallback((item: Item) => {
    if (tombstones.current.has(item.id)) return
    setItems((old) => (old.some((i) => i.id === item.id) ? old : [item, ...old]))
  }, [])

  const remove = useCallback((id: string) => {
    tombstones.current.add(id)
    setItems((old) => old.filter((i) => i.id !== id))
  }, [])

  useEffect(() => {
    if (enabled) void refetch()
    return () => { if (soon.current) clearTimeout(soon.current) }
  }, [enabled, refetch])

  return { items, hasMore: next !== null, state, loadMore, refetch, refetchSoon, insert, remove }
}

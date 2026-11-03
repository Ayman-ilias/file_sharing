import { Fragment, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { Item, Me } from '../../api/types'
import { Icon } from '../../icons'
import { dayGroup } from '../../lib/format'
import { ItemCard } from './ItemCard'
import type { LiveEvents } from './liveEvents'
import { SectionSwitch } from './SectionSwitch'
import { Toasts, type Toast } from './Toasts'
import { useEvents } from './useEvents'
import { useItems, type Section } from './useItems'

const NOTE: Record<Section, string> = {
  private: 'Only you and the people you chose can see these.',
  global: 'Everyone at Southern IoT can see these.',
}

function Empty({ section }: { section: Section }) {
  return section === 'private' ? (
    <div className="card empty"><div className="ic"><Icon name="i-lock" size={24} /></div><h4>Nothing private yet</h4>
      <p>Files and text sent to you, or by you to someone, show up here.</p></div>
  ) : (
    <div className="card empty"><div className="ic"><Icon name="i-globe" size={24} /></div><h4>Nothing shared with everyone</h4>
      <p>Choose Global in Send to and it appears here for all staff.</p></div>
  )
}

function Skeleton() {
  const row = (a: string, b: string) => (
    <div className="card item"><div className="row"><div className="ficon" />
      <div><div className="skel" style={{ width: a }} /><div className="skel" style={{ width: b, marginTop: 8 }} /></div>
      <div className="skel" style={{ width: 90, height: 34, borderRadius: 10 }} /></div></div>
  )
  return <div className="items" aria-label="Loading">{row('55%', '30%')}{row('40%', '22%')}</div>
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine !== false)
  useEffect(() => {
    const on = () => setOnline(navigator.onLine !== false)
    window.addEventListener('online', on)
    window.addEventListener('offline', on)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on) }
  }, [])
  return online
}

/** Date headers in list order: "Today", "Yesterday", "Oct 30". */
function groups(items: Item[]): [string, Item[]][] {
  const out: [string, Item[]][] = []
  const now = new Date()
  for (const it of items) {
    const label = dayGroup(it.created_at, now)
    if (out.length && out[out.length - 1][0] === label) out[out.length - 1][1].push(it)
    else out.push([label, [it]])
  }
  return out
}

type Props = { me: Me; live?: LiveEvents }

export function Lists({ me, live }: Props) {
  const [section, setSection] = useState<Section>(me.is_global ? 'global' : 'private')
  const lists = { private: useItems('private', !me.is_global), global: useItems('global') }
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  const online = useOnline()
  const sentinel = useRef<HTMLDivElement>(null)

  const toast = useCallback((text: string, icon = 'i-alert') => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, text, icon }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
  }, [])

  const announced = useRef(new Set<string>()) // an event can arrive twice (reconnects): one toast

  useEvents((e) => {
    const l = lists
    if (e.type === 'created') {
      const sec: Section = e.item.is_global ? 'global' : 'private'
      if (sec === 'private' && me.is_global) return
      l[sec].insert(e.item)
      if (e.item.sender.id !== me.id && !announced.current.has(e.item.id)) {
        announced.current.add(e.item.id)
        toast(e.item.is_global
          ? `${e.item.sender.username} shared "${e.item.name}" with everyone`
          : `${e.item.sender.username} sent you "${e.item.name}"`, 'i-share')
      }
    } else if (e.type === 'deleted') {
      const known = [...l.private.items, ...l.global.items].find((i) => i.id === e.id)
      l.private.remove(e.id)
      l.global.remove(e.id)
      if (known && e.by && e.by !== me.username) toast(`${e.by} deleted "${known.name}"`, 'i-trash')
    } else if (e.first) {
      if (!me.is_global) void l.private.refetch() // at once: the gap before the stream opened
      void l.global.refetch()
    } else {
      l.private.refetchSoon()
      l.global.refetchSoon()
    }
  }, live)

  // back online or back in view: refresh
  const refreshBoth = useEffectEvent(() => {
    lists.private.refetchSoon()
    lists.global.refetchSoon()
  })
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible') refreshBoth() }
    window.addEventListener('online', again)
    document.addEventListener('visibilitychange', again)
    return () => { window.removeEventListener('online', again); document.removeEventListener('visibilitychange', again) }
  }, [])

  const current = lists[section]
  const { hasMore, loadMore } = current

  // the next page when the end of the list scrolls into view
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || typeof IntersectionObserver !== 'function') return
    const io = new IntersectionObserver((seen) => { if (seen.some((s) => s.isIntersecting)) void loadMore() }, { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loadMore, section])

  const count = (s: Section) => `${lists[s].items.length}${lists[s].hasMore ? '+' : ''}`

  let body
  if (current.state === 'loading' && !current.items.length) body = <Skeleton />
  else if (current.state === 'error' && !current.items.length) {
    body = (
      <div className="card pad errcard"><div className="ic"><Icon name="i-alert" size={20} /></div>
        <div style={{ flex: 1 }}><b>Couldn't load your files</b>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>The server didn't answer. Uploads in progress are not affected.</div></div>
        <button type="button" className="btn" onClick={() => void current.refetch()}><Icon name="i-retry" size={15} />Try again</button>
      </div>
    )
  } else if (!current.items.length) body = <Empty section={section} />
  else {
    body = groups(current.items).map(([label, items]) => (
      <Fragment key={label}>
        <div className="date">{label}</div>
        <div className="items">
          {items.map((it) => (
            <ItemCard key={it.id} item={it} me={me} onRemoved={(id) => current.remove(id)} onToast={(t) => toast(t)} />
          ))}
        </div>
      </Fragment>
    ))
  }

  return (
    <>
      {!me.is_global && <SectionSwitch value={section} onChange={setSection} counts={{ private: count('private'), global: count('global') }} />}
      <section className="pane" id={`pane-${section}`}>
        <p className="pane-note">{NOTE[section]}</p>
        {!online && (
          <div className="offline" style={{ marginTop: 18 }}><Icon name="i-wifi" size={18} />You're offline. The list will refresh when you're back.</div>
        )}
        {body}
        <div ref={sentinel} />
      </section>
      <Toasts toasts={toasts} />
    </>
  )
}

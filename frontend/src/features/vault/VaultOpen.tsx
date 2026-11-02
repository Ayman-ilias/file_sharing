import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../../icons'
import { formatBytes } from '../../lib/format'
import { Toasts, type Toast } from '../sharing/Toasts'
import type { FileMeta, VaultMeta } from './api'
import { BrokenCard, FileRow, LinkCard, NoteCard, PasswordCard } from './cards'
import { ItemForm, type FormKind } from './ItemForm'
import { PhotoGrid } from './PhotoGrid'
import { Deleted, KeyChanged, StaleVersion, type DecryptedItem, type VaultStore } from './store'
import { useVault } from './useVault'

type Kind = 'all' | 'note' | 'link' | 'password' | 'photo' | 'file'
const KINDS: [Kind, string][] = [['all', 'All'], ['note', 'Notes'], ['link', 'Links'], ['password', 'Passwords'], ['photo', 'Photos'], ['file', 'Files']]
const FULL_BELOW = 1024 * 1024

type Props = {
  store?: VaultStore
  onDownload: (item: DecryptedItem, meta: FileMeta) => void
  onAddFiles: (kind: 'photo' | 'file') => void
  queue?: ReactNode
  takeStartMessage?: () => string | null // e.g. "1 upload to My storage didn't finish…" after a reload
}

export function VaultOpen({ store: given, onDownload, onAddFiles, queue, takeStartMessage }: Props) {
  const vault = useVault(given)
  const { store, items, usedBytes, quotaBytes } = vault
  const [kind, setKind] = useState<Kind>('all')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<{ kind: FormKind; item?: DecryptedItem } | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)

  const toast = useCallback((text: string, icon = 'i-alert') => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, text, icon }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])

  const [startMessage] = useState(() => takeStartMessage?.() ?? null)
  useEffect(() => {
    if (startMessage) toast(startMessage, 'i-up')
  }, [startMessage, toast])

  const free = Math.max(0, quotaBytes - usedBytes)
  const full = quotaBytes > 0 && free < FULL_BELOW
  const ratio = quotaBytes ? Math.min(1, usedBytes / quotaBytes) : 0

  async function save(meta: VaultMeta) {
    try {
      if (form?.item) await store.update(form.item.id, meta)
      else await store.add(meta)
      setForm(null)
    } catch (e) {
      if (e instanceof StaleVersion) toast('Changed in another tab — reloaded.') // the form keeps the text
      else if (e instanceof Deleted) { toast('Deleted in another tab.'); setForm(null) }
      else if (e instanceof KeyChanged) setForm(null)
      else if (e instanceof TypeError) toast("You're offline — saved nothing yet.")
      else toast("Couldn't save. Try again.")
    }
  }

  async function remove(id: string) {
    try {
      await store.remove(id)
    } catch {
      toast("Couldn't delete it. Try again.")
    }
  }

  function startAdd(k: 'note' | 'link' | 'password' | 'photo' | 'file') {
    setAdding(false)
    if (k === 'photo' || k === 'file') onAddFiles(k)
    else setForm({ kind: k })
  }

  const shown = kind === 'all' ? items : items.filter((i) => i.meta?.kind === kind)
  const of = (k: VaultMeta['kind']) => shown.filter((i) => i.meta?.kind === k)
  const card = (i: DecryptedItem) => {
    const common = { item: i, onDelete: () => void remove(i.id), onToast: toast }
    const edit = (k: FormKind) => () => setForm({ kind: k, item: i })
    if (!i.meta) return <BrokenCard key={i.id} onDelete={common.onDelete} />
    switch (i.meta.kind) {
      case 'password': return <PasswordCard key={i.id} {...common} meta={i.meta} onEdit={edit('password')} />
      case 'note': return <NoteCard key={i.id} {...common} meta={i.meta} onEdit={edit('note')} />
      case 'link': return <LinkCard key={i.id} {...common} meta={i.meta} onEdit={edit('link')} />
      case 'file': return <FileRow key={i.id} {...common} meta={i.meta} onEdit={edit('rename')} onDownload={() => onDownload(i, i.meta as FileMeta)} />
      default: return null
    }
  }

  const passwords = of('password')
  const notesLinks = shown.filter((i) => i.meta?.kind === 'note' || i.meta?.kind === 'link')
  const files = of('file')
  const photoItems = of('photo')
  const broken = kind === 'all' ? shown.filter((i) => i.broken) : []

  return (
    <section id="vault-open">
      <div className="card vault-head">
        <div className="vh-top">
          <div><b>My storage</b><span className="enc"><Icon name="i-shield" size={14} />Encrypted, only you can see this</span>
            <span className="autolock">Locks itself after 20 minutes without activity</span></div>
          <button type="button" className="btn" onClick={() => store.lock('manual')}><Icon name="i-lock" size={15} />Lock</button>
        </div>
        <div className={`q-bar${full ? ' full' : ''}`}><i style={{ '--p': Number(ratio.toFixed(3)) } as CSSProperties} /></div>
        <div className="q-foot">
          <span><b>{formatBytes(usedBytes)}</b> of {formatBytes(quotaBytes)} used{full && <> · <span className="full-tag">Full</span></>}</span>
          <span>{full ? 'Delete something to add more' : `${formatBytes(free)} free`}</span>
        </div>
      </div>

      <div className="vault-bar">
        <div className="kinds" role="tablist" aria-label="Show">
          {KINDS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={`kind${kind === k ? ' on' : ''}`}
              onClick={() => setKind(k)}>{label}</button>
          ))}
        </div>
        <div className="add-wrap">
          <button type="button" className="primary small" disabled={full} aria-haspopup="menu" aria-expanded={adding}
            title={full ? 'My storage is full. Delete something to add more.' : undefined}
            onClick={() => setAdding(!adding)}><Icon name="i-plus" size={16} />Add</button>
          {adding && (
            <div className="add-menu" role="menu" onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false) }}>
              <button type="button" role="menuitem" onClick={() => startAdd('note')}><Icon name="i-text" size={16} />Note</button>
              <button type="button" role="menuitem" onClick={() => startAdd('link')}><Icon name="i-link" size={16} />Link</button>
              <button type="button" role="menuitem" onClick={() => startAdd('password')}><Icon name="i-key" size={16} />Password</button>
              <button type="button" role="menuitem" onClick={() => startAdd('photo')}><Icon name="i-image" size={16} />Photo</button>
              <button type="button" role="menuitem" onClick={() => startAdd('file')}><Icon name="i-file" size={16} />File</button>
            </div>
          )}
        </div>
      </div>

      {queue}

      {items.length === 0 && (
        <div className="card empty">
          <div className="ic"><Icon name="i-shield" size={24} /></div>
          <h4>Nothing saved yet</h4>
          <p>Keep passwords, notes, links, photos and files here. Only you can open them.</p>
          <button type="button" className="primary small" style={{ marginTop: 14, background: 'var(--navy)', color: '#fff' }}
            onClick={() => setAdding(true)}><Icon name="i-plus" size={16} />Add the first one</button>
        </div>
      )}

      {passwords.length > 0 && <><div className="vgroup">Passwords</div><div className="vgrid">{passwords.map(card)}</div></>}
      {notesLinks.length > 0 && <><div className="vgroup">Notes and links</div><div className="vgrid">{notesLinks.map(card)}</div></>}
      {photoItems.length > 0 && <><div className="vgroup">Photos</div><PhotoGrid items={photoItems} store={store} onToast={toast} /></>}
      {files.length > 0 && <><div className="vgroup">Files</div><div className="items">{files.map(card)}</div></>}
      {broken.length > 0 && <><div className="vgroup">Can't be opened</div><div className="vgrid">{broken.map(card)}</div></>}

      {form && <ItemForm kind={form.kind} initial={form.item?.meta ?? undefined} onSave={save} onClose={() => setForm(null)} />}
      <Toasts toasts={toasts} />
    </section>
  )
}

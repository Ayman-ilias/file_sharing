import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons'
import { copyText } from '../../lib/clipboard'
import { editedAgo, formatBytes, relativeTime } from '../../lib/format'
import type { FileMeta, LinkMeta, NoteMeta, PasswordMeta } from './api'
import { normalizeUrl } from './ItemForm'
import type { DecryptedItem } from './store'

export type MenuAction = { label: string; icon: string; run: () => void }

/** Copy a secret; clear the clipboard after 30 s if it still holds it (best effort). */
export async function copySecret(text: string): Promise<boolean> {
  const ok = await copyText(text)
  if (ok && globalThis.isSecureContext && navigator.clipboard?.readText) {
    setTimeout(async () => {
      try {
        if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText('')
      } catch {
        // reading the clipboard was refused: leave it
      }
    }, 30_000)
  }
  return ok
}

/** ⋯ menu with Edit / Copy … and Delete, which asks inline ("Delete?" for 4 s). */
export function ItemMenu({ actions, onDelete }: { actions: MenuAction[]; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        more.current?.focus()
      }
    }
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  if (asking) {
    return (
      <div className="vtools">
        <button type="button" className="confirm-del" autoFocus onClick={() => {
          if (timer.current) clearTimeout(timer.current)
          setAsking(false)
          onDelete()
        }}>Delete?</button>
      </div>
    )
  }
  return (
    <div className="vtools" ref={box}>
      <button ref={more} type="button" className="mini" aria-label="More" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}><Icon name="i-more" size={18} /></button>
      {open && (
        <div className="menu" role="menu">
          {actions.map((a) => (
            <button key={a.label} type="button" role="menuitem" onClick={() => { setOpen(false); a.run() }}>
              <Icon name={a.icon} size={16} />{a.label}
            </button>
          ))}
          <div className="sep" />
          <button type="button" role="menuitem" className="danger" onClick={() => {
            setOpen(false)
            setAsking(true)
            timer.current = setTimeout(() => setAsking(false), 4000)
          }}><Icon name="i-trash" size={16} />Delete</button>
        </div>
      )}
    </div>
  )
}

type CardProps<M> = { item: DecryptedItem; meta: M; onEdit: () => void; onDelete: () => void; onToast: (t: string) => void }

const copied = (onToast: (t: string) => void) => (ok: boolean) => onToast(ok ? 'Copied.' : 'Copy failed — select the text')

export function PasswordCard({ meta, onEdit, onDelete, onToast }: CardProps<PasswordMeta>) {
  const [shown, setShown] = useState(false)
  const sub = [meta.username, meta.url].filter(Boolean).join(' · ')
  return (
    <div className="card vcard pw">
      <div className="vc-top">
        <span className="vc-ic key"><Icon name="i-key" size={18} /></span>
        <div><b>{meta.title}</b>{sub && <small>{sub}</small>}</div>
        <ItemMenu onDelete={onDelete} actions={[
          { label: 'Edit', icon: 'i-edit', run: onEdit },
          { label: 'Copy password', icon: 'i-copy', run: () => void copySecret(meta.password).then(copied(onToast)) },
          ...(meta.username ? [{ label: 'Copy username', icon: 'i-copy', run: () => void copyText(meta.username).then(copied(onToast)) }] : []),
        ]} />
      </div>
      <div className="secret">
        <span className="dots">{shown ? meta.password : '••••••••••••'}</span>
        <button type="button" className="mini" aria-label="Show password" aria-pressed={shown} onClick={() => setShown(!shown)}>
          <Icon name="i-eye" size={16} />
        </button>
        <button type="button" className="mini" aria-label="Copy password" onClick={() => void copySecret(meta.password).then(copied(onToast))}>
          <Icon name="i-copy" size={16} />
        </button>
      </div>
    </div>
  )
}

export function NoteCard({ item, meta, onEdit, onDelete, onToast }: CardProps<NoteMeta>) {
  return (
    <div className="card vcard">
      <div className="vc-top">
        <span className="vc-ic note"><Icon name="i-text" size={18} /></span>
        <div><b>{meta.title}</b><small>Edited {editedAgo(item.updated_at)}</small></div>
        <ItemMenu onDelete={onDelete} actions={[
          { label: 'Edit', icon: 'i-edit', run: onEdit },
          { label: 'Copy note', icon: 'i-copy', run: () => void copyText(meta.text).then(copied(onToast)) },
        ]} />
      </div>
      <p className="snippet">{meta.text.slice(0, 200)}</p>
    </div>
  )
}

export function LinkCard({ meta, onEdit, onDelete, onToast }: CardProps<LinkMeta>) {
  const href = normalizeUrl(meta.url) // checked again here: only http/https ever become links
  const host = href ? new URL(href).host : meta.url
  return (
    <div className="card vcard">
      <div className="vc-top">
        <span className="vc-ic link"><Icon name="i-link" size={18} /></span>
        <div>
          {href ? <a className="ttl-link" href={href} target="_blank" rel="noopener noreferrer"><b>{meta.title} ↗</b></a> : <b>{meta.title}</b>}
          <small>{host}</small>
        </div>
        <ItemMenu onDelete={onDelete} actions={[
          { label: 'Edit', icon: 'i-edit', run: onEdit },
          { label: 'Copy address', icon: 'i-copy', run: () => void copyText(meta.url).then(copied(onToast)) },
        ]} />
      </div>
      {meta.note && <p className="snippet">{meta.note}</p>}
    </div>
  )
}

export function FileRow({ item, meta, onEdit, onDelete, onDownload }: CardProps<FileMeta> & { onDownload: () => void }) {
  return (
    <div className="card item">
      <div className="row">
        <div className={`ficon${meta.mime === 'application/pdf' ? ' pdf' : ''}`}><Icon name="i-file" size={20} /></div>
        <div><div className="name"><span>{meta.name}</span></div>
          <div className="meta">{formatBytes(meta.size)} · added {relativeTime(item.created_at)}</div></div>
        <div className="btns">
          <button type="button" className="btn" onClick={onDownload}><Icon name="i-down" size={15} />Download</button>
          <ItemMenu onDelete={onDelete} actions={[{ label: 'Rename', icon: 'i-edit', run: onEdit }]} />
        </div>
      </div>
    </div>
  )
}

export function BrokenCard({ onDelete }: { onDelete: () => void }) {
  return (
    <div className="card vcard">
      <div className="vc-top">
        <span className="vc-ic note"><Icon name="i-alert" size={18} /></span>
        <div><b>This item can't be decrypted</b><small>It may be damaged. You can delete it.</small></div>
        <ItemMenu onDelete={onDelete} actions={[]} />
      </div>
    </div>
  )
}

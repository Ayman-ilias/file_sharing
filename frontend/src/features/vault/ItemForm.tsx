import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from '../../icons'
import type { FileMeta, LinkMeta, NoteMeta, PasswordMeta, VaultMeta } from './api'

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+'

/** 20 random characters (rejection sampling, so every character is equally likely). */
export function generatePassword(length = 20): string {
  const out: string[] = []
  const limit = 256 - (256 % CHARSET.length)
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out.push(CHARSET[b % CHARSET.length])
    }
  }
  return out.join('')
}

/** A typed address → an https/http URL, or null. A bare host (or IP:port) gets https://. */
export function normalizeUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text || /\s/.test(text) || text.startsWith('//')) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  if (!hasScheme && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return null // javascript:, mailto: … (not host:8080)
  let u: URL
  try {
    u = new URL(hasScheme ? text : `https://${text}`)
  } catch {
    return null
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname.includes('.')) return null
  const bare = u.pathname === '/' && !u.search && !u.hash && !text.endsWith('/')
  return bare ? u.href.slice(0, -1) : u.href
}

export type FormKind = 'password' | 'note' | 'link' | 'rename'

type Props = {
  kind: FormKind
  initial?: VaultMeta
  onSave: (meta: VaultMeta) => Promise<void>
  onClose: () => void
}

const TITLES: Record<FormKind, [string, string]> = {
  password: ['New password', 'Edit password'],
  note: ['New note', 'Edit note'],
  link: ['New link', 'Edit link'],
  rename: ['Rename', 'Rename'],
}

const optional = <span style={{ fontWeight: 400, color: 'var(--faint)' }}>(optional)</span>

export function ItemForm({ kind, initial, onSave, onClose }: Props) {
  const pw = initial?.kind === 'password' ? initial : null
  const nt = initial?.kind === 'note' ? initial : null
  const ln = initial?.kind === 'link' ? initial : null
  const fl = initial && (initial.kind === 'file' || initial.kind === 'photo') ? initial : null
  const [title, setTitle] = useState(pw?.title ?? nt?.title ?? ln?.title ?? '')
  const [username, setUsername] = useState(pw?.username ?? '')
  const [url, setUrl] = useState(pw?.url ?? ln?.url ?? '')
  const [password, setPassword] = useState(pw?.password ?? '')
  const [showPw, setShowPw] = useState(false)
  const [note, setNote] = useState(pw?.note ?? ln?.note ?? '')
  const [text, setText] = useState(nt?.text ?? '')
  const [name, setName] = useState(fl?.name ?? '')
  const [error, setError] = useState<{ field: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key !== 'Tab' || !box.current) return
      // keep focus inside the dialog
      const f = box.current.querySelectorAll<HTMLElement>('input, textarea, button')
      if (!f.length) return
      const [first, last] = [f[0], f[f.length - 1]]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function build(): VaultMeta | null {
    if (kind === 'note') {
      if (!text.trim()) return setError({ field: 'text', text: 'Write something before saving.' }), null
      return { kind: 'note', title: title.trim() || text.trim().split('\n')[0].slice(0, 80), text } satisfies NoteMeta
    }
    if (kind === 'link') {
      const href = normalizeUrl(url)
      if (!href) return setError({ field: 'url', text: "That isn't a web address. Example: grafana.southerniot.net" }), null
      return { kind: 'link', title: title.trim() || new URL(href).host, url: href, note: note.trim() } satisfies LinkMeta
    }
    if (kind === 'password') {
      if (!password) return setError({ field: 'password', text: 'Enter the password to keep.' }), null
      return {
        kind: 'password', title: title.trim() || url.trim() || username.trim() || 'Password',
        username: username.trim(), url: url.trim(), password, note: note.trim(),
      } satisfies PasswordMeta
    }
    if (!name.trim() || !fl) return setError({ field: 'name', text: 'Enter a name.' }), null
    return { ...fl, name: name.trim() } satisfies FileMeta
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const meta = build()
    if (!meta || busy) return
    setBusy(true)
    try {
      await onSave(meta) // the caller closes on success, keeps it open on a stale save
    } finally {
      setBusy(false)
    }
  }

  const err = (field: string) => error?.field === field && (
    <div className="err-msg" role="alert"><Icon name="i-alert" size={14} />{error.text}</div>
  )
  const bad = (field: string) => (error?.field === field ? { borderColor: '#f1a7a7' } : undefined)
  const heading = TITLES[kind][initial ? 1 : 0]

  return (
    <div className="overlay" style={{ justifyContent: 'center', alignItems: 'center', padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form ref={box} className="card pad" role="dialog" aria-modal="true" aria-label={heading} onSubmit={submit} noValidate
        style={{ width: 'min(480px, 100%)', textAlign: 'left' }}>
        <div className="modal-h"><h3>{heading}</h3>
          <button type="button" className="mini" aria-label="Close" onClick={onClose}><Icon name="i-x" size={16} /></button></div>

        {kind === 'password' && (
          <>
            <div className="field"><label htmlFor="vf-title">Title</label>
              <input id="vf-title" className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div className="row2">
              <div className="field"><label htmlFor="vf-user">Username</label>
                <input id="vf-user" className="input" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></div>
              <div className="field"><label htmlFor="vf-url">Website or IP</label>
                <input id="vf-url" className="input" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
            </div>
            <div className="field"><label htmlFor="vf-pw">Password</label>
              <div className="pw-in">
                <input id="vf-pw" className="input" type={showPw ? 'text' : 'password'} autoComplete="new-password"
                  value={password} onChange={(e) => setPassword(e.target.value)} style={bad('password')} />
                <button type="button" className="mini" title="Show" aria-label="Show password" aria-pressed={showPw}
                  onClick={() => setShowPw(!showPw)}><Icon name="i-eye" size={16} /></button>
                <button type="button" className="btn" style={{ height: 40 }} onClick={() => { setPassword(generatePassword()); setShowPw(true) }}>Generate</button>
              </div>
              {err('password')}
            </div>
            <div className="field"><label htmlFor="vf-note">Note {optional}</label>
              <input id="vf-note" className="input" placeholder="Anything to remember" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </>
        )}

        {kind === 'note' && (
          <>
            <div className="field"><label htmlFor="vf-title">Title {optional}</label>
              <input id="vf-title" className="input" placeholder="First line is used if empty" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div className="field"><label htmlFor="vf-text">Note</label>
              <textarea id="vf-text" autoFocus style={{ minHeight: 110, ...bad('text') }} value={text} onChange={(e) => setText(e.target.value)} />
              {err('text')}</div>
          </>
        )}

        {kind === 'link' && (
          <>
            <div className="field"><label htmlFor="vf-title">Title</label>
              <input id="vf-title" className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div className="field"><label htmlFor="vf-url">Address</label>
              <input id="vf-url" className="input" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} style={bad('url')} />
              {err('url')}</div>
            <div className="field"><label htmlFor="vf-note">Note {optional}</label>
              <input id="vf-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </>
        )}

        {kind === 'rename' && (
          <div className="field"><label htmlFor="vf-name">Name</label>
            <input id="vf-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} style={bad('name')} />
            {err('name')}</div>
        )}

        <div className="actions-r">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary small" disabled={busy} style={{ background: 'var(--navy)', color: '#fff' }}>Save</button>
        </div>
      </form>
    </div>
  )
}

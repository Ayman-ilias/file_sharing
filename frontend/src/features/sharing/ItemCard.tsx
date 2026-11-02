import { useState, type CSSProperties, type ReactNode } from 'react'
import { api, ApiError } from '../../api/client'
import type { EntryOut, Item, Me } from '../../api/types'
import { Icon } from '../../icons'
import { copyText } from '../../lib/clipboard'
import { expiresSoon, formatBytes, relativeTime } from '../../lib/format'
import { DeleteButton } from './DeleteButton'
import { FolderEntries } from './FolderEntries'
import { Lightbox } from './Lightbox'
import { PhotoPeek } from './PhotoPeek'
import { TextBody } from './TextBody'
import { downloadUrl, entriesUrl, inlineUrl, itemUrl, startDownload, zipUrl } from './urls'

type Props = { item: Item; me: Me; onRemoved: (id: string) => void; onToast: (text: string) => void }

const PHOTO = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']) // the server shows these inline
const FOLD_LINES = 4
const SHEET = /(spreadsheet|excel|csv)/i

const isPdf = (i: Item) => i.mime === 'application/pdf'
const isPhoto = (i: Item) => PHOTO.has(i.mime)
const isVideo = (i: Item) => i.mime === 'video/mp4'

function Meta({ item, me, parts }: { item: Item; me: Me; parts: (string | null)[] }) {
  const mine = item.sender.id === me.id
  const names = item.recipients.map((r) => r.username)
  const soon = expiresSoon(item.expires_at)
  const shown = names.slice(0, 2)
  const rest = names.slice(2)
  return (
    <div className="meta">
      From <b>{mine ? 'you' : item.sender.username}</b>
      {mine && !item.is_global && shown.length > 0 && ` to ${shown.join(', ')}`}
      {mine && !item.is_global && rest.length > 0 && <> <span className="more-rc" title={rest.join(', ')}>+{rest.length}</span></>}
      {parts.filter(Boolean).map((p) => ` · ${p}`).join('')}
      {soon && <> · <span className="soon">{soon}</span></>}
    </div>
  )
}

function Ficon({ item }: { item: Item }) {
  if (item.kind === 'text') return <div className="ficon txt"><Icon name="i-text" size={20} /></div>
  if (item.kind === 'folder') return <div className="ficon dir"><Icon name="i-folder" size={20} /></div>
  if (isPdf(item)) return <div className="ficon pdf"><Icon name="i-file" size={20} /></div>
  if (isVideo(item)) return <div className="ficon" style={{ background: '#f3effd', color: '#6d28d9' }}><Icon name="i-video" size={20} /></div>
  const style: CSSProperties | undefined = SHEET.test(item.mime) || /\.(xlsx?|csv)$/i.test(item.name)
    ? { background: '#e8f6ef', color: '#15803d' } : undefined
  return <div className="ficon" style={style}><Icon name="i-file" size={20} /></div>
}

export function ItemCard({ item, me, onRemoved, onToast }: Props) {
  const [open, setOpen] = useState(item.kind === 'text')
  const [full, setFull] = useState<string | null>(item.text_truncated ? null : item.text_body)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [entries, setEntries] = useState<EntryOut[] | null>(null)
  const [lightbox, setLightbox] = useState(false)

  /** A 404 means someone deleted it meanwhile: drop the card without a fuss. */
  function failed(e: unknown, what: string) {
    if (e instanceof ApiError && e.status === 404) onRemoved(item.id)
    else onToast(`Couldn't ${what} "${item.name}". Try again.`)
  }

  async function fullText(): Promise<string | null> {
    if (full !== null) return full
    try {
      const it = await api.get<Item>(itemUrl(item.id))
      setFull(it.text_body ?? '')
      return it.text_body ?? ''
    } catch (e) {
      failed(e, 'load')
      return null
    }
  }

  async function copy() {
    const text = await fullText()
    if (text === null) return
    if (await copyText(text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      onToast('Copy failed — select the text')
    }
  }

  async function download(url: string) {
    try {
      await api.get(itemUrl(item.id)) // still there? (else the browser would open an error page)
      startDownload(url)
    } catch (e) {
      failed(e, 'download')
    }
  }

  async function remove() {
    try {
      await api.send('DELETE', itemUrl(item.id))
      onRemoved(item.id)
    } catch (e) {
      failed(e, 'delete')
    }
  }

  async function toggleFolder() {
    if (!open && entries === null) {
      try {
        setEntries(await api.get<EntryOut[]>(entriesUrl(item.id)))
      } catch (e) {
        return failed(e, 'open')
      }
    }
    setOpen(!open)
  }

  const size = formatBytes(item.size)
  const lines = item.line_count ?? 0
  const folds = item.kind === 'text' && (lines > FOLD_LINES || item.text_truncated)
  const del = <DeleteButton onConfirm={() => void remove()} />

  let name: ReactNode = <span>{item.name}</span>
  let parts: (string | null)[] = [size]
  let buttons: ReactNode = (
    <button type="button" className="btn" onClick={() => void download(downloadUrl(item.id))}>
      <Icon name="i-down" size={15} />Download
    </button>
  )
  const toggle = (label: string, onClick: () => void) => (
    <button type="button" className={`toggle${open ? ' open' : ''}`} aria-label={label} aria-expanded={open} onClick={onClick}>
      <Icon name="i-chev" size={14} />
    </button>
  )

  if (item.kind === 'text') {
    name = <>{toggle(open ? 'Collapse' : 'Expand', () => setOpen(!open))}<span>{item.name}</span></>
    parts = [relativeTime(item.created_at), lines > FOLD_LINES ? `${lines} lines` : null]
    buttons = (
      <button type="button" className={`btn${copied ? ' copied' : ''}`} onClick={() => void copy()}>
        <Icon name="i-copy" size={15} /><span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    )
  } else if (item.kind === 'folder') {
    name = <>{toggle(open ? 'Hide files' : 'Show files', () => void toggleFolder())}<span>{item.name}</span></>
    parts = [`${(item.file_count ?? 0).toLocaleString('en-US')} files`, size]
    buttons = (
      <button type="button" className="btn" onClick={() => void download(zipUrl(item.id))}>
        <Icon name="i-down" size={15} />Download all
      </button>
    )
  } else if (isPdf(item)) {
    name = (
      <>
        <a href={inlineUrl(item.id)} target="_blank" rel="noopener noreferrer"><span>{item.name}</span></a>
        <span className="opens">Open in new tab<Icon name="i-ext" size={12} /></span>
      </>
    )
  } else if (isVideo(item)) {
    name = <>{toggle(open ? 'Hide video' : 'Play', () => setOpen(!open))}<span>{item.name}</span></>
  }

  const cls = `card item${isPdf(item) ? ' openable' : ''}${isPhoto(item) ? ' photo' : ''}`
  return (
    <div className={cls}>
      {isPhoto(item) && <PhotoPeek src={inlineUrl(item.id)} name={item.name} size={size} />}
      <div className="row" onClick={isPhoto(item) ? (e) => { if (!(e.target as Element).closest('button, a')) setLightbox(true) } : undefined}>
        {isPhoto(item) ? <img className="thumb" src={inlineUrl(item.id)} alt="" loading="lazy" /> : <Ficon item={item} />}
        <div><div className="name">{name}</div><Meta item={item} me={me} parts={parts} /></div>
        <div className="btns">{buttons}{del}</div>
      </div>

      {item.kind === 'text' && open && (
        <>
          <TextBody text={(expanded ? full : null) ?? item.text_body ?? ''} clamp={folds && !expanded} />
          {folds && !expanded && (
            <button type="button" className="showall" onClick={async () => {
              if ((await fullText()) !== null) setExpanded(true)
            }}>Show all {lines.toLocaleString('en-US')} lines</button>
          )}
        </>
      )}
      {item.kind === 'folder' && open && entries && <FolderEntries itemId={item.id} entries={entries} />}
      {isVideo(item) && open && (
        <div className="preview" style={{ padding: 0, overflow: 'hidden', background: '#000' }}>
          <video controls preload="metadata" src={inlineUrl(item.id)} style={{ width: '100%', display: 'block' }} />
        </div>
      )}
      {lightbox && (
        <Lightbox src={inlineUrl(item.id)} name={item.name} label={`${item.name} · ${size}`}
          onClose={() => setLightbox(false)} onDownload={() => void download(downloadUrl(item.id))}
          onDelete={() => void remove()} />
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { Me, User } from '../../api/types'
import { Icon } from '../../icons'
import { supportsFolderPick } from '../../lib/device'
import { formatBytes } from '../../lib/format'
import type { Target, Uploader } from '../uploads/Uploader'
import { useUploads } from '../uploads/useUploads'
import { DropZone } from './DropZone'
import { RecipientPicker } from './RecipientPicker'
import { isTooLong, TextForm } from './TextForm'
import { UploadQueue } from './UploadQueue'

type Tab = 'text' | 'files' | 'folder'

const MAX_FOLDER_FILES = 5000 // the server's MAX_BATCH_FILES

type Props = { me: Me; uploader?: Uploader; folderPick?: boolean }

const TABS: [Tab, string, string][] = [['text', 'i-text', 'Text'], ['files', 'i-file', 'Files'], ['folder', 'i-folder', 'Folder']]

function sendError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 413) return 'Too long — send it as a file'
    if (e.detail === 'no_recipients' || e.detail === 'unknown_recipient') return 'Choose who to send to.'
    return 'Not sent. Try again.'
  }
  return "Can't reach the server. Check your connection."
}

export function SendCard({ me, uploader, folderPick = supportsFolderPick() }: Props) {
  const { jobs, uploader: engine } = useUploads(uploader)
  const [tab, setTab] = useState<Tab>('text')
  const [users, setUsers] = useState<User[]>([])
  const [target, setTarget] = useState<Target>({ recipientIds: [], isGlobal: me.is_global })
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [folder, setFolder] = useState<File[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (me.is_global) return
    api.get<User[]>('/api/users').then(setUsers, () => setUsers([]))
  }, [me.is_global])

  const sendTo: Target = me.is_global ? { recipientIds: [], isGlobal: true } : target
  const hasTarget = sendTo.isGlobal || sendTo.recipientIds.length > 0
  const hasContent = tab === 'text'
    ? body.trim() !== '' && !isTooLong(body)
    : tab === 'files' ? files.length > 0 : !!folder?.length

  async function send() {
    if (!hasTarget || !hasContent || busy) return
    setError(null)
    setNotice(null)
    if (tab === 'text') {
      setBusy(true)
      try {
        await api.send('POST', '/api/items/text', {
          ...(title.trim() ? { title: title.trim() } : {}),
          body, recipient_ids: sendTo.isGlobal ? [] : sendTo.recipientIds, is_global: sendTo.isGlobal,
        })
        setTitle('')
        setBody('')
      } catch (e) {
        setError(sendError(e))
      } finally {
        setBusy(false)
      }
    } else if (tab === 'files') {
      const picked = files
      setFiles([])
      const { duplicates } = await engine.addFiles(picked, sendTo)
      if (duplicates.length) setNotice(`Already sending: ${duplicates.join(', ')}`)
    } else if (folder) {
      engine.addFolder(folder, sendTo)
      setFolder(null)
    }
  }

  function pickFolder(files: File[]) {
    setNotice(null)
    if (!files.length) return setError('This folder is empty — there is nothing to send.')
    if (files.length > MAX_FOLDER_FILES) {
      setFolder(null)
      return setError(`This folder has ${files.length.toLocaleString('en-US')} files. The limit is 5,000 — zip it, or send it in parts.`)
    }
    setError(null)
    setFolder(files)
  }

  const folderName = folder?.[0]?.webkitRelativePath.split('/')[0] ?? ''
  const queue = (
    <UploadQueue jobs={jobs.filter((j) => !j.vault)} onRetry={(id) => engine.retry(id)} onCancel={(id) => void engine.cancel(id)}
      onDismiss={(id) => engine.dismiss(id)} />
  )

  return (
    <section className="card upload">
      <div className="tabs">
        {TABS.map(([t, icon, label]) => (
          <button key={t} type="button" className={`tab${tab === t ? ' on' : ''}`} aria-pressed={tab === t}
            onClick={() => { setTab(t); setError(null); setNotice(null) }}>
            <Icon name={icon} size={17} />{label}
          </button>
        ))}
      </div>

      <RecipientPicker me={me} users={users} value={target} onChange={setTarget} />

      {tab === 'text' && (
        <>
          <TextForm title={title} body={body} onTitle={setTitle} onBody={setBody} />
          {queue}
        </>
      )}

      {tab === 'files' && (
        <div id="p-files">
          <DropZone folder={false} onFiles={(picked) => setFiles((old) => [...old, ...picked])} />
          {files.length > 0 && (
            <div className="queue">
              {files.map((f, i) => (
                <div className="q" key={`${f.name}-${i}`}>
                  <div className="q-top"><b>{f.name}</b><span className="pct">Ready</span>
                    <button type="button" className="x" aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles((old) => old.filter((_, j) => j !== i))}><Icon name="i-x" size={14} /></button>
                  </div>
                  <div className="q-sub"><span>{formatBytes(f.size)}</span><span>Ready to send</span></div>
                </div>
              ))}
            </div>
          )}
          {queue}
        </div>
      )}

      {tab === 'folder' && (
        <div id="p-folder">
          {folderPick ? (
            <DropZone folder onFiles={pickFolder} />
          ) : (
            <div className="offline"><Icon name="i-alert" size={18} />This phone can't choose folders. Zip the folder, or use Files to pick several files.</div>
          )}
          {folder && (
            <div className="queue">
              <div className="q">
                <div className="q-top"><b>{folderName}</b><span className="pct">Ready</span>
                  <button type="button" className="x" aria-label={`Remove ${folderName}`} onClick={() => setFolder(null)}>
                    <Icon name="i-x" size={14} />
                  </button>
                </div>
                <div className="q-sub">
                  <span>{folder.length.toLocaleString('en-US')} files · {formatBytes(folder.reduce((s, f) => s + f.size, 0))}</span>
                  <span>Ready to send</span>
                </div>
              </div>
            </div>
          )}
          {queue}
        </div>
      )}

      {error && <div className="err-msg" role="alert"><Icon name="i-alert" size={14} />{error}</div>}
      {notice && <div className="hintline" role="status">{notice}</div>}

      <div className="actions">
        <small>Choose Global to share with everyone.</small>
        <button type="button" className="primary" disabled={!hasTarget || !hasContent || busy} onClick={() => void send()}>
          Send<Icon name="i-send" size={16} />
        </button>
      </div>
    </section>
  )
}

import { useState, type CSSProperties } from 'react'
import { Icon } from '../../icons'
import { formatBytes, formatEta, formatProgress, formatSpeed } from '../../lib/format'
import type { Job, Reason } from '../uploads/Uploader'

type Props = {
  jobs: Job[]
  onRetry: (id: string) => void
  onCancel: (id: string) => void
  onDismiss: (id: string) => void
}

const LABEL: Partial<Record<Reason, string>> = {
  too_large: 'Too large',
  disk_full: 'Server full',
  upload_quota: 'Too many uploads',
  interrupted: 'Interrupted',
}

function failure(job: Job): [string, string] {
  switch (job.reason) {
    case 'network': return [`${formatProgress(job.sent, job.size)} kept, so Retry continues from there`, "Server didn't answer"]
    case 'too_large': return [`${formatBytes(job.size)}. The limit is 10 GB per file`, 'not sent']
    case 'disk_full': return ['The server is low on space. Ask the admin, or try later', 'not sent']
    case 'upload_quota': return ['You have too many unfinished uploads. Let some finish, then try again', 'not sent']
    case 'file_changed': return ['File changed or moved — choose it again', 'not sent']
    case 'not_found': return ['The server lost this upload. Retry starts it again', 'not sent']
    case 'interrupted': return ['Interrupted — choose the file again to continue', formatBytes(job.size)]
    default: return ['The server refused this file', 'not sent']
  }
}

const SHORT: Partial<Record<Reason, string>> = {
  too_large: 'too large', disk_full: 'server full', upload_quota: 'too many uploads',
  file_changed: 'changed or moved', network: "server didn't answer", rejected: 'refused',
}

function audience(job: Job): string {
  if (!job.item) return ''
  if (job.item.is_global) return 'to everyone'
  return `to ${job.item.recipients.map((r) => r.username).join(', ')}`
}

function Row({ job, onRetry, onCancel, onDismiss }: { job: Job } & Omit<Props, 'jobs'>) {
  const [open, setOpen] = useState(false)
  const ratio = job.size ? Math.min(1, job.sent / job.size) : job.state === 'done' ? 1 : 0
  const pct = `${job.state === 'done' ? 100 : Math.min(99, Math.round(ratio * 100))}%`
  const failed = job.files?.failed ?? []
  const fileCount = job.files ? `${job.files.done.toLocaleString('en-US')} of ${job.files.total.toLocaleString('en-US')} files` : null
  const speed = job.speed > 0 && job.eta !== null ? `${formatSpeed(job.speed)} · ${formatEta(job.eta)}` : 'starting…'

  let cls = 'q'
  let label = pct
  let left = fileCount ?? formatProgress(job.sent, job.size)
  let right = speed
  let track = true
  if (job.state === 'queued') {
    label = 'Waiting'
    left = fileCount ?? formatBytes(job.size)
    right = 'waiting'
  } else if (job.state === 'paused') {
    cls += ' paused'
    label = 'Paused'
    left = job.reason === 'signed_out'
      ? 'Signed out. It continues after you sign in again'
      : "You're offline. It continues by itself when you're back"
    right = pct
  } else if (job.state === 'failed') {
    cls += ' failed'
    label = LABEL[job.reason!] ?? 'Failed'
    ;[left, right] = failure(job)
    track = job.reason === 'network' || job.reason === 'not_found'
  } else if (job.state === 'done') {
    cls += ' done'
    label = failed.length ? `Done · ${failed.length} failed` : 'Sent'
    left = job.files ? `${job.files.done.toLocaleString('en-US')} files · ${formatBytes(job.size)}` : formatBytes(job.size)
    right = audience(job)
  }

  const active = job.state === 'queued' || job.state === 'sending' || job.state === 'paused'
  const retry = (job.state === 'failed' && job.canRetry) || (job.state === 'done' && failed.length > 0)
  return (
    <div className={cls}>
      <div className="q-top">
        <b>{job.name}</b>
        {failed.length > 0 && (
          <button type="button" className={`toggle${open ? ' open' : ''}`} aria-label={open ? 'Hide failed files' : 'Show failed files'}
            aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="i-chev" size={14} />
          </button>
        )}
        <span className="pct">{label}</span>
        {retry && <button type="button" className="act" onClick={() => onRetry(job.id)}><Icon name="i-retry" size={13} />Retry</button>}
        {active && <button type="button" className="x" aria-label="Cancel" onClick={() => onCancel(job.id)}><Icon name="i-x" size={14} /></button>}
        {job.state === 'failed' && <button type="button" className="x" aria-label="Remove" onClick={() => onDismiss(job.id)}><Icon name="i-x" size={14} /></button>}
      </div>
      {track && <div className="track"><i style={{ '--p': Number(ratio.toFixed(3)) } as CSSProperties} /></div>}
      <div className="q-sub"><span>{left}</span><span>{right}</span></div>
      {open && failed.map((f) => (
        <div className="q-sub" key={f.path}><span>{f.path}</span><span>{SHORT[f.reason] ?? 'failed'}</span></div>
      ))}
    </div>
  )
}

export function UploadQueue({ jobs, ...handlers }: Props) {
  if (!jobs.length) return null
  return <div className="queue">{jobs.map((j) => <Row key={j.id} job={j} {...handlers} />)}</div>
}

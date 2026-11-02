import { useEffect, useRef, useState } from 'react'
import type { Me } from '../../api/types'
import { Icon } from '../../icons'
import { formatBytes } from '../../lib/format'
import { UploadQueue } from '../sharing/UploadQueue'
import type { Uploader } from '../uploads/Uploader'
import { useUploads } from '../uploads/useUploads'
import { AutoLockToast } from './AutoLockToast'
import { downloadVaultFile } from './PhotoGrid'
import type { VaultStore } from './store'
import { addVaultFiles, markUnfinished, PHOTO_TYPES, takeUnfinished } from './vaultFiles'
import { useVault } from './useVault'
import { VaultLock } from './VaultLock'
import { VaultOpen } from './VaultOpen'
import { OwnPasswordGate, VaultSetup } from './VaultSetup'

type Session = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

type Props = { me: Me; store?: VaultStore; uploader?: Uploader; session?: Session; onOpenProfile: () => void }

function browserSession(): Session | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function VaultView({ me, store: given, uploader: givenUploader, session: givenSession, onOpenProfile }: Props) {
  const vault = useVault(given)
  const { jobs, uploader } = useUploads(givenUploader)
  const { store, status } = vault
  const [problem, setProblem] = useState<{ text: string; held: number } | null>(null)
  const photos = useRef<HTMLInputElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const session = givenSession ?? browserSession()

  useEffect(() => {
    if (status === 'loading') void store.load().catch(() => {})
  }, [status, store])

  // a reload cuts My storage uploads (they can't resume): remember a count, say so next time
  useEffect(() => {
    if (!session) return
    const leaving = () => markUnfinished(uploader, session)
    window.addEventListener('pagehide', leaving)
    return () => window.removeEventListener('pagehide', leaving)
  }, [uploader, session])

  /** Read once when the open view mounts: how many My storage uploads a reload cut short. */
  function takeStartMessage(): string | null {
    const n = session ? takeUnfinished(session) : 0
    return n ? `${n} ${n === 1 ? 'upload' : 'uploads'} to My storage didn't finish. Add ${n === 1 ? 'it' : 'them'} again.` : null
  }

  async function add(picked: File[], kind: 'photo' | 'file') {
    setProblem(null)
    const out = await addVaultFiles(picked, kind, store, uploader)
    if (out.error) setProblem({ text: out.error, held: out.held ?? 0 })
  }

  async function releaseHeld() {
    try {
      await store.releaseHeld()
      setProblem(null)
    } catch {
      setProblem((p) => p && { ...p, held: 0 })
    }
  }

  if (status === 'unavailable') {
    return <section className="card vault-lock"><p>My storage needs a secure (https) connection.</p></section>
  }
  if (status === 'loading') return null
  if (status === 'setup') {
    return me.uses_shared_password
      ? <OwnPasswordGate onOpenProfile={onOpenProfile} />
      : <VaultSetup store={store} onOpenProfile={onOpenProfile} />
  }
  if (status === 'locked') {
    return <VaultLock store={store} lockedBecause={vault.lockedBecause} usedBytes={vault.usedBytes} itemCount={vault.itemCount} />
  }

  const vaultJobs = jobs.filter((j) => j.vault)
  const picker = (ref: typeof photos, kind: 'photo' | 'file', label: string) => (
    <input ref={ref} type="file" multiple hidden aria-label={label} accept={kind === 'photo' ? PHOTO_TYPES.join(',') : undefined}
      onChange={(e) => {
        const picked = Array.from(e.target.files ?? [])
        e.target.value = ''
        void add(picked, kind)
      }} />
  )
  return (
    <>
      {picker(photos, 'photo', 'Choose photos')}
      {picker(files, 'file', 'Choose files')}
      <VaultOpen store={store} takeStartMessage={takeStartMessage}
        onAddFiles={(k) => (k === 'photo' ? photos : files).current?.click()}
        onDownload={(item) => void downloadVaultFile(store, item).catch(() => setProblem({ text: "Couldn't open it. Try again.", held: 0 }))}
        queue={
          <>
            {problem && (
              <div className="card pad" role="alert" style={{ marginBottom: 10 }}>
                <div className="err-msg" style={{ marginTop: 0 }}><Icon name="i-alert" size={14} />{problem.text}</div>
                {problem.held > 0 && (
                  <div className="hintline">
                    {formatBytes(problem.held)} is held by an upload that didn't finish.{' '}
                    <button type="button" onClick={() => void releaseHeld()} style={{ color: 'var(--navy)', fontWeight: 600 }}>Cancel it</button>
                  </div>
                )}
              </div>
            )}
            <UploadQueue jobs={vaultJobs} onRetry={(id) => uploader.retry(id)} onCancel={(id) => void uploader.cancel(id)}
              onDismiss={(id) => uploader.dismiss(id)} />
          </>
        } />
      {vault.lockWarning && <AutoLockToast onStay={() => store.touch()} />}
    </>
  )
}

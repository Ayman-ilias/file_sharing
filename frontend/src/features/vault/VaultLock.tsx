import { useRef, useState, type FormEvent } from 'react'
import { Icon } from '../../icons'
import { EraseDialog } from './EraseDialog'
import { WrongPassword, type LockReason, type VaultStore } from './store'

type Props = { store: VaultStore; lockedBecause: LockReason; usedBytes: number; itemCount: number }

export function VaultLock({ store, lockedBecause, usedBytes, itemCount }: Props) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [erasing, setErasing] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!pw || busy) return
    setBusy(true)
    setError(null)
    try {
      await store.unlock(pw)
    } catch (err) {
      setError(err instanceof WrongPassword ? 'Wrong storage password.' : "Couldn't open it. Check your connection and try again.")
      setPw('')
      input.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card vault-lock" id="vault-locked">
      <div className="lock-ic"><Icon name="i-lock" size={26} /></div>
      <h2>My storage is locked</h2>
      {lockedBecause === 'idle' && <span className="why-locked">Locked after 20 minutes without activity</span>}
      {/* spec §3.7: honest about the limit (the mockup's "not even the server admin" was not true) */}
      <p>Your notes, links, passwords and photos are encrypted on this device before they are saved. The database, backups and colleagues can't read them; a hacked server could.</p>
      <form className="unlock" onSubmit={submit}>
        <input ref={input} className="input" type="password" placeholder="Storage password" aria-label="Storage password"
          autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="primary" type="submit" disabled={busy || !pw}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      </form>
      {error && <div className="err-msg" role="alert" style={{ justifyContent: 'center' }}><Icon name="i-alert" size={14} />{error}</div>}
      <small>
        Forgot it? It cannot be reset.{' '}
        <button type="button" onClick={() => setErasing(true)} style={{ color: 'var(--navy)', fontWeight: 600, fontSize: 'inherit' }}>
          Erase My storage and start again
        </button>
      </small>
      {erasing && <EraseDialog store={store} usedBytes={usedBytes} itemCount={itemCount} onClose={() => setErasing(false)} />}
    </section>
  )
}

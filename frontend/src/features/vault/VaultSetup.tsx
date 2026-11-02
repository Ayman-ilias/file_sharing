import { useState, type FormEvent } from 'react'
import { Icon } from '../../icons'
import { OwnPasswordRequired, type VaultStore } from './store'

const MIN = 10

/** Needs the user's own login password first: on the shared one, any colleague could open it. */
export function OwnPasswordGate({ onOpenProfile }: { onOpenProfile: () => void }) {
  return (
    <section className="card vault-lock">
      <div className="lock-ic"><Icon name="i-shield" size={26} /></div>
      <h2>Set up My storage</h2>
      <p>Set your own login password first (Profile). While you still use the shared starting password, anyone who knows it could open or erase your storage.</p>
      <button type="button" className="primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onOpenProfile}>
        Set your own login password
      </button>
    </section>
  )
}

export function VaultSetup({ store, onOpenProfile }: { store: VaultStore; onOpenProfile: () => void }) {
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [ticked, setTicked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [gate, setGate] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const short = pw !== '' && pw.length < MIN
  const mismatch = again !== '' && again !== pw
  const ready = pw.length >= MIN && pw === again && ticked && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await store.setup(pw)
    } catch (err) {
      if (err instanceof OwnPasswordRequired) setGate(true)
      else setError("Couldn't set it up. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  if (gate) return <OwnPasswordGate onOpenProfile={onOpenProfile} />
  return (
    <form className="card vault-lock" onSubmit={submit} noValidate>
      <div className="lock-ic"><Icon name="i-shield" size={26} /></div>
      <h2>Set up My storage</h2>
      <p>Choose a storage password. It encrypts everything on this device before it is saved, so only you can open it.</p>
      <div className="field" style={{ textAlign: 'left' }}>
        <label htmlFor="vault-new-pw">Storage password</label>
        <input id="vault-new-pw" className="input" type="password" autoComplete="new-password" autoFocus
          value={pw} onChange={(e) => setPw(e.target.value)} />
        <div className="hintline">At least 10 characters. Don't reuse your login password.</div>
        {short && <div className="err-msg"><Icon name="i-alert" size={14} />Use at least 10 characters.</div>}
      </div>
      <div className="field" style={{ textAlign: 'left' }}>
        <label htmlFor="vault-new-pw2">Repeat it</label>
        <input id="vault-new-pw2" className="input" type="password" autoComplete="new-password"
          value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <div className="err-msg"><Icon name="i-alert" size={14} />The passwords don't match.</div>}
      </div>
      <label className="tick" style={{ textAlign: 'left' }}>
        <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
        I understand this password can't be reset. If I forget it, my storage is lost and nobody can recover it.
      </label>
      {error && <div className="err-msg" role="alert"><Icon name="i-alert" size={14} />{error}</div>}
      <button className="primary" type="submit" disabled={!ready} style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}>
        {busy ? 'Setting up…' : 'Create My storage'}
      </button>
    </form>
  )
}

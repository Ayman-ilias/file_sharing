import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError } from '../../api/client'
import type { Me } from '../../api/types'
import { Icon } from '../../icons'
import { initials } from './Header'

const MIN_LEN = 10

const MESSAGES: Record<string, string> = {
  bad_credentials: 'Current password is wrong.',
  too_short: 'Use at least 10 characters.',
  same_as_shared: 'Choose a password that is not the shared starting password.',
  mismatch: "The new passwords don't match.",
}

type Props = {
  me: Me
  open: boolean
  onClose: () => void
  onChanged: () => void
  onSetupStorage?: () => void
}

function LoginPasswordForm({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setDone(false)
    if (next.length < MIN_LEN) return setError(MESSAGES.too_short)
    if (next !== repeat) return setError(MESSAGES.mismatch)
    setBusy(true)
    setError(null)
    try {
      await api.send('POST', '/api/auth/password', { current_password: current, new_password: next })
      setCurrent('')
      setNext('')
      setRepeat('')
      setDone(true)
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError
        ? MESSAGES[err.detail] ?? 'Something went wrong. Try again.'
        : "Can't reach the server. Check your connection.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="dr-sec" onSubmit={submit} noValidate>
      <h3>Login password</h3>
      <p>Everyone starts with the shared password. Set your own so nobody else can sign in as you.</p>
      {done && (
        <div className="ok-msg" role="status">
          <Icon name="i-check" />Login password changed. Other devices were signed out.
        </div>
      )}
      <div className="field">
        <label htmlFor="pw-current">Current password</label>
        <input id="pw-current" className="input" type="password" autoComplete="current-password"
          value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pw-new">New password</label>
        <input id="pw-new" className="input" type="password" autoComplete="new-password" placeholder="At least 10 characters"
          value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pw-repeat">Repeat new password</label>
        <input id="pw-repeat" className="input" type="password" autoComplete="new-password"
          value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </div>
      {error && <div className="err-msg" role="alert"><Icon name="i-alert" size={14} />{error}</div>}
      <button className="primary" type="submit" disabled={busy}>Change login password</button>
    </form>
  )
}

export function ProfileDrawer({ me, open, onClose, onChanged, onSetupStorage }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="overlay" data-testid="profile-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Profile">
        <div className="dr-head">
          <div className="av big" aria-hidden="true">{initials(me.username)}</div>
          <div><b>{me.username}</b><span>{me.email}</span></div>
          <button className="mini" aria-label="Close" onClick={onClose}><Icon name="i-x" size={18} /></button>
        </div>

        {me.is_global ? (
          <section className="dr-sec muted-sec">
            <h3>Signed in as the global account</h3>
            <p>The shared <b>{me.email}</b> account sees only Global files. It has no My storage, and its password cannot be changed here.</p>
          </section>
        ) : (
          <>
            <LoginPasswordForm onChanged={onChanged} />
            <section className="dr-sec">
              <h3>Storage password</h3>
              <p>You haven't set up My storage yet.</p>
              <button className="btn" onClick={onSetupStorage}><Icon name="i-shield" size={15} />Set up My storage</button>
            </section>
          </>
        )}
      </aside>
    </div>
  )
}

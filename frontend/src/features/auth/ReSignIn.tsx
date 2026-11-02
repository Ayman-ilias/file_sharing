import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../../api/client'
import type { Me } from '../../api/types'
import { Icon } from '../../icons'

type Props = { me: Me; paused: number; onSignedIn: () => void; onSwitchUser?: () => void }

function waiting(n: number): string {
  if (n === 0) return 'Your session ended. Sign in to carry on where you were.'
  return `${n} ${n === 1 ? 'upload is' : 'uploads are'} paused and will continue after you sign in.`
}

/** Signed out mid-session: ask for the password in place, so uploads and the page survive. */
export function ReSignIn({ me, paused, onSignedIn, onSwitchUser }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.send('POST', '/api/auth/login', { email: me.email, password })
      onSignedIn()
    } catch (err) {
      setError(err instanceof ApiError
        ? err.detail === 'too_many_attempts' ? 'Too many tries. Wait a minute and try again.' : 'Email or password is wrong.'
        : "Can't reach the server. Check your connection.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" style={{ justifyContent: 'center', alignItems: 'center', padding: 16 }}>
      <form className="card pad" role="dialog" aria-modal="true" aria-labelledby="resign-title" onSubmit={submit}
        style={{ textAlign: 'center', width: 'min(380px, 100%)' }}>
        <div className="lock-ic" style={{ width: 48, height: 48, margin: '0 auto 10px', borderRadius: 14, display: 'grid', placeItems: 'center', background: '#eef0f8', color: 'var(--navy)' }}>
          <Icon name="i-lock" size={22} />
        </div>
        <b id="resign-title">Please sign in again</b>
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: '4px 0 14px' }}>{waiting(paused)}</p>
        <div className="field" style={{ textAlign: 'left' }}>
          <label htmlFor="resign-password">Password for {me.email}</label>
          <input id="resign-password" className="input" type="password" autoComplete="current-password" autoFocus
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div className="err-msg" role="alert" style={{ textAlign: 'left' }}><Icon name="i-alert" size={14} />{error}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>Sign in and continue</button>
        {onSwitchUser && (
          <div className="switch" style={{ marginTop: 14, fontSize: 13.5, color: 'var(--muted)' }}>
            Not {me.username}?{' '}
            <button type="button" onClick={onSwitchUser} style={{ color: 'var(--navy)', fontWeight: 600 }}>Sign in as someone else</button>
          </div>
        )}
      </form>
    </div>
  )
}

import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../../api/client'
import type { Me } from '../../api/types'
import { Icon } from '../../icons'

const DOMAIN = 'southerniot.net'

const MESSAGES: Record<string, string> = {
  bad_credentials: 'Email or password is wrong.',
  too_many_attempts: 'Too many tries. Wait a minute and try again.',
  domain_not_allowed: `Only @${DOMAIN} emails can register.`,
  reserved: "This address can't be registered.",
}

function message(e: unknown): string {
  if (e instanceof ApiError) return MESSAGES[e.detail] ?? 'Something went wrong. Try again.'
  return "Can't reach the server. Check your connection."
}

/** The name part of what was typed or pasted, and whether its domain (if any) is wrong. */
function splitEmail(raw: string): { name: string; badDomain: boolean } {
  const at = raw.indexOf('@')
  if (at < 0) return { name: raw.trim(), badDomain: false }
  const domain = raw.slice(at + 1).trim().toLowerCase()
  if (domain === DOMAIN || domain === '') return { name: raw.slice(0, at).trim(), badDomain: false }
  return { name: raw, badDomain: true }
}

function ErrMsg({ text }: { text: string }) {
  return (
    <div className="err-msg" role="alert">
      <Icon name="i-alert" size={14} />
      {text}
    </div>
  )
}

type Props = { onSignedIn: (me: Me) => void }

export function LoginPage({ onSignedIn }: Props) {
  const [view, setView] = useState<'signin' | 'register'>('signin')
  const [name, setName] = useState('')
  const [badDomain, setBadDomain] = useState(false)
  const [password, setPassword] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const email = `${name.trim().toLowerCase()}@${DOMAIN}`

  function onEmail(raw: string) {
    const parts = splitEmail(raw)
    setName(parts.name)
    setBadDomain(parts.badDomain)
    setError(null)
  }

  function switchTo(next: 'signin' | 'register') {
    setView(next)
    setCreated(null)
    setError(null)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (badDomain || !name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      if (view === 'register') {
        const out = await api.send<{ email: string }>('POST', '/api/auth/register', { email })
        setCreated(out.email)
        setPassword('')
        setView('signin')
      } else {
        onSignedIn(await api.send<Me>('POST', '/api/auth/login', { email, password }))
      }
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const emailField = (
    <div className="field">
      <label htmlFor="login-email">Email</label>
      <div className="email" style={badDomain ? { borderColor: '#f1a7a7' } : undefined}>
        <input
          id="login-email"
          value={name}
          onChange={(e) => onEmail(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
        />
        <span>@{DOMAIN}</span>
      </div>
      {badDomain && <ErrMsg text={MESSAGES.domain_not_allowed} />}
    </div>
  )

  const passwordField = (
    <div className="field">
      <label htmlFor="login-password">Password</label>
      <input
        id="login-password"
        className="input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        autoFocus={created !== null}
      />
    </div>
  )

  return (
    <div className="loginframe">
      <div className="lpage">
        <div className="band" />
        <form className="card lcard" onSubmit={submit} noValidate>
          {view === 'register' ? (
            <>
              <h2>Create your account</h2>
              <p>Use your Southern IoT email</p>
              {emailField}
              {error && <ErrMsg text={error} />}
              <button className="primary" type="submit" disabled={busy}>Create account</button>
              <div className="switch">
                Already registered?{' '}
                <a href="#" onClick={(e) => { e.preventDefault(); switchTo('signin') }}>Sign in</a>
              </div>
            </>
          ) : created ? (
            <>
              <div className="ok-msg" style={{ textAlign: 'left' }}>
                <Icon name="i-check" />
                Account created for {created}. Sign in with the shared starting password, then set your own in Profile.
              </div>
              <div style={{ marginTop: 14 }}>{passwordField}</div>
              {error && <ErrMsg text={error} />}
              <button className="primary" type="submit" disabled={busy}>Sign in</button>
            </>
          ) : (
            <>
              <div className="logo"><img src="/mark.png" alt="Southern IoT" /></div>
              <h2>Southern IoT Files</h2>
              <p>Sign in with your work email</p>
              {emailField}
              {passwordField}
              {error && <ErrMsg text={error} />}
              <button className="primary" type="submit" disabled={busy}>Sign in</button>
              <div className="switch">
                First time here?{' '}
                <a href="#" onClick={(e) => { e.preventDefault(); switchTo('register') }}>Register</a>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  )
}

import type { Me } from '../../api/types'

export function initials(username: string): string {
  return username.slice(0, 2).toUpperCase()
}

type Props = { me: Me; onProfile: () => void; onLogout: () => void }

export function Header({ me, onProfile, onLogout }: Props) {
  return (
    <>
      <div className="account">
        <button className="acct-btn" onClick={onProfile}>
          <span>{me.email}</span>
          <span className="av" aria-hidden="true">{initials(me.username)}</span>
        </button>
        <a href="#" onClick={(e) => { e.preventDefault(); onLogout() }}>Log out</a>
      </div>
      <header>
        <div className="logo"><img src="/mark.png" alt="Southern IoT" /></div>
        <h1>Southern IoT</h1>
        <p className="tag">File &amp; Text Sharing</p>
      </header>
    </>
  )
}

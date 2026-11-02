import { useState } from 'react'
import { useSession } from './api/session'
import { LoginPage } from './features/auth/LoginPage'
import { ReSignIn } from './features/auth/ReSignIn'
import { Background } from './features/layout/Background'
import { Header } from './features/layout/Header'
import { Nudge } from './features/layout/Nudge'
import { ProfileDrawer } from './features/layout/ProfileDrawer'
import { TopTabs, type View } from './features/layout/TopTabs'
import { Lists } from './features/sharing/Lists'
import { SendCard } from './features/sharing/SendCard'
import { useUploads } from './features/uploads/useUploads'
import { Icon } from './icons'

export default function App() {
  const { me: signedIn, lost, loading, refresh, logout } = useSession()
  const { jobs, uploader } = useUploads()

  /** Uploads never outlive the session that started them (the next person could be someone else). */
  async function logOut() {
    if (uploader.busy() && !window.confirm('Uploads are still sending. Log out and cancel them?')) return
    await uploader.cancelAll()
    await logout()
  }
  const [view, setView] = useState<View>('sharing')
  const [profileOpen, setProfileOpen] = useState(false)

  if (loading) return <Background />
  // a session that ended by itself keeps the page (and its uploads) under a sign-in dialog
  const me = signedIn ?? lost
  if (!me) {
    return (
      <>
        <Background />
        <LoginPage onSignedIn={() => { setView('sharing'); void refresh() }} />
      </>
    )
  }

  const showStorage = !me.is_global
  const current = showStorage ? view : 'sharing'
  return (
    <>
      <Background />
      <div style={{ position: 'relative' }}>
        <div className="band" />
        <div className="wrap">
          <Header me={me} onProfile={() => setProfileOpen(true)} onLogout={() => void logOut()} />
          <TopTabs value={current} onChange={setView} showStorage={showStorage} />
          {current === 'sharing' ? (
            <div id="view-sharing">
              <Nudge show={!me.is_global && me.uses_shared_password} onSetOwn={() => setProfileOpen(true)} />
              <div className="notice"><Icon name="i-clock" size={18} />Everything shared here is deleted automatically after 30 days.</div>
              <SendCard me={me} />
              <Lists me={me} />
            </div>
          ) : (
            <div id="view-storage" />
          )}
        </div>
      </div>
      <ProfileDrawer me={me} open={profileOpen && !!signedIn} onClose={() => setProfileOpen(false)} onChanged={() => void refresh()} />
      {!signedIn && (
        <ReSignIn me={me} paused={jobs.filter((j) => j.state === 'paused' || j.state === 'queued').length}
          onSignedIn={() => void refresh()} onSwitchUser={() => void logout()} />
      )}
    </>
  )
}

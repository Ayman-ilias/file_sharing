import { useState } from 'react'
import { useSession } from './api/session'
import { LoginPage } from './features/auth/LoginPage'
import { Background } from './features/layout/Background'
import { Header } from './features/layout/Header'
import { Nudge } from './features/layout/Nudge'
import { ProfileDrawer } from './features/layout/ProfileDrawer'
import { TopTabs, type View } from './features/layout/TopTabs'
import { SendCard } from './features/sharing/SendCard'
import { Icon } from './icons'

export default function App() {
  const { me, loading, refresh, logout } = useSession()
  const [view, setView] = useState<View>('sharing')
  const [profileOpen, setProfileOpen] = useState(false)

  if (loading) return <Background />
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
          <Header me={me} onProfile={() => setProfileOpen(true)} onLogout={() => void logout()} />
          <TopTabs value={current} onChange={setView} showStorage={showStorage} />
          {current === 'sharing' ? (
            <div id="view-sharing">
              <Nudge show={!me.is_global && me.uses_shared_password} onSetOwn={() => setProfileOpen(true)} />
              <div className="notice"><Icon name="i-clock" size={18} />Everything shared here is deleted automatically after 30 days.</div>
              <SendCard me={me} />
            </div>
          ) : (
            <div id="view-storage" />
          )}
        </div>
      </div>
      <ProfileDrawer me={me} open={profileOpen} onClose={() => setProfileOpen(false)} onChanged={() => void refresh()} />
    </>
  )
}

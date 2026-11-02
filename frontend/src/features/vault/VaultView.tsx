import { useEffect } from 'react'
import type { Me } from '../../api/types'
import { AutoLockToast } from './AutoLockToast'
import type { VaultStore } from './store'
import { useVault } from './useVault'
import { VaultLock } from './VaultLock'
import { OwnPasswordGate, VaultSetup } from './VaultSetup'

type Props = { me: Me; store?: VaultStore; onOpenProfile: () => void }

export function VaultView({ me, store: given, onOpenProfile }: Props) {
  const vault = useVault(given)
  const { store, status } = vault

  useEffect(() => {
    if (status === 'loading') void store.load().catch(() => {})
  }, [status, store])

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
  return (
    <>
      <section id="vault-open" />
      {vault.lockWarning && <AutoLockToast onStay={() => store.touch()} />}
    </>
  )
}

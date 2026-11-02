import { useSyncExternalStore } from 'react'
import { vaultApi } from './api'
import { VaultStore } from './store'

let shared: VaultStore | null = null

/** The tab's one vault store (the key lives only in its memory). */
export function sharedVault(): VaultStore {
  shared ??= new VaultStore({ api: vaultApi })
  return shared
}

export function useVault(store: VaultStore = sharedVault()) {
  const state = useSyncExternalStore(store.onChange, store.snapshot)
  return { ...state, store }
}

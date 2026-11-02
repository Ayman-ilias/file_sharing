import { useSyncExternalStore } from 'react'
import { api } from '../../api/client'
import { Uploader, type Storage } from './Uploader'

let shared: Uploader | null = null

/** localStorage / sessionStorage in the engine's shape; undefined when blocked (no resume after reload). */
function browserStorage(get: () => globalThis.Storage): Storage | undefined {
  try {
    const s = get()
    return {
      getItem: (k) => s.getItem(k),
      setItem: (k, v) => s.setItem(k, v),
      removeItem: (k) => s.removeItem(k),
      keys: () => Object.keys(s),
    }
  } catch {
    return undefined
  }
}

/** The one engine for this tab, created on first use with the real API and browser events. */
export function sharedUploader(): Uploader {
  shared ??= new Uploader({
    api,
    env: window,
    storage: browserStorage(() => window.localStorage),
    session: browserStorage(() => window.sessionStorage),
  })
  return shared
}

export function useUploads(uploader: Uploader = sharedUploader()) {
  const jobs = useSyncExternalStore(uploader.onChange, uploader.jobs)
  return { jobs, uploader }
}

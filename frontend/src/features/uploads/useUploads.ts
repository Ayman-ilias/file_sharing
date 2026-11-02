import { useSyncExternalStore } from 'react'
import { api } from '../../api/client'
import { Uploader } from './Uploader'

let shared: Uploader | null = null

/** The one engine for this tab, created on first use with the real API and browser events. */
export function sharedUploader(): Uploader {
  shared ??= new Uploader({
    api,
    env: window,
    storage: (() => {
      try {
        return window.localStorage
      } catch {
        return undefined // storage blocked: no resume after reload
      }
    })(),
  })
  return shared
}

export function useUploads(uploader: Uploader = sharedUploader()) {
  const jobs = useSyncExternalStore(uploader.onChange, uploader.jobs)
  return { jobs, uploader }
}

import { useEffect, useEffectEvent } from 'react'
import { LiveEvents, type LiveEvent } from './liveEvents'

let shared: LiveEvents | null = null

/** The tab's one LiveEvents (it shares a single connection with the other tabs). */
export function sharedLive(): LiveEvents {
  if (!shared) {
    shared = new LiveEvents()
    window.addEventListener('pagehide', () => shared?.stop())
  }
  return shared
}

export function useEvents(handler: (e: LiveEvent) => void, live?: LiveEvents) {
  const onEvent = useEffectEvent(handler) // always the latest handler, without re-subscribing
  useEffect(() => {
    const l = live ?? sharedLive()
    const off = l.subscribe((e) => onEvent(e))
    l.start()
    return () => {
      off()
      if (live) live.stop() // an injected one (tests) belongs to this component
    }
  }, [live])
}

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from './client'
import type { Me } from './types'

/**
 * The signed-in user. When the session ends by itself (expired, password changed elsewhere),
 * `lost` keeps who it was, so the page can ask for the password in place without losing state.
 */
export function useSession() {
  const [me, setMe] = useState<Me | null>(null)
  const [lost, setLost] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const user = await api.get<Me>('/api/auth/me')
      setMe(user)
      setLost(null)
      window.dispatchEvent(new Event('fs:signed-in')) // paused uploads continue
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null)
      else throw e
    } finally {
      setLoading(false)
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.send('POST', '/api/auth/logout')
    } finally {
      setMe(null)
      setLost(null)
    }
  }, [])

  useEffect(() => {
    // state is set after the request finishes, not synchronously in the effect
    // oxlint-disable-next-line react/set-state-in-effect
    refresh().catch(() => setLoading(false))
    const out = () => setMe((current) => {
      if (current) setLost(current)
      return null
    })
    window.addEventListener('fs:signed-out', out)
    return () => window.removeEventListener('fs:signed-out', out)
  }, [refresh])

  return { me, lost, loading, refresh, logout }
}

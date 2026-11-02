import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from './client'
import type { Me } from './types'

export function useSession() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/api/auth/me'))
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
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => setLoading(false))
    const out = () => setMe(null)
    window.addEventListener('fs:signed-out', out)
    return () => window.removeEventListener('fs:signed-out', out)
  }, [refresh])

  return { me, loading, refresh, logout }
}

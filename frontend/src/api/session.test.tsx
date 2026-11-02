import { renderHook, waitFor, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSession } from './session'

const me = { id: 1, email: 'rahim@southerniot.net', username: 'rahim', is_global: false, uses_shared_password: true }
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('useSession', () => {
  it('gives me = null on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(401, { detail: 'not_signed_in' }))
    const { result } = renderHook(() => useSession())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.me).toBeNull()
  })

  it('loads me once, and logout clears it', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, me)).mockResolvedValueOnce(json(204))
    const { result } = renderHook(() => useSession())
    await waitFor(() => expect(result.current.me?.username).toBe('rahim'))
    await act(() => result.current.logout())
    expect(result.current.me).toBeNull()
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[1][0]).toBe('/api/auth/logout')
  })

  it('clears me when any call reports signed-out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, me))
    const { result } = renderHook(() => useSession())
    await waitFor(() => expect(result.current.me).not.toBeNull())
    act(() => { window.dispatchEvent(new Event('fs:signed-out')) })
    expect(result.current.me).toBeNull()
  })

  it('announces fs:signed-in when a user is loaded, so paused uploads continue', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(200, me))
    const seen = vi.fn()
    window.addEventListener('fs:signed-in', seen)
    const { result } = renderHook(() => useSession())
    await waitFor(() => expect(result.current.me).not.toBeNull())
    await act(() => result.current.refresh())
    window.removeEventListener('fs:signed-in', seen)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('keeps the lost user when the session ends by itself, not after Log out', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/logout') ? json(204) : json(200, me))
    const { result } = renderHook(() => useSession())
    await waitFor(() => expect(result.current.me).not.toBeNull())
    act(() => { window.dispatchEvent(new Event('fs:signed-out')) })
    expect(result.current.lost?.username).toBe('rahim')
    await act(() => result.current.refresh())
    expect(result.current.me?.username).toBe('rahim')
    expect(result.current.lost).toBeNull()
    await act(() => result.current.logout())
    expect(result.current.lost).toBeNull()
  })

  it('says who signed in, so the upload engine never resumes another user\'s jobs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(200, me))
    const ids: unknown[] = []
    const seen = (e: Event) => ids.push((e as CustomEvent).detail?.id)
    window.addEventListener('fs:signed-in', seen)
    const { result } = renderHook(() => useSession())
    await waitFor(() => expect(result.current.me).not.toBeNull())
    window.removeEventListener('fs:signed-in', seen)
    expect(ids).toEqual([1])
  })
})

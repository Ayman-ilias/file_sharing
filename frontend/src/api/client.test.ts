import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './client'

function reply(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('api client', () => {
  it('sends the CSRF header and same-origin credentials on writes', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(201, { id: 'a' }))
    await api.send('POST', '/api/items/text', { body: 'hi' })
    await api.put('/api/uploads/x/chunks/0', new Blob(['abc']))
    await api.send('DELETE', '/api/items/a')
    for (const [, init] of f.mock.calls) {
      expect(new Headers(init?.headers).get('X-Requested-With')).toBe('fs')
      expect(init?.credentials).toBe('same-origin')
    }
  })

  it('passes a chunk Blob straight to fetch', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(204))
    const blob = new Blob(['abc'])
    await api.put('/api/uploads/x/chunks/0', blob)
    expect(f.mock.calls[0][1]?.body).toBe(blob)
  })

  it('reads JSON and returns undefined for 204', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(200, { a: 1 })).mockResolvedValueOnce(reply(204))
    expect(await api.get('/api/x')).toEqual({ a: 1 })
    expect(await api.send('DELETE', '/api/x')).toBeUndefined()
  })

  it('turns an error body into ApiError with the extra fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(409, { detail: 'missing_chunks', missing: [1] }))
    const err = (await api.send('POST', '/api/uploads/x/complete').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(409)
    expect(err.detail).toBe('missing_chunks')
    expect(err.extra.missing).toEqual([1])
  })

  it('copes with a non-JSON error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>502</html>', { status: 502 }))
    const err = (await api.get('/api/x').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(502)
    expect(err.detail).toBe('http_502')
  })

  it('fires fs:signed-out on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(401, { detail: 'not_signed_in' }))
    const seen = vi.fn()
    window.addEventListener('fs:signed-out', seen)
    await api.get('/api/items').catch(() => {})
    window.removeEventListener('fs:signed-out', seen)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('does not fire fs:signed-out for a failed login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(401, { detail: 'bad_credentials' }))
    const seen = vi.fn()
    window.addEventListener('fs:signed-out', seen)
    await api.send('POST', '/api/auth/login', {}).catch(() => {})
    window.removeEventListener('fs:signed-out', seen)
    expect(seen).not.toHaveBeenCalled()
  })
})

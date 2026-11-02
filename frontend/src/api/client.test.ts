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
    await api.send('DELETE', '/api/items/a')
    for (const [, init] of f.mock.calls) {
      expect(new Headers(init?.headers).get('X-Requested-With')).toBe('fs')
      expect(init?.credentials).toBe('same-origin')
    }
  })

  it('gives every JSON request a time limit, so a dead connection fails instead of hanging', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(200, {}))
    await api.get('/api/x')
    await api.send('POST', '/api/y', {})
    for (const [, init] of f.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal)
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

class FakeXHR {
  static last: FakeXHR
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown
  status = 0
  responseText = ''
  aborted = false
  upload = new EventTarget()
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  send(body: unknown) { this.body = body; FakeXHR.last = this }
  abort() { this.aborted = true; this.onabort?.() }
  respond(status: number, body?: unknown) {
    this.status = status
    this.responseText = body === undefined ? '' : JSON.stringify(body)
    this.onload?.()
  }
  progress(loaded: number) { this.upload.dispatchEvent(Object.assign(new Event('progress'), { loaded })) }
}

describe('api.put (chunks, with upload progress)', () => {
  afterEach(() => vi.unstubAllGlobals())
  const stub = () => vi.stubGlobal('XMLHttpRequest', FakeXHR)

  it('sends the Blob itself with the CSRF header and reports progress', async () => {
    stub()
    const blob = new Blob(['abcdef'])
    const seen: number[] = []
    const p = api.put('/api/uploads/x/chunks/0', blob, { onProgress: (n) => seen.push(n) })
    const xhr = FakeXHR.last
    expect(xhr.method).toBe('PUT')
    expect(xhr.url).toBe('/api/uploads/x/chunks/0')
    expect(xhr.headers['X-Requested-With']).toBe('fs')
    expect(xhr.body).toBe(blob)
    xhr.progress(3)
    xhr.respond(204)
    await p
    expect(seen).toEqual([3])
  })

  it('turns an error answer into ApiError and a lost session into fs:signed-out', async () => {
    stub()
    const p1 = api.put('/u', new Blob(['a']))
    FakeXHR.last.respond(409, { detail: 'already_complete' })
    const e1 = (await p1.catch((e: unknown) => e)) as ApiError
    expect(e1.status).toBe(409)
    expect(e1.detail).toBe('already_complete')

    const seen = vi.fn()
    window.addEventListener('fs:signed-out', seen)
    const p2 = api.put('/u', new Blob(['a']))
    FakeXHR.last.respond(401, { detail: 'not_signed_in' })
    await p2.catch(() => {})
    window.removeEventListener('fs:signed-out', seen)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('rejects with TypeError on a network error and AbortError on abort', async () => {
    stub()
    const p1 = api.put('/u', new Blob(['a']))
    FakeXHR.last.onerror?.()
    expect(await p1.catch((e: unknown) => e)).toBeInstanceOf(TypeError)

    const ctl = new AbortController()
    const p2 = api.put('/u', new Blob(['a']), { signal: ctl.signal })
    const xhr = FakeXHR.last
    ctl.abort()
    const e2 = (await p2.catch((e: unknown) => e)) as DOMException
    expect(xhr.aborted).toBe(true)
    expect(e2.name).toBe('AbortError')
  })
})

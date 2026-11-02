// The one way the app talks to the backend: cookie session, CSRF header on every write.

export class ApiError extends Error {
  status: number
  detail: string
  extra: Record<string, unknown>

  constructor(status: number, detail: string, extra: Record<string, unknown> = {}) {
    super(`${status} ${detail}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.extra = extra
  }
}

async function toError(res: Response): Promise<ApiError> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // proxies answer 502/504 with HTML
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { detail, ...extra } = body as Record<string, unknown>
    // 422 validation errors carry a list in detail
    return new ApiError(res.status, typeof detail === 'string' ? detail : 'invalid', { ...extra, detail })
  }
  return new ApiError(res.status, `http_${res.status}`)
}

async function request<T>(method: string, path: string, body?: BodyInit, json = false): Promise<T> {
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['X-Requested-With'] = 'fs'
  if (json) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, body, credentials: 'same-origin' })
  if (!res.ok) {
    const err = await toError(res)
    // only a lost session signs out; a wrong password (bad_credentials) is just an error
    if (err.status === 401 && err.detail === 'not_signed_in') {
      window.dispatchEvent(new Event('fs:signed-out'))
    }
    throw err
  }
  if (res.status === 204 || res.headers.get('Content-Length') === '0') return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  send: <T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
    body === undefined ? request<T>(method, path) : request<T>(method, path, JSON.stringify(body), true),
  put: (path: string, blob: Blob) => request<void>('PUT', path, blob),
}

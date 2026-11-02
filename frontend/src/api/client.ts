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

function toError(status: number, text: string): ApiError {
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    // proxies answer 502/504 with HTML
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { detail, ...extra } = body as Record<string, unknown>
    // 422 validation errors carry a list in detail
    return new ApiError(status, typeof detail === 'string' ? detail : 'invalid', { ...extra, detail })
  }
  return new ApiError(status, `http_${status}`)
}

function fail(err: ApiError): ApiError {
  // only a lost session signs out; a wrong password (bad_credentials) is just an error
  if (err.status === 401 && err.detail === 'not_signed_in') {
    window.dispatchEvent(new Event('fs:signed-out'))
  }
  return err
}

async function request<T>(method: string, path: string, body?: BodyInit, json = false): Promise<T> {
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['X-Requested-With'] = 'fs'
  if (json) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, body, credentials: 'same-origin' })
  const text = await res.text()
  if (!res.ok) throw fail(toError(res.status, text))
  return (text ? JSON.parse(text) : undefined) as T
}

export type PutOptions = { signal?: AbortSignal; onProgress?: (loaded: number) => void }

/** A chunk upload. XMLHttpRequest, because fetch can't report upload progress. */
function putBlob(path: string, blob: Blob, opts: PutOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const settle = () => opts.signal?.removeEventListener('abort', abort)
    xhr.open('PUT', path)
    xhr.setRequestHeader('X-Requested-With', 'fs')
    if (opts.onProgress) xhr.upload.addEventListener('progress', (e) => opts.onProgress?.((e as ProgressEvent).loaded))
    xhr.onload = () => {
      settle()
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(fail(toError(xhr.status, xhr.responseText)))
    }
    xhr.onerror = () => { settle(); reject(new TypeError('Network request failed')) }
    xhr.onabort = () => { settle(); reject(new DOMException('Aborted', 'AbortError')) }
    if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    opts.signal?.addEventListener('abort', abort, { once: true })
    xhr.send(blob)
  })
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  send: <T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
    body === undefined ? request<T>(method, path) : request<T>(method, path, JSON.stringify(body), true),
  put: putBlob,
}

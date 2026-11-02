import { vi } from 'vitest'

export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

type Route = (init: RequestInit | undefined) => Response | Promise<Response>

/** A fake backend: "METHOD /path" → handler. Unknown routes answer 404. */
export function fakeApi(routes: Record<string, Route>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.split('?')[0]
    const handler = routes[`${init?.method ?? 'GET'} ${path}`]
    return handler ? handler(init) : json(404, { detail: 'not_found' })
  })
}

export const ayman = { id: 1, email: 'ayman@southerniot.net', username: 'ayman', is_global: false, uses_shared_password: true }
export const globalMe = { id: 2, email: 'global@southerniot.net', username: 'global', is_global: true, uses_shared_password: true }

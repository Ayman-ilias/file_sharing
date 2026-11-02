// The mockup's sample data, answered in the browser, so the app can be compared with mockup.html.
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { ROOT } from './fixtures'

export const NOW = new Date('2026-11-02T16:30:00+06:00')
const MIN = 60_000
const DAY = 86_400_000
const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const expires = new Date(NOW.getTime() + 25 * DAY).toISOString()

export const ayman = { id: 1, email: 'ayman@southerniot.net', username: 'ayman', is_global: false, uses_shared_password: true }
const u = (id: number, username: string) => ({ id, username })
const users = [[2, 'rahim'], [3, 'nusrat'], [4, 'tanvir'], [5, 'tasnim'], [6, 'arif']].map(([id, n]) => ({
  id, username: n, email: `${n}@southerniot.net`,
}))
const base = { text_body: null, text_truncated: false, line_count: null, file_count: null, expires_at: expires }

export const privateItems = [
  { ...base, id: 't1', kind: 'text', name: 'Gateway config for Uttara', size: 0, mime: 'text/plain', sender: u(2, 'rahim'),
    recipients: [u(1, 'ayman')], is_global: false, created_at: at(2 * MIN), line_count: 4,
    text_body: 'Dashboard: https://grafana.southerniot.net/d/uttara\nSSID: SIOT-Field-5G\nGateway IP: 10.10.8.51\nSetup guide: www.southerniot.net' },
  { ...base, id: 'f1', kind: 'folder', name: 'firmware-v3.2', size: 64.2 * 1024 ** 2, mime: 'inode/directory', sender: u(4, 'tanvir'),
    recipients: [u(1, 'ayman')], is_global: false, created_at: at(60 * MIN), file_count: 12 },
  { ...base, id: 'p1', kind: 'file', name: 'Site-Survey-Report.pdf', size: 18.4 * 1024 ** 2, mime: 'application/pdf', sender: u(1, 'ayman'),
    recipients: [u(2, 'rahim')], is_global: false, created_at: at(90 * MIN) },
  { ...base, id: 'x1', kind: 'file', name: 'BOQ-final.xlsx', size: 2.3 * 1024 ** 2,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sender: u(1, 'ayman'),
    recipients: [u(2, 'rahim'), u(3, 'nusrat')], is_global: false, created_at: at(DAY) },
]

export const globalItems = [
  { ...base, id: 'v1', kind: 'file', name: 'drone-footage-mirpur.mp4', size: 1.8 * 1024 ** 3, mime: 'video/mp4', sender: u(3, 'nusrat'),
    recipients: [], is_global: true, created_at: at(30 * MIN) },
  { ...base, id: 'ph1', kind: 'file', name: 'rack-wiring-photo.jpg', size: 4.1 * 1024 ** 2, mime: 'image/jpeg', sender: u(6, 'arif'),
    recipients: [], is_global: true, created_at: at(45 * MIN) },
  { ...base, id: 'g1', kind: 'text', name: 'Guest Wi-Fi this week', size: 0, mime: 'text/plain', sender: u(5, 'tasnim'),
    recipients: [], is_global: true, created_at: at(DAY), line_count: 3,
    text_body: 'Network: SIOT-Guest\nPassword: changes every Monday, ask at the front desk\nMap: maps.google.com' },
]

type Options = { me?: typeof ayman | null; private?: unknown[]; global?: unknown[]; users?: unknown[] }

export async function mockApi(page: Page, opts: Options = {}) {
  const me = opts.me === undefined ? ayman : opts.me
  const photo = readFileSync(`${ROOT}/docs/design/assets/sample-photo.jpg`)
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/auth/me') return me ? json(200, me) : json(401, { detail: 'not_signed_in' })
    if (p === '/api/users') return json(200, opts.users ?? users)
    if (p === '/api/items') {
      const items = url.searchParams.get('section') === 'global' ? opts.global ?? globalItems : opts.private ?? privateItems
      return json(200, { items, next: null })
    }
    if (p.endsWith('/download')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: photo })
    if (p === '/api/events') return route.fulfill({ status: 204, body: '' })
    return json(404, { detail: 'not_found' })
  })
}

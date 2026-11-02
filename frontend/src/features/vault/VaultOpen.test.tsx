import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as clipboard from '../../lib/clipboard'
import type { VaultMeta } from './api'
import { fakeVault } from './fakeVault'
import { generatePassword, normalizeUrl } from './ItemForm'
import { VaultStore } from './store'
import { VaultOpen } from './VaultOpen'

vi.setConfig({ testTimeout: 20_000 })

const PW = 'storage-pass-123'
const router: VaultMeta = { kind: 'password', title: 'Office router admin', username: 'admin', url: '192.168.1.1', password: 'Uttara#Gw2026!', note: '' }
const notes: VaultMeta = { kind: 'note', title: 'Meeting notes, 28 Oct', text: 'Uttara rollout moves to 12 Nov. Need 6 more gateways.' }
const dash: VaultMeta = { kind: 'link', title: 'Uttara dashboard', url: 'https://grafana.southerniot.net/d/uttara', note: 'Live readings.' }
const cv: VaultMeta = { kind: 'file', name: 'Ayman-CV-2026.pdf', mime: 'application/pdf', size: 1.2 * 1024 ** 2, prefix: 'AAAAAAAAAAA=' }

let base: { srv: ReturnType<typeof fakeVault>; wrapped: string }

/** One real setup (PBKDF2 is slow), then each test opens its own store on a copy of that vault. */
beforeAll(async () => {
  const srv = fakeVault()
  const env = new EventTarget()
  const s = new VaultStore({ api: srv.api as never, env, channel: null })
  env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: 1 } }))
  await s.load()
  await s.setup(PW)
  base = { srv, wrapped: srv.peek()!.wrapped_key }
})

async function opened(items: VaultMeta[] = [router, notes, dash, cv]) {
  base.srv.items.clear()
  const env = new EventTarget()
  const store = new VaultStore({ api: base.srv.api as never, env, channel: null })
  env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: 1 } }))
  await store.load()
  await store.unlock(PW)
  for (const m of items) await store.add(m)
  render(<VaultOpen store={store} onDownload={vi.fn()} onAddFiles={vi.fn()} />)
  return store
}

afterEach(() => vi.restoreAllMocks())

describe('the open vault', () => {
  it('renders the head, groups and cards like the mockup', async () => {
    await opened()
    expect(screen.getByText('Encrypted, only you can see this')).toBeInTheDocument()
    expect(screen.getByText('Locks itself after 20 minutes without activity')).toBeInTheDocument()
    expect(document.querySelector('.q-foot')?.textContent).toMatch(/of 200 MB used/)
    expect([...document.querySelectorAll('.vgroup')].map((g) => g.textContent)).toEqual(['Passwords', 'Notes and links', 'Files'])
    const pw = document.querySelector('.vcard.pw')!
    expect(pw).toHaveTextContent('Office router admin')
    expect(pw).toHaveTextContent('admin · 192.168.1.1')
    expect(pw.querySelector('.dots')).toHaveTextContent('••••••••••••')
    expect(screen.getByText('Meeting notes, 28 Oct').closest('.vcard')?.querySelector('.snippet')).toHaveTextContent('Uttara rollout')
    expect(screen.getByText('Ayman-CV-2026.pdf').closest('.item')?.querySelector('.meta')).toHaveTextContent(/^1.2 MB · added /)
  })

  it('a link opens from its title only, in a new tab without opener', async () => {
    await opened()
    const a = screen.getByRole('link', { name: /Uttara dashboard/ })
    expect(a).toHaveAttribute('href', 'https://grafana.southerniot.net/d/uttara')
    expect(a).toHaveAttribute('target', '_blank')
    expect(a).toHaveAttribute('rel', 'noopener noreferrer')
    expect(a.closest('.vcard')?.tagName).toBe('DIV')
  })

  it('reveals and copies a password', async () => {
    await opened([router])
    const copy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true)
    const show = screen.getByRole('button', { name: 'Show password' })
    await userEvent.click(show)
    expect(show).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('.dots')).toHaveTextContent('Uttara#Gw2026!')
    await userEvent.click(screen.getByRole('button', { name: 'Copy password' }))
    expect(copy).toHaveBeenCalledWith('Uttara#Gw2026!')
  })

  it('filters by kind', async () => {
    await opened()
    await userEvent.click(screen.getByRole('tab', { name: 'Links' }))
    expect(screen.getByText('Uttara dashboard ↗')).toBeInTheDocument()
    expect(screen.queryByText('Office router admin')).toBeNull()
    expect(screen.queryByText('Meeting notes, 28 Oct')).toBeNull()
  })

  it('shows the empty state', async () => {
    await opened([])
    expect(screen.getByText('Nothing saved yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add the first one' })).toBeInTheDocument()
  })

  it('full storage: red bar, Full, and Add off with the reason', async () => {
    const store = await opened([notes])
    act(() => store.forcePatchForTest({ usedBytes: 209715200 }))
    expect(document.querySelector('.q-bar')).toHaveClass('full')
    expect(screen.getByText('Full')).toHaveClass('full-tag')
    expect(screen.getByText('Delete something to add more')).toBeInTheDocument()
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    expect(add).toHaveAttribute('title', 'My storage is full. Delete something to add more.')
  })

  it('every field is text, never markup', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    await opened([
      { kind: 'note', title: evil, text: evil },
      { kind: 'password', title: evil, username: evil, url: evil, password: evil, note: evil },
      { kind: 'link', title: evil, url: 'https://x.io', note: evil },
      { kind: 'link', title: 'bad', url: 'javascript:alert(1)', note: '' },
    ])
    expect(document.querySelector('[onerror]')).toBeNull()
    expect(document.querySelector('a[href^="javascript"]')).toBeNull()
    expect(screen.getAllByText(/<img src=x/).length).toBeGreaterThan(0)
  })
})

describe('menus and delete', () => {
  it('⋯ Delete asks inline, then deletes', async () => {
    const store = await opened([notes])
    const card = screen.getByText('Meeting notes, 28 Oct').closest('.vcard') as HTMLElement
    await userEvent.click(within(card).getByRole('button', { name: 'More' }))
    await userEvent.click(within(card).getByRole('menuitem', { name: 'Delete' }))
    expect(store.snapshot().items).toHaveLength(1)
    await userEvent.click(within(card).getByRole('button', { name: 'Delete?' }))
    await waitFor(() => expect(store.snapshot().items).toHaveLength(0))
  })

  it('the menu closes on Escape and gives focus back', async () => {
    await opened([notes])
    const more = screen.getByRole('button', { name: 'More' })
    await userEvent.click(more)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(more).toHaveFocus()
  })
})

describe('forms', () => {
  it('note: empty → error; the title defaults to the first line', async () => {
    const store = await opened([])
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Note' }))
    const dialog = screen.getByRole('dialog', { name: 'New note' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByText('Write something before saving.')).toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText('Note'), 'Buy 6 gateways{Enter}before Friday')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(store.snapshot().items[0]?.meta).toMatchObject({ kind: 'note', title: 'Buy 6 gateways' }))
  })

  it('link: a bad address is refused; a bare host is saved as https', async () => {
    const store = await opened([])
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Link' }))
    const dialog = screen.getByRole('dialog', { name: 'New link' })
    await userEvent.type(within(dialog).getByLabelText('Address'), 'grafana southerniot')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByText("That isn't a web address. Example: grafana.southerniot.net")).toBeInTheDocument()
    await userEvent.clear(within(dialog).getByLabelText('Address'))
    await userEvent.type(within(dialog).getByLabelText('Address'), ' grafana.southerniot.net ')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(store.snapshot().items[0]?.meta).toMatchObject({ url: 'https://grafana.southerniot.net', title: 'grafana.southerniot.net' }))
  })

  it('password: Generate fills 20 characters; Edit saves a new version', async () => {
    const store = await opened([router])
    const card = document.querySelector('.vcard.pw') as HTMLElement
    await userEvent.click(within(card).getByRole('button', { name: 'More' }))
    await userEvent.click(within(card).getByRole('menuitem', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit password' })
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Office router admin')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }))
    expect((within(dialog).getByLabelText('Password') as HTMLInputElement).value).toHaveLength(20)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(store.snapshot().items[0]?.version).toBe(2))
  })

  it('a stale save keeps the form open with the text and says why', async () => {
    const store = await opened([notes])
    const card = screen.getByText('Meeting notes, 28 Oct').closest('.vcard') as HTMLElement
    await userEvent.click(within(card).getByRole('button', { name: 'More' }))
    await userEvent.click(within(card).getByRole('menuitem', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit note' })
    const id = store.snapshot().items[0].id
    const row = base.srv.items.get(id)!
    base.srv.items.set(id, { ...row, version: row.version + 1 }) // another tab saved first
    await userEvent.type(within(dialog).getByLabelText('Note'), ' and more')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Changed in another tab — reloaded.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Edit note' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Note')).toHaveValue(notes.kind === 'note' ? notes.text + ' and more' : '')
  })
})

describe('helpers', () => {
  it('normalizeUrl', () => {
    expect(normalizeUrl('grafana.southerniot.net')).toBe('https://grafana.southerniot.net')
    expect(normalizeUrl('HTTP://Example.com/a')).toBe('http://example.com/a')
    expect(normalizeUrl('192.168.1.1:8080')).toBe('https://192.168.1.1:8080')
    expect(normalizeUrl('  www.x.io  ')).toBe('https://www.x.io')
    expect(normalizeUrl('grafana southerniot')).toBeNull()
    expect(normalizeUrl('//evil.io')).toBeNull()
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('ftp://x.io')).toBeNull()
    expect(normalizeUrl('localhost')).toBeNull()
  })

  it('generatePassword: 20 characters from the set', () => {
    const p = generatePassword()
    expect(p).toHaveLength(20)
    expect(p).toMatch(/^[A-Za-z0-9!@#$%^&*\-_=+]{20}$/)
    expect(generatePassword()).not.toBe(p)
  })
})

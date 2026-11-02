import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as clipboard from '../../lib/clipboard'
import { ayman, fakeApi, json } from '../../test/http'
import { mkItem } from '../../test/items'
import { ItemCard } from './ItemCard'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function card(item = mkItem('a'), handlers = { onRemoved: vi.fn(), onToast: vi.fn() }) {
  const view = render(<ItemCard item={item} me={ayman} {...handlers} />)
  return { ...view, ...handlers }
}

const textItem = (over = {}) => mkItem('t1', { kind: 'text', name: 'Notes', mime: 'text/plain', size: 0, text_body: 'hello', line_count: 1, ...over })

describe('ItemCard: safety', () => {
  it('renders hostile text as text; only the http link is a link', () => {
    const { container } = card(textItem({ text_body: '<script>alert(1)</script> javascript:alert(1) <a href="x">y</a> https://ok.io/x.' }))
    const links = container.querySelectorAll('.preview a')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://ok.io/x')
    expect(container.innerHTML).not.toContain('<script')
    expect(container.querySelector('.preview')?.textContent).toContain('<script>alert(1)</script>')
  })

  it('never turns names or usernames into markup', () => {
    const evil = '<img src=x onerror=alert(1)>'
    const { container } = card(mkItem('a', { name: evil, sender: { id: 9, username: evil } }))
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(screen.getAllByText(new RegExp(evil.replace(/[()]/g, '\\$&'))).length).toBeGreaterThan(0)
  })

  it('every new-tab link has rel="noopener noreferrer"', () => {
    const { container } = card(textItem({ text_body: 'https://a.io www.b.io' }))
    const pdf = render(<ItemCard item={mkItem('p', { name: 'r.pdf', mime: 'application/pdf' })} me={ayman} onRemoved={vi.fn()} onToast={vi.fn()} />)
    const anchors = [...container.querySelectorAll('a[target="_blank"]'), ...pdf.container.querySelectorAll('a[target="_blank"]')]
    expect(anchors.length).toBe(3)
    for (const a of anchors) expect(a).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('ItemCard: text', () => {
  it('"Show all" loads the full text', async () => {
    fakeApi({ 'GET /api/items/t1': () => json(200, textItem({ text_body: 'full text\n'.repeat(120), text_truncated: false })) })
    card(textItem({ text_body: 'part', text_truncated: true, line_count: 120 }))
    await userEvent.click(screen.getByRole('button', { name: 'Show all 120 lines' }))
    await waitFor(() => expect(document.querySelector('.preview')?.textContent).toContain('full text\nfull text'))
    expect(document.querySelector('.preview')).not.toHaveClass('clamp')
  })

  it('Copy copies the full text even when the list only has a preview', async () => {
    fakeApi({ 'GET /api/items/t1': () => json(200, textItem({ text_body: 'the whole thing', text_truncated: false })) })
    const copy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true)
    card(textItem({ text_body: 'the who', text_truncated: true }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith('the whole thing'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toHaveClass('copied')
  })

  it('says so when copying fails', async () => {
    vi.spyOn(clipboard, 'copyText').mockResolvedValue(false)
    const { onToast } = card(textItem())
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Copy failed — select the text'))
  })

  it('folds after 4 lines', () => {
    card(textItem({ text_body: '1\n2\n3\n4\n5', line_count: 5 }))
    expect(document.querySelector('.preview')).toHaveClass('clamp')
    expect(screen.getByRole('button', { name: 'Show all 5 lines' })).toBeInTheDocument()
    expect(screen.getByText(/· 5 lines/)).toBeInTheDocument()
  })

  it('a 404 on "Show all" removes the card quietly', async () => {
    fakeApi({ 'GET /api/items/t1': () => json(404, { detail: 'not_found' }) })
    const { onRemoved } = card(textItem({ text_truncated: true, line_count: 9 }))
    await userEvent.click(screen.getByRole('button', { name: 'Show all 9 lines' }))
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('t1'))
  })
})

describe('ItemCard: delete', () => {
  it('asks inline; a second click within 4 s deletes', async () => {
    const f = fakeApi({ 'DELETE /api/items/a': () => json(204) })
    const { onRemoved } = card()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(f).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Delete?' }))
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('a'))
    expect(f.mock.calls[0][1]?.method).toBe('DELETE')
  })

  it('goes back to the bin after 4 s', async () => {
    vi.useFakeTimers()
    card()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('button', { name: 'Delete?' })).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('a 404 on delete removes the card quietly', async () => {
    fakeApi({ 'DELETE /api/items/a': () => json(404, { detail: 'not_found' }) })
    const { onRemoved, onToast } = card()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete?' }))
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('a'))
    expect(onToast).not.toHaveBeenCalled()
  })
})

describe('ItemCard: files', () => {
  it('a PDF opens in a new tab', () => {
    card(mkItem('p 1', { name: 'Site-Survey-Report.pdf', mime: 'application/pdf' }))
    const link = screen.getByRole('link', { name: 'Site-Survey-Report.pdf' })
    expect(link).toHaveAttribute('href', '/api/items/p%201/download?inline=1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByText('Open in new tab')).toBeInTheDocument()
    expect(document.querySelector('.item')).toHaveClass('openable')
  })

  it('a photo has a thumbnail and peek, and opens full screen; Escape closes', async () => {
    const { container } = card(mkItem('ph', { name: 'rack.jpg', mime: 'image/jpeg', size: 4.1 * 1024 ** 2 }))
    expect(container.querySelector('.item')).toHaveClass('photo')
    expect(container.querySelector('img.thumb')).toHaveAttribute('src', '/api/items/ph/download?inline=1')
    expect(container.querySelector('.peek img')).toHaveAttribute('loading', 'lazy')
    await userEvent.click(within(container.querySelector('.row') as HTMLElement).getByText('rack.jpg'))
    const box = screen.getByRole('dialog', { name: 'rack.jpg' })
    expect(box.querySelector('img')).toHaveAttribute('src', '/api/items/ph/download?inline=1')
    expect(screen.getByText('rack.jpg · 4.1 MB')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a video plays inline', async () => {
    card(mkItem('v', { name: 'drone.mp4', mime: 'video/mp4' }))
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(document.querySelector('video')).toHaveAttribute('src', '/api/items/v/download?inline=1')
  })

  it('Download checks the item still exists; a 404 removes the card', async () => {
    fakeApi({ 'GET /api/items/a': () => json(404, { detail: 'not_found' }) })
    const { onRemoved } = card()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('a'))
  })

  it('names many recipients as two plus "+N" with the rest in a tooltip', () => {
    const recipients = ['rahim', 'nusrat', 'tanvir', 'tasnim', 'arif'].map((u, i) => ({ id: 10 + i, username: u }))
    card(mkItem('q', { sender: { id: 1, username: 'ayman' }, recipients, size: 3.1 * 1024 ** 2 }))
    expect(screen.getByText('you')).toBeInTheDocument()
    expect(screen.getByText(/to rahim, nusrat/)).toBeInTheDocument()
    expect(screen.getByText('+3')).toHaveAttribute('title', 'tanvir, tasnim, arif')
  })

  it('warns in amber when it expires within 3 days', () => {
    card(mkItem('e', { expires_at: new Date(Date.now() + 1.5 * 86_400_000).toISOString() }))
    expect(screen.getByText('expires in 2 days')).toHaveClass('soon')
  })
})

describe('ItemCard: folders', () => {
  it('expands to its files, each downloadable; Download all is the zip', async () => {
    fakeApi({
      'GET /api/items/f': () => json(200, mkItem('f', { kind: 'folder' })),
      'GET /api/items/f/entries': () => json(200, [
        { id: 'e1', relative_path: 'app.hex', size: 3 },
        { id: 'e2', relative_path: 'config/gw.json', size: 4 },
      ]),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    card(mkItem('f', { kind: 'folder', name: 'firmware-v3.2', mime: 'inode/directory', file_count: 2, size: 7 }))
    expect(screen.getByText(/2 files/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show files' }))
    const entry = await screen.findByRole('link', { name: 'config/gw.json ↓' })
    expect(entry).toHaveAttribute('href', '/api/items/f/entries/e2/download')
    await userEvent.click(screen.getByRole('button', { name: 'Download all' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect((click.mock.contexts[0] as HTMLAnchorElement).getAttribute('href')).toBe('/api/items/f/zip')
  })
})

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as urls from '../sharing/urls'
import { Corrupt } from './crypto'
import { fakeVault } from './fakeVault'
import { PhotoGrid } from './PhotoGrid'
import { VaultStore, type DecryptedItem } from './store'

const photo = (id: string, mime = 'image/png', thumb: string | null = 'AAEC'): DecryptedItem => ({
  id, meta_ct: 'x', blob_id: 'b'.repeat(32), size_bytes: 10, version: 1, created_at: '', updated_at: '',
  meta: { kind: 'photo', name: `${id}.png`, mime, size: 10, prefix: 'AAAAAAAAAAA=', ...(thumb ? { thumb } : {}) },
})

let made: string[]
let revoked: string[]
beforeEach(() => {
  made = []
  revoked = []
  let n = 0
  URL.createObjectURL = vi.fn(() => { const u = `blob:test/${++n}`; made.push(u); return u })
  URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u) })
})
afterEach(() => vi.restoreAllMocks())

function store() {
  return new VaultStore({ api: fakeVault().api as never, env: new EventTarget(), channel: null })
}

describe('PhotoGrid', () => {
  it('tiles show the decrypted thumbnail; a click opens the full photo in the viewer', async () => {
    const s = store()
    const open = vi.spyOn(s, 'openBlob').mockResolvedValue(new Blob(['img'], { type: 'image/png' }))
    const { container } = render(<PhotoGrid items={[photo('rack')]} store={s} onToast={vi.fn()} />)
    await waitFor(() => expect((container.querySelector('.ph') as HTMLElement).style.backgroundImage).toContain('blob:test/1'))
    await userEvent.click(screen.getByRole('button', { name: 'Open rack.png' }))
    const box = await screen.findByRole('dialog', { name: 'rack.png' })
    expect(box.querySelector('img')?.getAttribute('src')).toBe('blob:test/2')
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'rack' }), 'image/png')
  })

  it('a photo whose type is not a safe image opens as plain bytes, never as a document', async () => {
    const s = store()
    const open = vi.spyOn(s, 'openBlob').mockResolvedValue(new Blob(['x']))
    render(<PhotoGrid items={[photo('evil', 'image/svg+xml')]} store={s} onToast={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open evil.png' }))
    expect(open).toHaveBeenCalledWith(expect.anything(), 'application/octet-stream')
  })

  it('Download saves the decrypted file under its name, as plain bytes', async () => {
    const s = store()
    const open = vi.spyOn(s, 'openBlob').mockResolvedValue(new Blob(['x']))
    const start = vi.spyOn(urls, 'startDownload').mockImplementation(() => {})
    render(<PhotoGrid items={[photo('rack')]} store={s} onToast={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.stringMatching(/^blob:test\//), 'rack.png'))
    expect(open).toHaveBeenCalledWith(expect.anything(), 'application/octet-stream')
  })

  it("a damaged photo says it can't be decrypted", async () => {
    const s = store()
    vi.spyOn(s, 'openBlob').mockRejectedValue(new Corrupt('file'))
    const toast = vi.fn()
    render(<PhotoGrid items={[photo('rack')]} store={s} onToast={toast} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open rack.png' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith("This file can't be decrypted"))
  })

  it('unmounting (e.g. on lock) revokes every decrypted URL', async () => {
    const s = store()
    vi.spyOn(s, 'openBlob').mockResolvedValue(new Blob(['img']))
    const view = render(<PhotoGrid items={[photo('a'), photo('b', 'image/png', null)]} store={s} onToast={vi.fn()} />)
    await waitFor(() => expect(made.length).toBe(1)) // b has no thumbnail: a plain tile
    await userEvent.click(screen.getByRole('button', { name: 'Open a.png' }))
    await screen.findByRole('dialog')
    view.unmount()
    expect(revoked.sort()).toEqual(made.sort())
  })
})

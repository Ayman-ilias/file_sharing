import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ayman } from '../../test/http'
import { fakeServer, memoryStorage } from '../uploads/fakeServer'
import { Uploader } from '../uploads/Uploader'
import { fakeVault } from './fakeVault'
import { VaultStore } from './store'
import { VaultView } from './VaultView'

vi.setConfig({ testTimeout: 20_000 })
const own = { ...ayman, uses_shared_password: false }
let srv: ReturnType<typeof fakeVault>

beforeAll(async () => {
  srv = fakeVault()
  const env = new EventTarget()
  const s = new VaultStore({ api: srv.api as never, env, channel: null })
  env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: 1 } }))
  await s.load()
  await s.setup('storage-pass-123')
})

async function openVault(session = memoryStorage(), prep: (up: Uploader) => void = () => {}) {
  const env = new EventTarget()
  const store = new VaultStore({ api: srv.api as never, env, channel: null })
  env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: 1 } }))
  await store.load()
  await store.unlock('storage-pass-123')
  const up = new Uploader({ api: fakeServer().api, env: new EventTarget(), storage: memoryStorage(), session: memoryStorage(), online: () => true })
  prep(up)
  render(<VaultView me={own} store={store} uploader={up} session={session} onOpenProfile={vi.fn()} />)
  return { store, up, session }
}

afterEach(() => vi.restoreAllMocks())

describe('photos and files in the vault view', () => {
  it('Add → Photo opens a picker for images only; Add → File for anything', async () => {
    await openVault()
    const photoPicker = screen.getByLabelText('Choose photos') as HTMLInputElement
    const filePicker = screen.getByLabelText('Choose files') as HTMLInputElement
    expect(photoPicker.accept).toBe('image/png,image/jpeg,image/gif,image/webp')
    expect(filePicker.accept).toBe('')
    const click = vi.spyOn(photoPicker, 'click')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Photo' }))
    expect(click).toHaveBeenCalled()
  })

  it('not enough space: says how much is held by an unfinished upload, with Cancel it', async () => {
    const { store } = await openVault()
    store.forcePatchForTest({ usedBytes: 209715200 - 70_000, heldBytes: 5 * 1024 * 1024 })
    const release = vi.spyOn(srv.api, 'releaseHeld')
    await userEvent.upload(screen.getByLabelText('Choose files'), new File([new Uint8Array(20_000)], 'big.bin'))
    expect(await screen.findByText(/^Not enough space in My storage/)).toBeInTheDocument()
    expect(screen.getByText("5 MB is held by an upload that didn't finish.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel it' }))
    await waitFor(() => expect(release).toHaveBeenCalled())
  })

  it('shows only My storage uploads in its queue', async () => {
    await openVault(memoryStorage(), (up) => vi.spyOn(up, 'jobs').mockReturnValue([
      { id: 's', kind: 'file', name: 'shared.txt', size: 1, sent: 0, state: 'sending', canRetry: false, speed: 0, eta: null, vault: false },
      { id: 'v', kind: 'file', name: 'secret.pdf', size: 1, sent: 0, state: 'sending', canRetry: false, speed: 0, eta: null, vault: true },
    ]))
    expect(screen.getByText('secret.pdf')).toBeInTheDocument()
    expect(screen.queryByText('shared.txt')).toBeNull()
  })

  it('after a reload that cut an upload, says so once', async () => {
    const session = memoryStorage()
    session.setItem('fs.vault.unfinished', '1')
    await openVault(session)
    expect(await screen.findByText("1 upload to My storage didn't finish. Add it again.")).toBeInTheDocument()
    expect(session.getItem('fs.vault.unfinished')).toBeNull()
  })
})

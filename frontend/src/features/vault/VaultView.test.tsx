import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { ayman } from '../../test/http'
import { fakeVault } from './fakeVault'
import { VaultStore } from './store'
import { VaultView } from './VaultView'

vi.setConfig({ testTimeout: 20_000 }) // real PBKDF2 (600 000 rounds)

const PW = 'storage-pass-123'
const own = { ...ayman, uses_shared_password: false }

function make(srv = fakeVault()) {
  const env = new EventTarget()
  const store = new VaultStore({ api: srv.api as never, env, channel: null })
  env.dispatchEvent(new CustomEvent('fs:signed-in', { detail: { id: own.id } }))
  return { store, env, srv }
}

function view(store: VaultStore, me = own, onOpenProfile = vi.fn()) {
  render(<VaultView me={me} store={store} onOpenProfile={onOpenProfile} />)
  return onOpenProfile
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('setup', () => {
  it('asks for an own login password first while on the shared one', async () => {
    const { store } = make()
    const open = view(store, ayman)
    expect(await screen.findByText(/Set your own login password first/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Storage password')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Set your own login password' }))
    expect(open).toHaveBeenCalled()
  })

  it('the button stays off until both passwords are ≥ 10, equal, and the box is ticked', async () => {
    const { store } = make()
    view(store)
    const create = await screen.findByRole('button', { name: 'Create My storage' })
    await userEvent.type(screen.getByLabelText('Storage password'), 'short')
    expect(screen.getByText('Use at least 10 characters.')).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('Storage password'))
    await userEvent.type(screen.getByLabelText('Storage password'), PW)
    await userEvent.type(screen.getByLabelText('Repeat it'), PW + 'x')
    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument()
    expect(create).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Repeat it'))
    await userEvent.type(screen.getByLabelText('Repeat it'), PW)
    expect(create).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox'))
    expect(create).toBeEnabled()
  })

  it('creates the vault and opens it', async () => {
    const { store } = make()
    view(store)
    await userEvent.type(await screen.findByLabelText('Storage password'), PW)
    await userEvent.type(screen.getByLabelText('Repeat it'), PW)
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Create My storage' }))
    await waitFor(() => expect(store.snapshot().status).toBe('open'))
  })

  it('the server refusing (still on the shared password) shows the same gate', async () => {
    const { store, srv } = make()
    srv.api.setup.mockRejectedValueOnce(new ApiError(403, 'own_password_required'))
    view(store)
    await userEvent.type(await screen.findByLabelText('Storage password'), PW)
    await userEvent.type(screen.getByLabelText('Repeat it'), PW)
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Create My storage' }))
    expect(await screen.findByText(/Set your own login password first/)).toBeInTheDocument()
  })
})

describe('lock screen', () => {
  async function locked(reason: 'manual' | 'idle' = 'manual') {
    const t = make()
    await t.store.load()
    await t.store.setup(PW)
    t.store.lock(reason)
    return t
  }

  it('shows the honest text (no claim that the server admin can never read it)', async () => {
    const { store } = await locked()
    view(store)
    expect(screen.getByText(/so the database, backups and colleagues can't read them/)).toBeInTheDocument()
    expect(screen.getByText(/It can't protect you if the server itself is taken over/)).toBeInTheDocument()
    expect(screen.queryByText(/Not even the server admin/)).toBeNull()
  })

  it('a wrong password shows the message and clears the field', async () => {
    const { store } = await locked()
    view(store)
    const input = screen.getByLabelText('Storage password')
    await userEvent.type(input, 'wrong-wrong-wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByText('Wrong storage password.')).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('unlocks with the right password', async () => {
    const { store } = await locked()
    view(store)
    await userEvent.type(screen.getByLabelText('Storage password'), PW)
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(store.snapshot().status).toBe('open'))
  })

  it('an idle lock says why; a manual one does not', async () => {
    const idle = await locked('idle')
    const first = render(<VaultView me={own} store={idle.store} onOpenProfile={vi.fn()} />)
    expect(screen.getByText('Locked after 20 minutes without activity')).toBeInTheDocument()
    first.unmount()
    const manual = await locked('manual')
    view(manual.store)
    expect(screen.queryByText('Locked after 20 minutes without activity')).toBeNull()
  })
})

describe('erase', () => {
  it('needs exactly ERASE and the login password, then goes back to setup', async () => {
    const t = make()
    await t.store.load()
    await t.store.setup(PW)
    t.store.lock()
    view(t.store)
    await userEvent.click(screen.getByRole('button', { name: 'Erase My storage and start again' }))
    const dialog = screen.getByRole('dialog', { name: 'Erase My storage' })
    expect(dialog).toHaveTextContent("This permanently deletes everything in My storage")
    const go = screen.getByRole('button', { name: 'Erase and start again' })
    await userEvent.type(screen.getByLabelText('Your login password'), 'login-pass-123')
    await userEvent.type(screen.getByLabelText('Type ERASE to confirm'), 'ERAS')
    expect(go).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Type ERASE to confirm'), 'E')
    expect(go).toBeEnabled()
    await userEvent.click(go)
    await waitFor(() => expect(t.store.snapshot().status).toBe('setup'))
    expect(t.srv.api.erase).toHaveBeenCalledWith('login-pass-123')
  })

  it('a wrong login password says so and erases nothing', async () => {
    const t = make()
    await t.store.load()
    await t.store.setup(PW)
    t.store.lock()
    t.srv.api.erase.mockRejectedValueOnce(new ApiError(401, 'bad_credentials'))
    view(t.store)
    await userEvent.click(screen.getByRole('button', { name: 'Erase My storage and start again' }))
    await userEvent.type(screen.getByLabelText('Your login password'), 'nope')
    await userEvent.type(screen.getByLabelText('Type ERASE to confirm'), 'ERASE')
    await userEvent.click(screen.getByRole('button', { name: 'Erase and start again' }))
    expect(await screen.findByText('Login password is wrong.')).toBeInTheDocument()
    expect(t.store.snapshot().status).toBe('locked')
  })
})

describe('auto-lock warning', () => {
  it('appears in the last minute; Stay unlocked keeps it open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }) // before the store starts its tick
    const t = make()
    await t.store.load()
    await t.store.setup(PW)
    view(t.store)
    act(() => { vi.advanceTimersByTime(19 * 60_000 + 15_000) })
    expect(screen.getByRole('status')).toHaveTextContent("My storage locks in 60 s because you've been away.")
    fireEvent.click(screen.getByRole('button', { name: 'Stay unlocked' }))
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(screen.queryByRole('status')).toBeNull()
    expect(t.store.snapshot().status).toBe('open')
  })
})

it('says so when the page is not secure (no WebCrypto)', () => {
  const t = make()
  t.store.forceStatusForTest('unavailable')
  view(t.store)
  expect(screen.getByText('My storage needs a secure (https) connection.')).toBeInTheDocument()
})

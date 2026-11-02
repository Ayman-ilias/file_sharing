import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { ayman, fakeApi, globalMe, json } from './test/http'

afterEach(() => vi.restoreAllMocks())

const NUDGE = /still using the shared starting password/

describe('App shell', () => {
  it('shows the login page when signed out', async () => {
    fakeApi({ 'GET /api/auth/me': () => json(401, { detail: 'not_signed_in' }) })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Southern IoT Files' })).toBeInTheDocument()
  })

  it('a regular user sees both tabs, opens on Sharing, and sees the nudge', async () => {
    fakeApi({ 'GET /api/auth/me': () => json(200, ayman) })
    render(<App />)
    const sharing = await screen.findByRole('tab', { name: 'Sharing' })
    expect(sharing).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'My storage' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByText(NUDGE)).toBeInTheDocument()
    expect(screen.getByText('ayman@southerniot.net')).toBeInTheDocument()
    expect(screen.getByText('Everything shared here is deleted automatically after 30 days.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'My storage' }))
    expect(screen.getByRole('tab', { name: 'My storage' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText(NUDGE)).toBeNull() // the nudge belongs to the Sharing view
  })

  it('the global account sees only Sharing, no nudge, no password forms', async () => {
    fakeApi({ 'GET /api/auth/me': () => json(200, globalMe) })
    render(<App />)
    await screen.findByRole('tab', { name: 'Sharing' })
    expect(screen.queryByRole('tab', { name: 'My storage' })).toBeNull()
    expect(screen.queryByText(NUDGE)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /global@southerniot.net/ }))
    expect(screen.getByRole('dialog', { name: 'Profile' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Current password')).toBeNull()
    expect(screen.getByText(/sees only Global files/)).toBeInTheDocument()
  })

  it('a successful password change hides the nudge', async () => {
    let me = ayman
    fakeApi({
      'GET /api/auth/me': () => json(200, me),
      'POST /api/auth/password': () => { me = { ...ayman, uses_shared_password: false }; return json(204) },
    })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Set your own' }))
    await userEvent.type(screen.getByLabelText('Current password'), 'shared-start')
    await userEvent.type(screen.getByLabelText('New password'), 'a-long-new-password')
    await userEvent.type(screen.getByLabelText('Repeat new password'), 'a-long-new-password')
    await userEvent.click(screen.getByRole('button', { name: 'Change login password' }))
    expect(await screen.findByText('Login password changed. Other devices were signed out.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(NUDGE)).toBeNull())
  })

  it('logging out returns to the login page', async () => {
    fakeApi({ 'GET /api/auth/me': () => json(200, ayman), 'POST /api/auth/logout': () => json(204) })
    render(<App />)
    await userEvent.click(await screen.findByRole('link', { name: 'Log out' }))
    expect(await screen.findByRole('heading', { name: 'Southern IoT Files' })).toBeInTheDocument()
  })

  it('a session that ends by itself asks for the password over the page, then carries on', async () => {
    let signedIn = true
    fakeApi({
      'GET /api/auth/me': () => (signedIn ? json(200, ayman) : json(401, { detail: 'not_signed_in' })),
      'POST /api/auth/login': () => { signedIn = true; return json(200, ayman) },
    })
    render(<App />)
    await screen.findByRole('tab', { name: 'Sharing' })
    signedIn = false
    act(() => { window.dispatchEvent(new Event('fs:signed-out')) })
    expect(screen.getByRole('dialog', { name: 'Please sign in again' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Sharing' })).toBeInTheDocument() // the page stays
    await userEvent.type(screen.getByLabelText('Password for ayman@southerniot.net'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in and continue' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows the Private/Global lists under the send card', async () => {
    fakeApi({
      'GET /api/auth/me': () => json(200, ayman),
      'GET /api/items': () => json(200, { items: [], next: null }),
    })
    render(<App />)
    expect(await screen.findByText('Nothing private yet')).toBeInTheDocument()
  })
})

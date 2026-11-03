import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ayman, fakeApi, json } from '../../test/http'
import { ReSignIn } from './ReSignIn'

afterEach(() => vi.restoreAllMocks())

describe('ReSignIn', () => {
  it('asks for the password of the same account and says uploads wait', async () => {
    const f = fakeApi({ 'POST /api/auth/login': () => json(200, ayman) })
    const onSignedIn = vi.fn()
    render(<ReSignIn me={ayman} paused={2} onSignedIn={onSignedIn} />)
    expect(screen.getByRole('dialog', { name: 'Please sign in again' })).toBeInTheDocument()
    expect(screen.getByText('2 uploads are paused and will continue after you sign in.')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Password for ayman@southerniot.net'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in and continue' }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ email: 'ayman@southerniot.net', password: 'pw' })
  })

  it('words one or no paused uploads', () => {
    const { rerender } = render(<ReSignIn me={ayman} paused={1} onSignedIn={() => {}} />)
    expect(screen.getByText('1 upload is paused and will continue after you sign in.')).toBeInTheDocument()
    rerender(<ReSignIn me={ayman} paused={0} onSignedIn={() => {}} />)
    expect(screen.getByText('Your session ended. Sign in to carry on where you were.')).toBeInTheDocument()
  })

  it('shows a wrong password', async () => {
    fakeApi({ 'POST /api/auth/login': () => json(401, { detail: 'bad_credentials' }) })
    render(<ReSignIn me={ayman} paused={0} onSignedIn={() => {}} />)
    await userEvent.type(screen.getByLabelText(/Password for/), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in and continue' }))
    expect(await screen.findByText('Email or password is wrong.')).toBeInTheDocument()
  })

  it('lets someone else sign in instead', async () => {
    const onSwitchUser = vi.fn()
    render(<ReSignIn me={ayman} paused={0} onSignedIn={() => {}} onSwitchUser={onSwitchUser} />)
    await userEvent.click(screen.getByRole('button', { name: 'Sign in as someone else' }))
    expect(onSwitchUser).toHaveBeenCalled()
  })
})

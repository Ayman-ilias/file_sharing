import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'

const me = { id: 7, email: 'tanvir@southerniot.net', username: 'tanvir', is_global: false, uses_shared_password: true }
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

const emailBox = () => screen.getByLabelText('Email') as HTMLInputElement
const paste = (text: string) => fireEvent.change(emailBox(), { target: { value: text } })

describe('LoginPage', () => {
  it('keeps only the name when a company address is pasted', () => {
    render(<LoginPage onSignedIn={() => {}} />)
    paste('tanvir@southerniot.net')
    expect(emailBox().value).toBe('tanvir')
    expect(screen.queryByText(/Only @southerniot.net/)).toBeNull()
  })

  it('shows the domain error for another domain and does not send', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
    render(<LoginPage onSignedIn={() => {}} />)
    paste('x@gmail.com')
    expect(screen.getByText('Only @southerniot.net emails can register.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(f).not.toHaveBeenCalled()
  })

  it('registers, then signs in, calling the endpoints in order', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(201, { email: 'tanvir@southerniot.net', username: 'tanvir' }))
      .mockResolvedValueOnce(json(200, me))
    const onSignedIn = vi.fn()
    render(<LoginPage onSignedIn={onSignedIn} />)
    await userEvent.click(screen.getByRole('link', { name: 'Register' }))
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    await userEvent.type(emailBox(), 'Tanvir')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(
      'Account created for tanvir@southerniot.net. Sign in with the shared starting password, then set your own in Profile.',
    )).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Password'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(me))
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/auth/register', '/api/auth/login'])
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ email: 'tanvir@southerniot.net' })
    expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ email: 'tanvir@southerniot.net', password: 'pw' })
  })

  it.each([
    ['bad_credentials', 401, 'Email or password is wrong.'],
    ['too_many_attempts', 429, 'Too many tries. Wait a minute and try again.'],
    ['domain_not_allowed', 400, 'Only @southerniot.net emails can register.'],
  ])('maps %s to its sentence', async (detail, status, sentence) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(status, { detail }))
    render(<LoginPage onSignedIn={() => {}} />)
    await userEvent.type(emailBox(), 'tanvir')
    await userEvent.type(screen.getByLabelText('Password'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(sentence)).toBeInTheDocument()
  })

  it('says so when the server cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    render(<LoginPage onSignedIn={() => {}} />)
    await userEvent.type(emailBox(), 'tanvir')
    await userEvent.type(screen.getByLabelText('Password'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText("Can't reach the server. Check your connection.")).toBeInTheDocument()
  })
})

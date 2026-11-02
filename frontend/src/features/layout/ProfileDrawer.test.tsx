import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ayman, fakeApi, json } from '../../test/http'
import { ProfileDrawer } from './ProfileDrawer'

afterEach(() => vi.restoreAllMocks())

async function change(current: string, next: string, repeat = next) {
  await userEvent.type(screen.getByLabelText('Current password'), current)
  await userEvent.type(screen.getByLabelText('New password'), next)
  await userEvent.type(screen.getByLabelText('Repeat new password'), repeat)
  await userEvent.click(screen.getByRole('button', { name: 'Change login password' }))
}

describe('ProfileDrawer', () => {
  it.each([
    ['too_short', 'Use at least 10 characters.'],
    ['bad_credentials', 'Current password is wrong.'],
    ['same_as_shared', 'Choose a password that is not the shared starting password.'],
  ])('shows the message for %s', async (detail, sentence) => {
    fakeApi({ 'POST /api/auth/password': () => json(detail === 'bad_credentials' ? 401 : 400, { detail }) })
    render(<ProfileDrawer me={ayman} open onClose={() => {}} onChanged={() => {}} />)
    await change('old-password', 'new-password-123')
    expect(await screen.findByText(sentence)).toBeInTheDocument()
  })

  it('catches a mismatch and a short password before sending', async () => {
    const f = fakeApi({})
    render(<ProfileDrawer me={ayman} open onClose={() => {}} onChanged={() => {}} />)
    await change('old-password', 'new-password-123', 'new-password-124')
    expect(screen.getByText("The new passwords don't match.")).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('New password'))
    await userEvent.clear(screen.getByLabelText('Repeat new password'))
    await userEvent.type(screen.getByLabelText('New password'), 'short')
    await userEvent.type(screen.getByLabelText('Repeat new password'), 'short')
    await userEvent.click(screen.getByRole('button', { name: 'Change login password' }))
    expect(screen.getByText('Use at least 10 characters.')).toBeInTheDocument()
    expect(f).not.toHaveBeenCalled()
  })

  it('a wrong current password does not sign the user out', async () => {
    fakeApi({ 'POST /api/auth/password': () => json(401, { detail: 'bad_credentials' }) })
    const out = vi.fn()
    window.addEventListener('fs:signed-out', out)
    render(<ProfileDrawer me={ayman} open onClose={() => {}} onChanged={() => {}} />)
    await change('wrong-one', 'new-password-123')
    await screen.findByText('Current password is wrong.')
    window.removeEventListener('fs:signed-out', out)
    expect(out).not.toHaveBeenCalled()
  })

  it('closes on overlay click and on Escape, not on a click inside', async () => {
    const onClose = vi.fn()
    render(<ProfileDrawer me={ayman} open onClose={onClose} onChanged={() => {}} />)
    await userEvent.click(screen.getByRole('dialog', { name: 'Profile' }))
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('profile-overlay'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows the storage set-up link and no global note for a regular user', () => {
    render(<ProfileDrawer me={ayman} open onClose={() => {}} onChanged={() => {}} />)
    expect(screen.getByText("You haven't set up My storage yet.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up My storage' })).toBeInTheDocument()
    expect(screen.queryByText(/sees only Global files/)).toBeNull()
  })

  it('renders nothing when closed', () => {
    render(<ProfileDrawer me={ayman} open={false} onClose={() => {}} onChanged={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

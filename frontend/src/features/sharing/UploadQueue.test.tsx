import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Job } from '../uploads/Uploader'
import { UploadQueue } from './UploadQueue'

const GB = 1024 ** 3
const MB = 1024 ** 2
const base = { kind: 'file' as const, canRetry: false, speed: 0, eta: null }
const job = (j: Partial<Job> & Pick<Job, 'id' | 'name' | 'size' | 'sent' | 'state'>): Job => ({ ...base, ...j })

function show(jobs: Job[]) {
  const handlers = { onRetry: vi.fn(), onCancel: vi.fn(), onDismiss: vi.fn() }
  render(<UploadQueue jobs={jobs} {...handlers} />)
  return handlers
}

describe('UploadQueue', () => {
  it('shows %, "x of y", speed and time left while sending', () => {
    show([job({ id: 'a', name: 'site-walkthrough-4k.mp4', size: 1.8 * GB, sent: 1.04 * GB, state: 'sending', speed: 84.7 * MB, eta: 9 })])
    expect(screen.getByText('58%')).toBeInTheDocument()
    expect(screen.getByText('1.04 GB of 1.80 GB')).toBeInTheDocument()
    expect(screen.getByText('84.7 MB/s · 9 s left')).toBeInTheDocument()
    expect(document.querySelector('.track i')).toHaveStyle('--p: 0.578')
  })

  it('words longer times in minutes and hours', () => {
    show([
      job({ id: 'a', name: 'a', size: 10, sent: 1, state: 'sending', speed: 2 * MB, eta: 130 }),
      job({ id: 'b', name: 'b', size: 10, sent: 1, state: 'sending', speed: 2 * MB, eta: 3900 }),
    ])
    expect(screen.getByText('2 MB/s · 3 min left')).toBeInTheDocument()
    expect(screen.getByText('2 MB/s · 1 h 5 min left')).toBeInTheDocument()
  })

  it('a network failure offers Retry and says what is kept', async () => {
    const h = show([job({ id: 'a', name: 'site.mp4', size: 1.8 * GB, sent: 0.76 * GB, state: 'failed', reason: 'network', canRetry: true })])
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('0.76 GB of 1.80 GB kept, so Retry continues from there')).toBeInTheDocument()
    expect(screen.getByText("Server didn't answer")).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(h.onRetry).toHaveBeenCalledWith('a')
  })

  it.each([
    ['too_large', 12.4 * GB, 'Too large', '12.4 GB. The limit is 10 GB per file'],
    ['disk_full', MB, 'Server full', 'The server is low on space. Ask the admin, or try later'],
    ['upload_quota', MB, 'Too many uploads', 'You have too many unfinished uploads. Let some finish, then try again'],
    ['file_changed', MB, 'Failed', 'File changed or moved — choose it again'],
  ] as const)('%s fails without Retry', (reason, size, label, sentence) => {
    show([job({ id: 'a', name: 'x', size, sent: 0, state: 'failed', reason })])
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText(sentence)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('a paused row says why and keeps the %', () => {
    show([
      job({ id: 'a', name: 'survey-data.zip', size: 100, sent: 71, state: 'paused', reason: 'offline' }),
      job({ id: 'b', name: 'b.zip', size: 100, sent: 10, state: 'paused', reason: 'signed_out' }),
    ])
    expect(screen.getByText("You're offline. It continues by itself when you're back")).toBeInTheDocument()
    expect(screen.getByText('71%')).toBeInTheDocument()
    expect(screen.getByText('Signed out. It continues after you sign in again')).toBeInTheDocument()
  })

  it('an interrupted row asks for the file again', () => {
    show([job({ id: 'a', name: 'report.pdf', size: MB, sent: 0, state: 'failed', reason: 'interrupted' })])
    expect(screen.getByText('Interrupted — choose the file again to continue')).toBeInTheDocument()
  })

  it('a finished file says Sent and to whom', () => {
    show([job({ id: 'a', name: 'BOQ-final.xlsx', size: 2.3 * MB, sent: 2.3 * MB, state: 'done', item: {
      id: 'i', kind: 'file', name: 'BOQ-final.xlsx', size: 1, mime: '', sender: { id: 1, username: 'ayman' },
      recipients: [{ id: 5, username: 'rahim' }, { id: 6, username: 'nusrat' }], is_global: false, text_body: null,
      text_truncated: false, line_count: null, file_count: null, created_at: '', expires_at: '',
    } })])
    expect(screen.getByText('Sent')).toBeInTheDocument()
    expect(screen.getByText('2.3 MB')).toBeInTheDocument()
    expect(screen.getByText('to rahim, nusrat')).toBeInTheDocument()
  })

  it('a folder is one row with a file count; it expands to failed files only', async () => {
    show([job({ id: 'f', kind: 'folder', name: 'photos', size: 100 * MB, sent: 30 * MB, state: 'sending', speed: 38 * MB, eta: 120,
      files: { total: 5000, done: 1204, failed: [{ path: 'raw/a.cr2', reason: 'disk_full' }] } })])
    expect(screen.getByText('1,204 of 5,000 files')).toBeInTheDocument()
    expect(screen.getByText('38 MB/s · 2 min left')).toBeInTheDocument()
    expect(screen.queryByText('raw/a.cr2')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show failed files' }))
    expect(screen.getByText('raw/a.cr2')).toBeInTheDocument()
  })

  it('a finished folder with failures says Done · N failed with Retry', async () => {
    const h = show([job({ id: 'f', kind: 'folder', name: 'photos', size: 10, sent: 9, state: 'done',
      files: { total: 3, done: 2, failed: [{ path: 'b.txt', reason: 'network' }] } })])
    expect(screen.getByText('Done · 1 failed')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(h.onRetry).toHaveBeenCalledWith('f')
  })

  it('cancel and dismiss go to the right handler', async () => {
    const h = show([
      job({ id: 'a', name: 'a', size: 10, sent: 1, state: 'sending' }),
      job({ id: 'b', name: 'b', size: 10, sent: 0, state: 'failed', reason: 'too_large' }),
    ])
    const [cancel, dismiss] = screen.getAllByRole('button', { name: /Cancel|Remove/ })
    await userEvent.click(cancel)
    await userEvent.click(dismiss)
    expect(h.onCancel).toHaveBeenCalledWith('a')
    expect(h.onDismiss).toHaveBeenCalledWith('b')
  })

  it('renders names as plain text', () => {
    show([job({ id: 'a', name: '<img src=x onerror=alert(1)>', size: 1, sent: 0, state: 'queued' })])
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})

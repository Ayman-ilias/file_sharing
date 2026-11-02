import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('uses the Clipboard API in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('isSecureContext', true)
    expect(await copyText('hello')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to a hidden textarea on plain http (LAN IP)', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('isSecureContext', false)
    let copied = ''
    document.execCommand = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement).value
      return true
    })
    expect(await copyText('line 1\nline 2')).toBe(true)
    expect(copied).toBe('line 1\nline 2')
    expect(document.querySelector('textarea')).toBeNull() // cleaned up
  })

  it('reports failure when both ways fail', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    vi.stubGlobal('isSecureContext', true)
    document.execCommand = vi.fn(() => false)
    expect(await copyText('x')).toBe(false)
  })
})

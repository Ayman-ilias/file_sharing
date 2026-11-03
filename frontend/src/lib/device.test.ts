import { afterEach, describe, expect, it, vi } from 'vitest'
import { supportsFolderPick } from './device'

afterEach(() => vi.restoreAllMocks())

describe('supportsFolderPick', () => {
  it('is true when inputs know webkitdirectory', () => {
    expect(supportsFolderPick()).toBe('webkitdirectory' in document.createElement('input'))
  })

  it('is false when the browser (iPhone) has no webkitdirectory', () => {
    const real = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'input' ? ({} as HTMLInputElement) : real(tag))
    expect(supportsFolderPick()).toBe(false)
  })
})

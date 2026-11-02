import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Background } from './Background'

function media(matches: Record<string, boolean>) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: matches[q] ?? false, media: q, addEventListener() {}, removeEventListener() {},
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('Background', () => {
  it('draws the gradient blobs and 15 bubbles on a desktop', () => {
    media({ '(hover: hover) and (min-width: 641px)': true })
    const { container } = render(<Background />)
    expect(container.querySelectorAll('.bg i')).toHaveLength(4)
    expect(container.querySelectorAll('.bubbles span')).toHaveLength(15)
  })

  it('has no bubbles under reduced motion', () => {
    media({ '(hover: hover) and (min-width: 641px)': true, '(prefers-reduced-motion: reduce)': true })
    const { container } = render(<Background />)
    expect(container.querySelectorAll('.bubbles span')).toHaveLength(0)
  })

  it('has no bubbles on a phone', () => {
    media({})
    const { container } = render(<Background />)
    expect(container.querySelectorAll('.bubbles span')).toHaveLength(0)
  })
})

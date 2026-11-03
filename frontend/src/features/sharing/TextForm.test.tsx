import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TextForm } from './TextForm'

describe('TextForm', () => {
  it('counts characters, not UTF-16 units (an emoji is one)', () => {
    render(<TextForm title="" body={'ab😀'} onTitle={() => {}} onBody={() => {}} />)
    expect(screen.getByText('3 characters')).toBeInTheDocument()
  })

  it('does not encode the text when it cannot be over 1 MiB', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    render(<TextForm title="" body={'x'.repeat(300_000)} onTitle={() => {}} onBody={() => {}} />)
    expect(encode).not.toHaveBeenCalled()
    encode.mockRestore()
  })
})

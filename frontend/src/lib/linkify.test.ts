import { describe, expect, it } from 'vitest'
import { linkify } from './linkify'

const links = (text: string) =>
  linkify(text).filter((p): p is { href: string; text: string } => typeof p !== 'string')

describe('linkify', () => {
  it('links http, https and www, keeping the rest as text', () => {
    expect(linkify('see https://a.io/x and www.b.com now')).toEqual([
      'see ', { href: 'https://a.io/x', text: 'https://a.io/x' }, ' and ',
      { href: 'https://www.b.com', text: 'www.b.com' }, ' now',
    ])
  })

  it('leaves trailing punctuation out', () => {
    expect(links('(see http://x.y/path).')[0].href).toBe('http://x.y/path')
    for (const p of ['.', ',', ')', '!', '?']) expect(links(`go http://x.y/a${p}`)[0].href).toBe('http://x.y/a')
  })

  it('keeps balanced brackets that are part of the address', () => {
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')[0].href).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })

  it('never links javascript: or data: addresses', () => {
    expect(links('javascript:alert(1) data:text/html,<script>alert(1)</script>')).toEqual([])
    expect(links('javascript://www.evil.com/%0aalert(1)')).toEqual([])
  })

  it('keeps HTML as plain text and only ever yields http(s) hrefs', () => {
    const parts = linkify('<a href="http://evil.io" onclick="x()">x</a>')
    expect(parts.filter((p) => typeof p === 'string').join('')).toContain('<a href="')
    for (const l of links('<a href="http://evil.io">x</a> <img src=x onerror=alert(1)>')) {
      expect(l.href).toMatch(/^https?:\/\//)
      expect(l.href).not.toMatch(/["<>]/)
    }
  })

  it('does not link a bare scheme or a word that only contains it', () => {
    expect(links('http:// and xhttp://a.b')).toEqual([])
  })

  it('returns the text unchanged when there is no link', () => {
    expect(linkify('plain text')).toEqual(['plain text'])
    expect(linkify('')).toEqual([])
  })
})

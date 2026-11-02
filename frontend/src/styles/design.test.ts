// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, test } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

describe('the design CSS is copied from the approved mockup', () => {
  test('app.css carries the mockup styles', () => {
    const css = read('frontend/src/styles/app.css')
    for (const needle of ['.seg-btn', '.top-tabs', '.vault-lock', '.peek', '--navy: #303289']) {
      expect(css).toContain(needle)
    }
  })

  test('states.css carries the extra component styles but not the gallery frame', () => {
    const css = read('frontend/src/styles/states.css')
    for (const needle of ['.menu', '.dd', '.skel', '.lightbox']) expect(css).toContain(needle)
    expect(css).not.toMatch(/\.gal\s*\{/)
  })

  test('every icon used by the design exists in the sprite', () => {
    const used = new Set<string>()
    for (const f of ['docs/design/mockup.html', 'docs/design/states.html']) {
      for (const m of read(f).matchAll(/href="#(i-[a-z0-9]+)"/g)) used.add(m[1])
    }
    const sprite = read('frontend/index.html') // the sprite lives in index.html (static, no innerHTML)
    const missing = [...used].filter((id) => !sprite.includes(`id="${id}"`))
    expect(used.size).toBeGreaterThan(10)
    expect(missing).toEqual([])
  })
})

describe('extra.css (rules the static mockup cannot show)', () => {
  const extra = readFileSync(resolve(import.meta.dirname, 'extra.css'), 'utf8')

  it('only adds touch and focus behaviour, never restyles the design', () => {
    const selectors = [...extra.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map((m) => m[1].trim()).filter((s) => !s.startsWith('@media'))
    expect(selectors.sort()).toEqual([
      '.drop:focus-visible, .inside [role="button"]:focus-visible', '.item.photo .peek', '.opens',
      '.phw .ph-act', '.phw:hover .ph-act, .phw:focus-within .ph-act', '.phw .ph-act',
    ].sort())
  })

  it('shows hover-only hints on touch screens', () => {
    expect(extra).toMatch(/@media \(hover: none\)\s*\{[^}]*\.opens\s*\{\s*opacity:\s*1/)
  })

  it('photo actions show on hover or focus only; on touch the tap opens the viewer instead', () => {
    expect(extra).toMatch(/\.phw \.ph-act \{[^}]*opacity: 0/)
    const touch = extra.slice(extra.indexOf('@media (hover: none)'), extra.indexOf('\n}', extra.indexOf('@media (hover: none)')))
    expect(touch).toContain('.phw .ph-act { display: none; }')
  })
})


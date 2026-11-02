// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

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

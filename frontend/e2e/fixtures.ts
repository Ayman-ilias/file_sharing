import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

export const ROOT = resolve(import.meta.dirname, '../..')
export const MOCKUP = `file://${ROOT}/docs/design/mockup.html`
const FONTS = resolve(import.meta.dirname, '../public/fonts')

/** Both pages get the same local Inter: the mockup's Google Fonts link is answered from disk. */
export async function localFonts(page: Page) {
  const css = readFileSync(`${FONTS}/inter.css`, 'utf8').replaceAll('url(/fonts/', 'url(https://fonts.gstatic.com/local/')
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: css }))
  await page.route('https://fonts.gstatic.com/local/**', (r) =>
    r.fulfill({ contentType: 'font/woff2', body: readFileSync(`${FONTS}/${r.request().url().split('/').pop()}`) }))
}

/** No motion: drop the bubbles and the drifting gradient blobs, wait for fonts. */
export async function settle(page: Page) {
  await page.evaluate(async () => {
    document.querySelectorAll('.bubbles > *, .bg i').forEach((n) => n.remove())
    // the fixed gradient stretches with the page height during tall element captures, and the two
    // pages differ in length: paint it one flat colour in both (app.css is pinned verbatim anyway)
    const bg = document.querySelector<HTMLElement>('.bg')
    if (bg) bg.style.background = '#303289'
    ;(document.activeElement as HTMLElement | null)?.blur()
    await document.fonts.ready
  })
}

/** Share of differing pixels between two screenshots (size differences count as different). */
export function difference(a: Buffer, b: Buffer, diffPath?: string): number {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  const w = Math.max(pa.width, pb.width)
  const h = Math.max(pa.height, pb.height)
  const pad = (p: PNG) => {
    const out = new PNG({ width: w, height: h })
    out.data.fill(0)
    PNG.bitblt(p, out, 0, 0, p.width, p.height, 0, 0)
    return out
  }
  const A = pad(pa)
  const B = pad(pb)
  const diff = new PNG({ width: w, height: h })
  const n = pixelmatch(A.data, B.data, diff.data, w, h, { threshold: 0.1 })
  if (diffPath) writeFileSync(diffPath, PNG.sync.write(diff))
  return n / (w * h)
}

export async function shot(target: Locator, clipHeight?: number): Promise<Buffer> {
  // a capture taller than the viewport is stitched from tiles and the fixed background breaks
  // between them: make the viewport tall enough for the whole element first
  const page = target.page()
  const size = page.viewportSize()!
  const bottom = await target.evaluate((el) => Math.ceil(el.getBoundingClientRect().bottom + window.scrollY))
  if (bottom > size.height) await page.setViewportSize({ width: size.width, height: bottom })
  if (!clipHeight) return target.screenshot({ animations: 'disabled', caret: 'hide' })
  const box = (await target.boundingBox())!
  return target.page().screenshot({ animations: 'disabled', caret: 'hide', clip: { x: box.x, y: box.y, width: box.width, height: clipHeight } })
}

// The production stack through nginx (plan 5): the real built app in Chrome, with the real
// security headers. Run by deploy/tests/browser.sh, never by the main Playwright config.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ROOT } from './fixtures'

const SHARED = process.env.DEPLOY_SHARED_PASSWORD!
const LOGIN = 'own-login-pass-1'
const STORAGE = 'storage-pass-123'
const PHOTO = join(ROOT, 'docs/design/assets/sample-photo.jpg')

/** Every CSP violation, console error and page error, so the test can demand none. */
function watch(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (m) => {
    // the signed-out "who am I?" check on first load is a 401 by design
    if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  return problems
}

test('the real app works through nginx with zero CSP violations', async ({ page }) => {
  const problems = watch(page)
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP blocked ${e.blockedURI} (${e.violatedDirective})`))
  })
  await page.goto('/')
  await page.getByRole('link', { name: 'Register' }).click()
  await page.getByLabel('Email').fill('browser1')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Password').fill(SHARED)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('tab', { name: 'Sharing' }).waitFor()

  // text to Global
  await page.getByLabel('Add recipient').click()
  await page.getByRole('option', { name: /Global/ }).click()
  await page.getByLabel('Add recipient').blur()
  await page.getByLabel('Text', { exact: true }).fill('hello from nginx')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('tab', { name: /Global/ }).click()
  await expect(page.locator('.item', { hasText: 'hello from nginx' })).toBeVisible()

  // a photo to Global: its thumbnail is served by nginx through X-Accel-Redirect
  await page.getByRole('tab', { name: /Private/ }).click()
  await page.getByRole('button', { name: 'Files' }).click()
  await page.getByLabel('Choose files').setInputFiles(PHOTO)
  await expect(page.getByRole('button', { name: 'Remove Global' })).toBeVisible() // kept from the text
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.q.done', { hasText: 'sample-photo.jpg' })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('tab', { name: /Global/ }).click()
  const card = page.locator('.item', { hasText: 'sample-photo.jpg' })
  await expect(card).toBeVisible()
  const thumb = card.locator('img').first()
  await expect(thumb).toBeVisible()
  await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0)

  // own login password, then My storage (WebCrypto + encrypted photo via /protected/vault/)
  await page.getByRole('button', { name: 'Set your own' }).click()
  await page.getByLabel('Current password').fill(SHARED)
  await page.getByLabel('New password', { exact: true }).fill(LOGIN)
  await page.getByLabel('Repeat new password').fill(LOGIN)
  await page.getByRole('button', { name: 'Change login password' }).click()
  await page.getByText('Login password changed.').first().waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: 'My storage' }).click()
  await page.getByLabel('Storage password', { exact: true }).fill(STORAGE)
  await page.getByLabel('Repeat it').fill(STORAGE)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Create My storage' }).click()
  await page.getByText('Encrypted, only you can see this').waitFor()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Note' }).click()
  const form = page.getByRole('dialog', { name: 'New note' })
  await form.getByLabel('Note', { exact: true }).fill('vault note through nginx')
  await form.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await expect(page.getByText('vault note through nginx').first()).toBeVisible()
  await page.getByLabel('Choose photos').setInputFiles(PHOTO)
  await expect(page.locator('#vault-open .ph')).toHaveCount(1, { timeout: 30_000 })
  await page.getByRole('button', { name: 'Open sample-photo.jpg' }).click()
  const big = page.getByRole('dialog', { name: 'sample-photo.jpg' }).locator('img')
  await expect(big).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => big.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0)

  expect(problems).toEqual([])
})

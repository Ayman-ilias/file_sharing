// End-to-end against the real backend (e2e/backend.sh): two people, live updates, real bytes.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'

const SHARED = 'e2e-shared-start-pw' // the dummy shared password backend.sh starts with
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function person(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByRole('link', { name: 'Register' }).click()
  await page.getByLabel('Email').fill(name)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Password').fill(SHARED)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('tab', { name: 'Sharing' }).waitFor()
  return page
}

async function sendTo(page: Page, who: string) {
  if (who === 'Global') {
    await page.getByLabel('Add recipient').click()
    await page.getByRole('option', { name: /Global/ }).click()
  } else {
    await page.getByLabel('Add recipient').fill(who)
    await page.getByRole('option', { name: new RegExp(who) }).click()
  }
  await page.getByLabel('Add recipient').blur()
}

async function downloaded(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()])
  return readFileSync((await dl.path())!)
}

test('text: sent live, copied, deleted live', async ({ browser }) => {
  const alice = await person(browser, 'alice1')
  const bob = await person(browser, 'bob1')
  await alice.reload() // the colleague list is loaded once per page
  await sendTo(alice, 'bob1')
  const body = 'Gateway IP: 10.10.8.51\nDashboard: https://example.com/d/1'
  await alice.getByLabel('Text', { exact: true }).fill(body)
  await alice.getByRole('button', { name: 'Send' }).click()

  await expect(alice.locator('.item', { hasText: 'Gateway IP' })).toBeVisible()
  const card = bob.locator('.item', { hasText: 'Gateway IP' })
  await expect(card).toBeVisible() // live, no reload
  await expect(card.getByRole('link', { name: 'https://example.com/d/1' })).toHaveAttribute('rel', 'noopener noreferrer')
  await card.getByRole('button', { name: 'Copy' }).click()
  await expect(card.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await bob.evaluate(() => navigator.clipboard.readText())).toBe(body)

  await expect(alice.locator('.item', { hasText: 'Gateway IP' })).toBeVisible()
  await card.getByRole('button', { name: 'Delete' }).click()
  await card.getByRole('button', { name: 'Delete?' }).click()
  await expect(card).toHaveCount(0)
  await expect(alice.locator('.item', { hasText: 'Gateway IP' })).toHaveCount(0)
  await expect(alice.getByText(/bob1 deleted/)).toBeVisible()
})

test('a 20 MB file to Global arrives byte for byte', async ({ browser }) => {
  const alice = await person(browser, 'alice2')
  const bob = await person(browser, 'bob2')
  const data = randomBytes(20 * 1024 * 1024)
  await alice.getByRole('button', { name: 'Files' }).click()
  await alice.getByLabel('Choose files').setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: data })
  await sendTo(alice, 'Global')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(alice.locator('.q.done', { hasText: 'big.bin' })).toBeVisible({ timeout: 60_000 })
  await expect(alice.locator('.q.done', { hasText: 'big.bin' })).toContainText('Sent')

  await bob.getByRole('tab', { name: /Global/ }).click()
  const card = bob.locator('.item', { hasText: 'big.bin' })
  await expect(card).toBeVisible()
  const got = await downloaded(bob, () => card.getByRole('button', { name: 'Download' }).click())
  expect(sha(got)).toBe(sha(data))
})

test('a 3-file folder arrives as one zip', async ({ browser }) => {
  const alice = await person(browser, 'alice3')
  const bob = await person(browser, 'bob3')
  const dir = join(mkdtempSync(join(tmpdir(), 'fs-e2e-')), 'site-photos')
  mkdirSync(join(dir, 'day1'), { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'first')
  writeFileSync(join(dir, 'day1', 'b.txt'), 'second')
  writeFileSync(join(dir, 'day1', 'c.txt'), 'third')
  await alice.getByRole('button', { name: 'Folder' }).click()
  await alice.getByLabel('Choose a folder').setInputFiles(dir)
  await sendTo(alice, 'Global')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(alice.locator('.q.done', { hasText: 'site-photos' })).toBeVisible({ timeout: 30_000 })

  await bob.getByRole('tab', { name: /Global/ }).click()
  const card = bob.locator('.item', { hasText: 'site-photos' })
  await expect(card).toContainText('3 files')
  const zip = await downloaded(bob, () => card.getByRole('button', { name: 'Download all' }).click())
  const text = zip.toString('latin1')
  for (const name of ['a.txt', 'day1/b.txt', 'day1/c.txt', 'first', 'second', 'third']) expect(text).toContain(name)
})

test('going offline mid-upload pauses, and it finishes intact when back online', async ({ browser }) => {
  const alice = await person(browser, 'alice4')
  const data = randomBytes(30 * 1024 * 1024)
  // slow the chunks down so there is a "mid-way" to go offline in
  await alice.route('**/api/uploads/*/chunks/*', async (r) => { await new Promise((ok) => setTimeout(ok, 150)); await r.continue() })
  await alice.getByRole('button', { name: 'Files' }).click()
  await alice.getByLabel('Choose files').setInputFiles({ name: 'survey.bin', mimeType: 'application/octet-stream', buffer: data })
  await sendTo(alice, 'Global')
  await alice.getByRole('button', { name: 'Send' }).click()
  const row = alice.locator('.q', { hasText: 'survey.bin' })
  await expect(row.locator('.pct')).toHaveText(/^[1-9]\d?%$/, { timeout: 30_000 })
  await alice.context().setOffline(true)
  await expect(row).toContainText("You're offline", { timeout: 15_000 })
  await alice.context().setOffline(false)
  await expect(row).toHaveClass(/done/, { timeout: 60_000 })

  await alice.getByRole('tab', { name: /Global/ }).click()
  const card = alice.locator('.item', { hasText: 'survey.bin' })
  const got = await downloaded(alice, () => card.getByRole('button', { name: 'Download' }).click())
  expect(sha(got)).toBe(sha(data))
})

test('setting your own password removes the nudge', async ({ browser }) => {
  const alice = await person(browser, 'alice5')
  const nudge = alice.getByText(/still using the shared starting password/)
  await expect(nudge).toBeVisible()
  await alice.getByRole('button', { name: 'Set your own' }).click()
  await alice.getByLabel('Current password').fill(SHARED)
  await alice.getByLabel('New password', { exact: true }).fill('alice-own-password-1')
  await alice.getByLabel('Repeat new password').fill('alice-own-password-1')
  await alice.getByRole('button', { name: 'Change login password' }).click()
  await expect(alice.getByText('Login password changed. Other devices were signed out.')).toBeVisible()
  await alice.keyboard.press('Escape')
  await expect(nudge).toHaveCount(0)
})

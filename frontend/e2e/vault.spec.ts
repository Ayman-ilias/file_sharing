// My storage end to end, against the real backend: setup, items, photos, lock, tabs, erase, password change.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { ROOT } from './fixtures'

const SHARED = 'e2e-shared-start-pw'
const LOGIN = 'own-login-password-1'
const STORAGE = 'my-storage-pass-123'
const NOTE = 'Router spare is in cabinet B7 (unique-note-text-91827)'
const SECRET = 'Uttara#Gw2026!-unique-91827'

/** A user with their own login password (My storage needs it), in a fresh browser context. */
async function person(browser: Browser, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByRole('link', { name: 'Register' }).click()
  await page.getByLabel('Email').fill(name)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Password').fill(SHARED)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('tab', { name: 'Sharing' }).waitFor()
  await page.getByRole('button', { name: 'Set your own' }).click()
  await page.getByLabel('Current password').fill(SHARED)
  await page.getByLabel('New password', { exact: true }).fill(LOGIN)
  await page.getByLabel('Repeat new password').fill(LOGIN)
  await page.getByRole('button', { name: 'Change login password' }).click()
  await page.getByText('Login password changed.').first().waitFor()
  await page.keyboard.press('Escape')
  return { ctx, page }
}

async function setUp(page: Page) {
  await page.getByRole('tab', { name: 'My storage' }).click()
  await page.getByLabel('Storage password', { exact: true }).fill(STORAGE)
  await page.getByLabel('Repeat it').fill(STORAGE)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Create My storage' }).click()
  await page.getByText('Encrypted, only you can see this').waitFor()
}

async function unlock(page: Page, password = STORAGE) {
  await page.getByLabel('Storage password').fill(password)
  await page.getByRole('button', { name: 'Unlock' }).click()
}

async function addNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Note' }).click()
  const form = page.getByRole('dialog', { name: 'New note' })
  await form.getByLabel('Note', { exact: true }).fill(text)
  await form.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? filesUnder(p) : [p]
  })
}

test('set up, add a note, a password and a photo, lock, unlock — and the server stores no plaintext', async ({ browser }) => {
  const { page } = await person(browser, 'vaulta')
  await setUp(page)
  await addNote(page, NOTE)

  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Password' }).click()
  const form = page.getByRole('dialog', { name: 'New password' })
  await form.getByLabel('Title').fill('Office router admin')
  await form.getByLabel('Username').fill('admin')
  await form.getByLabel('Password', { exact: true }).fill(SECRET)
  await form.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })

  await page.getByLabel('Choose photos').setInputFiles(join(ROOT, 'docs/design/assets/sample-photo.jpg'))
  await expect(page.locator('#vault-open .ph')).toHaveCount(1, { timeout: 30_000 })

  await page.getByRole('button', { name: 'Lock' }).click()
  await expect(page.getByText('My storage is locked')).toBeVisible()
  await expect(page.getByText(NOTE).first()).toHaveCount(0)
  await unlock(page)
  await expect(page.getByText(NOTE).first()).toBeVisible()
  await expect(page.getByText('Office router admin')).toBeVisible()
  await page.getByRole('button', { name: 'Open sample-photo.jpg' }).click()
  await expect(page.getByRole('dialog', { name: 'sample-photo.jpg' }).locator('img')).toHaveAttribute('src', /^blob:/)
  await page.keyboard.press('Escape')

  // the database, its WAL and every stored file: no note text, no password, no file name
  const dir = process.env.E2E_DATA_DIR!
  const all = filesUnder(dir)
  // control: the scan does see stored data (the username is meant to be stored in clear)
  expect(all.some((f) => readFileSync(f).toString('latin1').includes('vaulta@southerniot.net'))).toBe(true)
  expect(all.some((f) => f.includes(`${'/'}vault${'/'}`))).toBe(true) // the encrypted photo is on disk
  for (const file of all) {
    const bytes = readFileSync(file).toString('latin1')
    for (const secret of [NOTE, SECRET, 'sample-photo', 'Office router admin']) {
      expect(bytes.includes(secret), `${secret} found in ${file}`).toBe(false)
    }
  }
})

test('two tabs: a save from a stale form says so instead of overwriting', async ({ browser }) => {
  const { ctx, page: a } = await person(browser, 'vaultb')
  await setUp(a)
  await addNote(a, 'first version')
  const b = await ctx.newPage()
  await b.goto('/')
  await b.getByRole('tab', { name: 'My storage' }).click()
  await unlock(b) // a new tab opens locked
  await b.getByText('first version').first().waitFor()

  const cardIn = (p: Page) => p.locator('.vcard', { hasText: /version/ })
  await cardIn(b).getByRole('button', { name: 'More' }).click()
  await b.getByRole('menuitem', { name: 'Edit' }).click()
  await b.getByLabel('Note', { exact: true }).fill('from tab B')

  await cardIn(a).getByRole('button', { name: 'More' }).click()
  await a.getByRole('menuitem', { name: 'Edit' }).click()
  await a.getByLabel('Note', { exact: true }).fill('from tab A')
  await a.getByRole('button', { name: 'Save' }).click()
  await a.getByRole('dialog').waitFor({ state: 'detached' })

  await b.getByRole('button', { name: 'Save' }).click()
  await expect(b.getByText('Changed in another tab — reloaded.')).toBeVisible()
  await expect(b.getByRole('dialog', { name: 'Edit note' })).toBeVisible()
  await expect(a.getByText('from tab A').first()).toBeVisible()
})

test('erase needs ERASE and the login password, then frees everything', async ({ browser }) => {
  const { page } = await person(browser, 'vaultc')
  await setUp(page)
  await addNote(page, 'to be erased')
  await page.getByRole('button', { name: 'Lock' }).click()
  await page.getByRole('button', { name: 'Erase My storage and start again' }).click()
  await page.getByLabel('Your login password').fill(LOGIN)
  await page.getByLabel('Type ERASE to confirm').fill('ERASE')
  await page.getByRole('button', { name: 'Erase and start again' }).click()
  await expect(page.getByRole('button', { name: 'Create My storage' })).toBeVisible()
  const status = await page.evaluate(async () => (await fetch('/api/vault')).json())
  expect(status).toMatchObject({ initialized: false, used_bytes: 0, item_count: 0 })
})

test('changing the storage password: the old one stops working, the new one opens it', async ({ browser }) => {
  const { page } = await person(browser, 'vaultd')
  await setUp(page)
  await addNote(page, 'still readable after the change')
  await page.getByRole('button', { name: /vaultd@southerniot.net/ }).click()
  await page.getByLabel('Current storage password').fill(STORAGE)
  await page.getByLabel('New storage password').fill('a-brand-new-storage-pw')
  await page.getByRole('button', { name: 'Change storage password' }).click()
  await expect(page.getByText('Storage password changed.')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Lock' }).click()
  await unlock(page)
  await expect(page.getByText('Wrong storage password.')).toBeVisible()
  await unlock(page, 'a-brand-new-storage-pw')
  await expect(page.getByText('still readable after the change').first()).toBeVisible()
})

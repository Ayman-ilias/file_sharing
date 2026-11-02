// The app must look like docs/design/mockup.html: same sample data, same view, < 1 % differing pixels.
import { writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { difference, localFonts, MOCKUP, settle, shot } from './fixtures'
import { mockApi, NOW } from './mock-api'

const LIMIT = 0.01

async function open(page: Page, url: string) {
  await localFonts(page)
  await page.clock.setFixedTime(NOW)
  await page.goto(url)
}

/** The app's send card in the mockup's state: rahim + nusrat chosen, the sample title and text. */
async function fillSendCard(page: Page) {
  const to = page.getByLabel('Add recipient')
  for (const name of ['rahim', 'nusrat']) {
    await to.fill(name.slice(0, 3))
    await page.getByRole('option', { name: new RegExp(name) }).click()
  }
  await page.getByLabel(/Title/).fill('Gateway config for Uttara')
  await page.getByLabel('Text', { exact: true }).fill('Dashboard: https://grafana.southerniot.net/d/uttara\nGateway IP: 10.10.8.51')
}

async function compare(name: string, mock: Buffer, app: Buffer) {
  const ratio = difference(mock, app, test.info().outputPath(`${name}-diff.png`))
  writeFileSync(test.info().outputPath(`${name}-mockup.png`), mock)
  writeFileSync(test.info().outputPath(`${name}-app.png`), app)
  console.log(`${name}: ${(ratio * 100).toFixed(2)} % differ`)
  expect(ratio, `${name}: ${(ratio * 100).toFixed(2)} % of pixels differ`).toBeLessThan(LIMIT)
}

async function sharing(page: Page, section: 'Private' | 'Global') {
  await mockApi(page)
  await open(page, '/')
  await page.getByRole('tab', { name: 'Sharing' }).waitFor()
  await fillSendCard(page)
  if (section === 'Global') await page.getByRole('tab', { name: /Global/ }).click()
  await page.getByText(section === 'Global' ? 'rack-wiring-photo.jpg' : 'BOQ-final.xlsx').first().waitFor()
  await settle(page)
  return shot(page.locator('.wrap'))
}

async function mockupSharing(page: Page, section: 'Private' | 'Global') {
  await open(page, MOCKUP)
  if (section === 'Global') await page.locator('.seg-btn[data-pane="global"]').click()
  await settle(page)
  return shot(page.locator('.wrap').first())
}

test('Sharing / Private', async ({ browser }) => {
  const [m, a] = [await browser.newPage(), await browser.newPage()]
  await compare('private', await mockupSharing(m, 'Private'), await sharing(a, 'Private'))
})

test('Sharing / Global', async ({ browser }) => {
  const [m, a] = [await browser.newPage(), await browser.newPage()]
  await compare('global', await mockupSharing(m, 'Global'), await sharing(a, 'Global'))
})

test('Sharing on a phone', async ({ browser }) => {
  const viewport = { width: 390, height: 844 }
  const [m, a] = [await browser.newPage({ viewport }), await browser.newPage({ viewport })]
  await compare('phone', await mockupSharing(m, 'Private'), await sharing(a, 'Private'))
})

test('Login', async ({ browser }) => {
  const m = await browser.newPage()
  await open(m, MOCKUP)
  await settle(m)
  const mock = await shot(m.locator('.lpage'))

  const a = await browser.newPage()
  await mockApi(a, { me: null })
  await open(a, '/')
  await a.getByLabel('Email').fill('ayman')
  await a.getByLabel('Password').fill('xxxxxxxxxxxxxxx')
  await settle(a)
  await compare('login', mock, await shot(a.locator('.lpage')))
})

test('Profile drawer (head and login password)', async ({ browser }) => {
  // The storage part differs on purpose: before plan 4 it shows "Set up My storage" (states.html §9).
  const m = await browser.newPage()
  await open(m, MOCKUP)
  await m.locator('.acct-btn').click()
  await settle(m)
  const height = await m.locator('.drawer .dr-sec').first().evaluate((el) => el.getBoundingClientRect().bottom)

  const a = await browser.newPage()
  await mockApi(a)
  await open(a, '/')
  await a.locator('.acct-btn').click()
  await a.getByLabel('Current password').fill('xxxxxxxxxxxxxxx')
  await settle(a)
  await compare('drawer', await shot(m.locator('.drawer'), height), await shot(a.locator('.drawer'), height))
})

test('long names and many recipients never scroll sideways on a phone', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const long = 'x'.repeat(200)
  const recipients = Array.from({ length: 15 }, (_, i) => ({ id: 100 + i, username: `colleague${i}` }))
  const item = {
    id: 'l1', kind: 'file', name: `${long}.pdf`, size: 1024, mime: 'application/pdf', sender: { id: 1, username: 'ayman' },
    recipients, is_global: false, text_body: null, text_truncated: false, line_count: null, file_count: null,
    created_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
  }
  await mockApi(page, { private: [item] })
  await open(page, '/')
  await page.getByText(/colleague0, colleague1/).waitFor()
  const wide = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(wide).toBeLessThanOrEqual(390)
})

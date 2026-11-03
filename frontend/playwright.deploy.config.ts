import { defineConfig } from '@playwright/test'

// Runs e2e/deploy.spec.ts against an already running production stack (deploy/tests/browser.sh).
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'deploy.spec.ts',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    baseURL: process.env.DEPLOY_BASE_URL,
    timezoneId: 'Asia/Dhaka',
    locale: 'en-US',
    viewport: { width: 1300, height: 1000 },
  },
})

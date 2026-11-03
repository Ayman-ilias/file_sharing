import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// one throwaway data folder per run, shared with the tests through the environment
process.env.E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'fs-e2e-'))

// Parity runs against `vite preview` with /api mocked in the browser; the flows use a real backend
// on :8765 with a throwaway data folder (e2e/backend.sh).
export default defineConfig({
  testDir: 'e2e',
  testIgnore: 'deploy.spec.ts', // production stack only: playwright.deploy.config.ts
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5199',
    reducedMotion: 'reduce',
    timezoneId: 'Asia/Dhaka',
    locale: 'en-US',
    viewport: { width: 1300, height: 1000 },
  },
  webServer: [
    {
      command: 'bash e2e/backend.sh',
      env: { E2E_DATA_DIR: process.env.E2E_DATA_DIR! },
      url: 'http://127.0.0.1:8765/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run build && npx vite preview --host 127.0.0.1 --port 5199 --strictPort',
      url: 'http://127.0.0.1:5199',
      env: { FS_API: 'http://127.0.0.1:8765' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})

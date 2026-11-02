import { defineConfig } from '@playwright/test'

// Parity runs against `vite preview` with /api mocked in the browser; the flows use a real backend
// on :8765 with a throwaway data folder (e2e/backend.sh).
export default defineConfig({
  testDir: 'e2e',
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

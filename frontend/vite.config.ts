import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: the API runs on uvicorn :8000 (make backend-dev); production: nginx serves both (plan 5).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } },
  },
  preview: {
    port: 5181,
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } },
  },
})

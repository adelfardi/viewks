import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// dev: `npm run dev` avec le backend lancé sur :8081 (LISTEN_ADDR=:8081)
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.VIEWKS_API ?? 'http://localhost:8081', ws: true },
    },
  },
})

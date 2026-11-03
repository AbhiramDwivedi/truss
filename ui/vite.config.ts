// The client build (ADR-0018 section 2): source in app/, output in web/, which the server serves.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'app',
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../web',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
})

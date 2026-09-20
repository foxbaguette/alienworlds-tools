import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// `base: './'` keeps every asset path relative, so the build runs from any
// folder or sub-path it is served from. Routing is hash-based for the same
// reason: the server only ever sees index.html.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5290 },
  build: { target: 'es2020' },
})

import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss()],
  // --host exposes the dev server on the local network (open it on an iPhone on the same Wi-Fi).
  server: { host: true },
  worker: { format: 'es' },
})

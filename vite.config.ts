import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // --host exposes the dev server on the local network (open it on an iPhone on the same Wi-Fi).
  server: { host: true },
  worker: { format: 'es' },
})

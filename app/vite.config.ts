import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Rotate the full asset namespace once so clients that cached an old HTML
    // fallback under a chunk URL cannot reuse that poisoned response.
    assetsDir: 'assets-v2',
  },
})

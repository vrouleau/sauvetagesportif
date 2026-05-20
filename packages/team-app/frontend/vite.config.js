import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../../shared-ui/src'),
    },
    preserveSymlinks: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000'
    },
    fs: {
      allow: [path.resolve(__dirname, '../../shared-ui/src'), '.'],
    },
  },
})

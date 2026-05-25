import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  plugins: [tailwindcss(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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

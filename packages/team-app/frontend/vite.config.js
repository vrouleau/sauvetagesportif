import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
    // Ensure imports from symlinked shared-ui resolve node_modules from here
    preserveSymlinks: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000'
    }
  }
})

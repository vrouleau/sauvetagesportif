import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('../shared-ui/src')
      }
    },
    plugins: [react()],
    optimizeDeps: {
      exclude: ['zxing-wasm']
    },
    server: {
      fs: {
        // Allow serving WASM files from node_modules
        allow: ['../..']
      }
    }
  }
})

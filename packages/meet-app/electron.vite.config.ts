import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync, existsSync } from 'fs'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: 'copy-pg-worker',
        closeBundle() {
          // Copy pgWorker.js to the output directory alongside the bundled main
          const src = resolve('src/main/pgWorker.js')
          const outDir = resolve('out/main')
          if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
          copyFileSync(src, resolve(outDir, 'pgWorker.js'))
        }
      }
    ]
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
    plugins: [react()]
  }
})

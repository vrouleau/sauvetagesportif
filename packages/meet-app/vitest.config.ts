import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Mock electron imports for unit tests
      electron: './tests/mocks/electron.ts',
    },
  },
})

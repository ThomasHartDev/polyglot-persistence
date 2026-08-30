import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    hookTimeout: 120_000,
    testTimeout: 30_000,
    teardownTimeout: 30_000,
  },
})

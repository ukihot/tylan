import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    // Audit tests start the real job owner, which allows one instance per Windows user.
    fileParallelism: false,
    expect: { requireAssertions: true },
  },
})

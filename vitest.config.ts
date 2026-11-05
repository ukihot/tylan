import { svelte } from '@sveltejs/vite-plugin-svelte'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { viewerTemplatePlugin } from './build/standalone.ts'

export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.svelte.test.ts'],
        },
      },
      {
        plugins: [svelte(), viewerTemplatePlugin()],
        optimizeDeps: { include: ['zod/locales'] },
        test: {
          name: 'browser',
          include: ['src/**/*.svelte.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})

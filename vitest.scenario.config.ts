/// <reference types="vitest" />
import { resolve } from 'node:path'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Vitest config for scenario (integration) tests.
 *
 * These tests make real LLM and API calls and take 1-3 minutes each.
 * Run manually with: yarn test:scenario
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    test: {
      testTimeout: 300_000,
      hookTimeout: 120_000,
      env,
      include: ['**/*.scenario.test.ts'],
    },
    resolve: {
      alias: {
        '@cvault/convex/api': resolve(__dirname, 'convex/_generated/api'),
        '@cvault/convex/dataModel': resolve(__dirname, 'convex/_generated/dataModel'),
      },
    },
  }
})

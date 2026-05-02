/// <reference types="vitest" />
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Vitest config for integration tests.
 *
 * Tests the full Convex function pipeline (ingestion → processing → approval →
 * execution) using convex-test mock backend. Runs separately from unit and
 * scenario tests.
 *
 * Run with: yarn test:integration
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    test: {
      testTimeout: 30_000,
      env: {
        ...env,
      },
      // ONLY include integration tests
      include: ['**/*.integration.test.ts'],
    },
  }
})

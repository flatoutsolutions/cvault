/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'

/**
 * cvault CLI test config.
 *
 * Scope: this config governs ONLY tests under `cli/`. The repo root has its
 * own `vitest.config.ts` for the Convex backend (edge-runtime) and the
 * frontend (jsdom). CI runs the two suites independently.
 */
export default defineConfig({
  // Vite/Vitest natively resolves the `@cvault/convex/api` and
  // `@cvault/convex/dataModel` aliases declared in `tsconfig.json` via the
  // `resolve.tsconfigPaths` option. Bun's CLI runtime resolves them too,
  // so the path-aliased imports work both in the compiled binary and the
  // test runner without a plugin.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts'],
      thresholds: {
        // Per spec §11 — CLI floor is 80%
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
      reporter: ['text', 'html', 'lcov'],
    },
  },
})

/// <reference types="vitest" />
import { loadEnv } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Multi-project Vitest config — Vitest 4 replaced the old
// `environmentMatchGlobs` with first-class projects, each with its own
// runtime + plugin set.
//
// - convex-edge: every test under convex/ (incl. webhook + http handler
//   tests in convex/__tests__/) in the edge-runtime env that convex-test
//   expects.
// - convex-node: *.node.test.ts (e.g. crypto roundtrip) in plain Node
//   so node:crypto is available.
// - frontend: frontend tests in jsdom with the @/ path alias and a
//   Testing Library cleanup setup file.
//
// The CLI's tests live under cli/ and use Bun globals (`Bun.spawn`,
// `Bun.serve`). They are NOT included here — run them via the cli's
// own package.json `test` script: `cd cli && yarn test` (which delegates
// to `bunx --bun vitest run`).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    test: {
      env,
      // Apply at the parent level so child projects inherit; child-level
      // exclude is also additive.
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.scenario.test.ts'],
      projects: [
        {
          // Convex tests in edge-runtime (default for convex-test).
          extends: true,
          test: {
            name: 'convex-edge',
            include: ['convex/**/*.test.ts'],
            exclude: ['**/*.node.test.ts'],
            environment: 'edge-runtime',
          },
        },
        {
          // Convex tests that import node:crypto explicitly need plain Node.
          extends: true,
          test: {
            name: 'convex-node',
            include: ['convex/**/*.node.test.ts'],
            environment: 'node',
          },
        },
        {
          // Frontend (TanStack Start + Testing Library) — needs jsdom + @/
          // path alias from `tsconfig.app.json`.
          plugins: [tsconfigPaths({ projects: ['./tsconfig.app.json'] })],
          test: {
            name: 'frontend',
            include: ['frontend/**/*.test.{ts,tsx}'],
            environment: 'jsdom',
            setupFiles: ['./frontend/src/__tests__/setup.ts'],
            env,
          },
        },
      ],
    },
  }
})

import convexPlugin from '@convex-dev/eslint-plugin'
import js from '@eslint/js'
import { tanstackConfig } from '@tanstack/eslint-config'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    // cli/ has its own bun-managed install with @types/bun on the path so
    // `Bun.serve` etc resolve. Root yarn install (used by CI lint) does
    // NOT have that — it would tree-shake @types/bun and emit a wave of
    // "Unsafe call/member access" errors on otherwise correct CLI code.
    // The cli package has its own typecheck + lint step in release-cli.yml,
    // so excluding it from root lint is safe.
    ignores: ['dist', 'frontend/dist', 'cli/**', 'convex/_generated', '.yarn', '.agents'],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    ignores: ['frontend/**'],
    plugins: { js },
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  tseslint.configs.recommended,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  ...convexPlugin.configs.recommended,
  ...tanstackConfig.map((config) => ({
    ...config,
    files: ['frontend/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}'],
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...((config.languageOptions as Record<string, unknown>)?.parserOptions as Record<string, unknown>),
        project: undefined,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),
  {
    files: ['frontend/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'import/no-cycle': 'off',
      'import/order': 'off',
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      'pnpm/json-enforce-catalog': 'off',
    },
  },
])

/**
 * Frontend test setup — runs once before any test file.
 *
 * - Auto-runs Testing Library's `cleanup()` after each test so DOM
 *   state from `render()` doesn't leak into the next test. RTL only
 *   auto-cleans when `globals: true` is set in the Vitest config; we
 *   register the hook manually to avoid changing that.
 */
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})

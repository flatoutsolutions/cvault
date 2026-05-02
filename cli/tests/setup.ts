/**
 * Vitest setup file for the cvault CLI test suite.
 *
 * - Resets module state between tests so `vi.mock()` calls in one file don't
 *   bleed into the next.
 * - Restores all mocks/spies so spies on globals (e.g. `Bun.spawn`, `fetch`)
 *   don't carry over.
 * - Swallows known-benign unhandled rejections from late-firing setTimeout
 *   handlers in `callbackServer` (the timer that backs the 2-minute browser
 *   timeout fires after the test has already observed the rejection via
 *   `expect(...).rejects.toThrow(...)`; vitest counts it as "unhandled"
 *   because Bun's microtask scheduling differs slightly from Node).
 *
 * Per spec §11.
 */
import { afterEach, vi } from 'vitest'

const KNOWN_BENIGN_REJECTIONS = [/Browser sign-in timed out/, /callback server cancelled/]

process.on('unhandledRejection', (err: unknown) => {
  if (err instanceof Error) {
    for (const re of KNOWN_BENIGN_REJECTIONS) {
      if (re.test(err.message)) return
    }
  }
  // Re-throw via process.emit so vitest's own listener still picks it up
  // when the rejection is genuinely unexpected.
  throw err
})

afterEach(() => {
  // restoreAllMocks() resets spies; clearAllMocks() resets call history on
  // module mocks declared via `vi.mock(...)`. Both are needed so each test
  // starts from a clean slate.
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.resetModules()
})

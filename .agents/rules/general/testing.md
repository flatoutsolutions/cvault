---
trigger: always_on
---

# Testing Requirements

Every code change MUST include tests. Do NOT ship code without tests. If tests are difficult to write, that is a signal the code needs restructuring — fix the design, don't skip the tests.

## Unit Tests

- Every new module, function, or non-trivial code change MUST have unit tests.
- Tests live in `convex/__tests__/` (backend) or `frontend/__tests__/` (frontend).
- Use **Vitest** (`describe`, `it`, `expect`). Do NOT use Jest, Mocha, or any other test framework.
- Name test files `<module>.test.ts` (e.g., `polylineInterpolation.test.ts`).

### What to test

- All **pure functions** and utility logic (math, parsing, validation, transformation, mapping).
- **Edge cases**: null/undefined inputs, empty arrays, zero values, negative numbers, boundary values.
- **Error paths**: invalid inputs, missing data, malformed payloads.
- **Default/fallback behavior**: when optional fields are missing.

### Designing for testability

- Extract pure logic into helper files (`*Helpers.ts`, `*.helpers.ts`, or dedicated utility modules) that do NOT import Convex runtime (`_generated/server`). This allows unit testing without Convex infrastructure.
- Convex queries/mutations/actions should be thin wrappers that delegate to testable pure functions.
- If a function mixes pure computation with side effects (DB reads, API calls, scheduling), split it: pure logic in a helper, orchestration in the Convex function.

## Integration Tests

- Write integration tests when code crosses system boundaries: Convex functions calling other functions, multi-step pipelines, event-driven flows, or external API interactions.
- Integration test files use the `.integration.test.ts` or `.scenario.test.ts` suffix.
- Mock external API calls (Google Maps, OpenAI, Twilio, Towbook) — never make real API calls in tests.

## When to Write Tests

- **New code**: Write tests alongside the code, in the same PR. Not "later" — now.
- **Bug fixes**: Write a failing test that reproduces the bug FIRST, then fix it. The test proves the fix works and prevents regression.
- **Refactors**: Ensure existing tests pass. If refactoring changes behavior, update the tests to reflect the new behavior. If there are no existing tests for the code being refactored, write them before refactoring.

## Test Quality

- Tests must be **deterministic** — no reliance on wall-clock time, random values, or external state. Use fixed timestamps and predictable inputs.
- Tests must be **independent** — each test runs in isolation, no shared mutable state between tests.
- Tests must be **descriptive** — test names should read as specification: `it("returns fallback when API key is missing")` not `it("works")`.
- Prefer many small focused tests over few large tests. One assertion per logical behavior.

## Running Tests

Tests are run with `yarn test` (runs Vitest). Before telling the user you are done, run the tests and make sure they pass.

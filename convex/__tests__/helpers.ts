/// <reference types="vite/client" />
/**
 * Test harness helpers for convex-test.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §11.
 */
import { convexTest } from 'convex-test'

import schema from '../schema'

/**
 * Build a fresh in-memory Convex instance bound to the cvault schema.
 *
 * The second arg to convexTest() is the module map. We use Vite's
 * `import.meta.glob` so convex-test knows about every Convex function
 * file regardless of where the test file lives.
 */
export function vault() {
  // `import.meta.glob` is a Vite static API — Vite rewrites the call at
  // transform time. The `vite/client` reference at the top of this file
  // gives `import.meta.glob` a typed signature.
  const modules = import.meta.glob('../**/!(*.test).{ts,js}')
  return convexTest(schema, modules)
}

/**
 * Identity used by tests that need an authenticated Clerk-style caller.
 * The shape mirrors a real Clerk JWT identity payload.
 */
export const TEST_IDENTITY = {
  subject: 'user_test_alice',
  issuer: 'https://clear-redbird-6.clerk.accounts.dev',
  tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_alice',
  name: 'Alice Tester',
  email: 'alice@example.com',
} as const

export const SECOND_IDENTITY = {
  subject: 'user_test_bob',
  issuer: 'https://clear-redbird-6.clerk.accounts.dev',
  tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_bob',
  name: 'Bob Tester',
  email: 'bob@example.com',
} as const

/**
 * Seed a `users` row matching TEST_IDENTITY (or a custom one) so that
 * authenticated functions which look up the user by externalId find them.
 *
 * Returns the inserted user's `Id<'users'>` for convenience.
 */
export async function seedUser(
  t: ReturnType<typeof vault>,
  identity: { subject: string; name: string; email: string } = TEST_IDENTITY
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('users', {
      externalId: identity.subject,
      name: identity.name,
      primaryEmail: identity.email,
      otherEmails: [],
    })
  })
}

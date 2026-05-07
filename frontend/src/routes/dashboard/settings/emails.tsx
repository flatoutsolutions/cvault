/**
 * /dashboard/settings/emails — static route declaration.
 *
 * Pairs with `emails.lazy.tsx` (page component). Mirrors the
 * `domains.tsx` + `domains.lazy.tsx` convention used everywhere else in
 * this repo so the TanStack Router codegen has a real source-of-truth
 * file to import from.
 */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard/settings/emails')({})

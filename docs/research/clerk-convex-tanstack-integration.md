# Clerk + Convex + TanStack Start integration — research brief

Reference document for building cvault. Covers the existing Blueprint 2.0 wiring, the
TanStack Start (SPA mode) + Clerk + Convex stack on the frontend, and a Python CLI that
authenticates as the same Clerk user across multiple machines and calls Convex.

> Status: research only. No code in this repo has been modified.
> Verified against the Blueprint code currently in `/Users/saadings/Desktop/cvault/`.

---

## 1. Existing Blueprint state (verified in this repo)

### `convex/auth.config.ts` (verbatim)

```ts
// /Users/saadings/Desktop/cvault/convex/auth.config.ts
import { AuthConfig } from 'convex/server'

export default {
  providers: [
    {
      // Replace with your Clerk Frontend API URL
      // or with `process.env.CLERK_JWT_ISSUER_DOMAIN`
      // and configure CLERK_JWT_ISSUER_DOMAIN on the Convex Dashboard
      // See https://docs.convex.dev/auth/clerk#configuring-dev-and-prod-instances
      domain: process.env.CLERK_FRONTEND_API_URL!,
      applicationID: 'convex',
    },
  ],
} satisfies AuthConfig
```

This means:

- **JWT template name expected by Convex:** `convex` (matches `applicationID`). You must
  create a Clerk JWT template with this exact name in the Clerk Dashboard
  (Configure > JWT templates > New template > "Convex" preset, or a blank template
  named `convex` with `aud: "convex"`).
- **Issuer:** `process.env.CLERK_FRONTEND_API_URL` — must be set in the **Convex
  deployment env**, not just the local `.env.local`. Format:
  `https://verb-noun-XX.clerk.accounts.dev` (dev) or `https://clerk.<your-domain>.com`
  (prod). The JWT's `iss` claim must match this exactly.
- The `.env.local` here has `CLERK_FRONTEND_API_URL=https://clear-redbird-6.clerk.accounts.dev`,
  shared with the Blueprint dev tenant.

### `convex/utils/auth.ts` — how `authenticatedQuery` resolves identity (verbatim)

```ts
// /Users/saadings/Desktop/cvault/convex/utils/auth.ts (excerpt)
export const authenticatedQuery = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  handler: (
    ctx: GenericQueryCtx<DataModel> & {
      identity: NonNullable<Awaited<ReturnType<GenericQueryCtx<DataModel>['auth']['getUserIdentity']>>>
    },
    args: Args
  ) => Promise<unknown>
}) => {
  return query({
    args: fn.args ?? {},
    handler: async (ctx, args) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) {
        throw new Error('Not authenticated')
      }
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as QueryBuilder<DataModel, 'public'>
```

Identity flow:

1. Caller (browser via WS, or Python CLI via HTTP `Authorization: Bearer <jwt>`) presents
   a Clerk-issued JWT minted from the `convex` JWT template.
2. Convex verifies signature against the JWKS at
   `${CLERK_FRONTEND_API_URL}/.well-known/jwks.json` and that `iss` and `aud` match.
3. `ctx.auth.getUserIdentity()` returns a `UserIdentity` object whose `.subject` is the
   Clerk `user_id` (e.g. `user_2NxYZ...`). That's what `convex/users/actions.ts`
   (`userByExternalId`) keys off as the `externalId` in the `users` table.
4. The `users` row is populated/kept-in-sync by the Clerk webhook
   (`convex/webhooks/clerk.ts` → `internal.users.actions.upsert` on `user.created` /
   `user.updated`). The Convex HTTP route is `POST $CONVEX_SITE_URL/webhooks/clerk`
   and verifies the Svix signature using `CLERK_WEBHOOK_SECRET`.

### `users.current` query (the canonical "who am I" read)

```ts
// /Users/saadings/Desktop/cvault/convex/users/actions.ts (excerpt)
export const current = query({
  args: {},
  handler: async (ctx) => {
    return await getCurrentUser(ctx)
  },
})

export async function getCurrentUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity()
  if (identity === null) return null
  return await userByExternalId(ctx, identity.subject)
}
```

This is the function the Python CLI will call to confirm "the JWT in my vault belongs
to the user I think it does."

### Front-end wiring (verified)

```tsx
// /Users/saadings/Desktop/cvault/frontend/src/routes/__root.tsx (excerpt)
import { ClerkProvider, useAuth } from '@clerk/tanstack-react-start'
import { dark } from '@clerk/themes'
import { ConvexProviderWithClerk } from 'convex/react-clerk'

function RootComponent() {
  const { convexClient } = Route.useRouteContext()
  return (
    <ClerkProvider appearance={{ baseTheme: dark }}>
      <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
        <Outlet />
      </ConvexProviderWithClerk>
    </ClerkProvider>
  )
}
```

```tsx
// /Users/saadings/Desktop/cvault/frontend/src/router.tsx (excerpt)
const convexQueryClient = new ConvexQueryClient(env.VITE_CONVEX_URL)
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryKeyHashFn: convexQueryClient.hashFn(),
      queryFn: convexQueryClient.queryFn(),
    },
  },
})
convexQueryClient.connect(queryClient)
// ...
context: { queryClient, convexClient: convexQueryClient.convexClient },
```

`@convex-dev/react-query` builds a `ConvexReactClient` (WebSocket) wrapped by
TanStack Query. `ConvexProviderWithClerk` registers a token fetcher that calls
`useAuth().getToken({ template: 'convex', skipCache })` and pushes the resulting JWT
into the WebSocket auth handshake. This is also why the WS reconnects whenever Clerk
issues a new short-lived JWT (every 60s by default).

### Env vars currently configured (`.env.local`)

```
CONVEX_DEPLOYMENT=dev:beloved-mouse-707
CONVEX_URL=https://beloved-mouse-707.convex.cloud
CONVEX_SITE_URL=https://beloved-mouse-707.convex.site
VITE_CONVEX_URL=https://beloved-mouse-707.convex.cloud
VITE_CONVEX_SITE_URL=https://beloved-mouse-707.convex.site
CLERK_FRONTEND_API_URL=https://clear-redbird-6.clerk.accounts.dev
VITE_CLERK_PUBLISHABLE_KEY=pk_test_…
CLERK_SECRET_KEY=sk_test_…
```

> **Caveat (out of scope, flag for impl-time):** `.env.local` here is a dev-only file
> with a test-tier Clerk secret. Production keys must NEVER live in plaintext on disk —
> use a secret manager / encrypted env. The CLI's vault file
> (`~/.vault/session.json`) needs the same hygiene (see §7).

---

## 2. TanStack Start + Clerk wiring (current best practice)

The Blueprint already does this. Two divergences from the official quickstart that are
deliberate and should stay:

1. The official quickstart names the publishable key `CLERK_PUBLISHABLE_KEY`. The
   Blueprint uses `VITE_CLERK_PUBLISHABLE_KEY` because Vite only exposes vars prefixed
   with `VITE_` to the browser, and `@clerk/tanstack-react-start`'s `<ClerkProvider>`
   reads `VITE_CLERK_PUBLISHABLE_KEY` automatically when no explicit
   `publishableKey` prop is passed (this is the documented Vite/React quickstart
   pattern). The current code works without the prop because the SDK falls back to
   `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY`. If anything regresses, pass it
   explicitly:

   ```tsx
   <ClerkProvider
     publishableKey={env.VITE_CLERK_PUBLISHABLE_KEY}
     appearance={{ baseTheme: dark }}
   >
   ```

2. The Blueprint runs in **SPA mode** (`tanstackStart({ spa: { enabled: true, … } })` in
   `frontend/vite.config.ts`). There is no `src/start.ts` with `clerkMiddleware()` and
   no Vinxi server. That means:
   - `auth()` from `@clerk/tanstack-react-start/server` and TanStack server functions
     are NOT available at runtime — the build only ships static assets + a SPA shell.
   - All auth state must come from the client SDK (`useAuth`, `useUser`, `useClerk`,
     `<Show when="signed-in">`, etc.).
   - Route protection must use TanStack Router's client-side `beforeLoad` together
     with `Clerk.load()` rather than server-side `auth()`.

### Client-side route guard pattern (SPA-safe)

```tsx
// frontend/src/routes/dashboard.tsx (example — does not exist yet)
import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async () => {
    // Wait for Clerk to load before deciding
    const Clerk = (await import('@clerk/clerk-js')).Clerk
    // OR — preferred — use the global window.Clerk that ClerkProvider mounts:
    if (typeof window !== 'undefined' && window.Clerk) {
      await window.Clerk.load()
      if (!window.Clerk.user) {
        throw redirect({ to: '/sign-in' })
      }
    }
  },
  component: Dashboard,
})
```

Or, simpler and what the existing `routes/index.tsx` already does, just gate UI:

```tsx
import { Show, SignInButton, UserButton } from '@clerk/tanstack-react-start'

<Show when="signed-out"><SignInButton mode="modal">...</SignInButton></Show>
<Show when="signed-in"><UserButton /></Show>
```

### Custom sign-in UX in the dashboard

For the dashboard's `/sign-in` page (custom UI, not modal), use the
`useSignIn`-driven flow. This is documented in `clerk-custom-ui` skill →
`core-3/custom-sign-in.md`. Skeleton:

```tsx
// frontend/src/routes/sign-in.tsx (example)
import { useSignIn } from '@clerk/tanstack-react-start'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/sign-in')({ component: SignInPage })

function SignInPage() {
  const { isLoaded, signIn, setActive } = useSignIn()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [stage, setStage] = useState<'email' | 'code'>('email')

  if (!isLoaded) return null

  async function startSignIn() {
    const result = await signIn.create({ identifier: email })
    const emailFactor = result.supportedFirstFactors?.find((f) => f.strategy === 'email_code')
    if (!emailFactor) throw new Error('Email code not supported on this account')
    await signIn.prepareFirstFactor({
      strategy: 'email_code',
      emailAddressId: emailFactor.emailAddressId,
    })
    setStage('code')
  }

  async function verify() {
    const result = await signIn.attemptFirstFactor({ strategy: 'email_code', code })
    if (result.status === 'complete') {
      await setActive({ session: result.createdSessionId })
      navigate({ to: '/dashboard' })
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        stage === 'email' ? startSignIn() : verify()
      }}
    >
      {stage === 'email' ? (
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      ) : (
        <input value={code} onChange={(e) => setCode(e.target.value)} />
      )}
      <button type="submit">{stage === 'email' ? 'Send code' : 'Verify'}</button>
    </form>
  )
}
```

> If you want pre-built UI that matches dark/shadcn, drop in `<SignIn />` from
> `@clerk/tanstack-react-start` and pass `appearance={{ theme: shadcn }}` (install
> `@clerk/ui` and import `@clerk/ui/themes/shadcn.css`).

### Server-side identity in TanStack server functions — N/A in SPA mode

If you later flip `spa.enabled: false` and add a Node/Vinxi server, then:

```ts
// src/start.ts
import { clerkMiddleware } from '@clerk/tanstack-react-start/server'
import { createStart } from '@tanstack/react-start'

export const startInstance = createStart(() => ({
  requestMiddleware: [clerkMiddleware()],
}))
```

```ts
// any route's server function
import { auth } from '@clerk/tanstack-react-start/server'
import { createServerFn } from '@tanstack/react-start'

const me = createServerFn().handler(async () => {
  const { isAuthenticated, userId, getToken } = await auth()
  if (!isAuthenticated) throw new Error('not signed in')
  const convexJwt = await getToken({ template: 'convex' })
  return { userId, convexJwt }
})
```

But this is not the Blueprint shape today and should not be added without a reason.

Docs: <https://clerk.com/docs/tanstack-react-start/getting-started/quickstart>,
<https://clerk.com/docs/reference/components/clerk-provider>.

---

## 3. Convex client with Clerk in TanStack Start

The Blueprint uses `convex/react-clerk`'s `ConvexProviderWithClerk`. The integration
contract:

```tsx
import { useAuth } from '@clerk/tanstack-react-start'
import { ConvexProviderWithClerk } from 'convex/react-clerk'

;<ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
  …
</ConvexProviderWithClerk>
```

What this does behind the scenes:

1. Calls Clerk's `useAuth()` to subscribe to auth state changes.
2. Whenever `isSignedIn` flips true, calls
   `Clerk.session.getToken({ template: 'convex', skipCache })` and feeds the JWT into
   `convexClient.setAuth(fetchToken)`.
3. The Convex React client opens a WebSocket to `wss://<deployment>.convex.cloud`,
   sends the JWT in the WS auth message, and Convex validates against the JWKS.
4. Inside Convex functions, `await ctx.auth.getUserIdentity()` returns a non-null
   `{ subject: 'user_…', tokenIdentifier, email, name, … }` object.
5. Clerk JWTs are short-lived (60 seconds). Both `ConvexProviderWithClerk` and
   `Clerk.session.getToken` refresh transparently, so no app code is needed.

JWT template requirements (Clerk Dashboard → JWT templates → "Convex"):

- **Name:** `convex` (must match `applicationID` in `convex/auth.config.ts`).
- **Audience (`aud`):** `convex` (Clerk's preset configures this automatically).
- **Token lifetime:** leave at default 60s. The JWKS-based verification is local
  inside Convex; the short lifetime forces frequent refresh, which is the security
  posture you want.

Docs: <https://docs.convex.dev/auth/clerk>,
<https://clerk.com/docs/guides/development/integrations/databases/convex>.

---

## 4. CLI authentication path (settled approach)

### What Clerk supports

Clerk has three machine-auth product surfaces, and only one fits the
"authenticate AS the user across machines" requirement:

| Approach                                                              | Fit for cvault CLI? | Why / why not                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OAuth Authorization Code** (Clerk-as-OAuth-server, third-party app) | No                  | Heavy setup; intended for third-party apps wanting access to Clerk users. cvault is the same app, not a third party.                                                                                                                                                                                                                       |
| **M2M tokens** (`POST /v1/m2m_tokens`)                                | No                  | Authenticates a _machine_, not a user. Token is issued to a registered machine identity, not tied to `user_id`. Convex `ctx.auth.getUserIdentity()` would not return the human's identity.                                                                                                                                                 |
| **API keys (per-user)**                                               | Partially           | Long-lived per-user tokens that look like sessions to Convex. Currently in beta; semantics differ from session JWTs in subtle ways (no `sid`, special `sub`). Avoid until GA unless we accept beta risk.                                                                                                                                   |
| **Sign-in token + ticket strategy**                                   | **Yes (best fit)**  | Backend mints a short-lived single-use sign-in token tied to a specific `user_id`; client exchanges it via the `ticket` strategy to create a real Clerk session in a real Clerk client. From there the CLI behaves exactly like a browser tab — same `getToken({ template: 'convex' })` flow, same revocation surface in the dashboard.    |
| **Direct password / email-code sign-in via Clerk Frontend API**       | Possible fallback   | The CLI implements the same `signIn.create()` / `attemptFirstFactor()` flow that the dashboard does, but headless. Works with the official `clerk-sdk-python` package or raw HTTP to FAPI. Avoids the dashboard round-trip but means the CLI runs through 2FA / CAPTCHA / device verification etc. on its own. Higher implementation cost. |

**Settled choice for cvault: browser-assisted sign-in token + ticket exchange,
then cache the resulting session JWT.** This re-uses the dashboard for the actual
human-credential entry (passwords, MFA, social login) and keeps the CLI itself
credential-free.

> Clerk does NOT publish an OAuth 2.0 _Device Authorization Grant_ (RFC 8628) for
> end-user sessions. The "device flow" Clerk talks about under "OAuth Applications"
> is a separate product that turns Clerk into an OAuth provider for third-party apps —
> not a way to log a CLI into your own Clerk app as the human user. So the
> "type a code on phone, polls in terminal" UX is not directly available; we build the
> moral equivalent on top of sign-in tokens.

### CLI flow (settled)

```
┌─────────────────┐         ┌────────────────────┐          ┌────────────────┐
│  cvault CLI     │         │ cvault Dashboard   │          │ Clerk Backend  │
│  (Python)       │         │ (TanStack Start)   │          │ API            │
└────────┬────────┘         └──────────┬─────────┘          └────────┬───────┘
         │                             │                             │
   1. user runs `vault login`          │                             │
         │                             │                             │
   2. CLI starts a localhost           │                             │
      HTTP listener on 127.0.0.1:0     │                             │
      (random free port), then opens   │                             │
      browser to:                      │                             │
      https://dashboard.cvault/cli/    │                             │
        link?redirect=http://127.0.0.1:│                             │
        <port>/callback&state=<nonce>  │                             │
         │ ────────────────────────────▶                             │
         │                             │                             │
         │                       3. dashboard: <Show when="signed-in">│
         │                          if signed in, calls a Convex     │
         │                          action `cli.startLink({ state })`│
         │                          which:                           │
         │                            a) verifies caller via         │
         │                               getCurrentUserOrThrow       │
         │                            b) calls Clerk Backend         │
         │                               POST /v1/sign_in_tokens     │
         │                               { user_id }                 │ ─▶
         │                            c) returns { signInToken,      │
         │                               url } to the page           │ ◀─
         │                                                           │
         │                       4. dashboard JS does:               │
         │                          fetch(localhost callback,        │
         │                               { signInToken, state })     │
         │                          (or 302 the browser there;       │
         │                          fetch is cleaner — no nav)       │
         │ ◀───────────────────────────                              │
         │                                                           │
   5. CLI receives signInToken,        │                             │
      shuts down the listener,         │                             │
      and calls Clerk Frontend API     │                             │
      directly to exchange it for a    │                             │
      real session:                    │                             │
        POST $CLERK_FAPI/v1/client/    │                             │
          sign_ins?_clerk_js_version=… │                             │
          &__clerk_handshake=…         │                             │
        body: strategy=ticket          │                             │
              &ticket=<signInToken>    │                             │ ─▶
                                       │                             │
   6. response includes:               │                             │
      - createdSessionId (sess_…)      │                             │
      - client.lastActiveSessionId     │                             │
      - a __session cookie / JWT       │                             │ ◀─
         │                                                           │
   7. CLI mints a Convex template      │                             │
      JWT immediately:                 │                             │
        GET $CLERK_FAPI/v1/client/     │                             │
          sessions/<sess_id>/tokens/   │                             │
          convex                       │                             │ ─▶
                                       │                             │ ◀─
         │                                                           │
   8. CLI writes ~/.vault/session.json │                             │
      with mode 0600:                  │                             │
        { sessionId, refreshUrl,       │                             │
          clerkSessionToken,           │                             │
          convexJwt, convexJwtExpiry } │                             │
         │                                                           │
   9. CLI verifies by calling          │                             │
      ConvexHttpClient.set_auth(       │                             │
        convexJwt) and                 │                             │
      `users:current` query — should   │                             │
      return the human's user row.     │                             │
         │                                                           │
```

### Step 3 — the Convex action (server-side)

```ts
// convex/cli/actions.ts (does not exist yet — example for impl)
import { v } from 'convex/values'

import { action } from '../_generated/server'

export const startLink = action({
  args: { state: v.string() },
  handler: async (ctx, { state }): Promise<{ signInToken: string }> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')

    const res = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: identity.subject,
        // Default 30 days; for CLI link flow, a few minutes is enough.
        expires_in_seconds: 600,
      }),
    })
    if (!res.ok) {
      throw new Error(`Clerk sign_in_tokens failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { token: string }

    // Audit: log a row in `machineActivity` (already in schema) with state=state, user
    // so we can correlate with whichever machine claims it.
    return { signInToken: data.token }
  },
})
```

> Action (not mutation/query): mint sign-in token uses `fetch()` to Clerk's BAPI and
> reads `process.env.CLERK_SECRET_KEY`, which is only available in the Convex Node /
> action runtime. Mutations and queries can't make outbound HTTP calls.
> `CLERK_SECRET_KEY` must be set in the **Convex deployment env**
> (`npx convex env set CLERK_SECRET_KEY sk_test_…`), not just the local `.env.local`.

### Step 4 — dashboard page

```tsx
// frontend/src/routes/cli/link.tsx (example)
import { useUser } from '@clerk/tanstack-react-start'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import { useAction } from 'convex/react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'

import { api } from '../../../../convex/_generated/api'

const SearchSchema = z.object({ redirect: z.string().url(), state: z.string().min(8) })

export const Route = createFileRoute('/cli/link')({
  validateSearch: SearchSchema.parse,
  component: CliLinkPage,
})

function CliLinkPage() {
  const { redirect, state } = useSearch({ from: '/cli/link' })
  const { isSignedIn, isLoaded } = useUser()
  const startLink = useAction(api.cli.actions.startLink)
  const [status, setStatus] = useState<'idle' | 'linking' | 'done' | 'error'>('idle')
  const ran = useRef(false)

  useEffect(() => {
    if (!isLoaded || !isSignedIn || ran.current) return
    ran.current = true
    setStatus('linking')
    ;(async () => {
      try {
        const { signInToken } = await startLink({ state })
        const res = await fetch(redirect, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state, signInToken }),
        })
        if (!res.ok) throw new Error(await res.text())
        setStatus('done')
      } catch (e) {
        console.error(e)
        setStatus('error')
      }
    })()
  }, [isLoaded, isSignedIn, redirect, state, startLink])

  if (!isLoaded) return <p>Loading…</p>
  if (!isSignedIn) return <p>Sign in first, then re-open the link.</p>
  if (status === 'done') return <p>You can close this tab and return to the CLI.</p>
  if (status === 'error')
    return (
      <p>
        Linking failed. Run <code>vault login</code> again.
      </p>
    )
  return <p>Linking your machine…</p>
}
```

> Critical: the dashboard makes the localhost POST itself instead of redirecting the
> browser there. This avoids a window where the user's browser navigates to a
> URL containing the sign-in token — never put the token in a URL bar / referer log.

### Step 5/6 — exchanging the ticket on the CLI side

Two sub-options:

**5a. Use `clerk-sdk-python` (PyPI: `clerk-backend-api`)** — this is the **Backend SDK**
for calling Clerk's BAPI. It is NOT a frontend SDK, so it can't itself perform a
ticket sign-in. So 5a is only useful for steps that hit BAPI (which the dashboard side
already does in §3). The CLI does not need it.

**5b. Hit Clerk Frontend API (FAPI) directly with `httpx`.** The endpoint:

```
POST https://<frontend-api-host>/v1/client/sign_ins
  ?__clerk_api_version=2024-10-01
Body (form-urlencoded):
  strategy=ticket
  ticket=<signInToken>
Headers:
  Origin: https://<your dashboard origin>      ← must match clerk allowed origins
  User-Agent: cvault-cli/<version>
```

Response: a JSON `Client` object containing `sign_in.created_session_id` and a
`Set-Cookie: __session=<jwt>; …`. The simpler approach is to _also_ request a session
token immediately, scoped to the `convex` template:

```
POST https://<frontend-api-host>/v1/client/sessions/<session_id>/tokens/convex
Headers:
  Authorization: Bearer <__session JWT from the previous response>
Body: (empty)
```

Returns `{ "jwt": "<the convex-template JWT>" }`. That's what we cache.

**Important detail for the CLI:** Clerk's FAPI normally sets cookies on a browser
client. From a Python script there are no cookies, but the response body of
`POST /v1/client/sign_ins` includes the full `Client` object including
`sessions[*].last_active_token.jwt` (the same token it was about to set as the
`__session` cookie). The CLI grabs that token from the response body, not from a
cookie jar.

> If FAPI rejects the call due to missing `Origin` / cross-origin checks: pass
> `Origin` header set to the dashboard's deployed origin (e.g.
> `https://app.cvault.dev`) and ensure that origin is listed in Clerk Dashboard →
> Configure → Allowed origins. Some Clerk environments also require
> `?_clerk_js_version=5.x.x` and `__clerk_handshake=` query params; if the bare
> request fails, capture the exact request your dashboard makes during a live
> sign-in (DevTools → Network) and replicate it.

### `~/.vault/session.json` shape (proposed)

```json
{
  "version": 1,
  "clerkUserId": "user_2NxYZ…",
  "clerkSessionId": "sess_2OqW…",
  "clerkSessionToken": "<long-lived session JWT, ~7d default>",
  "convexJwt": "<short-lived convex-template JWT, ~60s default>",
  "convexJwtExpiry": 1735000000,
  "frontendApiUrl": "https://clear-redbird-6.clerk.accounts.dev",
  "convexUrl": "https://beloved-mouse-707.convex.cloud",
  "issuedAt": 1734999000,
  "machineLabel": "saadings-macbook"
}
```

File mode: `0600`. Directory `~/.vault/` mode `0700`. The CLI installer should create
both with the right perms and reject any wider permission on read.

### Token refresh

- The `convexJwt` expires every ~60 seconds. Whenever it's within 10s of expiry
  (or any Convex call returns 401 / "invalid auth"), the CLI re-mints it from FAPI:

  ```
  POST https://<frontend-api-host>/v1/client/sessions/<session_id>/tokens/convex
  Authorization: Bearer <clerkSessionToken>
  ```

  and rewrites the cached `convexJwt` + `convexJwtExpiry`.

- The `clerkSessionToken` itself expires per the Clerk Dashboard's session settings
  (default 7 days inactivity, 30 days absolute). When that fails, the CLI surfaces
  "Session expired — please run `vault login` again." There is no refresh-token
  primitive in Clerk; you re-do the browser-link flow.

- If the user revokes this session from the dashboard's `/dashboard/machines` page
  (see §6), every subsequent token mint will fail with `session_revoked`. The CLI
  should treat that the same as expiry: clear the vault and re-prompt for
  `vault login`.

---

## 5. Calling Convex from Python with a Clerk JWT

Use **`ConvexHttpClient`**, not the WebSocket-based `ConvexClient`. Reasons:

- The CLI is short-lived; opening / closing a WebSocket per call is wasteful, and
  reconnection on token-refresh is cleaner with HTTP (just put a fresh `Bearer …` on
  the next request).
- The HTTP client supports `Authorization: Bearer <jwt>` natively (verified in
  `convex-py/python/convex/http_client.py:44-46`).
- The WS client's `set_auth` semantics force a reconnect every time the JWT changes;
  for a CLI making one or two calls per invocation, HTTP avoids that overhead.

> If you later need realtime subscriptions in the CLI (e.g. `vault watch …`),
> switch that command to the WS `ConvexClient` and call `set_auth(token)` once at
> startup. The WS client also accepts `set_auth(None)` / `clear_auth()` to log out.

### Install

```
pip install "convex>=0.7"
```

### Wrapper (sketch)

```python
# vault/_convex.py (example for impl)
from __future__ import annotations
import json, os, time
from pathlib import Path
from typing import Any

import httpx
from convex import ConvexError
from convex.http_client import ConvexHttpClient

VAULT_PATH = Path.home() / ".vault" / "session.json"

class AuthExpired(Exception):
    """Raised when both convexJwt and clerkSessionToken can't be refreshed."""

def _load() -> dict[str, Any]:
    if not VAULT_PATH.exists():
        raise AuthExpired("not logged in — run `vault login`")
    if (VAULT_PATH.stat().st_mode & 0o077) != 0:
        raise AuthExpired(f"{VAULT_PATH} has loose permissions; run `chmod 600`")
    return json.loads(VAULT_PATH.read_text())

def _save(state: dict[str, Any]) -> None:
    VAULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    VAULT_PATH.write_text(json.dumps(state, indent=2))
    VAULT_PATH.chmod(0o600)

def _refresh_convex_jwt(state: dict[str, Any]) -> dict[str, Any]:
    fapi = state["frontendApiUrl"]
    sess = state["clerkSessionId"]
    bearer = state["clerkSessionToken"]
    r = httpx.post(
        f"{fapi}/v1/client/sessions/{sess}/tokens/convex",
        headers={"Authorization": f"Bearer {bearer}"},
        timeout=10.0,
    )
    if r.status_code in (401, 403, 404):
        raise AuthExpired(
            "Clerk session no longer valid (revoked or expired); run `vault login`"
        )
    r.raise_for_status()
    body = r.json()
    state["convexJwt"] = body["jwt"]
    # Clerk session-token JWTs default to 60s; decode exp instead of hardcoding.
    import base64
    payload = json.loads(base64.urlsafe_b64decode(body["jwt"].split(".")[1] + "=="))
    state["convexJwtExpiry"] = payload["exp"]
    _save(state)
    return state

def get_authed_client() -> ConvexHttpClient:
    state = _load()
    if state["convexJwtExpiry"] - time.time() < 10:
        state = _refresh_convex_jwt(state)
    client = ConvexHttpClient(state["convexUrl"])
    client.set_auth(state["convexJwt"])
    return client

def call_with_auth(fn, *args, **kwargs):
    """Call `fn(client, *args, **kwargs)` and retry once on auth failure."""
    try:
        return fn(get_authed_client(), *args, **kwargs)
    except Exception as e:
        # ConvexHttpClient raises a generic Exception with the form
        # "<status_code> <code>: <message>" on HTTP errors.
        msg = str(e)
        if "401" in msg or "Unauthenticated" in msg or "authentication" in msg.lower():
            state = _load()
            state = _refresh_convex_jwt(state)
            return fn(get_authed_client(), *args, **kwargs)
        raise

# Usage:
def whoami() -> dict[str, Any]:
    return call_with_auth(lambda c: c.query("users:current"))
```

### How the Python client surfaces auth failures

`ConvexHttpClient` is intentionally minimal — see
`convex-py/python/convex/http_client.py`:

- It sends `Authorization: Bearer <jwt>` (or `Convex <admin_key>` for admin).
- On a 4xx/5xx, it calls `r.raise_for_status()` then re-raises as a generic
  `Exception` with the form `"{status_code} {response['code']}: {response['message']}"`.
- `ConvexError` is reserved for _application_ errors thrown via `throw new ConvexError(...)`
  inside Convex functions — it doesn't fire on 401.
- There's no built-in retry. The wrapper above does one retry after a forced refresh.

**Detection rule:** treat any of the following as "JWT no longer valid":

- Exception message contains `401`, `Unauthenticated`, or `auth` (case-insensitive)
- `ConvexError` whose `data` mentions `Not authenticated` (this fires when
  `authenticatedQuery` throws because `ctx.auth.getUserIdentity()` returned `null`)

---

## 6. Revoking a machine = revoking a Clerk session

### Listing the user's sessions

Each successful `vault login` produces one Clerk session (one row in
`GET /v1/sessions?user_id=<id>`). The dashboard's `/dashboard/machines` page reads
this list and renders rich metadata including IP and browser/device.

```
GET https://api.clerk.com/v1/sessions?user_id=<id>&status=active
Authorization: Bearer $CLERK_SECRET_KEY
```

Response: an array of `Session` objects. Each contains:

| Field                                                 | Source                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                  | `sess_…`                                                                                                                                |
| `user_id`                                             | the Clerk user                                                                                                                          |
| `client_id`                                           | the Clerk Client object — different per browser/CLI machine                                                                             |
| `status`                                              | `active` / `expired` / `revoked` / `abandoned` / `ended` / `removed` / `replaced`                                                       |
| `last_active_at`                                      | unix ms; updates whenever a JWT is minted from this session                                                                             |
| `created_at`, `updated_at`, `expire_at`, `abandon_at` | unix ms                                                                                                                                 |
| `latest_activity`                                     | `SessionActivity` object — `device_type`, `is_mobile`, `browser_name`, `browser_version`, `ip_address`, `city`, `country` (geo from IP) |
| `last_active_organization_id`                         | optional                                                                                                                                |
| `actor`                                               | impersonation marker                                                                                                                    |

> The `latest_activity.device_type` / `browser_name` columns are populated by Clerk
> from the User-Agent of whichever client minted the most recent token.
> **Action item for impl:** the CLI must send a recognizable
> `User-Agent: cvault-cli/<version> (<os> <arch>; machine=<label>)` on every call to
> Clerk's FAPI so the dashboard can show "MacBook Pro · cvault CLI" instead of just
> "Other / Linux". `latest_activity.ip_address` is set automatically by Clerk from
> the request's source IP — no opt-in needed.

### Augmenting with cvault-side metadata

Clerk's session metadata is good for "where, when, what UA," but cvault may want a
human-meaningful machine label. Persist a row in
`convex/machineActivity` (already in the schema) on every successful CLI sign-in:

| Field            | Value                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `userId`         | `users._id`                                                                                    |
| `clerkSessionId` | `sess_…` (from the ticket exchange response)                                                   |
| `label`          | user-supplied or hostname (`saadings-macbook`)                                                 |
| `firstSeenAt`    | now                                                                                            |
| `lastSeenAt`     | now (updated on every Convex call via a cheap mutation, or relied-on Clerk's `last_active_at`) |

The dashboard `/dashboard/machines` page then joins:

- Convex `machineActivity` (label, first-seen) +
- Clerk session list (status, last_active, IP, UA, geo)

keyed by `clerkSessionId`.

### Revoking from `/dashboard/machines`

The revoke endpoint:

```
POST https://api.clerk.com/v1/sessions/{session_id}/revoke
Authorization: Bearer $CLERK_SECRET_KEY
```

Returns the session object with `status: "revoked"`. After revoke:

- The next CLI attempt to mint a `convex` template token (step 5 in §4) returns
  4xx → CLI surfaces "session revoked, please re-login."
- Any in-flight Convex WS connections from that session also drop on next token
  refresh (60s window).
- The Clerk session is permanently dead — there's no un-revoke; the user must
  `vault login` again to create a new session.

**Convex action wrapper:**

```ts
// convex/machineActivity/actions.ts (does not exist yet — example)
import { v } from 'convex/values'

import { authenticatedAction } from '../utils/auth'

// create alongside auth* helpers

export const revoke = authenticatedAction({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    // Belt and suspenders: confirm the session belongs to this user before revoking
    const owns = await fetch(`https://api.clerk.com/v1/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
    }).then((r) => r.json())
    if (owns.user_id !== ctx.identity.subject) {
      throw new Error('Forbidden')
    }
    const r = await fetch(`https://api.clerk.com/v1/sessions/${sessionId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
    })
    if (!r.ok) throw new Error(`Clerk revoke failed: ${r.status} ${await r.text()}`)
  },
})
```

> `authenticatedAction` doesn't exist in the Blueprint yet — the Blueprint exports
> `authenticatedQuery` and `authenticatedMutation` only. Mirror the pattern for
> `action` (or use `internalAction` + a thin `mutation` wrapper that re-checks
> identity).

Docs: <https://clerk.com/docs/reference/backend/sessions/revoke-session>,
<https://clerk.com/docs/reference/backend/sessions/get-session-list>.

---

## 7. Open questions / caveats for impl-time

### Auth flow

- **Allowed origins:** Clerk Dashboard → Configure → Allowed origins must include
  the dashboard's prod URL. The localhost URL the CLI listens on does NOT need to
  be there — the CLI is making a server-to-server call to FAPI from Python, but
  some Clerk environments validate the `Origin` header on FAPI calls. If the
  ticket exchange fails with `Origin not allowed`, set the CLI's `Origin` header to
  the dashboard origin (e.g. `https://app.cvault.dev`).
- **Bot detection:** Clerk's FAPI applies bot detection to sign-in attempts. The
  ticket strategy bypasses most of it, but if Clerk starts requiring CAPTCHA for
  ticket exchanges in the future, the CLI will need to surface a fallback
  ("open this URL in browser to finish auth"). No known CAPTCHA on tickets today.
- **Sign-in token TTL:** the CLI must redeem the ticket within `expires_in_seconds`
  (we set 600s = 10 minutes). If the user closes the browser tab without
  completing, the CLI listener should time out after ~5 min and ask them to retry.
- **State / nonce:** the `state` query param protects against an attacker tricking
  the user into linking their browser session to _the attacker's_ CLI. The CLI
  generates a random `state`, the dashboard echoes it back in the localhost POST,
  and the CLI verifies it matches before accepting the sign-in token.
- **127.0.0.1 vs localhost:** bind the listener to `127.0.0.1`, not `0.0.0.0`. The
  redirect URL must use `127.0.0.1` (some browsers / privacy extensions block
  `localhost` resolving to other interfaces). Choose a random free port — never
  hardcode.

### Token storage

- **Vault file location:** `~/.vault/session.json` — confirm with the user that
  `~/.vault/` is intended (not `~/.config/cvault/` per XDG). The current name
  `~/.vault/` collides with HashiCorp Vault's tooling on some systems.
- **Encryption at rest:** `chmod 600` is the floor; consider OS keychain
  (macOS Keychain, libsecret on Linux, Windows Credential Manager) for the
  `clerkSessionToken`. The convex-template JWT lives 60 seconds and is fine in
  the file. Use `keyring` PyPI package for cross-OS keychain access.
- **Multi-machine:** each machine = one Clerk session = one
  `~/.vault/session.json`. There is no shared cloud storage of these tokens —
  that would defeat the per-machine revocation model.

### Convex backend

- **`CLERK_SECRET_KEY` in Convex env:** must be set in the Convex deployment
  (`npx convex env set CLERK_SECRET_KEY sk_test_…`) before the `cli.startLink`
  action will work. Local `.env.local` doesn't propagate to Convex.
- **`CLERK_FRONTEND_API_URL` in Convex env:** already required by `auth.config.ts`;
  must be set the same way.
- **Webhook secret:** `CLERK_WEBHOOK_SECRET` (used in
  `convex/utils/validateRequest.ts`) needs to be set in Convex env and the Clerk
  webhook endpoint must point at `$CONVEX_SITE_URL/webhooks/clerk`.
- **`authenticatedAction` helper missing:** Blueprint only ships
  `authenticatedQuery` / `authenticatedMutation`. Add a matching `authenticatedAction`
  in `convex/utils/auth.ts` (same shape) before §6's revoke endpoint can be written
  cleanly.
- **`fetch` from Convex actions:** sign-in token mint and session revoke both call
  Clerk BAPI from Convex actions. Convex's Node action runtime supports `fetch`
  directly. No HTTP client library install needed.

### Frontend

- **SPA mode forces client-only auth checks:** any pattern from the Clerk docs that
  uses `auth()` from `@clerk/tanstack-react-start/server` will not work here
  (no server runtime). All checks must use `useAuth`/`useUser`/`<Show>`. If a
  feature genuinely needs server-side identity, that's a signal to flip
  `spa.enabled: false` and stand up a Vinxi server — talk to the user before doing
  that.
- **Custom dark sign-in:** Blueprint already passes `appearance={{ baseTheme: dark }}`
  to `<ClerkProvider>`. If shadcn parity is wanted, install `@clerk/ui` and switch
  to `appearance={{ theme: shadcn }}` plus
  `@import '@clerk/ui/themes/shadcn.css'` in `frontend/src/styles.css`.
- **`@clerk/themes` vs `@clerk/ui`:** Blueprint imports from `@clerk/themes`
  (older). Current docs route to `@clerk/ui`. Both work; no need to migrate as
  part of this work.

### Clerk caveats

- **No native OAuth Device Authorization Grant (RFC 8628)** for end-user sessions
  in your own app. Sign-in token + ticket is the de-facto equivalent.
- **Sign-in tokens are single-use.** A second `attemptFirstFactor` with the same
  ticket fails. Don't retry exchange — re-issue from `cli.startLink`.
- **Session JWT lifetime is short (60s)** by design. Anything cached from a JWT
  (e.g. `org_id`) is stale within a minute. Don't memoize across calls.
- **Clerk Backend API rate limits:** prod 1000/10s, dev 100/10s. The CLI minting
  one token every 60s is fine; mass-revoke from the dashboard could hit limits if
  many machines are revoked at once — handle 429 with backoff.
- **Per-user API keys (beta):** if Clerk ships these out of beta with proper
  per-token revocation, they may eventually be a better fit than session tokens
  for CLI auth (no 60s refresh cycle). Re-evaluate then.

### Testing

- **Clerk test users:** use `pk_test_…` / `sk_test_…` only in tests. The
  `clerk-testing` skill recommends `setupClerkTestingToken()` to bypass bot
  detection in Playwright. For CLI integration tests, hit a dev Clerk tenant and
  call `POST /v1/sign_in_tokens` directly to skip the browser UI.
- **Mock Convex:** use `convex-test` (the JS package) for backend unit tests.
  The Python CLI's tests can mock `httpx` and `ConvexHttpClient` rather than
  hitting a live deployment.

---

## Documentation references

- Clerk + TanStack Start quickstart:
  <https://clerk.com/docs/tanstack-react-start/getting-started/quickstart>
- Clerk + Convex integration guide:
  <https://clerk.com/docs/guides/development/integrations/databases/convex>
- Convex auth with Clerk:
  <https://docs.convex.dev/auth/clerk>
- Clerk JWT templates:
  <https://clerk.com/docs/guides/sessions/jwt-templates>
- Clerk session token refresh:
  <https://clerk.com/docs/guides/sessions/force-token-refresh>
- Clerk Backend API — Sessions:
  - List: <https://clerk.com/docs/reference/backend/sessions/get-session-list>
  - Get: <https://clerk.com/docs/reference/backend/sessions/get-session>
  - Revoke: <https://clerk.com/docs/reference/backend/sessions/revoke-session>
  - Get token: <https://clerk.com/docs/reference/backend/sessions/get-token>
- Clerk Backend API — Sign-in tokens:
  - Create: <https://clerk.com/docs/reference/backend/sign-in-tokens/create-sign-in-token>
- Clerk SignIn `ticket()` strategy:
  <https://clerk.com/docs/guides/development/custom-flows/authentication/embedded-email-links>
- Clerk Manual JWT verification (issuer, JWKS, claims):
  <https://clerk.com/docs/backend-requests/handling/manual-jwt>
- Convex Python client:
  - PyPI: <https://pypi.org/project/convex/>
  - Source: <https://github.com/get-convex/convex-py>
  - WS client: `python/convex/__init__.py`
  - HTTP client: `python/convex/http_client.py`
- TanStack Start auth quickstart pattern:
  <https://github.com/clerk/clerk-docs/blob/main/docs/getting-started/quickstart.tanstack-react-start.mdx>

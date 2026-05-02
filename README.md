# cvault

Centralized Claude Code credential vault. Sync Claude subscriptions across machines, auto-refresh tokens, view usage from one dashboard.

cvault reads/writes Claude Code's macOS Keychain entry (and the Linux/WSL credentials file) directly via a native TypeScript module — no Python or other runtime dependencies.

---

## Security model

cvault is intended for **single-user developer machines** (your personal Mac).

On macOS, the CLI calls `/usr/bin/security` to read/write the Claude Code Keychain item. The write path passes the OAuth blob via argv, which means it is briefly visible via `ps auxww` to processes running as the same user during the call (typically tens of milliseconds). Other users on the system cannot see it; macOS process accounting requires the same UID or root to read another process's argv.

Why argv and not a "safer" form:

- **stdin-prompt form** (`security add-generic-password -w` with no value, blob piped on stdin) silently truncates at 128 bytes — Claude Code's OAuth blob is 180-300 bytes. Pinned by the integration test.
- **`bun:ffi` to `SecKeychainAddGenericPassword`** works mechanically, but items written by the cvault binary have a different Keychain ACL than items written by `/usr/bin/security` or by Claude Code itself. Cross-binary reads then trigger a SecurityAgent prompt every time, which is unacceptable UX. Verified empirically during build.

**Do not run cvault on shared/multi-tenant machines** (shared CI runners, build farms, classroom Macs, or any machine where another user has shell access as your UID). The argv leak is acceptable on a personal box but not in a multi-tenant context.

On Linux/WSL, credentials live in `~/.claude/.credentials.json` with mode 0600 (file system permissions are the only enforcement; same caveats apply to multi-tenant systems).

---

## Quickstart

### 1. Prerequisites

- Node 22+, [Yarn 4](https://yarnpkg.com/), [Bun](https://bun.sh/) ≥ 1.2
- The `claude` CLI (Claude Code) on `PATH` — required for `cvault add` (interactive OAuth flow)
- Clerk + Convex accounts

### 2. Clone + install

```bash
git clone https://github.com/flatoutsolutions/cvault.git
cd cvault
yarn install
```

### 3. Configure

Create `.env.local`:

```bash
# Convex (run `npx convex dev` first to provision a deployment)
CONVEX_DEPLOYMENT=dev:<your-deployment>
VITE_CONVEX_URL=https://<your-deployment>.convex.cloud
VITE_CONVEX_SITE_URL=https://<your-deployment>.convex.site

# Clerk (from your Clerk dashboard)
CLERK_FRONTEND_API_URL=https://<your-tenant>.clerk.accounts.dev
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# CLI dashboard URL
CVAULT_DASHBOARD_URL=http://localhost:3000
```

In the Convex dashboard set the same Clerk vars + a master encryption key:

```bash
npx convex env set VAULT_AES_KEY $(openssl rand -base64 32)
npx convex env set CLERK_FRONTEND_API_URL https://<your-tenant>.clerk.accounts.dev
npx convex env set CLERK_SECRET_KEY sk_test_...
npx convex env set CLERK_WEBHOOK_SECRET whsec_...
```

In Clerk dashboard:

- Create a JWT template named `convex` (preset "Convex"), `aud: convex`
- Add a webhook → URL `<VITE_CONVEX_SITE_URL>/webhooks/clerk`, events `user.created/updated/deleted`

### 4. Run

```bash
yarn dev                    # Vite frontend + Convex dev watcher
# Open http://localhost:3000 → sign in → empty dashboard
```

### 5. CLI

```bash
cd cli
bun install
bun run src/index.ts -- login              # browser → Clerk → ~/.vault/session.json
bun run src/index.ts -- list                # empty
bun run src/index.ts -- add                 # captures active Claude Code login
bun run src/index.ts -- list                # 1 sub
bun run src/index.ts -- switch <slot|email>
bun run src/index.ts -- status
bun run src/index.ts -- refresh <slot|email>
bun run src/index.ts -- remove <slot|email>
bun run src/index.ts -- sync --all          # bootstrap on a new machine
bun run src/index.ts -- clean               # clear active credentials + last-hash cache
                                            # (server vault + login preserved; --yes to skip prompt)
```

Or build a static binary:

```bash
bun build --compile --target=bun-darwin-arm64 ./src/index.ts --outfile cvault
codesign --force --sign - ./cvault          # macOS only — required to avoid SIGKILL
./cvault login
```

---

## Configuration reference

CLI reads (highest precedence first):

1. `CVAULT_CONVEX_URL`, `CVAULT_FRONTEND_API_URL`, `CVAULT_DASHBOARD_URL`
2. Repo `.env.local`: `VITE_CONVEX_URL`, `CLERK_FRONTEND_API_URL`
3. `~/.vault/config.json`: `{convexUrl, frontendApiUrl, dashboardUrl}`

Missing values throw a clear error with remediation steps.

---

## Repo layout

```
convex/      Convex backend (schemas, queries, mutations, actions, crons, http)
frontend/    TanStack Start dashboard
cli/         TypeScript+Bun CLI (`cvault`)
docs/        Spec + research briefs + manual testing playbook
.github/     Release pipeline
Formula/     Homebrew tap formula
```

---

## Stack

| Layer    | Tech                                                                    |
| -------- | ----------------------------------------------------------------------- |
| Backend  | Convex (DB, functions, real-time, cron, HTTP)                           |
| Frontend | React 19 + TanStack Start + shadcn/ui + Tailwind v4                     |
| Auth     | Clerk (Convex JWT template + webhooks)                                  |
| CLI      | TypeScript on Bun (`citty`, `convex/browser`, `Bun.spawn`, `Bun.serve`) |
| Tests    | Vitest + Testing Library + `convex-test`                                |

---

## Docs

- **Manual testing**: [`docs/MANUAL_TESTING.md`](docs/MANUAL_TESTING.md)
- **Design spec**: [`docs/superpowers/specs/2026-05-02-cvault-design.md`](docs/superpowers/specs/2026-05-02-cvault-design.md)
- **Research briefs**: [`docs/research/`](docs/research/)
- **Implementation notes / handoffs**: [`IMPLEMENTATION_NOTES.md`](IMPLEMENTATION_NOTES.md)
- **Reviews**: [`docs/reviews/`](docs/reviews/)

---

## License

MIT

# cvault

Centralized Claude Code credential vault. Sync Claude subscriptions across machines, auto-refresh tokens, view usage from one dashboard.

Wraps [`claude-swap`](https://github.com/realiti4/claude-swap) with a Convex-backed sync layer.

---

## Quickstart

### 1. Prerequisites

- Node 22+, [Yarn 4](https://yarnpkg.com/), [Bun](https://bun.sh/) ≥ 1.2
- [`claude-swap`](https://github.com/realiti4/claude-swap) installed (`uv tool install claude-swap`)
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

| Layer | Tech |
|---|---|
| Backend | Convex (DB, functions, real-time, cron, HTTP) |
| Frontend | React 19 + TanStack Start + shadcn/ui + Tailwind v4 |
| Auth | Clerk (Convex JWT template + webhooks) |
| CLI | TypeScript on Bun (`citty`, `convex/browser`, `Bun.spawn`, `Bun.serve`) |
| Tests | Vitest + Testing Library + `convex-test` |

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

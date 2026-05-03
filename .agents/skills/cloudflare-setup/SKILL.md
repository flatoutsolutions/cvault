---
name: cloudflare-setup
displayName: Cloudflare Pages Project Setup
description: Guidance for setting up and managing Cloudflare Pages projects using the setupCloudflareProject.ts script. Covers prerequisites, environment variables, CLI usage, and CI/CD integration.
version: 1.0.0
tags: [cloudflare, deployment, pages, infrastructure]
---

# Cloudflare Pages Project Setup

This skill covers creating and managing Cloudflare Pages projects for static site deployments using the project's `setupCloudflareProject.ts` script.

## Overview

The project uses a standalone TypeScript script (`scripts/setupCloudflareProject.ts`) to create a Cloudflare Pages project via the Cloudflare API. It is **idempotent** — if the project already exists, it exits cleanly.

## Prerequisites

### Environment Variables

The script requires two environment variables, sourced from `.env.local` at the project root or from `process.env`:

| Variable                | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API token with Pages write permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                             |

> [!IMPORTANT]
> These variables must be set **before** running the script. For local use, add them to `.env.local`. For CI/CD, configure them as GitHub Actions secrets.

### Creating an API Token

1. Go to [Cloudflare Dashboard → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use the **Edit Cloudflare Workers** template or create a custom token with:
   - **Account → Cloudflare Pages → Edit** permission
4. Copy the generated token into `CLOUDFLARE_API_TOKEN`

## Usage

### Running Locally

```bash
npx tsx scripts/setupCloudflareProject.ts
```

### CLI Options

| Flag                  | Default      | Description                    |
| --------------------- | ------------ | ------------------------------ |
| `--project-name`      | `blueprint2` | Cloudflare Pages project name  |
| `--production-branch` | `main`       | Git branch used for production |

#### Examples

```bash
# Use defaults (project: blueprint2, branch: main)
npx tsx scripts/setupCloudflareProject.ts

# Custom project name
npx tsx scripts/setupCloudflareProject.ts --project-name my-app

# Custom project name and branch
npx tsx scripts/setupCloudflareProject.ts --project-name my-app --production-branch production
```

## How It Works

1. **Loads env vars** from `.env.local` via `dotenv`
2. **Checks existence** — calls `GET /accounts/{id}/pages/projects/{name}`
3. **Skips if exists** — prints a success message and exits
4. **Creates if missing** — calls `POST /accounts/{id}/pages/projects` with `name` and `production_branch`
5. **Reports result** — logs success or a detailed error with Cloudflare error codes

## CI/CD Integration

### GitHub Actions

In the deployment workflow, this script should run **before** the `wrangler pages deploy` step to ensure the Pages project exists:

```yaml
- name: Setup Cloudflare Pages project
  run: npx tsx scripts/setupCloudflareProject.ts --project-name ${{ vars.CLOUDFLARE_PROJECT_NAME }}
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

### Required GitHub Secrets & Variables

| Name                      | Type     | Description                   |
| ------------------------- | -------- | ----------------------------- |
| `CLOUDFLARE_API_TOKEN`    | Secret   | Cloudflare API token          |
| `CLOUDFLARE_ACCOUNT_ID`   | Secret   | Cloudflare account ID         |
| `CLOUDFLARE_PROJECT_NAME` | Variable | Cloudflare Pages project name |

## Troubleshooting

### `❌ Missing CLOUDFLARE_API_TOKEN environment variable`

The `CLOUDFLARE_API_TOKEN` is not set. Add it to `.env.local` or export it in your shell.

### `❌ Failed to create project: A project with this name already exists [code: 8000007]`

This should not happen with the current script since it checks for existence first. If it does, verify that the Cloudflare API token has read access to Pages.

### API token permission errors

Ensure the token has **Account → Cloudflare Pages → Edit** permission. Read-only tokens cannot create projects.

## Related Files

- [`scripts/setupCloudflareProject.ts`](file:///scripts/setupCloudflareProject.ts) — The setup script
- [`.env.local`](file:///.env.local) — Local environment variables
- [`.github/workflows/deploy.yml`](file:///.github/workflows/deploy.yml) — CI/CD workflow

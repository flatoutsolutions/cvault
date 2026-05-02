#!/usr/bin/env tsx
/**
 * Setup Cloudflare Pages Project
 *
 * Creates a Cloudflare Pages project if it doesn't already exist.
 * Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID environment
 * variables (reads from .env.local or process env).
 *
 * Usage:
 *   npx tsx scripts/setupCloudflareProject.ts
 *   npx tsx scripts/setupCloudflareProject.ts --project-name my-project
 *   npx tsx scripts/setupCloudflareProject.ts --production-branch main
 */
import { resolve } from 'path'

import { config } from 'dotenv'

// Load .env.local from project root
config({ path: resolve(import.meta.dirname, '..', '.env.local') })

const args = process.argv.slice(2)
// ─── CLI args ───────────────────────────────────────────────────────

function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback
}

const projectName = getArg('--project-name', 'blueprint2')
const productionBranch = getArg('--production-branch', 'main')

// ─── Env vars ───────────────────────────────────────────────────────

const apiToken = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID

if (!apiToken) {
  console.error('❌ Missing CLOUDFLARE_API_TOKEN environment variable')
  process.exit(1)
}

if (!accountId) {
  console.error('❌ Missing CLOUDFLARE_ACCOUNT_ID environment variable')
  process.exit(1)
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log(`\n☁️  Cloudflare Pages Project Setup`)
  console.log('='.repeat(50))
  console.log(`   Project:    ${projectName}`)
  console.log(`   Branch:     ${productionBranch}`)
  console.log(`   Account:    ${accountId}\n`)

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`

  // Check if project already exists
  console.log('🔍 Checking if project exists...')
  const checkResponse = await fetch(`${url}/${projectName}`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  })

  const checkData = (await checkResponse.json()) as { success: boolean }

  if (checkData.success) {
    console.log(`✅ Project "${projectName}" already exists. Nothing to do.`)
    return
  }

  // Create the project
  console.log('📦 Creating project...')
  const createResponse = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: projectName,
      production_branch: productionBranch,
    }),
  })

  const createData = (await createResponse.json()) as {
    success: boolean
    errors?: { message: string; code: number }[]
  }

  if (createData.success) {
    console.log(`✅ Project "${projectName}" created successfully!`)
  } else {
    const errorMsg = createData.errors?.map((e) => `${e.message} [code: ${e.code}]`).join(', ') || 'Unknown error'
    console.error(`❌ Failed to create project: ${errorMsg}`)
    process.exit(1)
  }
}

void main()

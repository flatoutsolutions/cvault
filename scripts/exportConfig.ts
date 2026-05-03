#!/usr/bin/env tsx
/**
 * Export Config — Convex Environment Variables + Database Settings
 *
 * Exports all environment variables and settings table rows from the
 * current Convex deployment into a single JSON file. This file can
 * then be used with `importConfig.ts` to bootstrap another environment.
 *
 * The output file (convex-config.json) is gitignored — it contains
 * credentials and must NOT be committed.
 *
 * Usage:
 *   npx tsx scripts/exportConfig.ts                    # export from dev
 *   npx tsx scripts/exportConfig.ts --prod              # export from prod
 *   npx tsx scripts/exportConfig.ts -o myconfig.json    # custom output path
 */
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

// ─── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2)
const isProd = args.includes('--prod')
const outputIndex = args.indexOf('-o')
const projectDir = resolve(dirname(new URL(import.meta.url).pathname), '..')
const defaultOutputFile = resolve(projectDir, 'convex-config.json')
const outputFile = outputIndex !== -1 && args[outputIndex + 1] ? resolve(args[outputIndex + 1]) : defaultOutputFile

const convexFlags = isProd ? '--prod' : ''

// ─── Helpers ────────────────────────────────────────────────────────

function run(cmd: string): string {
  return execSync(cmd, {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

// ─── Export env vars ────────────────────────────────────────────────

function exportEnvVars(): Record<string, string> {
  console.log('📦 Exporting environment variables...')

  let listOutput: string
  try {
    listOutput = run(`npx convex env list ${convexFlags}`)
  } catch {
    console.log('   No environment variables found.')
    return {}
  }

  if (!listOutput || listOutput.includes('No environment variables') || listOutput.trim() === '') {
    console.log('   No environment variables found.')
    return {}
  }

  const envVars: Record<string, string> = {}
  const lines = listOutput.split('\n').filter((l) => l.includes('='))

  for (const line of lines) {
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue
    const name = line.substring(0, eqIdx).trim()
    if (!name) continue

    // Get the full value (handles multi-line values)
    try {
      const value = run(`npx convex env get "${name}" ${convexFlags}`)
      envVars[name] = value
      console.log(`   ✓ ${name}`)
    } catch {
      console.log(`   ✗ ${name} (failed to read)`)
    }
  }

  return envVars
}

/**
 * Export the unified settings row via an internal query (no auth needed).
 * Returns all settings fields (fully dynamic — no field hardcoding).
 */
function exportSettings(): Record<string, unknown> | null {
  console.log('\n⚙️  Exporting database settings...')

  try {
    const output = run(`npx convex run ${convexFlags} --no-push "settings:getInternal" '{}'`)
    const result = JSON.parse(output) as Record<string, unknown>
    if (result && typeof result === 'object') {
      // Strip Convex internal fields
      delete result._id
      delete result._creationTime
      const fields = Object.keys(result)
      if (fields.length > 0) {
        console.log(`   ✓ settings (${fields.length} field(s): ${fields.join(', ')})`)
        return result
      }
    }
  } catch {
    // Query failed
  }

  console.log('   ○ settings (empty)')
  return null
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
  const deployment = isProd ? 'production' : 'development'
  console.log(`\n🔧 Convex Config Export (${deployment})`)
  console.log('='.repeat(60))

  const envVars = exportEnvVars()
  const settings = exportSettings()

  const config: Record<string, unknown> = {
    _meta: {
      exportedAt: new Date().toISOString(),
      deployment,
    },
    envVars,
  }
  if (settings) {
    config.settings = settings
  }

  writeFileSync(outputFile, JSON.stringify(config, null, 2) + '\n')

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Exported to: ${outputFile}`)
  console.log(`   ${Object.keys(envVars).length} env var(s), ${settings ? '1' : '0'} settings table(s)`)
  console.log(`\n⚠️  This file contains credentials — do NOT commit it!`)
}

main()

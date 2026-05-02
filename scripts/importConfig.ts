#!/usr/bin/env tsx
/**
 * Import Config — Convex Environment Variables + Database Settings
 *
 * Reads a convex-config.json file (produced by exportConfig.ts) and
 * imports all environment variables and settings into the current
 * Convex deployment.
 *
 * The settings import is fully dynamic: every field in the exported
 * settings object is imported — no need to update this script when
 * new settings categories are added.
 *
 * Usage:
 *   npx tsx scripts/importConfig.ts                        # import to dev
 *   npx tsx scripts/importConfig.ts -i myconfig.json       # custom input
 *   npx tsx scripts/importConfig.ts --env-only             # env vars only
 *   npx tsx scripts/importConfig.ts --settings-only        # settings only
 */
import { execSync } from 'child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

// ─── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2)
const envOnly = args.includes('--env-only')
const settingsOnly = args.includes('--settings-only')
const inputIndex = args.indexOf('-i')
const projectDir = resolve(dirname(new URL(import.meta.url).pathname), '..')
const defaultInputFile = resolve(projectDir, 'convex-config.json')
const inputFile = inputIndex !== -1 && args[inputIndex + 1] ? resolve(args[inputIndex + 1]) : defaultInputFile

// ─── Helpers ────────────────────────────────────────────────────────

function run(cmd: string): string {
  return execSync(cmd, {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

// ─── Import env vars ────────────────────────────────────────────────

function importEnvVars(envVars: Record<string, string>) {
  console.log('📦 Importing environment variables...')
  const entries = Object.entries(envVars)

  if (entries.length === 0) {
    console.log('   No env vars to import.')
    return
  }

  let count = 0
  for (const [name, value] of entries) {
    try {
      // Write value to a temp file to avoid shell escaping issues
      const tmpFile = `/tmp/convex-env-${name}.txt`
      writeFileSync(tmpFile, value)
      run(`npx convex env set "${name}" -- "$(cat '${tmpFile}')"`)
      try {
        unlinkSync(tmpFile)
      } catch {
        /* ignore */
      }
      console.log(`   ✓ ${name}`)
      count++
    } catch {
      // Fallback: try direct approach
      try {
        run(`npx convex env set "${name}" '${value.replace(/'/g, "'\\''")}'`)
        console.log(`   ✓ ${name}`)
        count++
      } catch {
        console.log(`   ✗ ${name} (failed)`)
      }
    }
  }

  console.log(`   Imported ${count}/${entries.length} env var(s).`)
}

// ─── Import settings ────────────────────────────────────────────────

/**
 * Import the settings row via an internal mutation.
 * Fully dynamic: passes all exported settings fields through.
 * The mutation handles stripping internal Convex fields and upserting.
 */
function importSettings(settings: Record<string, unknown>) {
  console.log('\n⚙️  Importing database settings...')

  const fields = Object.keys(settings)
  if (fields.length === 0) {
    console.log('   No settings to import.')
    return
  }

  console.log(`   Fields: ${fields.join(', ')}`)

  const tmpFile = `/tmp/convex-import-settings.json`
  writeFileSync(tmpFile, JSON.stringify({ settings }))

  try {
    const output = run(`npx convex run --no-push "settings:importInternal" "$(cat '${tmpFile}')"`)
    const result = JSON.parse(output) as { action?: string; fields?: string[] }
    console.log(`   ✓ settings (${result.action ?? 'unknown'}, ${result.fields?.length ?? 0} field(s))`)
  } catch (err) {
    console.log(`   ✗ settings (failed: ${err instanceof Error ? err.message : String(err)})`)
  } finally {
    try {
      unlinkSync(tmpFile)
    } catch {
      /* ignore */
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
  if (!existsSync(inputFile)) {
    console.error(`\n❌ File not found: ${inputFile}`)
    console.error(`\nRun 'npx tsx scripts/exportConfig.ts' first to create it.`)
    process.exit(1)
  }

  console.log(`\n🔧 Convex Config Import`)
  console.log('='.repeat(60))
  console.log(`   Source: ${inputFile}`)

  const raw = readFileSync(inputFile, 'utf-8')
  const config = JSON.parse(raw) as {
    _meta?: { exportedAt: string; deployment: string }
    envVars?: Record<string, string>
    settings?: Record<string, unknown>
  }

  if (config._meta) {
    console.log(`   Exported: ${config._meta.exportedAt}`)
    console.log(`   From: ${config._meta.deployment}`)
  }
  console.log('')

  if (!settingsOnly && config.envVars) {
    importEnvVars(config.envVars)
  }

  if (!envOnly && config.settings) {
    importSettings(config.settings)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log('✅ Import complete!')
}

main()

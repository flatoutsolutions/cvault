#!/usr/bin/env bun
/**
 * cvault CLI entry point.
 *
 * Wires every subcommand under a single citty command tree. Subcommands
 * are lazy-loaded (citty supports `() => import(...)` for code splitting,
 * but `bun build --compile` bakes them all into the binary anyway).
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * NOTE on the dispatch: we intentionally do NOT use citty's `runMain`.
 * `runMain` wraps the command body in its own try/catch that pipes the
 * thrown error through consola's "fancy" reporter — that turns a clean
 * server-side `ConvexError({code, message})` into a noisy
 * `ERROR  [Request ID: ...] Server Error\nUncaught ConvexError: {...}`
 * stack-trace dump and then calls `process.exit(1)` synchronously. That
 * means any `runMain(...).catch(...)` we attach is dead code (the promise
 * never rejects to us) and we lose the chance to format the error. So we
 * call `runCommand` directly + reimplement the trivial `--help` /
 * `--version` shortcuts here, which gives us a reachable top-level catch.
 */
import { defineCommand, runCommand, showUsage } from 'citty'

import pkg from '../package.json' with { type: 'json' }
import { addCommand } from './commands/add'
import { cleanCommand } from './commands/clean'
import { exportCommand } from './commands/exportBackup'
import { importCommand } from './commands/importBackup'
import { listCommand } from './commands/list'
import { loginCommand } from './commands/login'
import { logoutCommand } from './commands/logout'
import { pullCommand } from './commands/pull'
import { removeCommand } from './commands/remove'
import { rotateKeyCommand } from './commands/rotateKey'
import { statusCommand } from './commands/status'
import { switchCommand } from './commands/switch'
import { syncCommand } from './commands/sync'
import { upgradeCommand } from './commands/upgrade'
import { formatCliError } from './render/cliError'

const main = defineCommand({
  meta: {
    name: 'cvault',
    version: pkg.version,
    description: 'Centralized Claude Code credential vault.',
  },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    add: addCommand,
    pull: pullCommand,
    list: listCommand,
    switch: switchCommand,
    remove: removeCommand,
    status: statusCommand,
    sync: syncCommand,
    clean: cleanCommand,
    'rotate-key': rotateKeyCommand,
    export: exportCommand,
    import: importCommand,
    upgrade: upgradeCommand,
  },
})

async function dispatch(rawArgs: string[]): Promise<void> {
  // `--help` / `-h` and `--version` are top-level shortcuts that citty's
  // own `runMain` handles. We replicate them here because we bypass
  // `runMain` — see the note at the top of the file.
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    await showUsage(main)
    return
  }
  if (rawArgs.length === 1 && rawArgs[0] === '--version') {
    console.log(pkg.version)
    return
  }
  await runCommand(main, { rawArgs })
}

/**
 * citty's internal `CLIError` carries `error.name === 'CLIError'`; it's
 * thrown for arg-parse and dispatch failures (`E_NO_COMMAND`,
 * `E_UNKNOWN_COMMAND`, `EARG`). Detected by the public `name` field
 * because the class itself isn't exported. We mirror citty's
 * "show-usage-on-CLIError" UX so `cvault unknowncmd` still prints help.
 */
function isCittyCliError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'CLIError'
}

dispatch(process.argv.slice(2)).catch(async (err: unknown) => {
  const formatted = formatCliError(err)
  if (formatted !== null) {
    console.error(formatted)
    process.exit(1)
  }
  if (isCittyCliError(err)) {
    await showUsage(main)
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
  // Fallback for any other throw — preserves the previous behavior so
  // unexpected exceptions still surface their message without a stack
  // trace.
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`error: ${msg}`)
  process.exit(1)
})

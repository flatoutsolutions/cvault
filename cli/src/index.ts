#!/usr/bin/env bun
/**
 * cvault CLI entry point.
 *
 * Wires every subcommand under a single citty command tree. Subcommands
 * are lazy-loaded (citty supports `() => import(...)` for code splitting,
 * but `bun build --compile` bakes them all into the binary anyway).
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 */
import { defineCommand, runMain } from 'citty'

import pkg from '../package.json' with { type: 'json' }
import { addCommand } from './commands/add'
import { cleanCommand } from './commands/clean'
import { listCommand } from './commands/list'
import { loginCommand } from './commands/login'
import { refreshCommand } from './commands/refresh'
import { removeCommand } from './commands/remove'
import { statusCommand } from './commands/status'
import { switchCommand } from './commands/switch'
import { syncCommand } from './commands/sync'

const main = defineCommand({
  meta: {
    name: 'cvault',
    version: pkg.version,
    description: 'Centralized Claude Code credential vault.',
  },
  subCommands: {
    login: loginCommand,
    add: addCommand,
    list: listCommand,
    switch: switchCommand,
    refresh: refreshCommand,
    remove: removeCommand,
    status: statusCommand,
    sync: syncCommand,
    clean: cleanCommand,
  },
})

runMain(main).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`error: ${msg}`)
  process.exit(1)
})

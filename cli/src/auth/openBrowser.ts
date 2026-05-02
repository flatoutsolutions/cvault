/**
 * Open a URL in the user's default browser. Best-effort: if the launch
 * fails (no GUI, missing tool), the CLI prints the URL so the user can
 * copy/paste it.
 *
 * Per docs/research/ts-bun-cli-tooling.md §3.3 — `Bun.spawn(['open', url])`
 * is the macOS one-liner; xdg-open / cmd start cover the other two
 * platforms we ship binaries for.
 */
export async function openBrowser(url: string): Promise<void> {
  let cmd: string[]
  switch (process.platform) {
    case 'darwin':
      cmd = ['open', url]
      break
    case 'win32':
      // cmd /c start "" <url>  — the empty quoted title argument prevents
      // `start` from interpreting the URL as the title.
      cmd = ['cmd', '/c', 'start', '""', url]
      break
    default:
      // linux + other POSIX systems
      cmd = ['xdg-open', url]
      break
  }

  try {
    const proc = Bun.spawn({ cmd, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
  } catch {
    // Best-effort — we don't surface a failure here. The login command
    // prints the URL right after this returns so the user has a fallback.
  }
}

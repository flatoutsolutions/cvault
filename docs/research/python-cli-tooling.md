# cvault — Python CLI Tooling Reference Brief

**Date:** 2026-05-02
**Status:** Research output, drives §7 (CLI) implementation of [`/docs/superpowers/specs/2026-05-02-cvault-design.md`](../superpowers/specs/2026-05-02-cvault-design.md)
**Audience:** the engineer building `cvault` (Python 3.11+, distributed via `uv tool install vault-cli`, binary `cvault`)

---

## TL;DR — picks at the top

| Concern | Pick | Reason (one line) |
|---|---|---|
| Argument parser | **typer** | Type-hint-driven, generates `cvault --install-completion`, fits 8 verbs cleanly; thin layer over Click so no maturity risk. |
| Convex SDK | **`convex` 0.7.0** (PyPI) | Only official client; sync `query/mutation/action`, `set_auth(jwt)`. No HTTP-action call (use `httpx`). |
| Subprocess wrapper | **`subprocess.run(..., check=True, capture_output=True, text=True)`** | Stdlib, deterministic; missing-binary handled via `FileNotFoundError`. |
| HTTP client | **`httpx` + `tenacity`** | `httpx.HTTPTransport(retries=N)` only retries connect errors — `tenacity` decorates the call for 5xx. |
| Config dir | **`~/.vault/`** (literal, no `platformdirs`) | Spec is Mac-first v1; literal path matches §7 user expectation; `platformdirs` is a future v2 lift. |
| Build backend | **hatchling** | Same backend `claude-swap` ships with; rock-solid for `uv tool install`. |
| Test framework | **pytest** (mandated) | + `pytest-subprocess` for clean `claude-swap` mocking. |
| Linter / formatter | **ruff** (linter + formatter, both) | Single tool, `astral-sh` ecosystem aligns with `uv`. |
| Type checker | **mypy** (`--strict`) | `convex` ships only `.pyi` from `_convex` Rust ext — mypy plays cleanly; pyright's stricter inference creates noise on dynamic Convex return types. |

---

## 1. Argument parser — `typer`

### Picked: typer ≥ 0.12

### Justification

- **8 commands w/ subcommand-style args** (login, add, list, switch, refresh, remove, status, sync) is the sweet spot where `argparse`'s `add_subparsers` becomes verbose and `click`'s decorator stack starts to pay off — `typer` simplifies further by reusing Python type hints as parameter types.
- **Help quality:** Typer's auto-generated `--help` is colorized, alphabetized, and groups options vs args automatically. Argparse output is plain and noisier.
- **Shell completion:** `cvault --install-completion` generates bash/zsh/fish completion scripts. Argparse has none built-in. Click has it but you must wire it up. Typer's the lowest-effort path for `cvault list`/`cvault switch <slot|email>` autocompletion.
- **DX:** A subcommand is just `@app.command()` over a function with type-hinted params (`slot: int`, `email: str | None = None`). Single-source signature → help, validation, completion.
- **Dependency weight:** typer pulls click + rich-click. Both already standard in Python CLI ecosystem; total install < 2 MB.
- **Risk:** Typer is a thin layer over Click — if we ever need lower-level control we drop down without rewrite.

### Why not the others

- **argparse** (claude-swap's choice): zero-dep but verbose for our shape. Each command becomes its own subparser block, mutually-exclusive groups, manual completion. Only wins on "no extra deps" — irrelevant for a tool that already ships `httpx`, `convex`, `cryptography`.
- **click**: solid alternative; pick this only if Typer's type-hint inference ever fights us. For v1, no reason to skip Typer.

### Skeleton

```python
# src/cvault/cli.py
import typer
from cvault.commands import login, add, list_subs, switch, refresh, remove, status, sync

app = typer.Typer(
    name="cvault",
    help="Centralized Claude Code credential vault.",
    no_args_is_help=True,
    add_completion=True,
)

app.command("login")(login.run)
app.command("add")(add.run)
app.command("list")(list_subs.run)
app.command("switch")(switch.run)
app.command("refresh")(refresh.run)
app.command("remove")(remove.run)
app.command("status")(status.run)
app.command("sync")(sync.run)

def main() -> None:
    app()
```

---

## 2. Convex Python SDK

### Package

- **PyPI:** `convex` (https://pypi.org/project/convex/)
- **Latest version:** `0.7.0` (uploaded 2024-12-17, still current as of research date)
- **Repo:** https://github.com/get-convex/convex-py
- **`requires-python`:** `>=3.9` (compatible with our 3.11+ floor)
- **License:** MIT
- **Implementation note:** Wraps a Rust core (`_convex` PyO3 module) over a WebSocket transport — sync only, no asyncio.

### Supported / not supported

| Feature | Supported | Notes |
|---|---|---|
| Queries | yes | `client.query(name, args)` — args optional |
| Mutations | yes | `client.mutation(name, args)` |
| Actions | yes | `client.action(name, args)` |
| Subscriptions | yes | `client.subscribe(name, args)` returns iterable of result snapshots; blocks until `break` |
| HTTP actions | no | Not callable through SDK — use `httpx` direct to `https://<deployment>.convex.site/api/cli/sync` |
| Pagination | manual | Pass `paginationOpts={"numItems": N, "cursor": cursor}`, read `result['continueCursor']` and `result['isDone']` |
| Async API | no | Sync only. If we need async later, we wrap calls in `asyncio.to_thread`. |
| Auth | `set_auth(jwt: str)` / `clear_auth()` / `set_admin_auth(key)` | Pass Clerk session JWT — no special validation client-side. |

### API surface (from `python/convex/__init__.py`)

Quoted directly from the source:

```python
class ConvexClient:
    def __init__(self, deployment_url: str): ...
    def query(self, name: str, args: FunctionArgs = None) -> Any: ...
    def mutation(self, name: str, args: FunctionArgs = None) -> Any: ...
    def action(self, name: str, args: FunctionArgs = None) -> Any: ...
    def subscribe(self, name: str, args: FunctionArgs = None) -> QuerySubscription: ...
    def watch_all(self) -> QuerySetSubscription: ...
    def set_auth(self, token: str) -> None: ...
    def clear_auth(self) -> None: ...
    def set_admin_auth(self, admin_key: str) -> None: ...

class ConvexError(Exception):
    """Propagates from Convex functions; carries `.data` field."""

class ConvexExecutionError(Exception):
    """Convex execution error on server."""
```

### `set_auth(jwt)` semantics

From the README:

> "To provide authentication for function execution, call `set_auth()`."
> Passing `None` unsets auth (logout).

Token is sent on every WS frame after the call. There is no expiry-aware refresh in the SDK — when our cached Clerk JWT expires, Convex will start returning auth errors and we re-auth via Clerk + call `set_auth` again with the fresh token.

### Wrapper code (copy-paste-ready)

```python
# src/cvault/convex_client.py
"""Thin wrapper around convex.ConvexClient.

Exposes a `VaultClient` Protocol so unit tests can swap in a `FakeVaultClient`
without dragging the real WebSocket. Production builder is `make_vault_client`.
"""
from __future__ import annotations

from typing import Any, Protocol

from convex import ConvexClient, ConvexError


class VaultClient(Protocol):
    """Subset of Convex API that cvault uses. All methods sync."""

    def query(self, name: str, args: dict[str, Any] | None = None) -> Any: ...
    def mutation(self, name: str, args: dict[str, Any] | None = None) -> Any: ...
    def action(self, name: str, args: dict[str, Any] | None = None) -> Any: ...
    def set_auth(self, token: str) -> None: ...
    def clear_auth(self) -> None: ...


class ConvexVaultClient:
    """Production wrapper. Holds a single ConvexClient + the active JWT."""

    def __init__(self, deployment_url: str) -> None:
        self._client = ConvexClient(deployment_url)
        self._authed = False

    def authenticate(self, jwt: str) -> None:
        self._client.set_auth(jwt)
        self._authed = True

    def query(self, name: str, args: dict[str, Any] | None = None) -> Any:
        return self._client.query(name, args or {})

    def mutation(self, name: str, args: dict[str, Any] | None = None) -> Any:
        return self._client.mutation(name, args or {})

    def action(self, name: str, args: dict[str, Any] | None = None) -> Any:
        return self._client.action(name, args or {})

    def set_auth(self, token: str) -> None:
        self._client.set_auth(token)
        self._authed = True

    def clear_auth(self) -> None:
        self._client.clear_auth()
        self._authed = False


def make_vault_client(deployment_url: str, jwt: str) -> VaultClient:
    c = ConvexVaultClient(deployment_url)
    c.authenticate(jwt)
    return c


# Re-export for callers wanting to catch domain errors.
__all__ = ["VaultClient", "ConvexVaultClient", "make_vault_client", "ConvexError"]
```

---

## 3. Subprocess wrapper for `claude-swap`

### Concrete facts (from `claude-swap` source, v0.10.x)

- **Bin name:** ships **two** entry points — `claude-swap` and `cswap` (alias).
- **Argparse, mutually-exclusive group**, so exactly one verb per call.
- **Verbs we shell to:** `--add-account` (interactive prompt — uses live Claude Code creds), `--export PATH|-`, `--import PATH|-`, `--switch-to NUM|EMAIL`, `--remove-account NUM|EMAIL`, `--status`, `--list`.
- **Flag wrinkles:**
  - `--export -` writes envelope JSON to **stdout**, every diagnostic to **stderr**.
  - `--import -` reads from **stdin**.
  - `--account NUM|EMAIL` filters `--export` to one account.
  - `--full` includes the entire `~/.claude.json` (we DO NOT want this — default `--export` returns just `{oauthAccount}` per account, smaller and avoids leaking machine identity).
  - `--force` overwrites existing slots on `--import`.
- **Exit codes:** `0` success, `1` `ClaudeSwitchError`, `130` SIGINT, no other documented codes.
- **Python:** requires 3.12+ (newer than our cvault 3.11 floor — we just shell out, so no version conflict).

### Export envelope JSON (verified from `transfer.py`)

```jsonc
{
  "version": 1,
  "exportedAt": "2026-05-02T16:00:00Z",
  "exportedFrom": "macos",
  "swapVersion": "0.10.1",
  "encrypted": false,
  "activeAccountNumber": 2,
  "accounts": [
    {
      "number": 1,
      "email": "user@example.com",
      "uuid": "...",
      "organizationUuid": "...",
      "organizationName": "...",
      "added": "2026-04-01T...",
      "credentials": { "claudeAiOauth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1735689600000, "scopes": [...], "subscriptionType": "max" } },
      "config": { "oauthAccount": { /* slim Claude config */ } }
    }
  ]
}
```

The `credentials.claudeAiOauth` object is exactly what Convex stores AES-GCM-encrypted in `subscriptions.ciphertext` per spec §6.

### Single-account export shape (used by `cvault switch` import path)

When we call `--export - --account <slot>`, the envelope still has the same outer shape but `accounts` has length 1. `--import -` accepts this same shape.

### Wrapper code

```python
# src/cvault/claude_swap.py
"""Subprocess wrapper around the vendored `claude-swap` CLI.

claude-swap is the single Mac-Keychain authority. cvault never touches the
keychain directly — every read/write goes through this module.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import typer

CLAUDE_SWAP_BIN = "claude-swap"  # ships a `cswap` alias too; we pick the long form for clarity.


class ClaudeSwapError(RuntimeError):
    """claude-swap exited non-zero or produced non-JSON output."""


class ClaudeSwapMissing(RuntimeError):
    """claude-swap is not on PATH. Print install hint, exit 1."""


def _ensure_installed() -> str:
    path = shutil.which(CLAUDE_SWAP_BIN)
    if path is None:
        raise ClaudeSwapMissing(
            "claude-swap is not installed. Install it with:\n"
            "    uv tool install claude-swap\n"
            "Then re-run this command."
        )
    return path


def _run(*args: str, stdin: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    bin_path = _ensure_installed()
    try:
        return subprocess.run(
            [bin_path, *args],
            input=stdin,
            capture_output=True,
            text=True,
            check=check,
        )
    except FileNotFoundError as exc:
        # Race: bin existed at _ensure_installed() but was removed before exec.
        raise ClaudeSwapMissing(str(exc)) from exc
    except subprocess.CalledProcessError as exc:
        raise ClaudeSwapError(
            f"claude-swap {' '.join(args)} exited {exc.returncode}\n"
            f"stderr: {exc.stderr.strip()}"
        ) from exc


def export_account(slot_or_email: str | int) -> dict[str, Any]:
    """`claude-swap --export - --account <id>` → parsed envelope dict."""
    proc = _run("--export", "-", "--account", str(slot_or_email))
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ClaudeSwapError(f"--export emitted non-JSON: {exc}") from exc


def export_all() -> dict[str, Any]:
    """`claude-swap --export -` → parsed envelope dict (all accounts)."""
    proc = _run("--export", "-")
    return json.loads(proc.stdout)


def import_envelope(envelope: dict[str, Any], force: bool = False) -> None:
    """`claude-swap --import - [--force]` from a JSON envelope."""
    args = ["--import", "-"] + (["--force"] if force else [])
    _run(*args, stdin=json.dumps(envelope))


def switch_to(slot_or_email: str | int) -> None:
    _run("--switch-to", str(slot_or_email))


def remove_account(slot_or_email: str | int) -> None:
    _run("--remove-account", str(slot_or_email))


def status() -> str:
    """Returns claude-swap --status stdout (active account info)."""
    return _run("--status").stdout


def add_account_interactive() -> None:
    """`claude-swap --add-account` — captures whatever Claude Code is logged into.

    This is interactive (prints prompts to terminal). We pass through stdin/stdout
    by NOT capturing them. Use this from `cvault add` *before* calling export_account.
    """
    bin_path = _ensure_installed()
    result = subprocess.run([bin_path, "--add-account"], check=False)
    if result.returncode != 0:
        raise ClaudeSwapError(f"claude-swap --add-account exited {result.returncode}")


def install_hint_and_exit(err: ClaudeSwapMissing) -> None:
    """Top-level handler called from cli.py."""
    typer.echo(str(err), err=True)
    raise typer.Exit(code=1)
```

### Best-practice notes

- **Always `text=True`** — claude-swap emits UTF-8 strings, never raw bytes. Saves us decoding boilerplate.
- **Always `capture_output=True`** EXCEPT for the interactive `--add-account` and `--login` paths where stdin/stdout passthrough is required.
- **`check=True`** raises `CalledProcessError` w/ stderr — our wrapper converts to a domain `ClaudeSwapError` with a friendly message.
- **`shutil.which` first**, then `subprocess.run` — gives a clean install-hint path before we try to exec anything.

---

## 4. HTTP client — `httpx` + `tenacity`

### Used for

- The optional `/api/cli/sync` HTTP-action call (spec §5.7) — Convex's HTTP action namespace is **not** reachable through the WebSocket-based Python SDK. We must hit `https://<deployment>.convex.site/api/cli/sync` directly.

### Pattern

`httpx.HTTPTransport(retries=N)` only retries on `httpx.ConnectError` / `httpx.ConnectTimeout`. **5xx responses do not auto-retry** — we wrap the call with `tenacity`.

```python
# src/cvault/http.py
import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)


class TransientHTTPError(Exception):
    """Raised for 5xx so tenacity can catch + retry."""


@retry(
    retry=retry_if_exception_type((TransientHTTPError, httpx.ConnectError, httpx.ReadTimeout)),
    wait=wait_exponential(multiplier=0.5, min=0.5, max=8),
    stop=stop_after_attempt(4),
    reraise=True,
)
def post_cli_sync(deployment_site_url: str, jwt: str) -> dict:
    """POST /api/cli/sync. Returns parsed JSON. Retries 5xx + connect errors."""
    transport = httpx.HTTPTransport(retries=2)  # connect-only retries
    with httpx.Client(transport=transport, timeout=httpx.Timeout(30.0)) as client:
        resp = client.post(
            f"{deployment_site_url}/api/cli/sync",
            headers={"Authorization": f"Bearer {jwt}"},
        )
        if 500 <= resp.status_code < 600:
            raise TransientHTTPError(f"{resp.status_code} {resp.text[:200]}")
        resp.raise_for_status()  # 4xx → HTTPStatusError, no retry
        return resp.json()
```

**Why `tenacity`** — purpose-built for retry policies, mature (1.4k+ LOC repo, used by aiohttp/openai/anthropic SDKs), declarative `@retry` decorator, supports both sync + async.

---

## 5. Local config dir — `~/.vault/`

### Picked: literal `~/.vault/` (no `platformdirs`)

### Reason

- Spec §2 explicitly scopes v1 to **Mac-first**, with Linux/Windows deferred even though `claude-swap` supports them.
- Spec §7 hard-codes `~/.vault/` in the user-visible config-dir column — using `platformdirs` would land users on `~/Library/Application Support/cvault/` on macOS, which contradicts the spec.
- `~/.vault/` is also short and shell-typeable, which matters for "cat ~/.vault/session.json" debug flows.
- **Migration path:** the moment we add Linux/Windows support, swap in `platformdirs.user_config_dir("cvault", appauthor=False)` behind a single `vault_dir()` function — total cost ~10 LOC and one `XDG_CONFIG_HOME` honor. Document this as v2 work.

### Helper

```python
# src/cvault/paths.py
import os
import stat
from pathlib import Path


VAULT_DIR = Path.home() / ".vault"
SESSION_FILE = VAULT_DIR / "session.json"
CONFIG_FILE = VAULT_DIR / "config.toml"
HASH_DIR = VAULT_DIR  # last-hash-{email}.txt files live alongside session.json


def ensure_vault_dir() -> Path:
    """Create ~/.vault/ with mode 0700; return the Path."""
    VAULT_DIR.mkdir(mode=0o700, exist_ok=True)
    # Tighten if it pre-existed with looser perms
    if VAULT_DIR.stat().st_mode & 0o777 != 0o700:
        VAULT_DIR.chmod(0o700)
    return VAULT_DIR


def write_secret(path: Path, content: str) -> None:
    """Atomic write with mode 0600."""
    ensure_vault_dir()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(path)
    path.chmod(0o600)


def read_secret(path: Path) -> str | None:
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def last_hash_path(email: str) -> Path:
    safe = email.replace("/", "_").replace("..", "_")
    return HASH_DIR / f"last-hash-{safe}.txt"
```

Note: directory mode is **0700** (only owner can `cd` in / `ls`); files inside are **0600**. The spec says "mode 0600 files" — that applies to file permissions; the dir needs 0700 so an attacker can't even list filenames.

---

## 6. `pyproject.toml` template

This is exact, copy-paste-ready. Drop in the project root.

```toml
[project]
name = "vault-cli"
version = "0.1.0"
description = "Centralized Claude Code credential vault — wraps claude-swap with Convex sync."
readme = "README.md"
requires-python = ">=3.11"
license = { text = "MIT" }
authors = [{ name = "Stefan Asseg", email = "stefan@flatout.solutions" }]
keywords = ["claude", "claude-code", "credentials", "convex", "oauth"]
classifiers = [
    "Development Status :: 3 - Alpha",
    "Environment :: Console",
    "Intended Audience :: Developers",
    "License :: OSI Approved :: MIT License",
    "Operating System :: MacOS",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Programming Language :: Python :: 3.13",
    "Topic :: Utilities",
]
dependencies = [
    "typer>=0.12",
    "convex>=0.7,<1.0",
    "httpx>=0.27",
    "tenacity>=8.5",
    "rich>=13.7",          # tables for `cvault list`
    "cryptography>=43",    # only if CLI ever does local encryption (defer if not)
    "claude-swap>=0.10",   # vendored runtime dep — we shell to it
]

[project.urls]
Homepage = "https://github.com/flatoutsolutions/cvault"
Repository = "https://github.com/flatoutsolutions/cvault"
Issues = "https://github.com/flatoutsolutions/cvault/issues"

[project.scripts]
cvault = "cvault.cli:main"

[build-system]
requires = ["hatchling>=1.25"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/cvault"]

[dependency-groups]
dev = [
    "pytest>=8.3",
    "pytest-cov>=5.0",
    "pytest-subprocess>=1.5",  # mocks subprocess.run for claude-swap tests
    "respx>=0.21",             # mocks httpx
    "ruff>=0.6",
    "mypy>=1.11",
    "types-requests",          # if we end up importing requests anywhere
]

[tool.ruff]
line-length = 100
target-version = "py311"
src = ["src", "tests"]

[tool.ruff.lint]
select = [
    "E",    # pycodestyle errors
    "F",    # pyflakes
    "W",    # pycodestyle warnings
    "I",    # isort
    "B",    # flake8-bugbear
    "UP",   # pyupgrade
    "SIM",  # flake8-simplify
    "RUF",  # ruff-specific
    "S",    # bandit (security) — important for a creds tool
    "PT",   # pytest style
]
ignore = [
    "E501",  # line-length handled by formatter
    "S603",  # subprocess call — we sanitize args ourselves
    "S607",  # starting process with partial path — we use shutil.which first
]

[tool.ruff.lint.per-file-ignores]
"tests/**/*.py" = [
    "S101",   # assert allowed in tests
    "S105",   # hardcoded password ok in tests
    "S106",   # hardcoded password ok in tests
]

[tool.ruff.format]
quote-style = "double"
indent-style = "space"

[tool.mypy]
python_version = "3.11"
strict = true
warn_unused_ignores = true
warn_redundant_casts = true
no_implicit_reexport = true
show_error_codes = true
files = ["src", "tests"]

# convex SDK ships .pyi files for the Rust core; some cells are typed `Any`.
# Keep these as warnings rather than errors.
[[tool.mypy.overrides]]
module = "convex.*"
warn_return_any = false

[[tool.mypy.overrides]]
module = "claude_swap.*"
ignore_missing_imports = true  # vendor binary, no installed types

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
addopts = [
    "--strict-markers",
    "--strict-config",
    "-ra",
]
markers = [
    "integration: hits real Convex dev deployment (skipped by default)",
]
```

### `[tool.uv]` block?

Not needed for `uv tool install vault-cli`. The `uv` tool resolver reads `[project]` directly. Add `[tool.uv]` only if we want lockfile/source overrides for dev (e.g., `[tool.uv.sources] claude-swap = { git = "..." }`). Skip in v1.

---

## 7. Project layout

```
cvault/                            # repo root
├── pyproject.toml                 # § above
├── README.md
├── .python-version                # 3.11
├── uv.lock                        # generated by `uv lock`
├── src/
│   └── cvault/
│       ├── __init__.py            # __version__ = "0.1.0"
│       ├── __main__.py            # `python -m cvault` shim → cli.main
│       ├── cli.py                 # typer.Typer app, registers commands
│       ├── paths.py               # ~/.vault/, ensure_vault_dir, write_secret
│       ├── session.py             # session.json read/write, JWT lifecycle
│       ├── auth.py                # Clerk browser-flow trigger + token refresh
│       ├── convex_client.py       # VaultClient Protocol + ConvexVaultClient impl
│       ├── claude_swap.py         # subprocess wrapper (export/import/switch/...)
│       ├── http.py                # httpx + tenacity for /api/cli/sync
│       ├── hashing.py             # SHA-256 of envelope, last-hash-{email}.txt I/O
│       ├── render.py              # rich.Table renderers (list, status)
│       ├── errors.py              # CvaultError hierarchy
│       └── commands/
│           ├── __init__.py
│           ├── login.py           # cvault login
│           ├── add.py             # cvault add
│           ├── list_subs.py       # cvault list  (module name avoids `list` shadow)
│           ├── switch.py          # cvault switch <slot|email>
│           ├── refresh.py         # cvault refresh [slot]
│           ├── remove.py          # cvault remove <slot|email>
│           ├── status.py          # cvault status
│           └── sync.py            # cvault sync --all
└── tests/
    ├── conftest.py                # fixtures (FakeVaultClient, fake_process, tmp_vault_dir)
    ├── test_claude_swap.py
    ├── test_convex_client.py
    ├── test_paths.py
    ├── test_hashing.py
    ├── test_session.py
    ├── commands/
    │   ├── __init__.py
    │   ├── test_add.py
    │   ├── test_switch.py
    │   ├── test_list.py
    │   ├── test_refresh.py
    │   └── test_status.py
    └── fixtures/
        └── envelopes/
            ├── single_account.json
            └── three_accounts.json
```

Each file in `src/cvault/commands/` exposes exactly one `def run(...)` that Typer maps to `app.command(<name>)`. Keeps the `cli.py` registry to one wire-up pass and keeps each command unit-testable in isolation.

---

## 8. Test framework — pytest + fixtures

### `tests/conftest.py` (skeleton)

```python
"""Shared fixtures for cvault tests.

Two reusable patterns live here:
  1. `fake_vault_client` — in-memory implementation of the `VaultClient`
     Protocol so command tests don't need a real Convex deployment.
  2. `fake_process` (from pytest-subprocess) — registers fake responses for
     `subprocess.run`, used to mock claude-swap without spawning it.
"""
from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from cvault.convex_client import VaultClient


# ---------------------------------------------------------------------------
# FakeVaultClient — hand-rolled fake implementing the VaultClient Protocol
# ---------------------------------------------------------------------------

class FakeVaultClient:
    """In-memory stand-in. Tests pre-seed `query_responses`/`action_responses`
    by function name; calls record into `calls` for assertions."""

    def __init__(self) -> None:
        self.query_responses: dict[str, Any] = {}
        self.mutation_responses: dict[str, Any] = {}
        self.action_responses: dict[str, Any] = {}
        self.calls: list[tuple[str, str, dict[str, Any]]] = []  # (kind, name, args)
        self.auth_token: str | None = None

    def _resolve(self, table: dict[str, Any], name: str) -> Any:
        if name in table:
            return table[name]
        # Default: return None so missing stubs surface as obvious None rather
        # than silently erroring deep in command code.
        return None

    def query(self, name: str, args: dict[str, Any] | None = None) -> Any:
        self.calls.append(("query", name, args or {}))
        return self._resolve(self.query_responses, name)

    def mutation(self, name: str, args: dict[str, Any] | None = None) -> Any:
        self.calls.append(("mutation", name, args or {}))
        return self._resolve(self.mutation_responses, name)

    def action(self, name: str, args: dict[str, Any] | None = None) -> Any:
        self.calls.append(("action", name, args or {}))
        return self._resolve(self.action_responses, name)

    def set_auth(self, token: str) -> None:
        self.auth_token = token

    def clear_auth(self) -> None:
        self.auth_token = None


@pytest.fixture
def fake_vault_client() -> FakeVaultClient:
    """Use in any command test that needs a Convex stand-in."""
    return FakeVaultClient()


# ---------------------------------------------------------------------------
# Tmp vault dir — redirects ~/.vault/ to a per-test tmp path
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_vault_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Patch HOME so cvault.paths.VAULT_DIR resolves under tmp_path."""
    monkeypatch.setenv("HOME", str(tmp_path))
    # Re-evaluate the module-level constant against the patched HOME
    import importlib

    import cvault.paths

    importlib.reload(cvault.paths)
    return tmp_path / ".vault"


# ---------------------------------------------------------------------------
# claude-swap subprocess mocking via pytest-subprocess
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_claude_swap(fp):  # `fp` is the pytest-subprocess fixture
    """Convenience wrapper. Tests do:

        def test_switch(mock_claude_swap):
            mock_claude_swap.register(
                ["claude-swap", "--export", "-", "--account", "1"],
                stdout=open("tests/fixtures/envelopes/single_account.json").read(),
            )
            ...
    """
    return fp


# ---------------------------------------------------------------------------
# monkeypatch-only alternative (when you don't want pytest-subprocess)
# ---------------------------------------------------------------------------

@pytest.fixture
def patch_subprocess_run(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[list[str]]]:
    """Capture all subprocess.run calls; return a list the test inspects.

    Each entry in the returned list is the argv list passed to subprocess.run.
    The patched run returns a CompletedProcess with returncode=0, stdout="",
    stderr="" — override per-test by re-monkeypatching after this fixture if
    a specific stdout is needed.
    """
    import subprocess

    captured: list[list[str]] = []

    def fake_run(argv: list[str], *args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        captured.append(argv)
        return subprocess.CompletedProcess(
            args=argv, returncode=0, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    yield captured
```

### Why both `pytest-subprocess` AND a `monkeypatch` example?

- **`pytest-subprocess`** is the right answer for `test_claude_swap.py` — it returns realistic `CompletedProcess` objects, supports stdin matching, and registers per-argv stdout strings. ~1 KB of test code per scenario.
- **`monkeypatch` raw** is the fallback for tests where we just want to assert "did this command shell out at all?" without coupling to `pytest-subprocess`. The fixture above shows the pattern in 10 lines.

### Example test (illustrates both)

```python
# tests/commands/test_switch.py
from pathlib import Path

from cvault.commands import switch


def test_switch_pulls_and_imports_when_hash_mismatch(
    fake_vault_client, tmp_vault_dir, mock_claude_swap
):
    # Server returns a sub envelope with a known content hash
    fake_vault_client.action_responses["subscriptions:pullForSwitch"] = {
        "email": "u@x.com",
        "slot": 1,
        "plaintextBlob": '{"claudeAiOauth": {"accessToken": "...", "refreshToken": "..."}}',
        "contentHash": "abc123",
    }

    # No prior local hash → mismatch → expect import + switch-to
    mock_claude_swap.register(["claude-swap", "--import", "-"], stdout="")
    mock_claude_swap.register(["claude-swap", "--switch-to", "1"], stdout="")

    switch.run(slot_or_email="1", _client=fake_vault_client)  # DI seam

    # Local hash file was written
    assert (tmp_vault_dir / "last-hash-u@x.com.txt").read_text() == "abc123"
```

---

## 9. Linting / formatting — `ruff`

### Picked: ruff (linter + formatter, both in one tool)

### Justification

- One binary, two roles. Removes need for `black` + `isort` + `flake8`.
- Astral ecosystem (same authors as `uv`) — co-evolves with the build/install side.
- `ruff format` is a black-compatible formatter; we don't have to convince anyone about style.
- For a creds tool, the `S` (bandit) ruleset matters — it'd flag `subprocess` shell injections, hardcoded secrets, weak-RNG misuse.
- Fast enough that we can wire it into pre-commit + CI without slowing iteration.

### Config — see `[tool.ruff]` block in §6 above

Key choices:
- `line-length = 100` — slightly more than black's 88, fits modern wide editors but not rambling.
- `target-version = "py311"` — matches our floor.
- `select = ["E", "F", "W", "I", "B", "UP", "SIM", "RUF", "S", "PT"]` — solid spread covering correctness, modernization, pytest hygiene, security.
- Per-file ignore for tests so we can use `assert` and stub passwords.

---

## 10. Type checker — `mypy`

### Picked: mypy in `--strict` mode

### Justification

- **Convex SDK type quality:** `convex` 0.7.0 returns `Any` from `query/mutation/action` (see source — they explicitly chose `Any` over `ConvexValue` for caller ergonomics). Pyright's inference treats this aggressively and surfaces hundreds of "Type of x is partially unknown" warnings. Mypy with `warn_return_any = false` for the `convex.*` module gives us strict typing **everywhere else** without drowning in noise.
- **claude-swap is not type-stubbed** (it's a runtime dep we shell to, not import from). `[[tool.mypy.overrides]] module = "claude_swap.*" ignore_missing_imports = true` — clean, one block. Pyright's equivalent (`reportMissingTypeStubs`) is per-file noisier.
- **Plugin support:** if we ever want pydantic/sqlalchemy/django types, mypy has plugins; pyright doesn't.
- **CI story:** `mypy --strict src tests` is one command; pyright-in-CI requires the npm-distributed binary which is awkward in a uv-only project.

### Config — see `[tool.mypy]` block in §6 above

`strict = true` enables:
- `disallow_untyped_defs`
- `disallow_incomplete_defs`
- `check_untyped_defs`
- `disallow_untyped_decorators`
- `no_implicit_optional`
- `warn_return_any`
- `no_implicit_reexport`
- `strict_equality`
- `extra_checks`

### When pyright would win

If we end up pair-programming heavily in VS Code and want as-you-type errors without saving, pyright's faster watch mode helps. We can run pyright locally as a dev convenience and still gate CI on mypy. Skip in v1.

---

## Open questions for the builder

These are decisions the brief deliberately defers to implementation time because they need information not yet known:

1. **Clerk browser-flow specifics** — the spec says `cvault login` opens a browser → Clerk → persists session JSON. **Open:** does Clerk's CLI sign-in flow use OAuth device code or a localhost callback? Need to confirm with the Clerk-side implementer (or check the existing Blueprint Clerk config) before writing `auth.py`. If it's localhost callback, we need an embedded HTTP server (`http.server` stdlib is fine).

2. **Convex deployment URL discovery** — does the user run `cvault login --deployment <url>` once, or do we hard-code prod URL and let dev-loop folks override via `CVAULT_CONVEX_URL` env? Spec is silent. **Recommend:** hard-code prod URL in `cvault/__init__.py` with `CVAULT_CONVEX_URL` env override; document the env var in README. Single user, single deployment in v1 — no need for `--deployment`.

3. **claude-swap's `--add-account` is interactive** — it prompts the user to follow a Claude Code login flow, which means `cvault add` must passthrough stdin/stdout (no `capture_output=True`) and only AFTER the prompt completes can we call `--export` to grab the result. Builder must wire this two-phase pattern carefully — see `add_account_interactive()` in §3.

4. **HTTP-action URL pattern** — Convex HTTP actions live at `https://<deployment-name>.convex.site/`, not the same hostname as the WebSocket URL (`...convex.cloud`). **Open:** confirm the dashboard exposes both URLs explicitly, or derive `convex.site` from the deployment name. The Blueprint Convex setup almost certainly already has this — borrow.

5. **`claude-swap` version pin** — claude-swap's export envelope `version: 1`. If they bump to `version: 2` and our wrapper hard-asserts v1, every cvault user breaks until we ship a patch. Pin to a version range (`claude-swap>=0.10,<1.0`) AND treat unknown envelope versions as a clean "upgrade cvault" error rather than a crash.

6. **Subprocess timeout** — `subprocess.run` has no default timeout. claude-swap operations are local + fast (< 1s typically), but a hung Keychain prompt could block forever. **Recommend:** `timeout=30` on every non-interactive call.

7. **`platformdirs` deferral** — confirmed v2 task; trivially swappable behind `cvault.paths.VAULT_DIR`. Not blocking v1.

---

## File paths in this brief

- This brief: `/Users/saadings/Desktop/cvault/docs/research/python-cli-tooling.md`
- Source spec: `/Users/saadings/Desktop/cvault/docs/superpowers/specs/2026-05-02-cvault-design.md`

## Sources

- [convex on PyPI](https://pypi.org/project/convex/) — version 0.7.0
- [convex-py source](https://github.com/get-convex/convex-py) — ConvexClient API
- [claude-swap source](https://github.com/realiti4/claude-swap) — subprocess wrapper target
- [Typer docs](https://typer.tiangolo.com/) — argparse alternative
- [HTTPX transports](https://www.python-httpx.org/advanced/transports/) — retry semantics
- [Tenacity](https://tenacity.readthedocs.io/) — retry decorator
- [pytest-subprocess](https://pypi.org/project/pytest-subprocess/) — clean subprocess mocks
- [Ruff configuration](https://docs.astral.sh/ruff/configuration/) — linter + formatter setup
- [uv tool install](https://docs.astral.sh/uv/) — distribution path
- [platformdirs](https://platformdirs.readthedocs.io/) — v2 cross-platform target

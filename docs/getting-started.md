# Getting Started

**Parent topic**: [Overview](overview.md)

Ant Farm is a Tauri 2 desktop application that reads your project brain as a read-only source of truth and overlays live Claude Code and Cowork session data, token cost, git metrics, and headless agent dispatch on top. All data comes from local files — no API calls, no telemetry, no external services.

This guide walks through every step required to get a working development environment: installing prerequisites, wiring up the observability hook that powers push-based session status, and keeping the mandatory build gate green before every push to `main`.

For a conceptual map of how the pieces fit together once you are running, see [Architecture](architecture.md). For the exact files and paths the app reads at runtime, see [Local Data Sources](architecture/data-sources.md).

---

## Prerequisites

### Node.js and npm

The React + Vite frontend toolchain requires Node.js and npm. Ant Farm follows the Node LTS release schedule. Confirm you meet the minimum before continuing:

```bash
node --version    # 18.x or later
npm --version
```

If you need to manage multiple Node versions, `nvm` or `fnm` both work. Install Node 18 or 20 LTS through whichever manager you prefer. There is no `.nvmrc` in the repo — any LTS version from 18 onward is supported.

### Rust Toolchain

The Tauri 2 backend is written in Rust, edition 2021. Install the stable toolchain via `rustup` if it is not already present:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup default stable
```

Verify the installation:

```bash
rustc --version    # 1.77.0 or later (Tauri 2 minimum)
cargo --version
```

Ant Farm’s `Cargo.toml` targets stable Rust with edition 2021. No nightly compiler features are used. The key crate dependencies that have notable compile times on a cold cache are `reqwest` (TLS stack), `tauri` itself, and `portable-pty`.

### Tauri 2 macOS Prerequisites

Tauri 2 on macOS renders the UI in the platform’s built-in WebKit runtime. There is no bundled Chromium or Electron-style renderer — macOS ships WebKit as a system framework, and Tauri uses it directly. The only hard build dependency beyond Rust is the Xcode Command Line Tools, which supply the linker, system headers, and Metal libraries:

```bash
xcode-select --install
```

If you already have the full Xcode IDE installed, the command-line tools are already present. Confirm with:

```bash
xcode-select -p
# /Applications/Xcode.app/Contents/Developer  (or similar non-empty path)
```

Minimum macOS version for running the app is macOS 11 (Big Sur), which is also the Tauri 2 floor. macOS 13 Ventura or later is recommended for development.

### Project Brain and Registry

The app needs two local file trees to be present before it starts producing useful output. Both are strictly read-only from Ant Farm’s perspective — the app never writes to either.

**Brain directory**: `~/Desktop/CD_claude/tools-built/`

Each subdirectory under `tools-built/` represents one project, named by its slug. For a project with slug `my-tool`, the brain lives at:

```
~/Desktop/CD_claude/tools-built/my-tool/
  README.md          Required. Shown as the project brief in the detail view.
  decisions.md       Optional. Decision log surfaced in the detail view.
  ideas.md           Optional. Idea list surfaced in the detail view.
  notes/             Optional. Free-form notes directory, rendered as markdown.
```

If `tools-built/` does not exist, the Projects grid renders empty. The app does not crash — it degrades gracefully and shows a zero-state screen.

**Registry file**: `~/Desktop/CD_claude/ant-farm-registry.json`

A flat JSON object that maps each project slug to the local folder name of its git repository. Ant Farm uses the registry to locate git repos for metric collection, session auto-filing, and dispatch target resolution:

```json
{
  "my-tool": "my-tool-repo",
  "other-project": "other-project"
}
```

The registry value is a folder name, not a full path. Ant Farm resolves repositories relative to your home directory or a configured base path. Without a valid registry file, projects appear in the grid but git metrics and session auto-filing will not work.

See [Local Data Sources](architecture/data-sources.md) for the complete schema of every file the app reads, including session JSONL format, `events.jsonl`, and dispatch run records.

---

## Install

Clone the repository, then install JavaScript dependencies:

```bash
git clone <repo-url> antfarm
cd antfarm
npm install
```

`npm install` installs the frontend toolchain — Vite, React, TypeScript, Tailwind, and the Tauri CLI (`@tauri-apps/cli`). The Rust crate tree in `src-tauri/Cargo.toml` is resolved by Cargo automatically the first time you run `npm run tauri dev` or `cargo check`. That first Cargo fetch and compile takes a few minutes; subsequent builds are incremental.

The `package.json` scripts used in this guide:

| Script | Command |
| --- | --- |
| `npm run dev` | `vite` — starts the frontend dev server on port 1420 |
| `npm run build` | `tsc --noEmit && vite build` — the full pre-push gate |
| `npm run tauri dev` | Tauri CLI wrapping `npm run dev` + Rust backend |
| `npm run tauri build` | Tauri CLI production bundle (macOS `.app`) |

---

## Running in Development

```bash
npm run tauri dev
```

What happens under the hood:

1.  The Tauri CLI executes `beforeDevCommand` (`npm run dev`), which starts the Vite development server bound to `http://localhost:1420`. The `strictPort: true` setting in `vite.config.ts` means Vite fails immediately rather than falling back to an alternate port. If something else is on 1420, kill it first:
    
    ```bash
    lsof -i :1420 | grep LISTEN
    ```
    
2.  Tauri waits for port 1420 to respond, then compiles the Rust backend in debug mode. The first compile downloads and builds the full crate tree — expect 3-5 minutes on a cold cache. Subsequent incremental builds are seconds.
    
3.  The Tauri host process opens the app window and attaches Tauri DevTools. The window configuration comes from `src-tauri/tauri.conf.json`:
    
    -   `productName`: `"Ant Farm"` (macOS menu bar title)
    -   `devUrl`: `"http://localhost:1420"`
    -   Default size: 1100 × 740 px, minimum 760 × 500 px
    -   `withGlobalTauri: true` — Tauri APIs are exposed on `window.__TAURI__`, though the frontend imports them explicitly via `@tauri-apps/api`

### Hot Reload Scope

Vite’s HMR reloads the frontend on changes to any file under `src/`. The `vite.config.ts` watcher explicitly ignores two directories to prevent spurious frontend reloads:

-   `src-tauri/` — Rust source changes require a Rust recompile, not a Vite reload.
-   `.antfarm-worktrees/` — Dispatch worktrees write files here during runs; those writes must not trigger HMR.

Changes to Rust source (`src-tauri/src/*.rs`) require stopping and restarting `npm run tauri dev`. There is no automatic Rust hot-reload.

### First Run Checklist

On the first launch, confirm:

-   The dark-themed app window opens at roughly 1100 × 740 px.
-   The Projects page loads (empty if the brain directory is not set up — expected).
-   The Sessions page shows a zero-state message rather than an error.
-   No `ERROR` or `panicked` lines appear in the terminal where you ran `npm run tauri dev`.

If the window does not open, the Rust compile likely failed or errored. Read the terminal output — Tauri prints the full Rust compiler error there.

---

## Pre-Push Build Gate

Ant Farm enforces a mandatory two-step build gate. **Both steps must exit with code 0 before every push.** Work goes straight to `main` — there are no feature branches or pull requests.

```bash
# Step 1: TypeScript check + Vite production bundle
npm run build

# Step 2: Rust compiler check (no binary produced)
cargo check
```

Run both from the repository root. Run them in this order: TypeScript errors are typically faster to catch and fix than Rust errors, so they surface first.

### Step 1: `npm run build`

Defined in `package.json` as `tsc --noEmit && vite build`. Two tools run in sequence:

**`tsc --noEmit`** invokes the TypeScript compiler in check-only mode. It type-checks the entire frontend source tree — `src/`, `src/pages/`, `src/components/`, `src/lib/`, `src/types.ts` — and every imported third-party type. It exits non-zero on any type error. Errors include the file path, line number, and error code (e.g., `TS2345`).

**`vite build`** bundles the frontend into `dist/` using Rollup. It will emit a warning if any output chunk exceeds 1000 KB (`chunkSizeWarningLimit` in `vite.config.ts`), but the warning does not fail the build. The bundled output is consumed by `npm run tauri build` to produce the macOS app; it is not used by `npm run tauri dev`.

### Step 2: `cargo check`

Run from the repository root (Cargo finds `src-tauri/` automatically via the workspace, or run it from inside `src-tauri/` directly). `cargo check` exercises the Rust type system and borrow checker without compiling to machine code or linking a binary. It is significantly faster than `cargo build` and catches the common categories of error introduced during editing: type mismatches, missing trait implementations, and borrow violations.

### Common Failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `TS2345` or `TS2322` from `tsc` | Type mismatch in frontend | Fix the type; do not use `@ts-ignore` without a concrete reason |
| `tsc` fails, `vite build` not reached | TypeScript error blocks the `&&` chain | The `tsc` output shows the file and line |
| `cargo check` borrow error | Incorrect `Arc<Mutex<T>>` usage in Rust | Restructure the lock scope |
| `cargo check` type error in dispatch | `Result` propagation missed | Add `?` or match the error explicitly |
| Vite chunk size warning | Large dependency bundled into a single chunk | Warning only; does not fail the gate |

---

## Installing the Status Hook

Push-based session status (Running / Idle / Needs permission / Done) and dispatch observability both require a Claude Code lifecycle hook. This is a **one-time setup per machine**.

The hook script is `antfarm_status_hook.sh`, found at the repository root. It reads lifecycle metadata from the environment variables Claude Code sets on each event, appends a JSON record to `~/.antfarm/events.jsonl`, and always exits with code 0 — even if the write fails. The Tauri backend tails `events.jsonl` with a file watcher (`notify` crate) and emits parsed events to the frontend over IPC.

### Step 1: Place the Hook Script

```bash
mkdir -p ~/.antfarm/hooks
cp antfarm_status_hook.sh ~/.antfarm/hooks/
chmod +x ~/.antfarm/hooks/antfarm_status_hook.sh
```

Verify the executable bit is set:

```bash
ls -l ~/.antfarm/hooks/antfarm_status_hook.sh
# -rwxr-xr-x  1 you  staff  ...
```

`~/.antfarm/` is the only location Ant Farm writes to on your machine, outside of the Tauri-managed app-data directory (`~/Library/Application Support/com.connordore.antfarm/` on macOS). Both directories are created automatically by the app if they do not exist.

### Step 2: Merge Hook Entries into ~/.claude/settings.json

Claude Code reads hook configuration from `~/.claude/settings.json`. The `hooks` key maps each lifecycle event name to an array of matcher objects, each of which holds an array of command entries.

Add entries for all four events — `Stop`, `Notification`, `SessionStart`, and `SessionEnd`. Each command entry must set `"async": true`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.antfarm/hooks/antfarm_status_hook.sh",
            "async": true
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.antfarm/hooks/antfarm_status_hook.sh",
            "async": true
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.antfarm/hooks/antfarm_status_hook.sh",
            "async": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.antfarm/hooks/antfarm_status_hook.sh",
            "async": true
          }
        ]
      }
    ]
  }
}
```

If `~/.claude/settings.json` already contains a `hooks` key, merge the new event entries into the existing object. Do not replace an existing `hooks` block wholesale — other tools may have registered hooks there too.

### Why `async: true` Is Required

`async: true` instructs Claude Code to fire the hook in the background and continue without waiting for it to return. The hook writes one JSON line to disk and exits — fast under normal conditions, but disk flushes can occasionally be slow. A synchronous hook that stalls would pause the agent loop.

Because the hook always exits with code 0, it can never fail a Claude Code tool call or block a dispatch run, even if `events.jsonl` is temporarily unavailable.

### Verifying the Hook

Start a Claude Code session anywhere, then watch `events.jsonl` in another terminal:

```bash
tail -f ~/.antfarm/events.jsonl
```

A `SessionStart` record should appear immediately when Claude Code opens. A `Stop` record appears after each agent turn. If no file appears or no records arrive:

1.  Confirm the `command` path in `~/.claude/settings.json` is exactly `~/.antfarm/hooks/antfarm_status_hook.sh` (the tilde is expanded by the shell).
2.  Confirm `chmod +x` was applied and `ls -l` shows the `x` bit.
3.  Confirm the Claude Code session started after the hook entries were written to `settings.json` — hooks are read at session start, not on the fly.

See [Sessions](features/sessions.md) for how these events flow from `events.jsonl` through the Tauri IPC layer to the status badges in the Sessions view.

---

## Known Landmine: PATH in the Packaged App

When macOS launches the Ant Farm `.app` bundle via Finder or Spotlight, the process inherits a minimal environment — specifically, it does not inherit the `PATH` configured in your shell’s rc files (`~/.zshrc`, `~/.bashrc`). The `claude` binary, which lives in a directory added by those rc files (commonly `~/.claude/bin` or `~/.local/bin`), will not be found via a plain `PATH` lookup.

This matters for the dispatch feature, which spawns `claude -p` headless runs from the Rust backend. A bare `Command::new("claude")` would fail with “not found” in a Finder-launched app.

The backend works around this by resolving `claude` through a login shell before spawning dispatch runs:

```bash
/bin/zsh -l -c "which claude"
```

The `-l` (login) flag causes `/bin/zsh` to source `/etc/profile` and `~/.zshrc`, picking up the full configured `PATH`. The resolved absolute path to `claude` is then used for all dispatch child processes, bypassing the sparse inherited environment entirely.

If dispatch fails with `"claude: not found"` after packaging, test the login-shell resolution first:

```bash
/bin/zsh -l -c "which claude"
```

If the command returns empty or an error, `claude` is not on your login shell’s PATH. Add the install directory to `PATH` in `~/.zshrc`:

```bash
export PATH="$HOME/.claude/bin:$PATH"
```

Reopen a terminal to verify, then restart the Ant Farm app. The login-shell resolution picks up the change immediately.

---

## Related Topics

-   [Architecture](architecture.md) — The Tauri frontend/backend split, the IPC command surface, and the observe-first data flow traced from source code to UI.
-   [Local Data Sources](architecture/data-sources.md) — Complete path and schema reference for every local file the app reads or writes: brain, registry, sessions, `events.jsonl`, dispatch runs, and the mobile token.
-   [Sessions](features/sessions.md) — How hook events flow from `events.jsonl` through the Tauri file watcher and IPC emitter to the push-based status badges in the Sessions view.
-   [Dispatch](features/dispatch.md) — Firing headless `claude -p` runs at a project, worktree isolation, the live log stream, and one-click session takeover.
-   [Overview](overview.md) — What Ant Farm is and the core principles (observe-first, zero-API, tolerant parsers, sandboxed writes) it is built on.

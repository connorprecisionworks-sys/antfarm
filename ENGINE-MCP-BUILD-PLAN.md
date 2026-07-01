# Antfarm as Engine — MCP + Phone Vibecoding Build Plan

Locked 2026-06-30. Antfarm's moat is the gated agent crew (Forge's Planner/Builder/Reviewer pod loop, spec-mode auto-decomposition, stop-before-push), NOT the chat UI. Decision: treat Antfarm as an ENGINE and expose it so Cowork, Claude Code, and phone can all trigger it. The native UI stays only for the rich review surface (live pod tabs, visual diff, approve-and-push).

Ultimate goal: vibecode from the phone = command + review + approve (spec mode), never hand-editing code on a phone. The engine runs on the Mac (repos + claude auth live there). The phone only commands and reviews. NO inbound tunnel into the Mac (Tailscale crashed before, deferred). Route around it later with a job queue.

## The arc (each phase independently useful)

- Phase 1 — Headless CLI. `antfarm forge "task" --repo <name>` (plus `spec` and `delegate`) calls the SAME Rust pod/spec/agent logic with no GUI. Pure local, zero networking. Foundation for every later phase.
- Phase 2 — Local MCP server. Thin wrapper exposing `forge_run_pod`, `forge_run_spec`, `delegate_agent`, `list_agents`, `get_status`, `approve_and_push` as MCP tools, shelling out to the Phase 1 CLI. localhost only. Desktop Cowork + Claude Code on the Mac can then trigger the crew as a native tool call.
- Phase 3 — Queue + phone. Supabase `jobs` table; a Mac-side poller runs jobs through the CLI and writes results back; a tiny hosted MCP endpoint (or Cowork-reachable form) enqueues from the phone. Connor reviews summary + unified diff in Cowork mobile and approves, which triggers the push. Migration gate applies (stop and ask before `supabase db push`, rollback SQL in `supabase/rollbacks/` only).

---

## Phase 1 — Headless CLI (this phase)

### Goal
A CLI entry point that runs the existing pod/spec/agent logic headlessly, reusing `pod_loop`, `spec_loop`, and `spawn_agent_run` as-is. No new engine logic, no networking.

### Where the code is
- Entry: `src-tauri/src/main.rs` `fn main()` (line 2426). `tauri::Builder` starts at line 2441.
- Pod core: `src-tauri/src/pod.rs` — `pub fn pod_loop(app, claude_path, children, reasons, pod_id, repo_path, task, context) -> PodTerminal` (line 144). `PodTerminal` enum (line 131): `ReadyToPush { commit_msg, diff, reviewer_note }` and `NeedsYou { reason }`. `pod_loop` does NOT commit; it leaves working-tree changes and returns the diff.
- Spec core: `src-tauri/src/spec.rs` — `fn spec_loop(app, claude_path, children, reasons, spec_id, repo_path, scope)` (line 173, currently private, returns `()`, auto-commits each green item locally via `commit_local_impl`). Local-commit helper lives here.
- Agent core: `src-tauri/src/agents.rs` — `pub fn spawn_agent_run(app, claude_path, children, reasons, agent_id, task, parent_run_id, resume_session, repo_path, builder_write) -> Result<(String, mpsc::Receiver<String>), String>` (line 989). `pub fn expand_tilde(path) -> String` (line 38).
- Claude path: `src-tauri/src/dispatch.rs` — `pub fn resolve_claude_path() -> String` (line 124).

### The one real design question — getting an AppHandle headlessly
`pod_loop`, `spec_loop`, and `spawn_agent_run` all take a Tauri `AppHandle` purely to emit progress events (`pod-stream`, `spec-stream`, `agent-stream`). Every emit is fire-and-forget (`let _ =` / `.ok()`). The actual work (spawning `claude` child processes, reading stdout via threads + mpsc) is plain std and does NOT need the Tauri event loop.

DECISION (Design A — minimal diff, reuse cores as-is): in the CLI branch, BUILD a Tauri app to obtain a real `AppHandle`, but never call `.run()`. On macOS the AppKit run loop never spins, so no window displays. Emits to zero listeners are harmless no-ops. This requires ZERO changes to pod.rs / spec.rs / agents.rs signatures.

Fallback if a window ever flashes: set the `tauri.conf.json` main window `"visible": false` and add `window.show()` in the GUI `setup()` hook (one line, GUI path only). Documented, not expected to be needed.

Rejected (Design B): refactor every core to take `Option<AppHandle>`. Truly GUI-free but touches 3 files and every caller of `spawn_agent_run`; higher freeze risk for a load-bearing phase. Revisit only if Design A misbehaves.

### CLI surface
Detected at the very top of `fn main()` from `std::env::args()`, BEFORE `tauri::Builder`. If `args[1]` is `forge` | `spec` | `delegate`, route to `run_cli(&args)` then `return` (GUI never starts).

- `antfarm forge "<task>" --repo <name|path>`
  Resolve repo, call `pod_loop(...)` directly (blocking, on the main thread). On `ReadyToPush` -> commit locally via `commit_local_impl(repo_path, commit_msg)` (git add -A + commit, NO push), print commit message + the diff + reviewer note, exit 0. On `NeedsYou` -> print the reason, leave the tree untouched, exit 1.
- `antfarm spec "<scope>" --repo <name|path>`
  Make `spec_loop` `pub`, call it directly (blocking). It auto-decomposes and commits each green item locally, no push. Print the final summary, exit 0.
- `antfarm delegate <agent> "<task>"`
  Call `spawn_agent_run(handle, claude_path, children, reasons, agent_id, task, None, false, None, None)`, then `rx.recv()` for the final text, print it, exit 0. Valid agent ids: jack, clerk, scout, scribe, pulitzer, scholar (read+connectors agents); not the write-mode builder (that is what `forge` is for).

### Repo resolution (Phase 1, minimal)
Helper: if `--repo` starts with `/` or `~`, treat as a path and `expand_tilde`. Otherwise treat as a bare name and resolve to `~/Desktop/<name>` then `expand_tilde`. Verify `is_dir()`; if not, print a clear error and exit 1. Covers `antfarm-write-test` (`~/Desktop/antfarm-write-test`) and `roast-dash`. Richer resolution (recents, basename match) is a later add.

### Plumbing the CLI builds itself
- `claude_path` via `dispatch::resolve_claude_path()`.
- `children` / `reasons` as fresh `Arc::new(Mutex::new(HashMap::new()))` (no managed Tauri state needed — cores take plain Arcs).
- `pod_id` / `spec_id` via the existing `new_pod_id()` / `new_spec_id()` (make `pub` if needed) or a timestamp string.

### Hard rules that still hold
- Stop-before-push: the CLI commits LOCALLY only. It NEVER runs `git push`. (Local commits are not pushes — consistent with the locked rule.)
- Migration hard-stop: unchanged. The Builder prompt already refuses `supabase db push` and flags NEEDS YOU.
- Never target the live antfarm dev checkout with a write pod (it watches its own repo). Dogfood on `antfarm-write-test`.

### Gate (Connor verifies on his machine)
1. `cargo check` green (run in antfarm/src-tauri).
2. `cargo run -- forge "create hello-cli.txt with a one-line greeting" --repo antfarm-write-test` runs the full planner -> builder -> gate -> reviewer chain, ends ReadyToPush, commits LOCALLY in antfarm-write-test, prints the diff, and does NOT push.
3. Ground truth: in antfarm-write-test, `git log -1` shows the new local commit and `git status` shows the branch ahead of origin (nothing pushed).

Code's report ends at: file diff summary, `cargo check` green, commit/push of the Antfarm change itself. Connor runs the gate test above.

### In plain English
Phase 1 gives Antfarm a command-line mouth: you can type one line in a terminal and the same planner/builder/reviewer crew that runs in the app does the work, saves it locally, and stops before publishing. That command line is the hook everything else (a tool other AIs can call, and eventually your phone) plugs into.

# Engine/MCP/Phone — Claude Code Prompts

One phase at a time. Paste the Phase 1 prompt into a Claude Code session opened in the antfarm repo (`/Users/connordore/Desktop/antfarm`). Do not start Phase 2/3 until Phase 1 passes its gate.

---

## Phase 1 — Headless CLI

Paste everything in the box into Claude Code.

```
Add a headless CLI entry point to Antfarm so the existing agent crew can run from a terminal with no GUI. Reuse the existing Rust cores as-is. No networking, no new engine logic.

Work INCREMENTALLY and report after each step. Do NOT try to think through the whole thing in one pass. Build step 1, run `cargo check`, then continue.

CONTEXT — existing functions to reuse (do not rewrite them):
- src-tauri/src/pod.rs: `pub fn pod_loop(app: AppHandle, claude_path: String, children: Arc<Mutex<HashMap<String, Child>>>, reasons: Arc<Mutex<HashMap<String, &'static str>>>, pod_id: String, repo_path: String, task: String, context: Option<String>) -> PodTerminal`. `PodTerminal` is `ReadyToPush { commit_msg, diff, reviewer_note }` or `NeedsYou { reason }`. pod_loop does NOT commit; it leaves working-tree changes.
- src-tauri/src/spec.rs: `fn spec_loop(app, claude_path, children, reasons, spec_id, repo_path, scope)` (currently private, returns ()). It auto-decomposes the scope and commits each green item LOCALLY (no push) via a local-commit helper in the same file. Also in spec.rs is the local-commit helper used by spec mode (find it; it does `git add -A` + commit, no push).
- src-tauri/src/agents.rs: `pub fn spawn_agent_run(app, claude_path, children, reasons, agent_id, task, parent_run_id, resume_session, repo_path, builder_write) -> Result<(String, mpsc::Receiver<String>), String>`. `pub fn expand_tilde(path: &str) -> String`.
- src-tauri/src/dispatch.rs: `pub fn resolve_claude_path() -> String`.

DESIGN — getting an AppHandle headlessly:
These cores take an AppHandle only to emit progress events (all fire-and-forget). In the CLI, BUILD a Tauri app to obtain a real AppHandle but NEVER call `.run()`. On macOS the run loop never spins, so no window shows. Emits to zero listeners are harmless. This means ZERO signature changes to pod.rs/spec.rs/agents.rs.

STEP 1 — CLI dispatch + headless handle + `delegate` (simplest path first):
- At the very TOP of `fn main()` in src-tauri/src/main.rs (line ~2426), BEFORE `tauri::Builder`, read `std::env::args()`. If `args[1]` is one of `forge` | `spec` | `delegate`, call a new `run_cli(&args)` and then `return;` so the GUI never starts.
- Implement `fn run_cli(args: &[String])`. Inside it, build a headless app to get the handle:
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .build(tauri::generate_context!())
        .expect("failed to build headless antfarm app");
    let handle = app.handle().clone();
  Then build the shared plumbing: `let claude_path = dispatch::resolve_claude_path();`, `let children = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));`, `let reasons = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));`.
- Implement the `delegate` subcommand: `antfarm delegate <agent> "<task>"`. Call `agents::spawn_agent_run(handle, claude_path, children, reasons, agent_id, task, None, false, None, None)`, then `let final_text = rx.recv().unwrap_or_default();`, print it to stdout, `std::process::exit(0)`. Valid agent ids: jack, clerk, scout, scribe, pulitzer, scholar. Reject `builder` with a message pointing to `forge`.
- Run `cargo check`. Report green before continuing.

STEP 2 — `forge` subcommand (the gate target):
- `antfarm forge "<task>" --repo <name|path>`. Add a repo-resolution helper: if the value starts with `/` or `~`, treat as a path; else resolve to `~/Desktop/<name>`. Then `agents::expand_tilde(...)`. Verify `std::path::Path::is_dir`; on failure print a clear error and `exit(1)`.
- Generate a pod id (reuse pod.rs `new_pod_id()` — make it `pub` if needed — or a timestamp string).
- Call `pod::pod_loop(handle, claude_path, children, reasons, pod_id, repo_path.clone(), task, None)` directly (blocking, on the main thread).
- Match the result:
    - `PodTerminal::ReadyToPush { commit_msg, diff, reviewer_note }`: call the spec.rs local-commit helper to commit LOCALLY (`git add -A` + commit with `commit_msg`, NO push). If the helper isn't `pub`, make it `pub`. Then print the commit message, the reviewer note, and the diff. `exit(0)`.
    - `PodTerminal::NeedsYou { reason }`: print the reason, leave the working tree as-is, `exit(1)`.
- NEVER run `git push` anywhere in the CLI.
- Run `cargo check`. Report green.

STEP 3 — `spec` subcommand:
- Make `spec::spec_loop` `pub`.
- `antfarm spec "<scope>" --repo <name|path>`. Resolve repo as in step 2. Generate a spec id (reuse `new_spec_id()`, make `pub` if needed). Call `spec::spec_loop(handle, claude_path, children, reasons, spec_id, repo_path, scope)` directly (blocking). It commits each green item locally (no push). After it returns, print a short done summary and `exit(0)`.
- Run `cargo check`. Report green.

HARD RULES:
- The CLI commits LOCALLY only. It NEVER pushes.
- Do not change any pod_loop / spec_loop / spawn_agent_run logic. Only add the CLI entry, run_cli, the repo-resolution helper, and any `pub` visibility bumps needed.
- Do not run any `supabase db push` or migrations.
- Push the Antfarm change straight to main per the repo's flow only AFTER `cargo check` is green for all three steps. Report the diff summary, cargo check result, and commit hash. Do NOT run a live functional test — Connor runs that.

Report after each step with: what changed (file + lines), cargo check result, and the exact terminal command to invoke the new subcommand.
```

### Connor's gate test (run AFTER Code pushes, in his terminal in the antfarm repo)

```
cd ~/Desktop/antfarm/src-tauri
```

```
cargo run -- forge "create hello-cli.txt with a one-line greeting" --repo antfarm-write-test
```

Then verify nothing was pushed (run in his terminal in the antfarm-write-test repo):

```
cd ~/Desktop/antfarm-write-test
```

```
git log -1 --oneline
```

```
git status -sb
```

Expect: a new local commit at HEAD, `git status` shows the branch ahead of origin, hello-cli.txt present. If ReadyToPush printed and the commit exists with origin un-moved, Phase 1 passes.

---

## Phase 2 — Local MCP server (Phase 1 is green; this is next)

Standalone Node stdio MCP server that shells out to the built `ant-farm` binary. No Rust changes. Independent of whether the GUI is open. localhost/stdio only.

First build the release binary once. In Connor's terminal in the antfarm repo:

```
cd ~/Desktop/antfarm/src-tauri
```
```
cargo build --release
```

Binary lands at `~/Desktop/antfarm/src-tauri/target/release/ant-farm`.

Then paste this into a Claude Code session opened in the antfarm repo (`/Users/connordore/Desktop/antfarm`):

```
Build a standalone local MCP server that wraps the existing `ant-farm` CLI so Claude Code and Cowork can trigger the agent crew as native MCP tools. Node, stdio transport, no Rust changes.

Create a new folder `mcp-server/` in the antfarm repo with:
- package.json (type: module, deps: @modelcontextprotocol/sdk; bin not needed)
- index.mjs — an MCP stdio server using @modelcontextprotocol/sdk.

Binary path: read env `ANTFARM_BIN`, default to `/Users/connordore/Desktop/antfarm/src-tauri/target/release/ant-farm`. Resolve once at startup; if it does not exist, still start (tools report the missing-binary error when called).

Use Node `child_process.execFile` (NOT shell string interpolation — pass args as an array so tasks/scopes with quotes are safe). Capture BOTH stdout and stderr with a generous timeout (maxBuffer 50MB, timeout 1200000 ms = 20 min, since a pod runs for minutes). The CLI prints the RESULT to stdout and diagnostics + the NEEDS YOU reason to stderr, exiting 0 on success and 1 on NEEDS YOU / error. So: on exit 0 return stdout as the tool result text; on non-zero exit return the stderr text as the tool result text (do NOT throw — a NEEDS YOU is a normal, informative outcome the caller must see).

Expose these MCP tools:
- forge_run_pod  { repo: string, task: string }            -> execFile(bin, ["forge", task, "--repo", repo])
- forge_run_spec { repo: string, scope: string }           -> execFile(bin, ["spec", scope, "--repo", repo])
- delegate_agent { agent: string, task: string }           -> execFile(bin, ["delegate", agent, task])
- list_agents    {}                                         -> read ~/Desktop/antfarm-memory/agents/*/agent.json, return each agent's id (folder name) + role + a one-line description if present in the json. Pure Node fs, no CLI call.
- approve_and_push { repo: string } -> resolve the repo the same way the CLI does (absolute/~ as-is, bare name -> ~/Desktop/<repo>, expand ~), then execFile("git", ["-C", resolvedRepo, "push"]). Return stdout+stderr. THIS is the deliberate human-approved publish step; it is the only tool that pushes.

Each tool's description must be clear and name the stop-before-push contract: forge_run_pod / forge_run_spec COMMIT LOCALLY ONLY and never push; the human reviews and then calls approve_and_push.

Do NOT add a get_status tool — that is Phase 3 (the queue). 

Add a short mcp-server/README.md with the two registration commands:
- Claude Code:  claude mcp add antfarm-engine -- node /Users/connordore/Desktop/antfarm/mcp-server/index.mjs
- Cowork desktop: the equivalent entry in its MCP config (command: node, args: [absolute path to index.mjs]).

GATE: run `node index.mjs` and confirm it starts without crashing (it will wait on stdio — Ctrl+C is fine). Run `npm install` in mcp-server/ and confirm it completes. Do NOT run a live tool call — Connor does that after registering. Then push to main. Report: files created, npm install result, and the exact registration command.
```

### Connor's Phase 2 gate (after Code pushes)
1. Register the MCP in Claude Code: in his terminal, `claude mcp add antfarm-engine -- node /Users/connordore/Desktop/antfarm/mcp-server/index.mjs`.
2. Open a fresh Claude Code session and ask it to call `forge_run_pod` with repo `antfarm-write-test` and a tiny task (e.g. "create mcp-smoke.txt with one line"). Confirm it runs the crew and returns the commit hash + diff, and that nothing was pushed (`git -C ~/Desktop/antfarm-write-test status -sb` shows ahead, origin unmoved).

## Phase 3 — Queue + phone (not yet)
Supabase `jobs` table + Mac-side poller + hosted enqueue endpoint. Migration gate applies. Prompt to be written after Phase 2.

# Watchdog + Agent UX — Build Plan

Covers queue items #1 (run_agent timeout/watchdog) and #2 (agent UX pass).
Built together because both ride one new primitive: the ability to kill a running child.

Flow: Cowork plans/reviews → Code builds phase-by-phase → review diff before each commit.
Repo: `antfarm`. Build gate per phase: `cargo build` (Rust phases) and `npm run build` (frontend phase), reported green before commit. No push until reviewed.

---

## Decision: how the watchdog avoids killing legit long runs (locked 2026-06-26)

A truly hung `claude -p` goes SILENT on stdout. A legit long run (Builder writing code, Scout deep research) never stays silent for long — it streams tool_use + assistant events the whole time it works. So:

- **Primary guard = silence timeout.** Kill if no stdout line for `SILENCE_SECS = 120`. Cannot false-positive on a working run, because working runs always emit.
- **Backstop = wall-clock.** Kill if total runtime exceeds `WALL_SECS = 1800` (30 min). Only ever trips the pathological "streams junk forever, never returns a result" case.

Both tunable as consts at the top of `agents.rs`.

---

## Shared primitive

`run_agent` already stores each `Child` in `AgentRunState.children` keyed by `run_id`. Both the watchdog and the manual stop button kill via that same map. Killing the child closes the stdout pipe → the reader thread hits EOF and exits. We tag WHY it ended so the terminal event is correct.

Add a per-run reason map so the reader can emit the right terminal event:
- natural finish → existing `done` / `error` (unchanged)
- watchdog kill → `kind: "timeout"`
- manual stop → `kind: "stopped"`

---

## Phase A — backend watchdog + kill path (#1)

Goal: no run can hang forever, and a run can be killed on demand.

1. Add consts near the top of `agents.rs`:
   ```rust
   const SILENCE_SECS: u64 = 120;
   const WALL_SECS: u64    = 1800;
   ```
2. Extend `AgentRunState` with a reason map:
   ```rust
   pub reasons: Arc<Mutex<HashMap<String, &'static str>>>,
   ```
   ("running" implicit by absence; set to "timeout" or "stopped" on kill). Update `Default`.
3. In `run_agent`, before spawning the reader thread, create a shared last-activity clock:
   `let last_activity = Arc::new(Mutex::new(std::time::Instant::now()));` plus `let started = std::time::Instant::now();`
4. In the reader loop, on every non-empty line: `*last_activity.lock().unwrap() = Instant::now();` (touch before parsing).
5. Spawn a watchdog thread (clone `children`, `reasons`, `last_activity`, `app`, `run_id`, `agent_id`, `parent_run_id`):
   ```
   loop {
     sleep 5s
     if children.get(run_id).is_none() { break }   // reader already finished it
     let idle = last_activity.elapsed(); let total = started.elapsed();
     if idle > SILENCE_SECS || total > WALL_SECS {
        reasons.insert(run_id, "timeout");
        children.get_mut(run_id).map(|c| c.kill());
        break;
     }
   }
   ```
   Watchdog does NOT emit the event — the reader does, from the reason flag, so there's exactly one terminal event.
6. Reader EOF/safety-net branch (currently emits "done" when `result_text` is empty): read `reasons.remove(run_id)`. If `"timeout"` → emit `kind: "timeout"`, text `"Timed out after {SILENCE_SECS}s of silence (or {WALL_SECS}s wall limit)."`. If `"stopped"` → emit `kind: "stopped"`, text `"Stopped by Connor."`. Else keep existing behavior. Also `append_agent_log(..., is_error=true)` for timeout/stopped so log.md records it.
7. New command:
   ```rust
   #[tauri::command]
   pub fn stop_agent(agent_run: State<AgentRunState>, run_id: String) -> Result<(), String> {
     agent_run.reasons.lock().unwrap().insert(run_id.clone(), "stopped");
     if let Some(child) = agent_run.children.lock().unwrap().get_mut(&run_id) { let _ = child.kill(); }
     Ok(())
   }
   ```
8. Register `agents::stop_agent` in the `invoke_handler!` list in `main.rs` (next to `agents::run_agent`).

Acceptance: a hung run is killed and surfaces a clear "timed out" entry; `cargo build` green. (Connor verifies live by starting a run and watching it not hang.)

---

## Phase B — backend live activity + output capture (#2 data)

Goal: the frontend can show WHAT an agent is doing and WHICH files it produced.

In the reader loop, the `assistant` message content array contains `tool_use` blocks (alongside `text`). For each `tool_use` block:

1. Read its `name`. Emit `kind: "activity"` with a friendly label:
   - `WebSearch` / `WebFetch` → "searching the web"
   - any `*Gmail*` tool → "reading inbox"
   - any `*Calendar*` tool → "checking calendar"
   - `Read` / `Glob` / `Grep` → "reading files"
   - `Write` / `Edit` → "writing files"
   - `Bash` → "running a command"
   - fallback → the tool name
2. If the tool is `Write` or `Edit`, capture `input.file_path`. Resolve to absolute against the vault root if relative (the child runs with `current_dir = vault`). Collect into a `Vec<String>` `outputs`, de-duped, capped at ~10.
3. On the `result` event, include `outputs` in the done payload.

Extend `AgentStreamEvent` with `#[serde(default)] pub outputs: Vec<String>` (fill empty `vec![]` on all existing emits). The `activity` event reuses `text` for the label.

Acceptance: `cargo build` green; activity + outputs flow on the stream (verify with a quick console log on the frontend listener).

---

## Phase C — frontend UX pass (#2 UI)

In `src/pages/Chat.tsx`:

1. `StreamEntry`: add `status` variants `"timeout"` and `"stopped"`; add `activity?: string` and `outputs?: string[]`.
2. `agent-stream` listener: handle `kind === "activity"` (set `entry.activity`, keep status live); `kind === "timeout"` / `"stopped"` (set matching status + text); set `outputs` on done.
3. Live header label: replace the binary `"thinking… / responding…"` with `entry.activity ?? (entry.text ? "responding…" : "thinking…")`. Keep the spinner.
4. **Stop button:** on live entries (`isLive`), render a small X / "Stop" button in the header that calls `invoke("stop_agent", { runId: entry.runId })`. Disable if `runId === ""` (run id not assigned yet).
5. **Clear states:** distinct rendering for done (zinc), failed/`error` (red, message surfaced — already mostly there), `timeout` (amber, clock icon, "Timed out"), `stopped` (zinc/muted, "Stopped"). Make sure the error/timeout text is always visible, not swallowed.
6. **Output links:** when `entry.outputs?.length`, render each as a clickable chip under the body that calls `shellOpen(path)` (`import { open as shellOpen } from "@tauri-apps/plugin-shell"` — already used in Workspace.tsx; `shell:allow-open` capability is present). Show the basename as the label.
7. Polish: confirm the Approve/Reject (NEEDS YOU) flow still reads cleanly; ensure a "Failed to start" still renders as an error state, not a dangling spinner.

Acceptance: `npm run build` green; live runs show real activity, can be stopped, end in an unambiguous state, and Scout's PDF (and any written file) appears as a clickable link. Connor verifies live.

---

## Sequencing

A → review → commit → B → review → commit → C → review → commit. Each is independently shippable. After C, move to queue #3 (trim CLAUDE.md), then connectors (#4).

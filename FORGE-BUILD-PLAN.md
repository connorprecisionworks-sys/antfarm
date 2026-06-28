# Forge — Coding Crew Phase 2 build plan

Scoped 2026-06-27 (Cowork). Forge is the autonomous coding division inside the Chief of Staff system. Phase 1 (write-capable Builder, single agent, stop-before-push, build-gate, Approve-and-push card) is proven. Phase 2 adds the **Planner -> Builder -> Reviewer pod loop**: agents that plan, build, verify, and critique each other, iterating to green, then stopping for Connor to push.

Read this whole file before writing code. Build in the phase order below. Each phase pushes straight to `main` only after its acceptance checks pass and `cargo check` + `npm run build` are both green.

## Locked decisions (do not relitigate)

- **Loop controller lives in RUST**, not Chat.tsx. A 3-role iterate-to-green state machine with a cap belongs where the watchdog/kill/session logic already live, and it must survive frontend remounts. New module `src-tauri/src/pod.rs` (or a clearly-marked section of agents.rs), reusing `run_agent`'s spawn machinery.
- **Verification is a deterministic Rust command**, never model-eyeballed. It runs the real build and parses exit status. Reviewer does the LOGIC critique only.
- **Planner pre-approval = OFF.** Pod runs Plan -> Build -> Verify straight through and stops at the push gate. The plan is visible as the pod's first tab. (Leave a `require_plan_approval: bool` option on the pod, default false, for later.)
- **Outer loop cap = 3 rounds** (build -> review -> rebuild). Builder's internal build-fix retries stay capped at 5. After 3 outer rounds, STOP and escalate to Connor in plain English.
- **STOP BEFORE PUSH, always.** The pod NEVER calls `builder_commit_push`. It ends by surfacing the existing Approve-and-push card to Connor. Connor pushes.
- **Migration hard-stop stays** (Builder prompt + Bash guard hook already enforce it). The pod inherits it. Never autonomous migrations.
- **Dogfood/test target repo = `~/Desktop/antfarm-write-test`** (it has a local bare remote). Per the separate-clone rule, NEVER point the pod at the live antfarm dev checkout — the running app watches its own repo and a write triggers a rebuild mid-run. For real antfarm self-improvement later, use a separate clone.

## What already exists (reuse, do not rebuild)

- `run_agent` spawn machinery in agents.rs: cold-start vs `--resume`, `--add-dir` scoping, `--disallowedTools` via `build_deny_list`, write-mode flags (`--permission-mode bypassPermissions` + `ensure_builder_hooks` `--settings`) gated on `builder_write`.
- `AgentStreamEvent` (kind: start/text/activity/done/error/timeout/stopped), the watchdog (SILENCE_SECS 300 / WALL_SECS 1800), the kill primitive (`AgentRunState.reasons`), session auto-reset on prompt.md/agent.json mtime.
- Builder write-mode prompt contract: `---COMMIT: <msg>---` marker, `git diff HEAD`, NEEDS YOU for migrations/destructive ops.
- `builder_commit_push(repo_path, commit_message)` in main.rs (git add -A -> commit -> push), called by the green Approve card.
- Chat.tsx: `parseDelegations`, `handleFanout`, the dependency `(after:)` queue, `TabbedDelegation` panel (status dots, activity line, needs-you badge), `BuilderDoneCard` green Approve-and-push card (gated on `entry.builderWrite === true`).
- New vault agents already created by Cowork: `agents/planner/` and `agents/reviewer/` (both offline-code, read-only). Their `agent.json` + `prompt.md` are in the antfarm-memory vault. Planner outputs `---PLAN-READY---`; Reviewer outputs `---REVIEW: PASS---` or `---REVIEW: FAIL: <notes>---`.

---

## Phase 2a — Deterministic verification gate command

Smallest, independently useful piece. Build first.

Add a Tauri command `run_verification_gate(repo_path: String) -> Result<GateResult, String>` where:

```rust
struct GateResult { passed: bool, command: String, output: String }
```

- Auto-detect the build command from the repo root: if `Cargo.toml` exists run `cargo check` (in `src-tauri/` if that's where Cargo.toml is, else repo root); else if `package.json` has a `build` script run `npm run build`; else return an error "no known build command."
- Run it with cwd = repo root, capture combined stdout+stderr (truncate to a sane cap, e.g. last 8000 chars, so a wall of errors doesn't blow up the event payload).
- `passed = exit status success`. Return the command string and captured output either way.
- This is a plain `std::process::Command` call (like `builder_commit_push`), NOT routed through any agent's Bash tool, so the guard hook never touches it.

**Acceptance:** call `run_verification_gate` on antfarm-write-test (green) -> `passed: true`; introduce a deliberate compile error -> `passed: false` with the error text in `output`. Unit test the command-detection logic. `cargo check` + `npm run build` green. Commit + push.

---

## Phase 2b — Register Planner and Reviewer

- Confirm `list_agents` picks up the new `agents/planner/` and `agents/reviewer/` folders (they follow the existing agent.json schema). No code change should be needed beyond confirming discovery; fix if the loader filters by a hardcoded set.
- Add `planner` and `reviewer` to `KNOWN_AGENT_IDS` in Chat.tsx (currently `["scout","scribe","clerk","builder"]`).
- Verify both spawn READ-ONLY: in advisory mode (`builder_write=false`) for the `offline-code` profile, `build_deny_list` must deny `Write,Edit,MultiEdit,NotebookEdit,Bash` for them. Confirm Planner/Reviewer cannot write or run Bash.

**Acceptance:** spawn Planner with a trivial "summarize how X works" task against antfarm-write-test and confirm it reads files and produces a plan but cannot Write/Edit/Bash (check the deny list in the spawn args / log). Same read-only confirm for Reviewer. `cargo check` + `npm run build` green. Commit + push.

---

## Phase 2c — The pod loop controller (the core)

New command `run_pod(repo_path: String, task: String, opts: PodOptions) -> Result<String, String>` returning a `pod_id`. Drives the loop server-side, emitting a `pod-stream` event stream so the frontend can render it.

State machine (all spawns reuse the existing `run_agent` spawn helper — refactor it so the controller can call it and await a single run's final text, rather than only fire-and-forget):

1. **PLAN.** Spawn `planner` read-only, `--add-dir repo_path`, task = the build request. Await terminal. Capture text up to `---PLAN-READY---` as `plan`. (If `opts.require_plan_approval`, emit a needs-you event and wait for an approve command before continuing. Default false -> continue.)
2. **BUILD.** Spawn `builder` with `builder_write=true`, `--add-dir repo_path`, task = the original request + the injected `plan` + (on rounds >1) the prior round's fix notes. Builder self-build-gates and ends at `---COMMIT: <msg>---`. Capture the commit message + the run.
   - If Builder emits `NEEDS YOU:` (migration/destructive/blocked), STOP the pod and emit a needs-you terminal event carrying that message. Do not loop.
3. **GATE.** Call `run_verification_gate(repo_path)`. If `passed=false`, treat as a failed round: feed the captured `output` back to Builder as fix notes, increment the round counter, go to step 2 (unless cap hit).
4. **REVIEW.** Spawn `reviewer` read-only, `--add-dir repo_path`, task = original request + plan + the output of `git diff HEAD` (run via `std::process::Command`, inject as text). Await terminal. Parse the last verdict line:
   - `---REVIEW: PASS---` -> go to step 5.
   - `---REVIEW: FAIL: <notes>---` -> failed round: feed `<notes>` back to Builder, increment round, go to step 2 (unless cap hit).
5. **STOP / READY.** Emit a terminal `pod-stream` event of kind `ready_to_push` carrying: the commit message, the final `git diff HEAD`, and a plain-English summary. This is what renders the Approve-and-push card. The pod does NOT push.
6. **CAP.** If round counter reaches 3 without passing, STOP and emit a `needs_you` terminal event: plain-English explanation of where it got stuck (last gate output or last review notes), so Connor can decide.

Details:
- **Round counter** = outer rounds (a failed gate OR a failed review both consume a round). Cap 3.
- **Builder session within a pod:** resume Builder's session across rounds of the SAME pod so it remembers what it tried (pass `resume_session=true` after round 1). Planner and Reviewer spawn fresh each time.
- **`pod-stream` event:** reuse the `AgentStreamEvent` shape with added `pod_id: String` and `step: String` ("planning"|"building"|"verifying"|"reviewing"|"ready_to_push"|"needs_you") so the existing tabbed UI can map each role to a tab and show the current step. Emit `start`/`activity`/`text`/terminal per sub-run as today, tagged with the pod_id.
- **Watchdog/kill:** each sub-run keeps the existing per-run watchdog. Add a pod-level stop that kills the active child and halts the loop (reuse `AgentRunState.reasons`).
- **Plain English:** every pod-stream status the UI surfaces should be 5th-grade plain English ("Planning the change", "Writing the code", "Checking it builds", "Reviewing the logic", "Done and safe — ready for you to publish"). No jargon to Connor.

**Acceptance (the real test, run against `~/Desktop/antfarm-write-test`):** give the pod a small real task (e.g. "add a function that reverses a string and a test for it"). Observe Planner -> Builder -> gate green -> Reviewer PASS -> `ready_to_push` with a diff. Then give it a task you know needs a second round (or force a review FAIL once) and confirm it loops back to Builder and the round counter caps at 3 with a clean plain-English escalation. Confirm the pod NEVER pushed (git log on antfarm-write-test). `cargo check` + `npm run build` green. Commit + push.

---

## Phase 2d — Frontend pod view

- A minimal Forge launcher: a repo picker (default `~/Desktop/antfarm-write-test` while dogfooding) + a task box + a "Run Forge pod" button -> `invoke("run_pod", ...)`. Can live as a section in Chat or a new lightweight page; do not over-build it.
- Render the running pod by reusing `TabbedDelegation`: one tab per role (Planner / Builder / Reviewer), status dots, live activity line, current-step label, the plain-English roll-up at the top.
- On the `ready_to_push` terminal event, render the existing `BuilderDoneCard` green Approve-and-push path (commit message + diff + push button calling `builder_commit_push`). On `needs_you`, render the escalation in plain English with the stuck-state detail.

**Acceptance:** run a pod end to end from the UI against antfarm-write-test, watch the role tabs update live, land on the green card, click it, confirm the commit+push happened (git log). `cargo check` + `npm run build` green. Commit + push.

---

## Hard gates (every phase, non-negotiable)

- STOP before push — the pod never pushes; Connor's button does.
- HARD-STOP before any migration — never autonomous.
- Build-gate green before "done" — the deterministic gate, not tsc, not model judgment.
- Repo allow-list — the pod only touches the one `repo_path` passed in, via `--add-dir`.
- Do NOT point the pod at the live antfarm dev checkout. Test against antfarm-write-test.
- Connor verifies the real end-to-end run on his machine; Code's report ends at diff summary + commit hash + push confirmed + build green.

## Out of scope for Phase 2 (do not build)

- Parallel pods + Jack cross-pod orchestration (Phase 3).
- A first-class Tasks/Progress panel (logged as a later idea; the pod's steps will feed it then).
- Pointing Forge at Roastlytics or any DB/prod repo (last, and migrations stay manual forever-for-now).

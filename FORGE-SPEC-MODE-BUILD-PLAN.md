# Forge Spec Mode — autonomous big-scope build plan

Scoped 2026-06-28 (Cowork). The goal: Connor pastes one large scope, walks away, and Forge breaks it into a bounded checklist, runs the pod loop on each item, commits each locally, and keeps going until the whole scope is satisfied, then presents one review with every commit + the full diff for a single approve-and-push.

Why this works where one giant pod doesn't: a single pod overflows its context on a big scope and the 3-round cap stops it half-done. Spec mode keeps each sub-pod small (so it converges) and persists progress by committing each item locally. The unlock is AUTO-DECOMPOSITION, not removing the cap.

Read all of this before building. Phase order matters. Each phase: cargo check + npm run build green, then commit. No DB migrations.

## Locked decisions
- Decompose with the Planner agent (read-only) into an ordered checklist of bounded tasks.
- Run the EXISTING pod loop (pod_loop: plan -> build -> gate -> review, cap 3) per checklist item. Reuse it, do not reimplement.
- Commit each green item LOCALLY (git add -A + commit, NO push). This stacks progress so item N builds on N-1.
- Flag-and-continue: if an item caps or hits NEEDS YOU (migration/destructive), record it and move to the next item. Never halt the whole run on one item.
- STOP BEFORE PUSH holds: the whole run commits locally only; the final card has ONE "Approve and push all" that Connor clicks. Migrations never autonomous.
- Separate-clone / non-self-watching repo rule unchanged. Per-item cap stays 3.

## Reuse (do not rebuild)
- pod_loop in pod.rs (the plan/build/gate/review state machine, emits pod-stream).
- spawn_agent_run (await a single agent's final text) for the decompose step.
- builder_commit_push in main.rs (git add -A + commit + push) — factor out a commit-only variant.
- The Forge thread store + pod rendering in Forge.tsx.

---

## Phase A — Spec controller backend (run_spec)

Add `run_spec(repo_path: String, scope: String, opts) -> spec_id`, spawns a background thread running `spec_loop`, emits `spec-stream` events.

`commit_local(repo_path, message)` (Rust, factored from builder_commit_push): git add -A + git commit -m, NO push. Returns commit hash. Reused per item.

`spec_loop`:
1. DECOMPOSE. Spawn the planner (read-only, --add-dir repo) with a decompose prompt: "Given this scope and the repo, produce an ordered checklist of bounded build tasks, each small enough to build and review in a single pass (one page, one feature, one data change). Output a numbered list, one concrete task per line, ordered so each builds on the last. End with ---CHECKLIST-READY---." Parse the numbered list into items[]. Emit a `checklist` spec-stream event with the items (the UI shows the plan).
   - opts.require_checklist_approval (default false): if true, emit needs_you and wait for an approve command before running. Default: proceed, but the checklist is displayed so Connor can stop it.
2. For each item i in order:
   - emit `item_start` (index, text).
   - Run pod_loop INLINE for this item: task = item text, context = the overall scope + a one-line summary of items already completed, repo_path. Let it run plan -> build -> gate -> review with the existing cap 3. (Refactor pod_loop if needed so spec_loop can call it and get a terminal result: ready_to_push | needs_you.)
   - On ready_to_push: call commit_local(repo, "<short item summary>"). Mark item done, record commit hash. emit `item_done`.
   - On needs_you (cap hit or NEEDS YOU): mark item flagged with the reason, emit `item_flagged`, and CONTINUE to the next item. Do not push, do not halt.
3. After all items: emit `spec_done` carrying: the checklist with per-item status (done/flagged + reason), `git log --oneline <start>..HEAD` of the local commits, and the cumulative diff `git diff <start>^..HEAD` (use the intent-to-add trick so new files show). This is the final review payload.

`spec-stream` event shape: reuse the AgentStreamEvent/PodStreamEvent pattern + a `spec_id`, `phase` ("decomposing"|"checklist"|"item_start"|"item_done"|"item_flagged"|"spec_done"), `item_index`, `item_text`, and the final summary fields. Per-item pod-stream events still fire (tagged with the item) so the UI can show the live pod under each item.

**Acceptance (DevTools, against ~/Desktop/antfarm-write-test):** call run_spec with a 3-part scope (e.g. "add a utils.js with slugify + capitalize + truncate, each with a usage comment"). Observe: a checklist of ~3 items, each runs the pod loop, each green item produces a LOCAL commit (git log shows 3 commits, branch NOT pushed), final spec_done with all three done. Force one item to fail and confirm it's flagged and the run continues. cargo check + npm run build green. Commit + push (the feature).

---

## Phase B — Forge spec-mode UI

In Forge.tsx (or a clearly separated mode in the Forge page):
- A "Spec mode" entry: a larger scope textarea + a "Run spec" button (alongside the normal single-task input). Repo picker as usual.
- On run: render the checklist as it arrives (the deferred Tasks/Progress panel idea — this IS it): each item a row with a status chip (pending / building / done / flagged), the live pod (role tabs) expandable under the active item.
- On spec_done: a final review card showing the checklist summary, the list of local commits, a collapsible full diff, any flagged items with reasons, and ONE "Approve and push all" button (pushes the accumulated local commits via a single git push). Plus a "discard" that leaves the commits local for manual handling.
- Persist the spec run in the Forge thread store like a turn.

**Acceptance:** paste a multi-part scope in the UI against antfarm-write-test, watch the checklist tick through, land on the final card, click Approve and push all, confirm the commits push (git log on the bare remote). cargo check + npm run build green. Commit + push.

## Hard gates
- No push until the final Approve-and-push-all. Migrations never autonomous (flagged + skipped). Per-item build-gate green. Repo allow-list. Separate-clone. The decompose + per-item review keep quality; Connor reviews the whole run before publishing.

## Out of scope (later)
- Parallel item execution (keep sequential; items often depend on each other).
- Re-running only the flagged items (nice follow-up: a "retry flagged" button).
- Cross-repo specs.

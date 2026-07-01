# Forge Spec Mode — Claude Code prompts

Paste into Claude Code, in the `antfarm` repo, one phase at a time. Paste Code's report back to Cowork before the next. Full `npm run tauri dev` restart after Rust changes. No migrations.

---

## Prompt 1 — Phase A (spec controller backend)

```
Read FORGE-SPEC-MODE-BUILD-PLAN.md in the repo root, all of it. Build Phase A: the run_spec backend.

1. Add a commit_local(repo_path, message) Rust command factored out of builder_commit_push: git add -A + git commit -m, NO push. Returns the commit hash.

2. Add run_spec(repo_path, scope, opts) that spawns a background thread running spec_loop and returns a spec_id. spec_loop:
   - DECOMPOSE: spawn the planner read-only (--add-dir repo) with a decompose prompt that returns an ordered numbered checklist of bounded build tasks ending with ---CHECKLIST-READY---. Parse into items. Emit a checklist spec-stream event.
   - For each item in order: run the existing pod_loop inline (task = item, context = overall scope + summary of completed items, repo_path), reusing the plan->build->gate->review cap-3 machinery. Refactor pod_loop if needed so spec_loop can call it and get a terminal result (ready_to_push | needs_you). On ready_to_push: commit_local and mark done. On needs_you: flag with reason and CONTINUE to the next item (never halt; never push).
   - After all items: emit spec_done with the checklist statuses, git log of the local commits, and the cumulative diff (use git add -N so new files show).
   - Emit spec-stream events (spec_id, phase, item_index, item_text, summary). Per-item pod-stream events still fire.

Honor every gate: no push (commit_local only), migrations flagged-and-skipped, per-item cap stays 3.

Test against ~/Desktop/antfarm-write-test only. Report the diff, cargo check + npm run build, and a DevTools run of run_spec with a 3-part scope showing: a checklist, three local commits (git log), nothing pushed, and one forced failure that gets flagged while the run continues. Stop for my review — this touches the loop controller and git committing.
```

---

## Prompt 2 — Phase B (Forge spec-mode UI)

```
Phase A is approved. Build Phase B from FORGE-SPEC-MODE-BUILD-PLAN.md: the Forge spec-mode UI.

Add a spec-mode entry to the Forge page: a larger scope textarea + a "Run spec" button next to the normal single-task input, same repo picker. On run, render the checklist live from spec-stream: each item a row with a status chip (pending / building / done / flagged) and the live pod (role tabs) expandable under the active item. On spec_done, render a final review card: checklist summary, list of local commits, collapsible full diff, flagged items with reasons, and ONE "Approve and push all" button (single git push of the accumulated commits), plus a discard option. Persist the spec run in the Forge thread store.

Report the diff and cargo check + npm run build. I'll run the full end-to-end spec test from the UI against antfarm-write-test myself, then we point it at the connordore.com scope.
```

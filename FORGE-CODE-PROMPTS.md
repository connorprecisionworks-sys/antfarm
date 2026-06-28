# Forge Phase 2 — Claude Code prompts

Paste these into Claude Code, in the `antfarm` repo, one phase at a time. After each phase, paste Code's report back to Cowork for review before sending the next. Every Rust change needs a full `npm run tauri dev` restart before testing, not just closing the window. There are no database migrations in this work.

---

## Prompt 1 — Phase 2a (verification gate)

```
Read FORGE-BUILD-PLAN.md in the repo root, all of it, before writing any code. It is the full Phase 2 build plan for the Forge coding crew.

Build Phase 2a ONLY: the run_verification_gate Tauri command per the plan. Do not start 2b. When 2a is done, report back with the file diff, the cargo check and npm run build results, and the output of run_verification_gate run against ~/Desktop/antfarm-write-test in both the green case and a deliberately-broken case. Stop there for my review before pushing or moving on.
```

---

## Prompt 2 — Phase 2b (register Planner and Reviewer)

```
Phase 2a is approved. Build Phase 2b from FORGE-BUILD-PLAN.md: register the planner and reviewer agents.

The vault folders agents/planner/ and agents/reviewer/ already exist with agent.json and prompt.md. Confirm list_agents discovers them with no hardcoded filter blocking it, add planner and reviewer to KNOWN_AGENT_IDS in Chat.tsx, and verify both spawn READ-ONLY (advisory mode, offline-code profile must deny Write, Edit, MultiEdit, NotebookEdit, Bash via build_deny_list).

Report back with the file diff, cargo check and npm run build results, and proof from a live spawn that Planner and Reviewer can read files but cannot Write, Edit, or run Bash (show the deny list in the spawn args or the run log). Stop for my review before moving on.
```

---

## Prompt 3 — Phase 2c (the pod loop controller, the core)

```
Phase 2b is approved. Build Phase 2c from FORGE-BUILD-PLAN.md: the run_pod loop controller in Rust.

This is the biggest phase. The load-bearing change is refactoring run_agent so the controller can await a single sub-run's final text instead of fire-and-forget streaming. Do that carefully and keep the existing fire-and-forget path working for the current chat and fan-out flows. Do not break Captain Jack delegation.

Build the full Plan -> Build -> deterministic gate -> Review -> loop (cap 3 outer rounds) -> stop-before-push state machine exactly as the plan specifies, emitting pod-stream events. Honor every hard gate: the pod never pushes, never migrates, only touches the one repo_path via --add-dir, and Builder keeps its existing write-mode locks.

Do NOT test against the live antfarm checkout. Use ~/Desktop/antfarm-write-test only.

Report back with: the file diff, cargo check and npm run build results, and a description of a live run against antfarm-write-test where the pod planned, built, passed the gate, passed review, and stopped at ready_to_push WITHOUT pushing (confirm with git log on antfarm-write-test that nothing was committed or pushed by the pod). Also show one run that fails review or the gate once and loops back to Builder, and confirm the round counter caps at 3 with a plain-English escalation. Stop for my review before Phase 2d.
```

---

## Prompt 4 — Phase 2d (frontend pod view)

```
Phase 2c is approved. Build Phase 2d from FORGE-BUILD-PLAN.md: the frontend pod view.

Add the minimal Forge launcher (repo picker defaulting to ~/Desktop/antfarm-write-test, a task box, a Run Forge pod button calling run_pod), render the running pod by reusing TabbedDelegation with one tab per role and the plain-English roll-up, and wire the ready_to_push terminal event to the existing BuilderDoneCard green Approve-and-push path. Render needs_you escalations in plain English with the stuck-state detail. Do not over-build the launcher.

Report back with the file diff and the cargo check and npm run build results. I will run the full end-to-end test from the UI against antfarm-write-test myself.
```

---

## Standalone — Approve-and-push card fix (run anytime, parallel)

Cowork confirmed the root cause from the code: the green card is hard-gated on `entry.builderWrite === true` (Chat.tsx around line 251), so the regex was never the issue. The builder_write flag is not surviving onto the completed chat entry.

```
The Approve-and-push card still does not render after a completed write-mode Builder run, even with a same-line ---COMMIT:--- marker. Root cause is confirmed: the card is gated on entry.builderWrite === true (Chat.tsx around line 251: entry.builderWrite ? entry.text.match(...) : null), and the builder_write flag is not surviving onto the completed StreamEntry for a chat write-mode run.

Trace where builderWrite is set on the StreamEntry and why it is false or undefined by completion time for a chat-addressed write-mode Builder run. Fix it so a completed write-mode run with a ---COMMIT:--- marker reliably renders the green Approve-and-push card with a working commit-and-push button.

Acceptance: a live write-mode run against ~/Desktop/antfarm-write-test shows the green card, and clicking it commits and pushes (verified with git log). Report the diff plus cargo check and npm run build results. Stop for my review.
```

# Console Rung Code Prompts

Paste-ready prompts for the console glow-up rungs (see CONSOLE-SCOPE.md). One bounded rung at a time. Execution work for a cheap/fast model or Claude Code, not the Fable window.

---

## Rung A — Live play-by-play (step narration)

Paste into Claude Code opened in the antfarm repo (`/Users/connordore/Desktop/antfarm`).

```
Implement live step narration for the antfarm engine queue (Console Rung A). Two parts: a tiny Rust change so each pod/spec step prints a machine-readable line, and a poller change to stream those into Supabase as a job runs. The React console already reads `current_phase` and `steps`, so NO console change is needed. Work incrementally; run the gate after each part and report.

PART 1 — Rust (engine): make steps observable on stderr.
- src-tauri/src/pod.rs, function `emit_pod` (~line 58): it already does `let _ = app.emit("pod-stream", ...)`. Add ONE line at the end of the function:
    eprintln!("[STEP]\t{}\t{}", step, text);
- src-tauri/src/spec.rs, function `emit_spec` (~line 74): add after the existing emit:
    eprintln!("[STEP]\t{}\t{}", event.phase, event.item_text.clone().unwrap_or_default());
- Additive only; do not change existing behavior.
- GATE: `cargo build --release` green (this rebuilds the ant-farm binary the poller runs). Report, then continue.

PART 2 — Poller: stream steps into Supabase live.
- engine-queue/poller/index.mjs, function `processQueued`.
- Replace the single `execFileAsync(ANTFARM_BIN, args, EXEC_OPTS)` call with a streamed `spawn` so stderr can be read line-by-line while the job runs:
    - import { spawn } from "node:child_process".
    - Spawn the binary. Accumulate ALL stdout into a string (needed for the existing final parse). Also accumulate all stderr into a string (for NEEDS YOU / error detection). Read stderr incrementally (readline over the stderr stream, or split buffered chunks on newlines).
    - For each stderr line matching /^\[STEP\]\t([^\t]*)\t(.*)$/: phase = group 1, text = group 2. Append { phase, text, ts: new Date().toISOString() } to a local `steps` array and update the job live:
        await supabase.from("jobs").update({ current_phase: phase, steps }).eq("id", job.id);
    - On process close, exit code 0: parse the buffered stdout with the existing parseForgeOutput and set { status: "done", result_summary: stdout, commit_hash, reviewer_note, diff, current_phase: "done" } (keep the accumulated steps).
    - On non-zero exit: if accumulated stderr includes "NEEDS YOU" -> { status: "needs_you", result_summary: stderr }; else { status: "error", error: stderr || "unknown error" }.
- Keep single-job-at-a-time and the approvals-first tick logic unchanged.
- GATE: `node --check index.mjs`.

Report: files changed, cargo build result, node --check result. Do NOT run live — Connor tests by queueing a forge job from the phone and watching the pipeline light up step by step.
```

Connor's gate after Code pushes: restart the poller (`node index.mjs` in engine-queue/poller), queue a forge job on antfarm-write-test from the phone, and watch the console pipeline advance Plan -> Build -> Review -> Done with live plain-English step text.

---

## Rungs B–F — to be written when Rung A is proven.

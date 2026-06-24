# Antfarm Diagnostic — crash / slowdown when running Claude Code

Date: 2026-06-23

## What you reported

Running Claude Code inside Antfarm crashes the machine and makes everything crawl.

## Root causes found

### 1. PTY output flood (the crash) — CRITICAL, fixed

`src-tauri/src/pty.rs` spawned a reader thread that emitted **one Tauri IPC event per ~4KB read** of the terminal output, each one base64-encoded and shipped across the webview boundary.

Claude Code's interactive UI repaints constantly: the spinner, streaming tokens, and full-screen ANSI redraws produce a torrent of small writes. At that rate the app fires thousands of IPC messages per second. The webview's main thread and the JSON serialization saturate the CPU, the queue of pending events balloons memory, the system starts swapping, and the whole machine locks. Add a second pane (orchestrator + executor) and you double the firehose.

This is the textbook way a Tauri/Electron app melts a machine: high-frequency, unthrottled IPC.

**Fix:** added flow control. The raw reads now go through a channel to a second "batcher" thread that coalesces output and emits at most once per ~8ms, or whenever 64KB accumulates. A flood of thousands of tiny events collapses into a steady, bounded stream (max ~125 events/sec) while still looking real-time. Reader buffer also bumped 4KB → 8KB.

### 2. Orphaned worktrees pile up forever — HIGH, fixed

Every harness run creates a git worktree at `.antfarm-worktrees/<run_id>`, and each one materializes a full working tree, usually carrying a ~200MB `node_modules`. The old code only cleaned the worktree with the *same* run_id before reusing it. Since every run gets a fresh timestamped id, old worktrees were never removed.

Result right now: 8 worktrees, 5 of them ~197MB each — roughly 1GB of dead checkouts. The whole Antfarm folder is 9.2GB. That dead weight thrashes the disk and inflates anything that scans the tree.

**Fix:** added `cleanup_orphan_worktrees()` in `harness.rs`. When a plan starts, it removes any antfarm worktree whose run_id isn't part of the current plan. It keeps the `antfarm/<run_id>` git branch (your actual commits/work stay recoverable) and only deletes the on-disk working tree.

### What was already solid (no change needed)

The overnight harness itself is well-built and is your best interview artifact (see below). It already has wall-clock timeouts, stall/silence detection, USD budget caps, an abort flag, bounded parallelism, worktree isolation, and orphan reconciliation on startup. The crash was not in the agent logic; it was in the terminal plumbing and disk hygiene around it.

## Files changed

- `src-tauri/src/pty.rs` — batched/coalesced PTY output (the crash fix).
- `src-tauri/src/harness.rs` — orphan-worktree cleanup at plan start.

## Two things for you to run

### A. Verify the build (paste into Claude Code, in the `antfarm` repo)

```
Build the Tauri app and report the result. Run a release build of the Rust side and the Vite frontend, fix any compile errors in pty.rs or harness.rs, and confirm both are green. Do not change behavior beyond making it compile.
```

I can't compile the macOS Tauri target from here, so this is your build gate.

### B. Reclaim the ~1GB of dead worktrees now (run this in your terminal in the `antfarm` repo)

```
git worktree list
```

Then, after the build above is green and you've confirmed nothing in flight:

```
git worktree prune
```

The new code will keep this clean automatically from here, but the existing orphans predate the fix, so one manual prune clears them now. If `prune` alone doesn't reclaim the directories, the next harness run will, since cleanup now runs at plan start.

## In plain English

Antfarm was screaming every tiny flicker of the Claude Code terminal across to the app's display thousands of times a second, which is what choked your computer. Now it batches those updates a few times every 100th of a second instead, so the screen still looks live but your CPU and memory stop drowning. Separately, Antfarm was leaving behind a full copy of the project every time it ran a job and never cleaning them up, so a gig of junk built up. It now sweeps the old copies on each new run.

---

# Interview talking points — agent harnesses, loops, multi-step agents

Antfarm is a real, working agent harness, so you can speak from your own build instead of theory. Frame it like this.

**What an agent harness is.** A single LLM call is one shot with no guardrails. A harness is the supervisory wrapper that turns that into a controlled, bounded, recoverable process. Antfarm's `harness.rs` is exactly that: it spawns a headless `claude -p` process per step and supervises it live.

**The loop (this is the multi-step part).** Each run is a plan of steps. For every step Antfarm: builds a prompt with the run goal plus the prior step's result and the git log, runs the step, then runs an **acceptance check** (a shell command that must pass), commits a **checkpoint** if green or resets to the last good checkpoint if not, and moves on. After all steps, a separate **review** pass judges the whole diff. So the cycle is: plan → step → acceptance check → checkpoint or rollback → next step → final review. That is a closed feedback loop, not a fire-and-forget prompt.

**Watchdogs (how you keep an agent from running away).** Every step runs under four kill conditions: a wall-clock timeout, a silence/stall timeout (no output for too long), a USD budget cap computed live from streamed token usage, and a user abort flag. Hit any one and the process is killed and the reason recorded. This is the single most important thing interviewers want to hear: you thought about cost, runaway loops, and stalls.

**Isolation and safety.** Each run executes in its own git worktree on a private branch, so `main` is never touched. Permissions are constrained by an allowlist (`.claude/settings.json`); no network, no DB migrations, no servers. Failures are sandboxed.

**Bounded parallelism.** A worker pool of `max_parallel` threads pulls runs off a shared queue. Classic producer/consumer pattern, so concurrency is capped instead of spawning unbounded processes.

**Cost-aware model escalation.** Runs start on a cheap model (Haiku/Sonnet) and escalate one tier toward Opus on each retry. Cheap by default, smart only when needed.

**Orchestrator/executor split (multi-agent).** Opus 4.8 plans, Sonnet 4.6 executes the volume work. Different models for different jobs in one system.

**Recovery.** Each step's PID is persisted to `state.json` while it runs, and on a fresh startup `reconcile_orphans()` sweeps any entry still marked "running" from a crashed session. The harness survives its own restarts.

**The honest part (shows seniority).** The agent logic was sound; the failure was in the terminal I/O plumbing and disk hygiene around it. Knowing the difference between "the agent reasoning is wrong" and "the harness infrastructure is starving the host" is exactly the judgment the role is testing.

One-line version if they want it fast: *"I built an overnight agent harness that runs Claude Code in isolated git worktrees, supervised by timeout / stall / budget / abort watchdogs, with acceptance-checked checkpoints, model-tier escalation on retry, and a bounded worker pool. I just hardened its terminal I/O and disk cleanup after it was overwhelming my machine."*

# Handoff: Antfarm Engine + MCP + Phone Vibecoding

Paste this whole file into a fresh Cowork session to resume. Connor is on a long car ride and wants to push through the engine arc this session via the Cowork to Claude Code relay.

## First actions in the new session
1. Read `antfarm-memory/CLAUDE.md` (the brain) and `antfarm-memory/tools-built/ant-farm/decisions.md` (latest entry dated 2026-06-30 is the pivot). Confirm caught up in 2 lines, then scope Phase 1.
2. Scope the Phase 1 CLI command surface, write `ENGINE-MCP-BUILD-PLAN.md` and `ENGINE-MCP-CODE-PROMPTS.md` to the antfarm repo root, and hand Connor the Phase 1 paste-ready Claude Code prompt.

## How to work with Connor (hard rules from CLAUDE.md)
- NO em dashes. No emojis. No AI-tell phrasing.
- Direct, no fluff, no padding. Concise.
- Name WHO runs every command (Connor in his terminal / paste into Claude Code / paste into Supabase SQL editor) and WHERE (which repo folder). Paste-safe commands only: no inline `#` comments, no smart quotes, one command per block when steps are independent.
- After any technical work, end with a 1-3 sentence plain-English recap labeled "In plain English:".
- Cowork is the Claude Code RELAY: default output when Connor pastes Code output back is the exact next thing to paste into Code (approval, revision, gate review, or next phase). Cowork reviews Code's diffs (especially migrations) before handing back the next instruction.
- Verification is Connor's job, not Code's. Code's report ends at diff + cargo check / npm run build green + commit/push. Connor runs the real test on his machine.
- Build plans go in the antfarm repo root as markdown + paste-ready Code prompts, one phase at a time.
- Push straight to main per phase (no PRs). Code must run `npm run build` (and `cargo check` for Rust) green before pushing. Stop and ask before any `supabase db push`; save rollback SQL in `supabase/rollbacks/` only.

## The strategic decision (locked 2026-06-30)
Antfarm's moat is NOT the chat UI (that overlaps Cowork). It is the agent crew plus Forge's gated Planner/Builder/Reviewer pod loop plus spec-mode auto-decomposition plus stop-before-push. DECISION: treat Antfarm as the ENGINE and expose it via MCP so Cowork, Claude Code, and PHONE can trigger it. Ultimate goal: vibecode from phone = command + review + approve (spec mode), not hand-editing code on a phone. Keep Antfarm native UI only for the rich review surface (live pod tabs, visual diff, approve-and-push).

## The phone constraint and the design choice
The engine must run on the Mac (repos and claude auth live there). The phone commands and reviews only. DO NOT open an inbound tunnel into the Mac. Tailscale crashed before (see `antfarm-memory/tools-built/ant-farm/mobile-remote-spec.md`, deferred). Route around it with a job queue: the phone writes a job to Supabase, the Mac polls and runs it, results are written back. No open inbound port, survives sleep and reconnect.

## Phased build (each phase independently useful)
Phase 1 - Headless CLI. Add a command like `antfarm forge "task" --repo <name>` (plus `antfarm spec` and `antfarm delegate <agent>`) that calls the SAME Rust pod/spec/agent logic with no GUI. Add a CLI branch in `src-tauri/src/main.rs` `fn main()` (around line 2426) BEFORE `tauri::Builder` runs (around 2441), reading `std::env::args`. Reuse `pod.rs::pod_loop`, `spec.rs::spec_loop`/`run_spec`, `agents.rs::spawn_agent_run`. Pure local, zero networking. This is the foundation; every later phase wraps it. Gate: cargo check + the CLI runs a real pod on `antfarm-write-test`, commits locally, no push.

Phase 2 - Local MCP server. A thin wrapper exposing `forge_run_pod`, `forge_run_spec`, `delegate_agent`, `list_agents`, `get_status`, `approve_and_push` as MCP tools, shelling out to the Phase 1 CLI. Desktop Cowork and Claude Code on the Mac can then trigger the crew as a native tool call. localhost only.

Phase 3 - Queue + phone. Supabase `jobs` table (id, repo, kind, task/scope, status, result_summary, diff, created_at, approved). A Mac-side poller runs jobs through the CLI and writes results back. A tiny hosted MCP endpoint (or a simple Cowork-reachable form) enqueues from the phone. Connor reviews the summary plus unified diff in Cowork mobile and approves, which triggers the push. The rich visual diff stays best in Antfarm native; text plus diff reviews fine on a phone. Migration gate applies: stop and ask before `supabase db push`, save rollback SQL.

## Secondary want (later, not now)
Agent-grouped chat sidebar in Antfarm. Connor liked the mockup. Spec: a left sidebar like his Cowork projects, grouped by AGENT as headers (Captain Jack, Clerk, Pulitzer, Scholar, Forge), each with auto-titled conversation rows (hollow-circle bullet, short summary derived from the first message, renameable via a 3-dot menu, a small accent dot marks a live run), a search box at the top, a new-chat flow with an agent picker, and agent-scoped sending (a Jack convo fans out as today; Clerk/Pulitzer/Scholar = a direct single-agent run; Forge = reuse the existing InlineForgePod pod). This requires a multi-conversation store (today `chatStore` holds only ONE live conversation). Plus a retention/clear feature (auto-archive convos older than N days, a manual clear, a message cap). Easy and feasible. The chat transcript is NOT the system of record (vault agent logs + git commits are), so deleting old messages is safe. Lower priority than the engine/MCP/phone arc.

## Where the code is
- antfarm repo: `/Users/connordore/Desktop/antfarm` (the Tauri app is at REPO ROOT, registers in `main.rs`, no `desktop/` subdir). Rust: `src-tauri/src/{agents.rs,pod.rs,spec.rs,main.rs}`. Front end: `src/pages/{Chat.tsx,Forge.tsx}`, `src/lib/{chatStore.ts,forgeThreadStore.ts,usePodStreamSync.ts}`, `src/App.tsx`.
- brain: `/Users/connordore/Desktop/antfarm-memory` (`CLAUDE.md`, `tools-built/ant-farm/{decisions.md, mobile-remote-spec.md}`).
- test target: `antfarm-write-test` is the safe Forge test repo. `roast-dash` is the real revenue repo (clean baseline first).

## What shipped this session (done, do not redo)
- Jack to Forge nav-survival fix: `usePodStreamSync` (global pod-stream listener mounted once in `App.tsx`), `forgeThreadStore.activePods` + `registerActivePod`/`patchActivePodStep`/`reconcileActivePodRole`/`finalizeAndPersistPod`/`markActivePodPushed`, and `podId` + `repoPath` persisted onto the chat `StreamEntry` in `chatStore`. Runtime-tested: delegate from Jack, leave /chat mid-run, return, the pod is still there, ready-to-push works.
- roast-dash cleanup: untracked `desktop/node_modules`, `desktop/src-tauri/target`, `desktop/dist` (were inflating the diff to ~1M lines) and gitignored them. Remaining ~50 files are a real theme refactor (hardcoded colors to CSS variables). Connor still to confirm `npm run build` green and commit for a clean baseline.

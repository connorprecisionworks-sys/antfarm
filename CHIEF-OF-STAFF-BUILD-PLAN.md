# Chief of Staff / Agents — master build plan

The executable sequence for the agent system: the Chat page (the group-chat surface), the agent registry + runner, orchestrator delegation, the day-awareness primitives, connectors, and scheduling. Consolidates `tools-built/chief-of-staff/architecture.md`, `AGENTS-MANAGEMENT-SPEC.md`, and the Chat mockup.

Rules of engagement: build ONE phase per Code prompt. Gate each phase on `npm run build` AND `cargo check --manifest-path src-tauri/Cargo.toml`, both green. Show the diff before committing. Cowork reviews each diff before the next phase. Never batch phases.

## Data already in place (built by Cowork)
- The vault `antfarm-memory` with the brain + Memory page (shipped).
- `agents/<id>/` for all five agents: `agent.json` + `identity.md` + `log.md` (chief-of-staff/Captain Jack [Opus 4.6], scout, scribe, clerk, builder). Validated JSON.
- `agents/README.md` registry index.
- `active/state/` (plan-YYYY-MM-DD.json + commitments.jsonl homes) and `active/daily/` (dated recaps), with READMEs defining the schemas.

## Chat info-rules (enforce in every phase that touches the thread)
- Quiet by default. The thread carries DECISIONS and RESULTS that need Connor, not process.
- Two tiers: "Needs you" = loud (full, colored, inline action). "Done/FYI" = quiet (one collapsed line, expandable).
- Header filter defaults to "Needs you"; "All" is opt-in.
- Live progress lives in the right rail, not as chat messages. Status updates mutate in place, they don't stack.
- Agent-to-agent chatter is collapsed by default ("watch agent chatter").
- Routine auto-jobs stay silent unless something needs Connor.

## Phases

### Phase 1 — Registry backend + Chat page shell (first visible result)
Backend: `list_agents()` and `get_agent(id)` reading `<vault>/agents/*/agent.json`. Frontend: new `src/pages/Chat.tsx` + a "Chat" sidebar item (near Voice). Render the real crew in the right "Working now / Crew" rail from `list_agents`, the header status line, and the composer (recipient chip + @ + slash hints + mic + Overnight toggle). Conversation area can use mocked messages this phase, but the crew list and composer are real. Apply the info-rules to the message styling (loud vs quiet, the Needs-you/All filter). TEST: open Chat, see the five real agents in the rail with roles/models, switch the filter.

### Phase 2 — run_agent (one agent, real)
`run_agent(agent_id, task)`: read the def, spawn `claude -p` with `--add-dir <vault>/<agent.vault>`, the profile allowlist, model, and task; stream stdout back as `agent-msg-<id>` events; write-back to the agent's `log.md`. Wire Captain Jack to answer directly in Chat (no delegation yet). Status mutates in place in the rail. TEST: message Captain Jack, get a real streamed reply, see the log entry.

### Phase 3 — Orchestrator delegation + chatter + inline approval
Captain Jack proposes a plan of subagent tasks; on approve, `run_agent` fires the subagents; their messages stream into the thread as collapsed chatter, the rail updates per agent. "Needs you" items carry INLINE Approve / Reject (no tab switch). Builder completion surfaces as a "view diff / Merge" card (reuse existing diff/merge). TEST: one delegated task fans to a subagent, returns a Needs-you item, approve it inline.

### Phase 4 — Clock + state + reconcile (Clerk real, fixes the stale-plan bug)
Structured `active/state/plan-YYYY-MM-DD.json`; every plan read reconciles against the real date (never serve a past plan as current); sensors read git commits + Claude Code sessions + agent-log; the daily recap writes `active/daily/YYYY-MM-DD.md`; unfinished items carry forward. Clerk owns this, scheduled 7am. TEST: a past-dated plan is treated as stale; a recap reflects real commits.

### Phase 5 — Networked profile + connectors
`settings.networked.json` allowlist (web + the chosen connector tools, no worktree). Wire Scribe→Gmail (draft-and-approve, send gated) and Scout→web search. Stakes gate: read/draft auto, send/post approve. TEST: Scout does a real web search; Scribe drafts a Gmail reply held for approval.

### Phase 6 — Scheduling + skills
Per-agent `schedule` (cron) via the scheduled-tasks mechanism; install a curated skill pack into `~/.claude/skills` and assign per agent. TEST: Clerk's 7am run fires automatically; an assigned skill is usable by its agent.

### Phase 3.5 — Context and memory hygiene (do right after Phase 3)
The rule: context is a small scratchpad; memory is the vault. Keep working context lean and offload durable state to files so agents never work "dumb" in a full window.
- Track context budget: parse token usage from the claude -p stream, compute it as a percent of the model's window, and surface a context meter per agent in the rail.
- Thresholds: above ~40% an agent does NOT start a consequential change (write/send/merge); at ~50% it compacts. Make both numbers config, not magic.
- Compaction: at the threshold the agent writes a tight handoff summary of its working state to the vault (its log or active/state), then continues in a FRESH session seeded with that summary. Never let a bloated session keep going.
- Action gate: before any write/send/merge, if context is over the work threshold, compact first.
- Scoped loading: stop --add-dir-ing the whole vault. Load a compact context pack (active/state + the agent's own folder + a Home/index note) and fetch specific notes on demand. The vault is the memory; only pull what the task needs.
- Lean on delegation: subagents run in their own fresh windows and return summaries, so heavy work never bloats the orchestrator's context. (Phase 3 enables this; this phase makes it the default.)
TEST: drive a long multi-turn session, watch the meter climb, confirm it compacts at the threshold and the agent stays coherent with a fresh window + the summary.

## Status & findings (2026-06-25)

Shipped + committed: Phases 1-5 (Chat page, run_agent, delegation fan-out, day-awareness/Clerk, networked profile) + a Chat UI bugfix pass.

Confirmed working in live testing:
- Routing: @mention and recipient selection reach the right agent (was going to Captain Jack — fixed).
- Web: Scout pulls live data (real Anthropic pricing with sources).
- Gmail: Scribe reads the REAL inbox and creates REAL drafts (the connector-availability gap I feared does not exist).
- Delegation: Captain Jack fans out to subagents that run in parallel and report back.
- Day plan: stale-plan banner detects + Clerk reconciles, writes plan-YYYY-MM-DD.json.
- UI: own messages render, @mention blue pill, Needs-you/All filter.

Fixes applied (prompt-only, no rebuild):
- Voice/time + teammate tone across all agents.
- Wait-for-direction: agents no longer invent a big task from a bare "@agent" prompt; they ask first. (Triggered by Scribe auto-triaging the whole inbox from a bare @scribe.)

Known limitations (not bugs — scope/architecture):
- Gmail connector is READ + DRAFT only: it cannot SEND or archive/label. So "Approve to send" can't actually send (Connor sends from Gmail), and noise threads need manual cleanup. A real send/archive needs a wider Gmail integration.
- No cross-turn memory: each message is a fresh claude -p process, so agents don't remember the prior turn in a conversation. Session reuse (--resume) is the fix, pairs with the speed pass.
- Write-scope is prompt-soft (agents can technically write the whole vault); real path-scoping still open.
- Voice mic: webkitSpeechRecognition doesn't work in the WebView; being rewired to MediaRecorder -> mobile::voice_stt.
- Latency ~30s/run (Opus 4.6 + full-vault --add-dir); Sonnet + session reuse + scoped context is the speed pass.

Remaining build: voice-mic fix (in flight) -> Phase 3.5 (context hygiene + session reuse/speed) -> Phase 6 (skills + real scheduling) -> dedicated bug-hunt (gstack /qa + manual).

## Connor's setup tasks (outside the build)
- Connect Google Calendar in the app (Gmail already connected) — for Clerk/Captain Jack.
- When Phase 5/6 land: run the provided terminal commands to install the curated skills into `~/.claude/skills` and drop `settings.networked.json` into place (these touch `~/.claude`, which the build can scaffold but Connor places).
- Run Claude Code for each phase; paste diffs back to Cowork for review.

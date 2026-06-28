# Agents Management in Antfarm — build/manage agents inside the app

Goal: create, configure, run, and watch agents (the orchestrator Captain Jack + subagents) from inside Antfarm. This is a MANAGEMENT LAYER on top of engines that already exist (dispatch, harness, memory vault, scheduler, approval cards). Build additively. Gate each phase on `npm run build` AND `cargo check --manifest-path src-tauri/Cargo.toml`, both green. Code builds, Cowork reviews diffs.

## The connection model (3 layers)

### Layer 1 — Agent registry (the data spine)
One definition per agent, stored IN the vault at `agents/<name>/agent.json` (so it is human-editable, shows in the Memory tab and Obsidian, and compounds). Schema:

```
{
  "id": "chief-of-staff",
  "name": "Captain Jack",
  "role": "orchestrator",                 // orchestrator | subagent
  "model": "claude-opus-4-8",
  "vault": "agents/chief-of-staff",       // its scoped --add-dir, relative to the master vault
  "profile": "networked",                 // networked | offline-code
  "skills": ["ea-email", "research"],      // skill ids installed under ~/.claude/skills
  "connectors": ["gmail", "calendar"],
  "schedule": "0 7 * * *",                 // optional cron; null = manual only
  "identity_note": "agents/chief-of-staff/identity.md"
}
```

Antfarm reads this registry to know what agents exist. New Rust: `list_agents()`, `get_agent(id)`, `create_agent(def)` (writes agent.json + scaffolds `agents/<id>/` with identity.md + memory/ + skills/), `update_agent(def)`, `delete_agent(id)`.

### Layer 2 — The runner (reuse dispatch/harness)
New Rust `run_agent(agent_id, task)`: read the def, build the `claude -p` invocation with `--add-dir <master_vault>/<agent.vault>`, the profile's allowlist (`.claude/settings.networked.json` for networked, the existing offline allowlist for offline-code), the model, and the task prompt. Spawn it the SAME supervised way the harness spawns runs (background thread, watchdogs, write-back to the agent's own log). Approve-gated work flows through the existing plan/card path. The registry just parameterizes the engine that already runs `claude -p` (`dispatch.rs` / `harness.rs`).

### Layer 3 — The management UI (new Antfarm surface)
New `src/pages/Agents.tsx` + a sidebar nav item (sibling to Memory, same pattern). Contents:
- A grid of agent cards: name, role, model, profile, last run/status. Actions: Run, Edit, Open Memory, View Runs.
- An agent-builder form (create/edit): name, role, model, profile, skills picker, connectors, schedule, identity. Save calls create_agent/update_agent.
- "Open Memory" deep-links to the existing Memory page scoped to `agents/<id>/`.
- "View Runs" reuses the existing Agents-view run-card model (status, diff/summary, approve where stakes require).

## How it connects to what already exists

- Memory page (built): already browses the vault, so agent vaults + logs are visible/editable for free.
- Dispatch + harness (built): the run engine; `run_agent` reuses it.
- Captain Jack (built, mobile.rs): becomes the first registry entry (the orchestrator) with authority to propose subagent jobs you approve.
- Scheduler (built): `agent.schedule` wires to the scheduled-tasks mechanism for autonomous runs.
- Approval cards (built): the stakes-gate surface for write actions.
- Permission profiles: the networked profile (`settings.networked.json`) is the one genuinely new execution piece (web + connectors, no worktree).

## Build sequence (phased)

- M0 — Registry + scaffold: agent.json schema + list/get/create/update/delete + create scaffolds the `agents/<id>/` vault folder and identity note. TEST: create an agent in the UI, confirm the folder + agent.json appear in the vault.
- M1 — Agents page: sidebar nav + agent-card grid + builder form + Open-Memory deep link. TEST: see the agent, edit it, jump to its memory.
- M2 — run_agent: reuse dispatch to run an agent on a typed task, write-back to its log, show a run card. TEST: run the chief-of-staff agent on "summarize my day," see the result card + the log entry.
- M3 — Networked profile + connectors: `settings.networked.json` allowlist (web + chosen connectors), connector assignment per agent. TEST: run a networked agent that does a web search or reads Gmail (draft-and-approve).
- M4 — Scheduling: per-agent cron via scheduled-tasks; a morning run fires automatically. TEST: schedule a recap agent for the morning, confirm it runs and posts to the dock.

## Sequencing note (anti-overbuild)
Build the management SHELL plus ONE real agent end to end (the chief-of-staff running the daily recap), not a generic factory with no agents. The Phase 0 primitives from `tools-built/chief-of-staff/architecture.md` (clock, state, sensors, reconcile) are what make that one agent actually useful; do those alongside M2. A factory that manages agents that do not know what day it is is the abandonware trap.

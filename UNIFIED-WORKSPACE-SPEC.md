# Unified Workspace: scope → delegate → watch (build spec)

Goal: in a workspace, scope a plan by talking to a Claude Code orchestrator pane, then click **Delegate** to fan the plan out into live executor panes seeded with subtasks. Watchable, non-blocking (panes keep running when you navigate away — Layout already keeps WorkspacePage mounted). Replace the clunky "Author a plan / pick project / Load existing plan" block.

Build additively. Do NOT rewrite the Dockview engine. All changes layer onto existing symbols. Run `npm run build` after each phase and report green. Use gstack `/qa` to drive the UI after Phase 3.

## What already exists (reuse, don't rebuild)

- `src/pages/Workspace.tsx`: Dockview docking. `TerminalPane` (roles `shell|orchestrator|executor`), `TerminalParams`, `DockAreaHandle` (`addPane`, `buildGrid`, `evenOut`), `buildGridLayout` with a `"conductor"` grid (orchestrator + 2 executors), `ROLE_META`, `ChatView` (chat-to-plan scoper), `AgentsView` (the clunky panel to replace).
- Backend: `pty::spawn_pty(paneId, cwd, cols, rows, kind)` where kind = `orchestrator|executor|shell`; `pty::write_pty(paneId, data)`; `harness::author_plan(description, projectPath)` → returns a validated plan with steps; `chat::*` for chat-driven scoping. Orchestrator/executor PTYs already boot `claude` with `--add-dir` the memory vault.

## Phase 1 — seedable executor panes (backend-light)

In `TerminalParams` add `seed?: string`. In `TerminalPane`, after `spawn_pty` resolves, if `params.seed` is set, fire it ONCE into the PTY after the agent boots:

```
if (params.seed) {
  const seed = params.seed;
  setTimeout(() => { invoke("write_pty", { paneId, data: seed + "\r" }).catch(() => {}); }, 4000);
}
```

Guard with a ref so React strict-mode double-mount can't double-send. 4s is a placeholder; better: write on first `pty-output` event that contains the claude prompt, fall back to timeout.

Acceptance: a terminal pane created with `seed: "echo hello"` runs it once on boot.

## Phase 2 — Delegate action on the dock handle

Add to `DockAreaHandle`:

```
delegate(slug: string | null, subtasks: string[]): void;
```

Implementation: for each subtask, `api.addPanel({ component: "terminal", params: { project_slug: slug, role: "executor", seed: subtask } })`, positioned to the right/below the orchestrator, then call the existing conductor relayout so they tile cleanly. Reuse the `freshAdd`/`reAddPanel` patterns already in `buildGridLayout`.

Acceptance: calling `delegate(slug, ["task A","task B"])` opens two executor panes, each seeded with its task, laid out conductor-style.

## Phase 3 — Scope & Delegate panel (replaces the clunky block)

Replace the "Author a plan / pick project / Load existing plan" UI in `AgentsView` with a single **Scope & Delegate** card:

1. One orchestrator pane is the scoping surface (already in the conductor grid). You talk to it in plain language to shape the work.
2. A **Subtasks** list: editable rows (one subtask per row), with an **Auto-fill from plan** button that calls `harness::author_plan(description, projectPath)` and populates the rows from the returned plan steps (`step.prompt`). You can edit/add/remove rows.
3. Two buttons:
   - **Delegate live** → `dockHandle.delegate(slug, subtasks)` (Phase 2). Visible panes, non-blocking.
   - **Arm overnight** → existing `arm_night_plan` path (keep the headless harness option).

Keep the old author/load UI reachable under an "Advanced" disclosure — do not delete the working path, just demote it.

Acceptance (gstack `/qa`): open a workspace → conductor grid → type a goal → Auto-fill → Delegate live → two+ executor panes spawn and each begins its subtask. Navigate to another page and back; panes still running.

## Phase 4 — clean the run/agent selector

The run/agent list (`AgentsView` lower half, `RunEntry`) should read as a simple status rail: one row per active pane/run with role, status chip, and a click-to-focus. Remove the dropdown-heavy selection. Cosmetic only; no backend change.

## Guardrails

- Commit before starting (checkpoint already made).
- `npm run build` is the gate each phase (not just tsc).
- Don't touch the memory `--add-dir` repoint or `memory.rs` — that's done and working.
- Seeding writes into a PTY; if the agent isn't ready the keystrokes are lost — prefer the "write on first prompt output" approach over a fixed timeout before calling it done.

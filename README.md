Ant Farm

A local-first desktop operating system for your projects. Ant Farm reads your project "brain" as the source of truth and overlays live Claude Code and Cowork sessions, token cost, git output, and one-click agent dispatch, all from local files with zero API calls.

It started as "watch your agents work through glass" and is growing into "dispatch work and get tapped on the shoulder when it needs you."

Principles


Observe-first. Agents never write to your brain. The brain stays human-edited; Ant Farm only reads it.
Zero API, zero tokens. Every number comes from the local filesystem, the process table, and Claude Code hooks. Nothing phones home.
Tolerant parsers. Session and transcript formats are undocumented and change between releases. A malformed file degrades to "details unavailable," it never crashes a list or a rollup.
Writes stay sandboxed. The app writes only to its own ~/.antfarm/ and app-data directories.


Features


Projects. A grid of every project in your brain, each with a detail view of its brief, ideas, notes, decisions, git summary, and uncommitted files.
Sessions. Live Claude Code and Cowork sessions, auto-filed under the right project, with push-based status (Running / Idle / Needs permission / Done) driven by Claude Code hooks instead of polling.
Usage. Token and estimated-dollar rollups per project, day, and week against a self-set cap. Pricing is per-model (read from each message's model) with cache-read and cache-write multipliers, so the estimate is honest. Counts both Claude Code and Cowork.
Git metrics. Commits, lines added and removed, files changed, and last-commit info per repo, plus working-tree tracking that flags uncommitted files by age (oldest first).
Dispatch. Fire a headless Claude Code task at any project from a prompt box. The run streams a live log, can isolate itself in a git worktree, runs in acceptEdits or dontAsk permission mode, and offers a one-click "Take over" that resumes the session in a real terminal when it needs a human.


Data sources (all local)


Brain: ~/Desktop/CD_claude/tools-built/<slug>/ (README, decisions.md, ideas.md, notes/).
Registry: ~/Desktop/CD_claude/ant-farm-registry.json maps each project slug to its repo folder names.
Sessions: ~/.claude/projects/*/*.jsonl (Claude Code) and Cowork session audit.jsonl files. Tokens live in message.usage.
Push events: Claude Code hooks append lifecycle events to ~/.antfarm/events.jsonl, which the app tails.
Dispatch runs: persisted under ~/.antfarm/runs/.
Liveness: a live claude process plus a recent transcript mtime.


Tech stack

Tauri 2, Rust backend, Vite + React + TypeScript + Tailwind. Dark theme. Not Next.js.

Develop

npm install
npm run tauri dev

Pre-push gate (required, run both green before pushing):

npm run build
cargo check

Work pushes straight to main; there are no feature branches or PRs.

Push status and dispatch setup

Push-based status and dispatch rely on a Claude Code status hook. Install once:


Place antfarm_status_hook.sh at ~/.antfarm/hooks/ and chmod +x it.
Merge the Stop, Notification, SessionStart, and SessionEnd hook entries into ~/.claude/settings.json (each running the hook script, async: true).


The hook is observability only and always exits clean, so it can never block an agent loop.

Structure

antfarm/
  src-tauri/        Rust backend (commands, parsers, watchers, dispatch)
    src/main.rs     project scan, session providers, usage rollup, git, events
    src/dispatch.rs headless run spawn, takeover, run records
  src/              React frontend
    pages/          Home, Projects, ProjectDetail, Sessions, Usage, Settings
    components/      SessionRow, DispatchPanel, StatCard, charts, etc.

Roadmap


v1 (shipped): projects, sessions, usage, git metrics, uncommitted tracking, push status, dispatch.
v2 (next): interactive Workspace. Named, tabbed workspaces, each tied to a project, hosting tiled terminal panes (a shell, a Claude Code pane, a reviewer pane), a web/media pane for background YouTube and dashboards, with per-workspace counters and a per-workspace "needs you" alert. Built on PTY terminals (portable-pty + xterm.js) and a docking layout.
Later: an installed-skills panel, and a "decisions to make" panel surfacing open product calls from the brain.


Status

Personal tool, pre-release. Not packaged or signed for distribution.

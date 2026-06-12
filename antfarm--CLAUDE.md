# CLAUDE.md — Ant Farm

## What this is
Ant Farm: a Tauri 2 desktop "project operating system." It reads Connor's CD_claude brain read-only and overlays live Claude Code + Cowork sessions, token cost, and git metrics on top. Solo dev. v1 is feature-complete; next track is "dispatch" (headless run supervision via `claude -p` + hooks).

## Source of truth (read these first, READ-ONLY)
- Brief:            ~/Desktop/CD_claude/tools-built/ant-farm/README.md
- Decisions log:    ~/Desktop/CD_claude/tools-built/ant-farm/decisions.md
- Dispatch roadmap: ~/Desktop/CD_claude/tools-built/ant-farm/dispatch-roadmap.md
- v2 workspace spec:~/Desktop/CD_claude/tools-built/ant-farm/v2-workspace-spec.md

Never edit anything under ~/Desktop/CD_claude/. If a decision needs recording, say so in your summary and the human logs it.

## Working agreements
- Stack: Tauri 2, Rust backend, Vite + React + TypeScript + Tailwind. Dark theme. NOT Next.js.
- Build gate before any push: `npm run build` AND `cargo check`, both green. Report both.
- Push straight to `main`, no branches, no PRs.
- Commits: small, imperative subject, no co-author tags.
- TOLERANT PARSERS everywhere (jsonl / Cowork formats are undocumented and change); never crash a list on one bad file.
- Zero API calls, zero tokens: everything is local filesystem + `ps`.
- App writes only to its own `~/.antfarm/` and app-data dirs. Read-only against the brain.

## Known landmines
- This project's registry repo name is `antfarm` (no dash); local folder is `~/Desktop/antfarm`.
- A Finder-launched Tauri `.app` does not inherit shell PATH, so `claude` won't be found in a packaged build; resolve the binary via a login shell (relevant when dispatch lands).
